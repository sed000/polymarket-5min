import WebSocket from "ws";

const WS_BASE_URL = "wss://ws-subscriptions-clob.polymarket.com";
const MARKET_WS_URL = `${WS_BASE_URL}/ws/market`;
const USER_WS_URL = `${WS_BASE_URL}/ws/user`;
const SUBSCRIBE_TIMEOUT_MS = 5000;

export interface PriceUpdate {
  tokenId: string;
  price: number;
  bestBid: number;
  bestAsk: number;
  spread?: number;
  timestamp: number;
  source: "book" | "price_change" | "price_change_item" | "last_trade_price" | "best_bid_ask";
}

export interface MarketEvent {
  eventType: string;
  id?: string;
  marketId?: string;
  slug?: string;
  question?: string;
  outcomes?: string[];
  assetsIds?: string[];
  winningAssetId?: string;
  winningOutcome?: string;
  timestamp?: number;
}

export interface UserAuth {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface UserTradeEvent {
  event_type?: string;
  type?: string;
  maker_orders?: Array<{
    order_id?: string;
    matched_amount?: string;
    price?: string;
  }>;
  taker_order_id?: string;
  size?: string;
  price?: string;
}

export interface UserOrderEvent {
  event_type?: string;
  type?: string;
  id?: string;
  size_matched?: string;
  original_size?: string;
  price?: string;
  status?: string;
}

type PriceCallback = (update: PriceUpdate) => void;
type MarketCallback = (event: MarketEvent) => void;
type ConnectionCallback = (connected: boolean) => void;

export class PriceStream {
  private ws: WebSocket | null = null;
  private subscriptions: Set<string> = new Set();
  private pendingSubscriptions: Set<string> = new Set();
  private prices: Map<string, PriceUpdate> = new Map();
  private tickSizes: Map<string, number> = new Map();
  private callbacks: PriceCallback[] = [];
  private marketCallbacks: MarketCallback[] = [];
  private connectionCallbacks: ConnectionCallback[] = [];
  private reconnectTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private subscriptionCheckTimer: Timer | null = null;
  private connected = false;
  private intentionalReconnect = false;
  private lastMessageAt = 0;

