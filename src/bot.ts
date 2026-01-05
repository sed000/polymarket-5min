import { Trader } from "./trader";
import { findEligibleMarkets, fetchBtc15MinMarkets, analyzeMarket, type EligibleMarket } from "./scanner";
import { insertTrade, closeTrade, getOpenTrades, type Trade } from "./db";

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
}

export type LogCallback = (message: string) => void;

export class Bot {
  private trader: Trader;
  private config: BotConfig;
  private state: BotState;
  private interval: Timer | null = null;
  private onLog: LogCallback;

  constructor(privateKey: string, config: BotConfig, onLog: LogCallback = console.log) {
    this.trader = new Trader(privateKey);
    this.config = config;
    this.onLog = onLog;
    this.state = {
      running: false,
      balance: 0,
      positions: new Map(),
      lastScan: null,
      logs: [],
      tradingEnabled: false,
      initError: null
    };
  }

  async init(): Promise<void> {
    await this.trader.init();

    const walletAddr = this.trader.getAddress();
    this.log(`Wallet: ${walletAddr.slice(0, 10)}...${walletAddr.slice(-8)}`);

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
      this.log("Tip: Register wallet on polymarket.com first");
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
        const { mid: currentPrice } = await this.trader.getPrice(tokenId);

        // Check if stop-loss triggered (price dropped to 85% or below)
        if (currentPrice <= this.config.stopLoss) {
          this.log(`Stop-loss triggered for ${position.side} @ ${currentPrice.toFixed(3)}`);

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
      const eligible = await findEligibleMarkets({
        entryThreshold: this.config.entryThreshold,
        timeWindowMs: this.config.timeWindowMs
      });

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
    const price = side === "UP" ? market.upPrice : market.downPrice;

    this.log(`Entry signal: ${side} @ ${price.toFixed(3)} (${Math.floor(market.timeRemaining / 1000)}s remaining)`);

    // Use full balance
    const balance = await this.trader.getBalance();
    if (balance < 1) {
      this.log("Insufficient balance");
      return;
    }

    const result = await this.trader.buy(tokenId, price, balance);
    if (!result) {
      this.log("Order failed");
      return;
    }

    // Record trade
    const tradeId = insertTrade({
      market_slug: market.slug,
      token_id: tokenId,
      side,
      entry_price: price,
      shares: result.shares,
      cost_basis: balance,
      created_at: new Date().toISOString()
    });

    this.state.positions.set(tokenId, {
      tradeId,
      tokenId,
      shares: result.shares,
      entryPrice: price,
      side,
      marketSlug: market.slug
    });

    this.log(`Bought ${result.shares.toFixed(2)} shares of ${side} @ ${price.toFixed(3)}`);
  }

  getState(): BotState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  async getMarketOverview(): Promise<EligibleMarket[]> {
    const markets = await fetchBtc15MinMarkets();
    return markets.map(m => analyzeMarket(m, {
      entryThreshold: this.config.entryThreshold,
      timeWindowMs: this.config.timeWindowMs
    }));
  }
}
