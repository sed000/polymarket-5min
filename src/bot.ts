import { Trader } from "./trader";
import { findEligibleMarkets, fetchBtc15MinMarkets, analyzeMarket, type EligibleMarket, type Market, type PriceOverride } from "./scanner";
import { insertTrade, closeTrade, getOpenTrades, type Trade } from "./db";
import { getPriceStream, type PriceStream } from "./websocket";

const PROFIT_TARGET = 0.99; // Auto-sell at $0.99 for profit

export type RiskMode = "normal" | "super-risk";

export interface BotConfig {
  entryThreshold: number;  // e.g., 0.95
  maxEntryPrice: number;   // e.g., 0.98 - avoid ceiling price
  stopLoss: number;        // e.g., 0.80
  stopLossDelayMs: number; // e.g., 5000 - confirmation delay in ms
  maxSpread: number;       // e.g., 0.03 - max bid-ask spread
  timeWindowMs: number;    // e.g., 5 * 60 * 1000
  pollIntervalMs: number;  // e.g., 10 * 1000
  paperTrading: boolean;   // Simulate trades with virtual money
  paperBalance: number;    // Starting balance for paper trading
  riskMode: RiskMode;      // "normal" or "super-risk"
}

export interface Position {
  tradeId: number;
  tokenId: string;
  shares: number;
  entryPrice: number;
  side: "UP" | "DOWN";
  marketSlug: string;
  marketEndDate: Date;
  limitOrderId?: string; // Limit sell order at $0.99
  pendingStopLoss?: {
    triggeredAt: number;  // Timestamp when stop-loss first triggered
    triggeredPrice: number;
  };
}

export interface BotState {
  running: boolean;
  balance: number;
  positions: Map<string, Position>;
  lastScan: Date | null;
  logs: string[];
  tradingEnabled: boolean;
  initError: string | null;
  wsConnected: boolean;
  markets: Market[];
  paperTrading: boolean;
}

export type LogCallback = (message: string) => void;

export class Bot {
  private trader: Trader;
  private config: BotConfig;
  private state: BotState;
  private interval: Timer | null = null;
  private onLog: LogCallback;
  private priceStream: PriceStream;
  private lastMarketRefresh: Date | null = null;
  private marketRefreshInterval = 30000; // Refresh markets every 30 seconds

  constructor(privateKey: string, config: BotConfig, onLog: LogCallback = console.log) {
    this.trader = new Trader(privateKey);
    this.config = config;
    this.onLog = onLog;
    this.priceStream = getPriceStream();
    this.state = {
      running: false,
      balance: config.paperTrading ? config.paperBalance : 0,
      positions: new Map(),
      lastScan: null,
      logs: [],
      tradingEnabled: false,
      initError: null,
      wsConnected: false,
      markets: [],
      paperTrading: config.paperTrading
    };
  }

