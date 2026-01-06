import { Trader } from "./trader";
import { findEligibleMarkets, fetchBtc15MinMarkets, analyzeMarket, type EligibleMarket, type Market, type PriceOverride } from "./scanner";
import { insertTrade, closeTrade, getOpenTrades, type Trade } from "./db";
import { getPriceStream, type PriceStream } from "./websocket";

export interface BotConfig {
  entryThreshold: number;  // e.g., 0.95
  stopLoss: number;        // e.g., 0.85
  timeWindowMs: number;    // e.g., 5 * 60 * 1000
  pollIntervalMs: number;  // e.g., 10 * 1000
}

export interface BotState {
  running: boolean;
  balance: number;
  positions: Map<string, { tradeId: number; tokenId: string; shares: number; entryPrice: number; side: "UP" | "DOWN"; marketSlug: string }>;
  lastScan: Date | null;
  logs: string[];
  tradingEnabled: boolean;
  initError: string | null;
  wsConnected: boolean;
  markets: Market[];
}

export type LogCallback = (message: string) => void;

export class Bot {
  private trader: Trader;
  private config: BotConfig;
  private state: BotState;
  private interval: Timer | null = null;
  private onLog: LogCallback;
  private priceStream: PriceStream;

  constructor(privateKey: string, config: BotConfig, onLog: LogCallback = console.log) {
    this.trader = new Trader(privateKey);
    this.config = config;
    this.onLog = onLog;
    this.priceStream = getPriceStream();
    this.state = {
      running: false,
      balance: 0,
      positions: new Map(),
      lastScan: null,
      logs: [],
      tradingEnabled: false,
      initError: null,
      wsConnected: false,
      markets: []
    };
  }