  constructor() {}

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.subscriptionCheckTimer) {
      clearTimeout(this.subscriptionCheckTimer);
      this.subscriptionCheckTimer = null;
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(MARKET_WS_URL);

        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          this.notifyConnectionChange(true);

          // Market channel does NOT require authentication (only user channel does)
          // Just start pinging and subscribe to markets

          // Start ping interval to keep connection alive
          this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send("PING");
            }
          }, 10000);

          // Resubscribe to any existing subscriptions
          if (this.subscriptions.size > 0) {
            this.sendSubscription([...this.subscriptions], "subscribe");
          }

          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = event.data.toString();
            if (msg === "PONG") return;
            this.lastMessageAt = Date.now();

            const data = JSON.parse(msg);
            // Debug: uncomment to see all messages
            // console.log("[WS RAW]", JSON.stringify(data).slice(0, 200));
            this.handleMessage(data);
          } catch {
            // Ignore parse errors
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.notifyConnectionChange(false);
          this.clearTimers();
          this.pendingSubscriptions.clear();
          // Reconnect immediately if intentional, otherwise wait 3 seconds
          const delay = this.intentionalReconnect ? 100 : 3000;
          this.intentionalReconnect = false;
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        };

      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(data: any) {
    // Debug: log message types
    const msgType = data.event_type || data.type || (Array.isArray(data) ? 'array' : 'unknown');
    if (msgType !== 'unknown' && msgType !== 'last_trade_price') {
      // console.log(`[WS] Message type: ${msgType}`);
    }

    // Handle different message types
    if (data.event_type === "book" || data.type === "book" || data.bids || data.asks) {
      this.handleBookUpdate(data);
    } else if (data.event_type === "best_bid_ask" || data.type === "best_bid_ask") {
      this.handleBestBidAsk(data);
    } else if (data.price_changes && Array.isArray(data.price_changes)) {
      // Handle price_changes array format
      for (const change of data.price_changes) {
        this.handlePriceChangeItem(change, data.timestamp);
      }
    } else if (data.event_type === "price_change" || data.type === "price_change") {
      this.handlePriceChange(data);
    } else if (data.event_type === "tick_size_change" || data.type === "tick_size_change") {
      this.handleTickSizeChange(data);
    } else if (data.event_type === "new_market" || data.type === "new_market" || data.event_type === "market_resolved" || data.type === "market_resolved" || data.winning_asset_id || data.winningAssetId) {
      this.handleMarketEvent(data);
    } else if (data.event_type === "last_trade_price" || data.type === "last_trade_price" || data.price) {
      this.handleLastTradePrice(data);
    } else if (Array.isArray(data)) {
      for (const item of data) {
        this.handleMessage(item);
      }
    }
  }

  private parseTimestamp(value: any): number {
    if (value === undefined || value === null) {
      return Date.now();
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return Date.now();
      }
      if (/[T-]/.test(trimmed)) {
        const parsedDate = Date.parse(trimmed);
        if (!Number.isNaN(parsedDate)) {
          return parsedDate;
        }
      }
    }

    const parsed = typeof value === "number" ? value : parseFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return Date.now();
    }
    // Treat 10-digit values as seconds, convert to ms.
    if (parsed < 1_000_000_000_000) {
      return parsed * 1000;
    }
    return parsed;
  }

  private recordPrice(update: PriceUpdate) {
    this.prices.set(update.tokenId, update);
    this.pendingSubscriptions.delete(update.tokenId);
    this.notifyCallbacks(update);
  }

  private handlePriceChangeItem(item: any, timestamp?: any) {
    const tokenId = item.asset_id;
    if (!tokenId) return;
    const eventTimestamp = this.parseTimestamp(timestamp ?? item.timestamp);

    // Check if this has best_bid/best_ask (real market price)
    if (item.best_bid !== undefined && item.best_ask !== undefined) {
      const bestBid = parseFloat(item.best_bid);
      const bestAsk = parseFloat(item.best_ask);
      if (bestBid > 0 || bestAsk < 1) {
        const price = (bestBid + bestAsk) / 2;
        const update: PriceUpdate = {
          tokenId,
          price,
          bestBid,
          bestAsk,
          spread: bestAsk - bestBid,
          timestamp: eventTimestamp,
          source: "price_change_item"
        };
        this.recordPrice(update);
      }
      return;
    }

    // If we already have orderbook data, don't overwrite with trade price
    const existing = this.prices.get(tokenId);
    if (existing && existing.bestBid !== existing.bestAsk) {
      return; // Keep orderbook-derived price
    }

    // Only use trade price if we have nothing else
    const price = parseFloat(item.price || "0");
    if (price === 0) return;

    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid: price,
      bestAsk: price,
      spread: 0,
      timestamp: eventTimestamp,
      source: "price_change_item"
    };
    this.recordPrice(update);
  }

  private handleBookUpdate(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;
    const eventTimestamp = this.parseTimestamp(data.timestamp);

    const bids = data.bids || [];
    const asks = data.asks || [];

    // Find best bid (highest price someone will pay)
    let bestBid = 0;
    for (const bid of bids) {
      const p = parseFloat(bid.price);
      if (p > bestBid) bestBid = p;
    }

    // Find best ask (lowest price someone will sell)
    let bestAsk = 1;
    for (const ask of asks) {
      const p = parseFloat(ask.price);
      if (p < bestAsk) bestAsk = p;
    }

    // Calculate midpoint price
    let price: number;
    if (bestBid > 0 && bestAsk < 1) {
      price = (bestBid + bestAsk) / 2;
    } else if (bestBid > 0) {
      price = bestBid;
    } else if (bestAsk < 1) {
      price = bestAsk;
    } else {
      return; // No real data
    }

    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      timestamp: eventTimestamp,
      source: "book"
    };
    this.recordPrice(update);
  }

  private handlePriceChange(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;
    const eventTimestamp = this.parseTimestamp(data.timestamp);

    const bestBid = parseFloat(data.best_bid || "0");
    const bestAsk = parseFloat(data.best_ask || "1");

    if (bestBid === 0 && bestAsk === 1) return; // No real data

    const price = (bestBid + bestAsk) / 2;

    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      timestamp: eventTimestamp,
      source: "price_change"
    };
    this.recordPrice(update);
  }

  private handleLastTradePrice(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;
    const eventTimestamp = this.parseTimestamp(data.timestamp);

    const price = parseFloat(data.price || "0");
    if (price === 0) return;

    const existing = this.prices.get(tokenId);
    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid: existing?.bestBid || price,
      bestAsk: existing?.bestAsk || price,
      spread: existing ? existing.bestAsk - existing.bestBid : 0,
      timestamp: eventTimestamp,
      source: "last_trade_price"
    };
    this.recordPrice(update);
  }

  private handleBestBidAsk(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;
    const eventTimestamp = this.parseTimestamp(data.timestamp);

    const bestBid = parseFloat(data.best_bid || "0");
    const bestAsk = parseFloat(data.best_ask || "1");
    if (bestBid === 0 && bestAsk === 1) return;

    const price = bestBid > 0 && bestAsk < 1 ? (bestBid + bestAsk) / 2 : Math.max(bestBid, 0) || Math.min(bestAsk, 1);
    const rawSpread = parseFloat(data.spread ?? "");
    const spread = Number.isFinite(rawSpread) ? rawSpread : bestAsk - bestBid;

    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid,
      bestAsk,
      spread,
      timestamp: eventTimestamp,
      source: "best_bid_ask"
    };
    this.recordPrice(update);
  }

  private handleTickSizeChange(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;
    const tickSize = parseFloat(data.new_tick_size || data.tick_size || "0");
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    this.tickSizes.set(tokenId, tickSize);
  }

  private handleMarketEvent(data: any) {
    const event: MarketEvent = {
      eventType: data.event_type || data.type || "market_event",
      id: data.id,
      marketId: data.market ?? data.market_id ?? data.marketId,
      slug: data.slug,
      question: data.question,
      outcomes: Array.isArray(data.outcomes) ? data.outcomes : undefined,
      assetsIds: Array.isArray(data.assets_ids) ? data.assets_ids : Array.isArray(data.assetsIds) ? data.assetsIds : undefined,
      winningAssetId: data.winning_asset_id ?? data.winningAssetId,
      winningOutcome: data.winning_outcome ?? data.winningOutcome,
      timestamp: this.parseTimestamp(data.timestamp)
    };
    this.notifyMarketEvent(event);
  }

  private notifyCallbacks(update: PriceUpdate) {
    for (const cb of this.callbacks) {
      try {
        cb(update);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private notifyMarketEvent(event: MarketEvent) {
    for (const cb of this.marketCallbacks) {
      try {
        cb(event);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private notifyConnectionChange(connected: boolean) {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private sendSubscription(tokenIds: string[], operation?: "subscribe" | "unsubscribe") {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    // console.log(`[WS] Subscribing to ${tokenIds.length} tokens`);
    const msg: Record<string, unknown> = {
      assets_ids: tokenIds,
      type: "market",
      custom_feature_enabled: true
    };
    if (operation) {
      msg.operation = operation;
    }
    this.ws.send(JSON.stringify(msg));
  }

  subscribe(tokenIds: string[]) {
    // Filter to only new token IDs we haven't subscribed to yet
    const newTokenIds = tokenIds.filter(id => !this.subscriptions.has(id));

    if (newTokenIds.length === 0) return;

    for (const id of newTokenIds) {
      this.subscriptions.add(id);
    }

    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(newTokenIds, "subscribe");
      this.scheduleSubscriptionCheck(newTokenIds);
    }
  }

  unsubscribe(tokenIds: string[]) {
    const existingTokenIds = tokenIds.filter(id => this.subscriptions.has(id));
    if (existingTokenIds.length === 0) return;

    for (const id of existingTokenIds) {
      this.subscriptions.delete(id);
    }

    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(existingTokenIds, "unsubscribe");
    }
  }

  private scheduleSubscriptionCheck(tokenIds: string[]) {
    for (const id of tokenIds) {
      this.pendingSubscriptions.add(id);
    }

    if (this.subscriptionCheckTimer) return;

    this.subscriptionCheckTimer = setTimeout(() => {
      if (this.pendingSubscriptions.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        this.pendingSubscriptions.clear();
        this.reconnect();
      }
      this.subscriptionCheckTimer = null;
    }, SUBSCRIBE_TIMEOUT_MS);
  }

  private reconnect() {
    // Close current connection (onclose handler will auto-reconnect)
    this.intentionalReconnect = true;
    if (this.ws) {
      this.ws.close();
    }
  }

  onPrice(callback: PriceCallback) {
    this.callbacks.push(callback);
  }

  onMarketEvent(callback: MarketCallback) {
    this.marketCallbacks.push(callback);
  }

  onConnectionChange(callback: ConnectionCallback) {
    this.connectionCallbacks.push(callback);
  }

  getPrice(tokenId: string, maxAgeMs?: number): PriceUpdate | null {
    const update = this.prices.get(tokenId) || null;
    if (!update) return null;
    if (maxAgeMs !== undefined && Date.now() - update.timestamp > maxAgeMs) {
      return null;
    }
    return update;
  }

  getTickSize(tokenId: string): number | null {
    return this.tickSizes.get(tokenId) ?? null;
  }

  getLastMessageAt(): number {
    return this.lastMessageAt;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getPriceCount(): number {
    return this.prices.size;
  }

  close() {
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingSubscriptions.clear();
    this.connected = false;
  }
}

type UserTradeCallback = (event: UserTradeEvent) => void;
type UserOrderCallback = (event: UserOrderEvent) => void;
type UserConnectionCallback = (connected: boolean) => void;

export class UserStream {
  private ws: WebSocket | null = null;
  private auth: UserAuth | null = null;
  private markets: Set<string> = new Set();
  private tradeCallbacks: UserTradeCallback[] = [];
  private orderCallbacks: UserOrderCallback[] = [];
  private connectionCallbacks: UserConnectionCallback[] = [];
  private reconnectTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private connected = false;
  private intentionalReconnect = false;
  private lastMessageAt = 0;

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  connect(auth?: UserAuth, markets?: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (auth) {
          this.auth = auth;
        }
        if (markets) {
          this.markets = new Set(markets.filter(Boolean));
        }
        if (!this.auth) {
          reject(new Error("User WebSocket auth missing"));
          return;
        }

        this.ws = new WebSocket(USER_WS_URL);

        const timeout = setTimeout(() => {
          reject(new Error("User WebSocket connection timeout"));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          this.notifyConnectionChange(true);

          this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send("PING");
            }
          }, 10000);

          const payload: Record<string, unknown> = {
            type: "user",
            auth: {
              apiKey: this.auth.apiKey,
              secret: this.auth.secret,
              passphrase: this.auth.passphrase
            }
          };
          if (this.markets.size > 0) {
            payload.markets = [...this.markets];
          }
          this.ws.send(JSON.stringify(payload));
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = event.data.toString();
            if (msg === "PONG") return;
            this.lastMessageAt = Date.now();

            const data = JSON.parse(msg);
            this.handleMessage(data);
          } catch {
            // Ignore parse errors
          }
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.notifyConnectionChange(false);
          this.clearTimers();
          const delay = this.intentionalReconnect ? 100 : 3000;
          this.intentionalReconnect = false;
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(data: any) {
    if (Array.isArray(data)) {
      for (const item of data) {
        this.handleMessage(item);
      }
      return;
    }

    const rawType = data.event_type || data.type || "";
    const eventType = rawType.toString().toLowerCase();

    if (eventType === "trade") {
      this.notifyTrade(data as UserTradeEvent);
      return;
    }

    if (eventType === "order" || eventType === "placement" || eventType === "update" || eventType === "cancel" || eventType === "canceled" || eventType === "cancelled") {
      this.notifyOrder(data as UserOrderEvent);
    }
  }

  private notifyTrade(event: UserTradeEvent) {
    for (const cb of this.tradeCallbacks) {
      try {
        cb(event);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private notifyOrder(event: UserOrderEvent) {
    for (const cb of this.orderCallbacks) {
      try {
        cb(event);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private notifyConnectionChange(connected: boolean) {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch {
        // Ignore callback errors
      }
    }
  }

  onTrade(callback: UserTradeCallback) {
    this.tradeCallbacks.push(callback);
  }

  onOrder(callback: UserOrderCallback) {
    this.orderCallbacks.push(callback);
  }

  onConnectionChange(callback: UserConnectionCallback) {
    this.connectionCallbacks.push(callback);
  }

  setMarkets(markets: string[]) {
    const nextMarkets = new Set(markets.filter(Boolean));
    if (nextMarkets.size === this.markets.size) {
      let same = true;
      for (const market of nextMarkets) {
        if (!this.markets.has(market)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }

    this.markets = nextMarkets;
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.reconnect();
    }
  }

  private reconnect() {
    this.intentionalReconnect = true;
    if (this.ws) {
      this.ws.close();
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getMarketCount(): number {
    return this.markets.size;
  }

  getLastMessageAt(): number {
    return this.lastMessageAt;
  }

  close() {
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

// Singleton instance
let priceStream: PriceStream | null = null;

export function getPriceStream(): PriceStream {
  if (!priceStream) {
    priceStream = new PriceStream();
  }
  return priceStream;
}