  /**
   * Get active trading config based on risk mode
   * SUPER-RISK mode uses more aggressive parameters
   */
  private getActiveConfig() {
    if (this.config.riskMode === "super-risk") {
      return {
        entryThreshold: 0.70,
        maxEntryPrice: 0.95,
        stopLoss: 0.40,
        timeWindowMs: 15 * 60 * 1000,  // Full 15 min market duration
        stopLossDelayMs: 0,  // No delay for super-risk - immediate stop-loss
        maxSpread: 0.05  // Allow wider spreads for volatile entries
      };
    }
    return {
      entryThreshold: this.config.entryThreshold,
      maxEntryPrice: this.config.maxEntryPrice,
      stopLoss: this.config.stopLoss,
      timeWindowMs: this.config.timeWindowMs,
      stopLossDelayMs: this.config.stopLossDelayMs,
      maxSpread: this.config.maxSpread
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

    // Connect WebSocket for real-time prices (market channel is public, no auth needed)
    // Set up connection state tracking
    this.priceStream.onConnectionChange((connected) => {
      this.state.wsConnected = connected;
      if (connected) {
        this.log("WebSocket reconnected");
      } else {
        this.log("WebSocket disconnected, will reconnect...");
      }
    });

    try {
      await this.priceStream.connect();
      this.state.wsConnected = true;
      this.log("WebSocket connected for real-time prices");

      if (this.state.markets.length > 0) {
        await this.subscribeToMarkets(this.state.markets);
      }
    } catch (err) {
      this.log("WebSocket connection failed, using Gamma API");
    }

    // Paper trading mode - skip real trader init
    if (this.config.paperTrading) {
      this.log("PAPER TRADING MODE - Using virtual money");
      this.state.tradingEnabled = true;

      // Load open paper trades from DB
      const openTrades = getOpenTrades();
      for (const trade of openTrades) {
        // Try to parse end date from slug if not stored (btc-updown-15m-TIMESTAMP)
        let marketEndDate: Date;
        if (trade.market_end_date) {
          marketEndDate = new Date(trade.market_end_date);
        } else {
          // Parse timestamp from slug and add 15 minutes
          const match = trade.market_slug.match(/btc-updown-15m-(\d+)/);
          if (match) {
            const startTimestamp = parseInt(match[1]) * 1000;
            marketEndDate = new Date(startTimestamp + 15 * 60 * 1000);
          } else {
            marketEndDate = new Date(0);
          }
        }

        this.state.positions.set(trade.token_id, {
          tradeId: trade.id,
          tokenId: trade.token_id,
          shares: trade.shares,
          entryPrice: trade.entry_price,
          side: trade.side as "UP" | "DOWN",
          marketSlug: trade.market_slug,
          marketEndDate
        });
      }
      if (openTrades.length > 0) {
        // Money is invested in positions, so available balance is 0
        this.state.balance = 0;
        this.log(`Loaded ${openTrades.length} open positions`);
        // Check for any expired positions immediately
        await this.checkExpiredPositions();
      }

      // Log final balance after processing
      this.log(`Available balance: $${this.state.balance.toFixed(2)}`);
    } else {
      // Initialize trader for real trading
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
          // Try to parse end date from slug if not stored (btc-updown-15m-TIMESTAMP)
          let marketEndDate: Date;
          if (trade.market_end_date) {
            marketEndDate = new Date(trade.market_end_date);
          } else {
            // Parse timestamp from slug and add 15 minutes
            const match = trade.market_slug.match(/btc-updown-15m-(\d+)/);
            if (match) {
              const startTimestamp = parseInt(match[1]) * 1000;
              marketEndDate = new Date(startTimestamp + 15 * 60 * 1000);
            } else {
              marketEndDate = new Date(0);
            }
          }

          this.state.positions.set(trade.token_id, {
            tradeId: trade.id,
            tokenId: trade.token_id,
            shares: trade.shares,
            entryPrice: trade.entry_price,
            side: trade.side as "UP" | "DOWN",
            marketSlug: trade.market_slug,
            marketEndDate
          });
        }
        if (openTrades.length > 0) {
          this.log(`Loaded ${openTrades.length} open positions`);
          // Check for any expired positions immediately
          await this.checkExpiredPositions();
        }
      } else {
        this.state.initError = this.trader.getInitError();
        this.log(`Trading disabled: ${this.state.initError}`);
        this.log("Tip: Ensure API keys match your wallet");
      }
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

  private async subscribeToMarkets(markets: Market[]): Promise<void> {
    const tokenIds: string[] = [];
    for (const market of markets) {
      if (market.clobTokenIds) {
        tokenIds.push(...market.clobTokenIds);
      }
    }
    if (tokenIds.length > 0) {
      const beforeCount = this.priceStream.getPriceCount();
      this.priceStream.subscribe(tokenIds);

      // Log subscription status
      if (!this.priceStream.isConnected()) {
        this.log(`Warning: WebSocket not connected, prices may be delayed`);
      } else {
        this.log(`Subscribed to ${tokenIds.length} tokens, waiting for prices...`);

        // Give WebSocket time to receive initial book snapshots
        await new Promise(resolve => setTimeout(resolve, 1500));

        const afterCount = this.priceStream.getPriceCount();
        const newPrices = afterCount - beforeCount;

        if (newPrices > 0) {
          this.log(`Received ${newPrices} new price updates (total: ${afterCount})`);
        } else {
          // Prices are still updating in real-time even if no NEW tokens were added
          this.log(`Tracking ${afterCount} live prices via WebSocket`);
        }
      }
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

      // Only trade if trading is enabled
      if (!this.state.tradingEnabled) {
        return;
      }

      // In paper mode, balance is managed internally
      if (!this.config.paperTrading) {
        this.state.balance = await this.trader.getBalance();
      }

      // Check for limit order fills (profit taking)
      await this.checkLimitOrderFills();

      // Check for expired markets first (close at $0.99)
      await this.checkExpiredPositions();

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

  private async checkLimitOrderFills(): Promise<void> {
    for (const [tokenId, position] of this.state.positions) {
      if (!position.limitOrderId) continue;

      try {
        if (this.config.paperTrading) {
          // Paper trading: check if price hit $0.99
          const wsPrice = this.priceStream.getPrice(tokenId);
          if (wsPrice && wsPrice.bestBid >= PROFIT_TARGET) {
            // Simulate limit order fill at profit target
            const exitPrice = PROFIT_TARGET;
            const proceeds = exitPrice * position.shares;
            const pnl = (exitPrice - position.entryPrice) * position.shares;

            closeTrade(position.tradeId, exitPrice, "RESOLVED");
            this.state.positions.delete(tokenId);
            this.state.balance += proceeds;

            this.log(`[PAPER] Limit order filled @ $${exitPrice.toFixed(2)}! PnL: $${pnl.toFixed(2)}`);
            this.log(`[PAPER] New balance: $${this.state.balance.toFixed(2)}`);
          }
        } else {
          // Real trading: check if order is filled
          const isFilled = await this.trader.isOrderFilled(position.limitOrderId);
          if (isFilled) {
            const exitPrice = PROFIT_TARGET;
            const proceeds = exitPrice * position.shares;
            const pnl = (exitPrice - position.entryPrice) * position.shares;

            closeTrade(position.tradeId, exitPrice, "RESOLVED");
            this.state.positions.delete(tokenId);

            this.log(`Limit order filled @ $${exitPrice.toFixed(2)}! PnL: $${pnl.toFixed(2)}`);
          }
        }
      } catch (err) {
        this.log(`Error checking limit order: ${err}`);
      }
    }
  }

  private async checkExpiredPositions(): Promise<void> {
    const now = new Date();

    for (const [tokenId, position] of this.state.positions) {
      // Check if market has ended
      if (position.marketEndDate.getTime() > 0 && now >= position.marketEndDate) {
        this.log(`Market expired for ${position.side} position`);

        // Exit at $0.99 (assuming win since we entered at >= $0.95 confidence)
        const exitPrice = 0.99;
        const proceeds = exitPrice * position.shares;
        const pnl = (exitPrice - position.entryPrice) * position.shares;

        if (this.config.paperTrading) {
          // Paper trading: add proceeds to balance
          closeTrade(position.tradeId, exitPrice, "RESOLVED");
          this.state.positions.delete(tokenId);
          this.state.balance += proceeds;
          this.log(`[PAPER] Market resolved. Sold ${position.shares.toFixed(2)} shares @ $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}`);
          this.log(`[PAPER] New balance: $${this.state.balance.toFixed(2)}`);
        } else {
          // Real trading: cancel limit order then market sell
          try {
            // Cancel the limit order if it exists
            if (position.limitOrderId) {
              await this.trader.cancelOrder(position.limitOrderId);
              this.log(`Cancelled unfilled limit order`);
            }

            const result = await this.trader.marketSell(tokenId, position.shares);
            if (result) {
              closeTrade(position.tradeId, result.price, "RESOLVED");
              this.state.positions.delete(tokenId);
              const realPnl = (result.price - position.entryPrice) * position.shares;
              this.log(`Market resolved. PnL: $${realPnl.toFixed(2)}`);
            }
          } catch (err) {
            this.log(`Error selling expired position: ${err}`);
          }
        }
      }
    }
  }

  private async checkStopLosses(): Promise<void> {
    const now = Date.now();
    const activeConfig = this.getActiveConfig();

    for (const [tokenId, position] of this.state.positions) {
      try {
        // Use WebSocket price if available, otherwise fall back to REST API
        let currentBid: number;
        const wsPrice = this.priceStream.getPrice(tokenId);
        if (wsPrice && this.state.wsConnected) {
          currentBid = wsPrice.bestBid;
        } else if (!this.config.paperTrading) {
          const { bid } = await this.trader.getPrice(tokenId);
          currentBid = bid;
        } else {
          continue; // Skip if no price available in paper mode
        }

        // Check if price is below stop-loss threshold
        if (currentBid <= activeConfig.stopLoss) {
          // First time triggering? Start the timer
          if (!position.pendingStopLoss) {
            position.pendingStopLoss = {
              triggeredAt: now,
              triggeredPrice: currentBid
            };
            const delaySec = activeConfig.stopLossDelayMs / 1000;
            this.log(`Stop-loss pending for ${position.side} @ $${currentBid.toFixed(2)} (${delaySec}s confirm)`);
            continue;
          }

          // Check if delay has passed
          const elapsed = now - position.pendingStopLoss.triggeredAt;
          if (elapsed >= activeConfig.stopLossDelayMs) {
            // Confirmed - execute stop-loss
            this.log(`Stop-loss CONFIRMED for ${position.side} @ $${currentBid.toFixed(2)} (held ${(elapsed / 1000).toFixed(1)}s)`);

            if (this.config.paperTrading) {
              // Paper trading: simulate sell at bid price
              const exitPrice = currentBid;
              const proceeds = exitPrice * position.shares;
              closeTrade(position.tradeId, exitPrice, "STOPPED");
              this.state.positions.delete(tokenId);
              this.state.balance += proceeds;
              const pnl = (exitPrice - position.entryPrice) * position.shares;
              this.log(`[PAPER] Sold ${position.shares.toFixed(2)} shares @ $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}`);
            } else {
              // Real trading: cancel limit order then market sell
              if (position.limitOrderId) {
                await this.trader.cancelOrder(position.limitOrderId);
                this.log(`Cancelled limit order`);
              }

              const result = await this.trader.marketSell(tokenId, position.shares);
              if (result) {
                closeTrade(position.tradeId, result.price, "STOPPED");
                this.state.positions.delete(tokenId);
                const pnl = (result.price - position.entryPrice) * position.shares;
                this.log(`Closed position. PnL: $${pnl.toFixed(2)}`);
              }
            }
          }
        } else {
          // Price recovered - cancel pending stop-loss
          if (position.pendingStopLoss) {
            this.log(`Stop-loss cancelled for ${position.side} - price recovered to $${currentBid.toFixed(2)}`);
            position.pendingStopLoss = undefined;
          }
        }
      } catch (err) {
        this.log(`Error checking stop-loss: ${err}`);
      }
    }
  }

  private async scanForEntries(): Promise<void> {
    try {
      const activeConfig = this.getActiveConfig();

      // Refresh markets list
      this.state.markets = await fetchBtc15MinMarkets();
      await this.subscribeToMarkets(this.state.markets);

      // Use WebSocket prices if available for more accurate signals
      const priceOverrides = this.getPriceOverrides();
      const eligible = findEligibleMarkets(this.state.markets, {
        entryThreshold: activeConfig.entryThreshold,
        timeWindowMs: activeConfig.timeWindowMs,
        maxEntryPrice: activeConfig.maxEntryPrice,
        maxSpread: activeConfig.maxSpread
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
    const activeConfig = this.getActiveConfig();
    const side = market.eligibleSide!;
    const tokenId = side === "UP" ? market.upTokenId : market.downTokenId;
    const askPrice = side === "UP" ? market.upAsk : market.downAsk;
    const bidPrice = side === "UP" ? market.upBid : market.downBid;

    // Don't buy if price is already at or above profit target
    if (askPrice >= PROFIT_TARGET) {
      this.log(`Skipping: ask $${askPrice.toFixed(2)} >= profit target $${PROFIT_TARGET.toFixed(2)}`);
      return;
    }

    // Don't buy if price is above max entry (ceiling filter)
    if (askPrice > activeConfig.maxEntryPrice) {
      this.log(`Skipping: ask $${askPrice.toFixed(2)} > max entry $${activeConfig.maxEntryPrice.toFixed(2)}`);
      return;
    }

    // Don't buy if spread is too wide (liquidity filter)
    const spread = askPrice - bidPrice;
    if (spread > activeConfig.maxSpread) {
      this.log(`Skipping: spread $${spread.toFixed(2)} > max $${activeConfig.maxSpread.toFixed(2)}`);
      return;
    }

    const modeLabel = this.config.riskMode === "super-risk" ? "[SUPER-RISK] " : "";
    this.log(`${modeLabel}Entry signal: ${side} @ $${askPrice.toFixed(2)} ask (${Math.floor(market.timeRemaining / 1000)}s remaining)`);

    if (this.config.paperTrading) {
      // Paper trading: simulate buy at ask price
      const balance = this.state.balance;
      if (balance < 1) {
        this.log("Insufficient paper balance");
        return;
      }

      // Calculate shares: balance / askPrice
      const shares = balance / askPrice;

      // Record paper trade
      const tradeId = insertTrade({
        market_slug: market.slug,
        token_id: tokenId,
        side,
        entry_price: askPrice,
        shares,
        cost_basis: balance,
        created_at: new Date().toISOString(),
        market_end_date: market.endDate.toISOString()
      });

      this.state.positions.set(tokenId, {
        tradeId,
        tokenId,
        shares,
        entryPrice: askPrice,
        side,
        marketSlug: market.slug,
        marketEndDate: market.endDate,
        limitOrderId: "paper-limit-" + tradeId // Simulated limit order
      });

      // Deduct from paper balance
      this.state.balance = 0;

      this.log(`[PAPER] Bought ${shares.toFixed(2)} shares of ${side} @ $${askPrice.toFixed(2)} ask`);
      this.log(`[PAPER] Placed limit sell @ $${PROFIT_TARGET.toFixed(2)}`);
    } else {
      // Real trading
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

      // Place limit sell order at profit target
      let limitOrderId: string | undefined;
      const limitResult = await this.trader.limitSell(tokenId, result.shares, PROFIT_TARGET);
      if (limitResult) {
        limitOrderId = limitResult.orderId;
        this.log(`Placed limit sell @ $${PROFIT_TARGET.toFixed(2)} (order: ${limitOrderId.slice(0, 8)}...)`);
      } else {
        this.log("Warning: Could not place limit sell order");
      }

      // Record trade
      const tradeId = insertTrade({
        market_slug: market.slug,
        token_id: tokenId,
        side,
        entry_price: askPrice,
        shares: result.shares,
        cost_basis: balance,
        created_at: new Date().toISOString(),
        market_end_date: market.endDate.toISOString()
      });

      this.state.positions.set(tokenId, {
        tradeId,
        tokenId,
        shares: result.shares,
        entryPrice: askPrice,
        side,
        marketSlug: market.slug,
        marketEndDate: market.endDate,
        limitOrderId
      });

      this.log(`Bought ${result.shares.toFixed(2)} shares of ${side} @ $${askPrice.toFixed(2)} ask`);
    }
  }

  getState(): BotState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  async getMarketOverview(): Promise<EligibleMarket[]> {
    const activeConfig = this.getActiveConfig();

    // Only refresh markets periodically (every 30 seconds), not every UI render
    const now = new Date();
    const shouldRefresh = !this.lastMarketRefresh ||
                         (now.getTime() - this.lastMarketRefresh.getTime()) > this.marketRefreshInterval;

    if (shouldRefresh) {
      this.state.markets = await fetchBtc15MinMarkets();
      await this.subscribeToMarkets(this.state.markets);
      this.lastMarketRefresh = now;
    }

    // Use WebSocket prices if available for more accurate display
    const priceOverrides = this.getPriceOverrides();
    return this.state.markets.map(m => analyzeMarket(m, {
      entryThreshold: activeConfig.entryThreshold,
      timeWindowMs: activeConfig.timeWindowMs,
      maxEntryPrice: activeConfig.maxEntryPrice,
      maxSpread: activeConfig.maxSpread
    }, priceOverrides));
  }

  isWsConnected(): boolean {
    return this.state.wsConnected;
  }
}
