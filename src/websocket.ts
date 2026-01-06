import WebSocket from "ws";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface PriceUpdate {
  tokenId: string;
  price: number;
  bestBid: number;
  bestAsk: number;
}

type PriceCallback = (update: PriceUpdate) => void;
type ConnectionCallback = (connected: boolean) => void;

export class PriceStream {
  private ws: WebSocket | null = null;
  private subscriptions: Set<string> = new Set();
  private prices: Map<string, PriceUpdate> = new Map();
  private callbacks: PriceCallback[] = [];
  private connectionCallbacks: ConnectionCallback[] = [];
  private reconnectTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private connected = false;

  constructor() {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL);

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
            this.sendSubscription([...this.subscriptions]);
          }

          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = event.data.toString();
            if (msg === "PONG") return;

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
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          // Reconnect after 3 seconds
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        };

      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(data: any) {
    // Handle different message types
    if (data.event_type === "book" || data.type === "book" || data.bids || data.asks) {
      this.handleBookUpdate(data);
    } else if (data.price_changes && Array.isArray(data.price_changes)) {
      // Handle price_changes array format
      for (const change of data.price_changes) {
        this.handlePriceChangeItem(change);
      }
    } else if (data.event_type === "price_change" || data.type === "price_change") {
      this.handlePriceChange(data);
    } else if (data.event_type === "last_trade_price" || data.type === "last_trade_price" || data.price) {
      this.handleLastTradePrice(data);
    } else if (Array.isArray(data)) {
      for (const item of data) {
        this.handleMessage(item);
      }
    }
  }

  private handlePriceChangeItem(item: any) {
    const tokenId = item.asset_id;
    if (!tokenId) return;

    // Check if this has best_bid/best_ask (real market price)
    if (item.best_bid !== undefined && item.best_ask !== undefined) {
      const bestBid = parseFloat(item.best_bid);
      const bestAsk = parseFloat(item.best_ask);
      if (bestBid > 0 || bestAsk < 1) {
        const price = (bestBid + bestAsk) / 2;
        const update: PriceUpdate = { tokenId, price, bestBid, bestAsk };
        this.prices.set(tokenId, update);
        this.notifyCallbacks(update);
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
      bestAsk: price
    };
    this.prices.set(tokenId, update);
    this.notifyCallbacks(update);
  }

  private handleBookUpdate(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;

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

    const update: PriceUpdate = { tokenId, price, bestBid, bestAsk };
    this.prices.set(tokenId, update);
    this.notifyCallbacks(update);
  }

  private handlePriceChange(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;

    const bestBid = parseFloat(data.best_bid || "0");
    const bestAsk = parseFloat(data.best_ask || "1");

    if (bestBid === 0 && bestAsk === 1) return; // No real data

    const price = (bestBid + bestAsk) / 2;

    const update: PriceUpdate = { tokenId, price, bestBid, bestAsk };
    this.prices.set(tokenId, update);
    this.notifyCallbacks(update);
  }

  private handleLastTradePrice(data: any) {
    const tokenId = data.asset_id;
    if (!tokenId) return;

    const price = parseFloat(data.price || "0");
    if (price === 0) return;

    const existing = this.prices.get(tokenId);
    const update: PriceUpdate = {
      tokenId,
      price,
      bestBid: existing?.bestBid || price,
      bestAsk: existing?.bestAsk || price
    };
    this.prices.set(tokenId, update);
    this.notifyCallbacks(update);
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

  private notifyConnectionChange(connected: boolean) {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private sendSubscription(tokenIds: string[]) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const msg = {
      assets_ids: tokenIds,
      type: "market"
    };
    this.ws.send(JSON.stringify(msg));
  }

  subscribe(tokenIds: string[]) {
    // Filter to only new token IDs we haven't subscribed to yet
    const newTokenIds = tokenIds.filter(id => !this.subscriptions.has(id));

    for (const id of newTokenIds) {
      this.subscriptions.add(id);
    }

    // Only send subscription if we have new tokens
    if (newTokenIds.length > 0 && this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription(newTokenIds);
    }
  }

  onPrice(callback: PriceCallback) {
    this.callbacks.push(callback);
  }

  onConnectionChange(callback: ConnectionCallback) {
    this.connectionCallbacks.push(callback);
  }

  getPrice(tokenId: string): PriceUpdate | null {
    return this.prices.get(tokenId) || null;
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
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