  async init(): Promise<void> {
    // Fetch initial markets
    try {
      this.state.markets = await fetchBtc15MinMarkets();
      if (this.state.markets.length > 0) {
        this.log(`Found ${this.state.markets.length} active markets`);
      }
    } catch (err) {
      this.log("Failed to fetch markets");
    }

    // Initialize trader
    await this.trader.init();

    const walletAddr = this.trader.getAddress();
    this.log(`Wallet: ${walletAddr.slice(0, 10)}...${walletAddr.slice(-8)}`);

    // Connect WebSocket for real-time prices (market channel is public, no auth needed)
    try {
      await this.priceStream.connect();
      this.state.wsConnected = true;
      this.log("WebSocket connected for real-time prices");

      if (this.state.markets.length > 0) {
        this.subscribeToMarkets(this.state.markets);
      }
    } catch (err) {
      this.log("WebSocket connection failed, using Gamma API");
    }

    if (this.trader.isReady()) {
      this.state.tradingEnabled = true;
      this.state.balance = await this.trader.getBalance();
      this.log(`Balance: $${this.state.balance.toFixed(2)} USDC`);

      // Load open trades from DB
      const openTrades = getOpenTrades();
      for (const trade of openTrades) {
        this.state.positions.set(trade.token_id, {
          tradeId: trade.id,
          tokenId: trade.token_id,
          shares: trade.shares,
          entryPrice: trade.entry_price,
          side: trade.side as "UP" | "DOWN",
          marketSlug: trade.market_slug
        });
      }
      if (openTrades.length > 0) {
        this.log(`Loaded ${openTrades.length} open positions`);
      }
    } else {
      this.state.initError = this.trader.getInitError();
      this.log(`Trading disabled: ${this.state.initError}`);
      this.log("Tip: Ensure API keys match your wallet");
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;
    this.state.logs.push(formatted);
    if (this.state.logs.length > 100) {
      this.state.logs.shift();
    }
    this.onLog(formatted);
  }

  private subscribeToMarkets(markets: Market[]): void {
    const tokenIds: string[] = [];
    for (const market of markets) {
      if (market.clobTokenIds) {
        tokenIds.push(...market.clobTokenIds);
      }
    }
    if (tokenIds.length > 0) {
      this.priceStream.subscribe(tokenIds);
    }
  }

  private getPriceOverrides(): PriceOverride | undefined {
    if (!this.state.wsConnected) return undefined;

    const overrides: PriceOverride = {};
    for (const market of this.state.markets) {
      for (const tokenId of market.clobTokenIds) {
        const wsPrice = this.priceStream.getPrice(tokenId);
        if (wsPrice) {
          overrides[tokenId] = {
            bestBid: wsPrice.bestBid,
            bestAsk: wsPrice.bestAsk
          };
        }
      }
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  async start(): Promise<void> {
    if (this.state.running) return;
    this.state.running = true;
    this.log("Bot started");

    // Run immediately
    await this.tick();

    // Then run on interval
    this.interval = setInterval(() => this.tick(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.state.running) return;
    this.state.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.log("Bot stopped");
  }

  private async tick(): Promise<void> {
    try {
      this.state.lastScan = new Date();

      // Only trade if CLOB client is ready
      if (!this.state.tradingEnabled) {
        return;
      }

      this.state.balance = await this.trader.getBalance();

      // Check stop-losses on open positions
      await this.checkStopLosses();

      // Only look for new trades if we have balance
      if (this.state.balance > 1) {
        await this.scanForEntries();
      }
    } catch (err) {
      this.log(`Error in tick: ${err}`);
    }
  }

  private async checkStopLosses(): Promise<void> {
    for (const [tokenId, position] of this.state.positions) {
      try {
        // Use WebSocket price if available, otherwise fall back to REST API
        let currentPrice: number;
        const wsPrice = this.priceStream.getPrice(tokenId);
        if (wsPrice && this.state.wsConnected) {
          currentPrice = wsPrice.price;
        } else {
          const { mid } = await this.trader.getPrice(tokenId);
          currentPrice = mid;
        }

        // Check if stop-loss triggered (price dropped to 85% or below)
        if (currentPrice <= this.config.stopLoss) {
          this.log(`Stop-loss triggered for ${position.side} @ $${currentPrice.toFixed(2)}`);

          const result = await this.trader.marketSell(tokenId, position.shares);
          if (result) {
            closeTrade(position.tradeId, result.price, "STOPPED");
            this.state.positions.delete(tokenId);
            const pnl = (result.price - position.entryPrice) * position.shares;
            this.log(`Closed position. PnL: $${pnl.toFixed(2)}`);
          }
        }
      } catch (err) {
        this.log(`Error checking stop-loss: ${err}`);
      }
    }
  }

  private async scanForEntries(): Promise<void> {
    try {
      // Refresh markets list
      this.state.markets = await fetchBtc15MinMarkets();
      this.subscribeToMarkets(this.state.markets);

      // Use WebSocket prices if available for more accurate signals
      const priceOverrides = this.getPriceOverrides();
      const eligible = findEligibleMarkets(this.state.markets, {
        entryThreshold: this.config.entryThreshold,
        timeWindowMs: this.config.timeWindowMs
      }, priceOverrides);

      for (const market of eligible) {
        // Skip if we already have a position in this market
        const tokenId = market.eligibleSide === "UP" ? market.upTokenId : market.downTokenId;
        if (this.state.positions.has(tokenId)) continue;

        await this.enterPosition(market);
      }
    } catch (err) {
      this.log(`Error scanning markets: ${err}`);
    }
  }

  private async enterPosition(market: EligibleMarket): Promise<void> {
    const side = market.eligibleSide!;
    const tokenId = side === "UP" ? market.upTokenId : market.downTokenId;
    const askPrice = side === "UP" ? market.upAsk : market.downAsk;

    this.log(`Entry signal: ${side} @ $${askPrice.toFixed(2)} ask (${Math.floor(market.timeRemaining / 1000)}s remaining)`);

    // Use full balance
    const balance = await this.trader.getBalance();
    if (balance < 1) {
      this.log("Insufficient balance");
      return;
    }

    const result = await this.trader.buy(tokenId, askPrice, balance);
    if (!result) {
      this.log("Order failed");
      return;
    }

    // Record trade
    const tradeId = insertTrade({
      market_slug: market.slug,
      token_id: tokenId,
      side,
      entry_price: askPrice,
      shares: result.shares,
      cost_basis: balance,
      created_at: new Date().toISOString()
    });

    this.state.positions.set(tokenId, {
      tradeId,
      tokenId,
      shares: result.shares,
      entryPrice: askPrice,
      side,
      marketSlug: market.slug
    });

    this.log(`Bought ${result.shares.toFixed(2)} shares of ${side} @ $${askPrice.toFixed(2)} ask`);
  }

  getState(): BotState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  async getMarketOverview(): Promise<EligibleMarket[]> {
    // Always fetch fresh market data for accurate prices
    this.state.markets = await fetchBtc15MinMarkets();
    this.subscribeToMarkets(this.state.markets);

    // Use WebSocket prices if available for more accurate display
    const priceOverrides = this.getPriceOverrides();
    return this.state.markets.map(m => analyzeMarket(m, {
      entryThreshold: this.config.entryThreshold,
      timeWindowMs: this.config.timeWindowMs
    }, priceOverrides));
  }

  isWsConnected(): boolean {
    return this.state.wsConnected;
  }
}
