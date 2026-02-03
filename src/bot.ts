import { Trader, type SignatureType, MIN_ORDER_SIZE } from "./trader";
import { findEligibleMarkets, fetchBtc15MinMarkets, analyzeMarket, fetchMarketResolution, type EligibleMarket, type Market, type PriceOverride } from "./scanner";
import { insertTrade, closeTrade, getOpenTrades, getLastClosedTrade, getLastWinningTradeInMarket, insertLog, markAsLadderTrade, updateLadderState, getTradeById, updateTradeShares, getLadderMarketLocks, setLadderMarketLock, clearLadderMarketLock, type Trade, type LogLevel } from "./db";
import { getPriceStream, UserStream, type MarketEvent, type PriceStream, type UserOrderEvent, type UserTradeEvent } from "./websocket";
import { type ConfigManager, type ConfigChangeEvent, type BotConfig, type LadderModeConfig, type LadderStep } from "./config";

export type { RiskMode, BotConfig } from "./config";
export type { LadderState };

export interface Position {
  tradeId: number;
  tokenId: string;
  shares: number;
  entryPrice: number;
  side: "UP" | "DOWN";
  marketSlug: string;
  marketEndDate: Date;
  // No limit orders - using WebSocket monitoring for profit target and stop-loss
  // Ladder mode fields
  isLadder?: boolean;
}

// Ladder state tracking for multi-step trading
export interface LadderState {
  tokenId: string;
  side: "UP" | "DOWN";
  marketSlug: string;
  marketEndDate: Date;

  // Progress tracking
  currentStepIndex: number;      // Which step we're waiting for
  currentStepPhase: "buy" | "sell"; // Which side of the step we're waiting for
  completedSteps: string[];      // IDs of completed steps
  skippedSteps: string[];        // IDs of skipped steps (with reasons)
  skippedReasons: Map<string, string>; // stepId -> reason

  // Position aggregation
  totalShares: number;           // Accumulated shares from all buys
  totalCostBasis: number;        // Total USDC spent
  averageEntryPrice: number;     // Weighted average
  totalSharesSold: number;       // Shares sold so far
  totalSellProceeds: number;     // USDC received from sells

  // Timing
  ladderStartTime: number;
  lastStepTime: number;
  lastStepPrice: number;

  // Database tracking
  tradeIds: number[];            // All trade IDs created for this ladder

  // Recovery tracking (after stop-loss reset)
  needsRecovery: boolean;        // If true, wait for price to rise above first trigger before re-entering

  status: "active" | "completed" | "stopped";
}

export interface BotState {
  running: boolean;
  balance: number;
  reservedBalance: number;  // Balance reserved for in-flight orders (prevents overspend)
  savedProfit: number;  // Profit taken out via compound limit
  positions: Map<string, Position>;
  pendingEntries: Set<string>;  // Tokens with in-flight entry orders (prevents race conditions)
  pendingExits: Set<string>;    // Tokens with in-flight exit orders (prevents double sells)
  lastScan: Date | null;
  logs: string[];
  tradingEnabled: boolean;
  initError: string | null;
  wsConnected: boolean;
  userWsConnected: boolean;
  markets: Market[];
  paperTrading: boolean;
  // Market resolutions from WebSocket (slug -> winning token ID)
  marketResolutions: Map<string, string>;
  // Ladder mode state tracking (tokenId -> LadderState)
  ladderStates: Map<string, LadderState>;
  // Locked markets where ladder completed (marketSlug set)
  ladderMarketLocks: Set<string>;
}

export interface WsStats {
  marketConnected: boolean;
  marketLastMessageAt: number;
  marketSubscriptionCount: number;
  marketPriceCount: number;
  userConnected: boolean;
  userLastMessageAt: number;
  userMarketCount: number;
  priceMaxAgeMs: number;
}

export type LogCallback = (message: string) => void;

// Memory limits
// Increased from 100 to 500 to reduce risk of missing profit exits
const MAX_LIMIT_FILLS_CACHE = 500;

export class Bot {
  private trader: Trader;
  private config: BotConfig;
  private configManager: ConfigManager;
  private state: BotState;
  private interval: Timer | null = null;
  private onLog: LogCallback;
  private priceStream: PriceStream;
  private userStream: UserStream | null = null;
  private wsLimitFills: Map<string, { filledShares: number; avgPrice: number; timestamp: number }> = new Map();
  private pendingLimitFills: Set<string> = new Set();
  private lastMarketRefresh: Date | null = null;

  constructor(privateKey: string, configManager: ConfigManager, onLog: LogCallback = console.log) {
    this.configManager = configManager;
    this.config = configManager.toBotConfig();
    this.trader = new Trader(privateKey, this.config.signatureType, this.config.funderAddress);
    this.onLog = onLog;
    this.priceStream = getPriceStream();
    this.state = {
      running: false,
      balance: this.config.paperTrading ? this.config.paperBalance : 0,
      reservedBalance: 0,
      savedProfit: 0,
      positions: new Map(),
      pendingEntries: new Set(),
      pendingExits: new Set(),
      lastScan: null,
      logs: [],
      tradingEnabled: false,
      initError: null,
      wsConnected: false,
      userWsConnected: false,
      markets: [],
      paperTrading: this.config.paperTrading,
      marketResolutions: new Map(),
      ladderStates: new Map(),
      ladderMarketLocks: new Set()
    };

    // Subscribe to config changes for hot-reload
    this.configManager.onConfigChange((event) => this.handleConfigChange(event));
  }

  /**
   * Handle configuration changes (hot-reload)
   */
  private handleConfigChange(event: ConfigChangeEvent): void {
    const prevConfig = this.config;
    this.config = this.configManager.toBotConfig();

    // Check for changes that require special handling
    const requiresRestart = event.changedPaths.some(path =>
      path.startsWith("trading.paperTrading") ||
      path.startsWith("wallet.signatureType") ||
      path.startsWith("wallet.funderAddress")
    );

    if (requiresRestart) {
      this.log("[CONFIG] Changed setting requires restart to take effect");
    }

    // Handle paperBalance changes in paper trading mode
    if (event.changedPaths.includes("trading.paperBalance") && this.config.paperTrading) {
      if (this.state.positions.size === 0) {
        this.state.balance = this.config.paperBalance;
        this.log(`[CONFIG] Paper balance updated to $${this.config.paperBalance.toFixed(2)}`);
      } else {
        this.log(`[CONFIG] Paper balance change ignored (${this.state.positions.size} open positions)`);
      }
    }

    // Handle pollIntervalMs changes - restart the interval
    if (event.changedPaths.includes("trading.pollIntervalMs") && this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => this.tick(), this.config.pollIntervalMs);
      this.log(`[CONFIG] Poll interval changed to ${this.config.pollIntervalMs}ms`);
    }

    // Log mode changes
    if (event.changedPaths.includes("activeMode")) {
      this.log(`[CONFIG] Mode changed: ${prevConfig.riskMode} -> ${this.config.riskMode}`);
    }

    // Log threshold changes for current mode
    const thresholdChanges = event.changedPaths.filter(p =>
      p.includes("entryThreshold") || p.includes("stopLoss") || p.includes("maxEntryPrice")
    );
    if (thresholdChanges.length > 0) {
      const mode = this.configManager.getActiveMode();
      if (this.configManager.isLadderMode()) {
        this.log(`[CONFIG] Updated: entry=$${mode.entryThreshold.toFixed(2)}, stop=per-step`);
      } else {
        this.log(`[CONFIG] Updated: entry=$${mode.entryThreshold.toFixed(2)}, stop=$${mode.stopLoss.toFixed(2)}`);
      }
    }
  }

  private parseMarketEndDate(trade: Trade): Date {
    if (trade.market_end_date) {
      return new Date(trade.market_end_date);
    }
    const match = trade.market_slug.match(/btc-updown-15m-(\d+)/);
    if (match) {
      const startTimestamp = parseInt(match[1]) * 1000;
      return new Date(startTimestamp + 15 * 60 * 1000);
    }
    return new Date(0);
  }

  /**
   * Get profit target from config
   */
  private getProfitTarget(): number {
    return this.configManager.getProfitTarget();
  }

  /**
   * Get paper fee rate from config
   */
  private getPaperFeeRate(): number {
    return this.configManager.getAdvanced().paperFeeRate;
  }

  /**
   * Get WebSocket price max age from config
   */
  private getWsPriceMaxAgeMs(): number {
    return this.configManager.getAdvanced().wsPriceMaxAgeMs;
  }

  /**
   * Get market refresh interval from config
   */
  private getMarketRefreshInterval(): number {
    return this.configManager.getAdvanced().marketRefreshInterval;
  }

  /**
   * Get active trading config based on risk mode
   * Parameters are loaded from config file, supporting custom modes
   */
  private getActiveConfig() {
    const mode = this.configManager.getActiveMode();

    return {
      entryThreshold: mode.entryThreshold,
      maxEntryPrice: mode.maxEntryPrice,
      stopLoss: mode.stopLoss,
      timeWindowMs: mode.timeWindowMs,
      maxSpread: mode.maxSpread
    };
  }

  /**
   * Check if current mode is ladder mode
   */
  private isLadderMode(): boolean {
    return this.configManager.isLadderMode();
  }

  /**
   * Get the ladder mode config (returns null if not in ladder mode)
   */
  private getLadderConfig(): LadderModeConfig | null {
    return this.configManager.getLadderMode();
  }

  private loadLadderMarketLocks(): void {
    const locks = getLadderMarketLocks();
    this.state.ladderMarketLocks = new Set(locks);
    if (locks.length > 0) {
      this.log(`[LADDER] Loaded ${locks.length} locked market(s)`);
    }
  }

  private isLadderMarketLocked(marketSlug: string): boolean {
    return this.state.ladderMarketLocks.has(marketSlug);
  }

  private lockLadderMarket(marketSlug: string): void {
    if (this.state.ladderMarketLocks.has(marketSlug)) return;
    setLadderMarketLock(marketSlug);
    this.state.ladderMarketLocks.add(marketSlug);
    this.log(`[LADDER] Market locked after ladder completion`, { marketSlug });
  }

  private clearLadderMarketLock(marketSlug: string, reason: string): void {
    if (!this.state.ladderMarketLocks.has(marketSlug)) return;
    clearLadderMarketLock(marketSlug);
    this.state.ladderMarketLocks.delete(marketSlug);
    this.log(`[LADDER] Market lock cleared (${reason})`, { marketSlug });
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

    // Load persisted ladder market locks (prevents re-entry after completion)
    this.loadLadderMarketLocks();

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

    // Real-time price monitoring via WebSocket
    // Note: Using async callback to properly await mutex-protected operations
    this.priceStream.onPrice(async (update) => {
      // Check if we're in ladder mode
      if (this.isLadderMode()) {
        // Ladder mode: check ladder steps for this token
        await this.checkLadderStepRealtime(update.tokenId, update.bestBid, update.bestAsk);
        // Still check stop-loss for non-ladder positions
        const ladderState = this.state.ladderStates.get(update.tokenId);
        if (!ladderState) {
          await this.checkStopLossRealtime(update.tokenId, update.bestBid);
        }
        // Real-time entry check for new ladder positions
        await this.checkEntryRealtime(update.tokenId, update.bestBid, update.bestAsk);
      } else {
        // Normal mode: existing behavior
        // Real-time stop-loss check (await to prevent race conditions)
        await this.checkStopLossRealtime(update.tokenId, update.bestBid);
        // Real-time profit target check (await to prevent race conditions)
        await this.checkProfitTargetRealtime(update.tokenId, update.bestBid);
        // Real-time entry check (await to prevent race conditions)
        await this.checkEntryRealtime(update.tokenId, update.bestBid, update.bestAsk);
      }
    });

    this.priceStream.onMarketEvent((event) => {
      this.handleMarketEvent(event);
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
      const ladderStates = this.restoreLadderStates(openTrades);
      this.state.ladderStates = ladderStates;

      for (const trade of openTrades) {
        if (trade.is_ladder_trade) continue;
        if (this.state.positions.has(trade.token_id)) continue;
        this.state.positions.set(trade.token_id, {
          tradeId: trade.id,
          tokenId: trade.token_id,
          shares: trade.shares,
          entryPrice: trade.entry_price,
          side: trade.side as "UP" | "DOWN",
          marketSlug: trade.market_slug,
          marketEndDate: this.parseMarketEndDate(trade)
        });
      }

      for (const ladderState of ladderStates.values()) {
        const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
        if (remainingShares < 0.01) continue;
        const tradeId = ladderState.tradeIds.length > 0 ? ladderState.tradeIds[ladderState.tradeIds.length - 1] : 0;
        this.state.positions.set(ladderState.tokenId, {
          tradeId,
          tokenId: ladderState.tokenId,
          shares: remainingShares,
          entryPrice: ladderState.averageEntryPrice,
          side: ladderState.side,
          marketSlug: ladderState.marketSlug,
          marketEndDate: ladderState.marketEndDate,
          isLadder: true
        });
      }

      if (openTrades.length > 0) {
        // Money is invested in positions, so available balance is 0
        this.state.balance = 0;
        this.log(`Loaded ${openTrades.length} open positions`);
        // Check for any expired positions immediately
        await this.checkExpiredPositions();

        // CRITICAL: Subscribe position tokens to WebSocket for real-time stop-loss monitoring
        if (this.priceStream.isConnected()) {
          const positionTokenIds = [...this.state.positions.keys()];
          this.priceStream.subscribe(positionTokenIds);
          this.log(`Subscribed to ${positionTokenIds.length} position token(s) for stop-loss monitoring`);
        }
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
        const balance = await this.trader.getBalance();
        if (balance === null) {
          this.state.initError = "Failed to fetch wallet balance - check API connection";
          this.state.tradingEnabled = false;
          this.log("Trading disabled: API error fetching balance");
          return;
        }
        this.state.balance = balance;
        this.log(`Balance: $${this.state.balance.toFixed(2)} USDC`);
        await this.initUserStream();

        // Load open trades from DB and verify they still exist on Polymarket
        const openTrades = getOpenTrades();
        const ladderStates = this.restoreLadderStates(openTrades);
        this.state.ladderStates = ladderStates;

        const ladderTradesByToken = new Map<string, Trade[]>();
        const normalTrades: Trade[] = [];
        for (const trade of openTrades) {
          if (trade.is_ladder_trade) {
            if (!ladderTradesByToken.has(trade.token_id)) {
              ladderTradesByToken.set(trade.token_id, []);
            }
            ladderTradesByToken.get(trade.token_id)!.push(trade);
          } else {
            normalTrades.push(trade);
          }
        }

        for (const trade of normalTrades) {
          if (this.state.positions.has(trade.token_id)) continue;
          // Verify position actually exists on Polymarket
          // Retry up to 3 times to distinguish API errors from actual 0 balance
          let actualBalance: number | null = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            actualBalance = await this.trader.getPositionBalance(trade.token_id);
            if (actualBalance !== null) break;
            this.log(`Position check failed (attempt ${attempt}/3), retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          // API error after all retries - keep position in DB, don't close
          if (actualBalance === null) {
            this.log(`Warning: Cannot verify position ${trade.side} - keeping in DB (API error)`);
            this.state.positions.set(trade.token_id, {
              tradeId: trade.id,
              tokenId: trade.token_id,
              shares: trade.shares, // Use DB value since API failed
              entryPrice: trade.entry_price,
              side: trade.side as "UP" | "DOWN",
              marketSlug: trade.market_slug,
              marketEndDate: this.parseMarketEndDate(trade)
            });
            continue;
          }

          if (actualBalance < 0.01) {
            // Position doesn't exist - was sold manually or resolved
            this.log(`Closing stale DB position: ${trade.side} (no shares on Polymarket)`);
            closeTrade(trade.id, 0.99, "RESOLVED"); // Assume resolved at profit
            continue;
          }

          // Use actual balance from Polymarket, not DB value
          this.state.positions.set(trade.token_id, {
            tradeId: trade.id,
            tokenId: trade.token_id,
            shares: actualBalance, // Use real balance
            entryPrice: trade.entry_price,
            side: trade.side as "UP" | "DOWN",
            marketSlug: trade.market_slug,
            marketEndDate: this.parseMarketEndDate(trade)
          });

          this.log(`Loaded position: ${trade.side} with ${actualBalance.toFixed(2)} shares`);
        }

        for (const [tokenId, trades] of ladderTradesByToken.entries()) {
          // Verify ladder position once per token
          let actualBalance: number | null = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            actualBalance = await this.trader.getPositionBalance(tokenId);
            if (actualBalance !== null) break;
            this.log(`Ladder position check failed (attempt ${attempt}/3), retrying...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          if (actualBalance === null) {
            this.log(`Warning: Cannot verify ladder position ${tokenId} - keeping in DB (API error)`);
          } else if (actualBalance < 0.01) {
            this.log(`Closing stale ladder position (no shares on Polymarket): ${tokenId}`);
            for (const trade of trades) {
              closeTrade(trade.id, 0.99, "RESOLVED");
            }
            this.state.ladderStates.delete(tokenId);
            continue;
          }

          const ladderState = this.state.ladderStates.get(tokenId);
          if (ladderState) {
            if (actualBalance !== null && Math.abs((ladderState.totalShares - ladderState.totalSharesSold) - actualBalance) > 0.01) {
              this.log(`[LADDER] Adjusted ladder shares to match actual balance (${actualBalance.toFixed(2)})`, {
                marketSlug: ladderState.marketSlug,
                tokenId
              });
              ladderState.totalShares = ladderState.totalSharesSold + actualBalance;
              ladderState.averageEntryPrice = ladderState.totalShares > 0 ? ladderState.totalCostBasis / ladderState.totalShares : 0;
              this.persistLadderState(ladderState);
            }

            const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
            if (remainingShares >= 0.01) {
              const tradeId = ladderState.tradeIds.length > 0 ? ladderState.tradeIds[ladderState.tradeIds.length - 1] : trades[0].id;
              this.state.positions.set(tokenId, {
                tradeId,
                tokenId,
                shares: actualBalance !== null ? actualBalance : remainingShares,
                entryPrice: ladderState.averageEntryPrice,
                side: ladderState.side,
                marketSlug: ladderState.marketSlug,
                marketEndDate: ladderState.marketEndDate,
                isLadder: true
              });
            }
          }
        }

        if (this.state.positions.size > 0) {
          // Check for any expired positions immediately
          await this.checkExpiredPositions();

          // CRITICAL: Subscribe position tokens to WebSocket for real-time stop-loss monitoring
          // Markets may no longer be in state.markets if they're closed/expired
          if (this.priceStream.isConnected()) {
            const positionTokenIds = [...this.state.positions.keys()];
            this.priceStream.subscribe(positionTokenIds);
            this.log(`Subscribed to ${positionTokenIds.length} position token(s) for stop-loss monitoring`);
          }
        }
      } else {
        this.state.initError = this.trader.getInitError();
        this.log(`Trading disabled: ${this.state.initError}`);
        this.log("Tip: Ensure API keys match your wallet");
      }
    }
  }

  private async initUserStream(): Promise<void> {
    if (this.config.paperTrading) return;

    const creds = this.trader.getApiCreds();
    if (!creds) {
      this.log("User WebSocket unavailable (missing API creds)");
      return;
    }

    this.userStream = new UserStream();
    this.userStream.onConnectionChange((connected) => {
      this.state.userWsConnected = connected;
      if (connected) {
        this.log("User WebSocket connected");
      } else {
        this.log("User WebSocket disconnected, will reconnect...");
      }
    });
    this.userStream.onTrade((event) => {
      this.handleUserTrade(event);
    });
    this.userStream.onOrder((event) => {
      this.handleUserOrder(event);
    });

    try {
      const marketIds = this.state.markets.map(m => m.id).filter(Boolean);
      await this.userStream.connect({
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase
      }, marketIds);
      this.state.userWsConnected = true;
    } catch {
      this.log("User WebSocket connection failed");
    }
  }

  private log(message: string, context?: { marketSlug?: string; tokenId?: string; tradeId?: number }): void {
    const timestamp = new Date().toLocaleTimeString();
    const formatted = `[${timestamp}] ${message}`;
    this.state.logs.push(formatted);
    if (this.state.logs.length > 100) {
      this.state.logs.shift();
    }
    this.onLog(formatted);

    // Persist to database with parsed context
    const logEntry = this.parseLogMessage(message, context);
    insertLog(logEntry);
  }

  /**
   * Parse log message to extract level, market, and token info
   */
  private parseLogMessage(message: string, context?: { marketSlug?: string; tokenId?: string; tradeId?: number }): {
    message: string;
    level: LogLevel;
    marketSlug?: string;
    tokenId?: string;
    tradeId?: number;
  } {
    let level: LogLevel = "INFO";

    // Detect log level from message prefixes
    if (message.startsWith("[WS]")) {
      level = "WS";
    } else if (message.startsWith("[PAPER]")) {
      level = "TRADE";
    } else if (message.startsWith("[STOP-LOSS]") || message.includes("Stop-loss")) {
      level = "TRADE";
    } else if (message.startsWith("[CONFIG]")) {
      level = "INFO";
    } else if (message.includes("Entry signal") || message.includes("Skipping:")) {
      level = "SIGNAL";
    } else if (message.includes("Bought") || message.includes("Sold") || message.includes("Order") || message.includes("PnL:")) {
      level = "TRADE";
    } else if (message.includes("Error") || message.includes("error") || message.includes("CRITICAL") || message.includes("Failed")) {
      level = "ERROR";
    } else if (message.includes("Warning") || message.includes("warning") || message.includes("WARNING")) {
      level = "WARN";
    }

    // Extract market slug from message if not provided in context
    let marketSlug = context?.marketSlug;
    if (!marketSlug) {
      // Try to extract market slug patterns like "btc-updown-15m-*"
      const marketMatch = message.match(/(btc-updown-15m-\d+)/);
      if (marketMatch) {
        marketSlug = marketMatch[1];
      }
    }

    // Extract token ID from message if not provided (look for hex-like strings)
    let tokenId = context?.tokenId;
    if (!tokenId) {
      // Token IDs are typically long numeric strings
      const tokenMatch = message.match(/token[:\s]+(\d{10,})/i);
      if (tokenMatch) {
        tokenId = tokenMatch[1];
      }
    }

    return {
      message,
      level,
      marketSlug,
      tokenId,
      tradeId: context?.tradeId
    };
  }

  /**
   * Get available balance (total balance minus reserved for in-flight orders)
   * This prevents multiple concurrent signals from overspending
   */
  private getAvailableBalance(): number {
    return Math.max(0, this.state.balance - this.state.reservedBalance);
  }

  private serializeLadderState(ladderState: LadderState): string {
    return JSON.stringify({
      ...ladderState,
      marketEndDate: ladderState.marketEndDate.toISOString(),
      skippedReasons: Object.fromEntries(ladderState.skippedReasons)
    });
  }

  private persistLadderState(ladderState: LadderState): void {
    if (ladderState.tradeIds.length === 0) {
      return;
    }
    const stateJson = this.serializeLadderState(ladderState);
    for (const tradeId of ladderState.tradeIds) {
      updateLadderState(tradeId, stateJson);
    }
  }

  private restoreLadderStates(openTrades: Trade[]): Map<string, LadderState> {
    const ladderStates = new Map<string, LadderState>();
    const ladderTradesByToken = new Map<string, Trade[]>();

    for (const trade of openTrades) {
      if (!trade.is_ladder_trade) continue;
      if (!ladderTradesByToken.has(trade.token_id)) {
        ladderTradesByToken.set(trade.token_id, []);
      }
      ladderTradesByToken.get(trade.token_id)!.push(trade);
    }

    for (const [tokenId, trades] of ladderTradesByToken.entries()) {
      const sortedTrades = [...trades].sort((a, b) => {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      const tradeWithState = trades.find(t => t.ladder_state_json && t.ladder_state_json.length > 0);
      if (tradeWithState && tradeWithState.ladder_state_json) {
        try {
          const raw = JSON.parse(tradeWithState.ladder_state_json);
          const skippedReasons = new Map<string, string>(Object.entries(raw.skippedReasons || {}));
          const marketEndDate = raw.marketEndDate ? new Date(raw.marketEndDate) : this.parseMarketEndDate(tradeWithState);
          const ladderState: LadderState = {
            tokenId,
            side: raw.side,
            marketSlug: raw.marketSlug,
            marketEndDate,
            currentStepIndex: raw.currentStepIndex ?? 0,
            currentStepPhase: raw.currentStepPhase ?? "buy",
            completedSteps: Array.isArray(raw.completedSteps) ? raw.completedSteps : [],
            skippedSteps: Array.isArray(raw.skippedSteps) ? raw.skippedSteps : [],
            skippedReasons,
            totalShares: raw.totalShares ?? 0,
            totalCostBasis: raw.totalCostBasis ?? 0,
            averageEntryPrice: raw.averageEntryPrice ?? 0,
            totalSharesSold: raw.totalSharesSold ?? 0,
            totalSellProceeds: raw.totalSellProceeds ?? 0,
            ladderStartTime: raw.ladderStartTime ?? Date.now(),
            lastStepTime: raw.lastStepTime ?? Date.now(),
            lastStepPrice: raw.lastStepPrice ?? 0,
            tradeIds: sortedTrades.map(t => t.id),
            needsRecovery: raw.needsRecovery ?? false,
            status: raw.status ?? "active"
          };
          ladderStates.set(tokenId, ladderState);
          continue;
        } catch (err) {
          this.log(`[LADDER] Failed to restore ladder state for ${tokenId}, rebuilding from trades: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Fallback: rebuild a minimal ladder state from open trades
      const totalShares = sortedTrades.reduce((sum, trade) => sum + trade.shares, 0);
      const totalCostBasis = sortedTrades.reduce((sum, trade) => sum + trade.cost_basis, 0);
      const averageEntryPrice = totalShares > 0 ? totalCostBasis / totalShares : 0;
      const fallbackState: LadderState = {
        tokenId,
        side: sortedTrades[0].side as "UP" | "DOWN",
        marketSlug: sortedTrades[0].market_slug,
        marketEndDate: this.parseMarketEndDate(sortedTrades[0]),
        currentStepIndex: 0,
        currentStepPhase: "buy",
        completedSteps: [],
        skippedSteps: [],
        skippedReasons: new Map(),
        totalShares,
        totalCostBasis,
        averageEntryPrice,
        totalSharesSold: 0,
        totalSellProceeds: 0,
        ladderStartTime: Date.now(),
        lastStepTime: Date.now(),
        lastStepPrice: 0,
        tradeIds: sortedTrades.map(t => t.id),
        needsRecovery: false,
        status: "active"
      };
      this.log(`[LADDER] Rebuilt ladder state from open trades for ${tokenId} (missing persisted state)`);
      ladderStates.set(tokenId, fallbackState);
    }

    return ladderStates;
  }

  private closeLadderTradesForSell(
    ladderState: LadderState,
    sellShares: number,
    exitPrice: number,
    status: "STOPPED" | "RESOLVED",
    stepId: string
  ): void {
    const epsilon = 0.0001;
    let remainingToSell = sellShares;
    const remainingOpenTradeIds: number[] = [];

    for (const tradeId of ladderState.tradeIds) {
      const trade = getTradeById(tradeId);
      if (!trade || trade.status !== "OPEN") {
        continue;
      }

      if (remainingToSell <= 0) {
        remainingOpenTradeIds.push(tradeId);
        continue;
      }

      if (trade.shares <= remainingToSell + epsilon) {
        closeTrade(tradeId, exitPrice, status);
        remainingToSell -= trade.shares;
        continue;
      }

      const costBasisPerShare = trade.shares > 0 ? trade.cost_basis / trade.shares : 0;
      const remainingShares = trade.shares - remainingToSell;
      const remainingCostBasis = costBasisPerShare * remainingShares;
      updateTradeShares(tradeId, remainingShares, remainingCostBasis);

      const soldCostBasis = costBasisPerShare * remainingToSell;
      const soldTradeId = insertTrade({
        market_slug: trade.market_slug,
        token_id: trade.token_id,
        side: trade.side as "UP" | "DOWN",
        entry_price: trade.entry_price,
        shares: remainingToSell,
        cost_basis: soldCostBasis,
        created_at: trade.created_at,
        market_end_date: trade.market_end_date || ladderState.marketEndDate.toISOString()
      });
      markAsLadderTrade(soldTradeId, stepId);
      closeTrade(soldTradeId, exitPrice, status);

      remainingToSell = 0;
      remainingOpenTradeIds.push(tradeId);
    }

    ladderState.tradeIds = remainingOpenTradeIds;

    if (remainingToSell > 0.01) {
      this.log(`[LADDER] Warning: attempted to sell ${sellShares.toFixed(2)} shares but only sold ${(sellShares - remainingToSell).toFixed(2)}`, {
        marketSlug: ladderState.marketSlug,
        tokenId: ladderState.tokenId
      });
    }
  }

  private closeAllOpenLadderTrades(
    ladderState: LadderState,
    exitPrice: number,
    status: "STOPPED" | "RESOLVED"
  ): void {
    for (const tradeId of ladderState.tradeIds) {
      const trade = getTradeById(tradeId);
      if (!trade || trade.status !== "OPEN") continue;
      closeTrade(tradeId, exitPrice, status);
    }
    ladderState.tradeIds = [];
  }

  private getOpenLadderShares(ladderState: LadderState): number {
    let total = 0;
    for (const tradeId of ladderState.tradeIds) {
      const trade = getTradeById(tradeId);
      if (!trade || trade.status !== "OPEN") continue;
      total += trade.shares;
    }
    return total;
  }

  private handleMarketEvent(event: MarketEvent): void {
    let slug = event.slug;
    if (!slug && event.marketId) {
      const match = this.state.markets.find(m => m.id === event.marketId);
      if (match) {
        slug = match.slug;
      }
    }
    if (!slug) return;
    if (!slug.startsWith("btc-updown-15m-")) return;

    const eventType = event.eventType.toLowerCase();
    if (eventType === "market_resolved" || event.winningAssetId) {
      const match = this.state.markets.find(m => m.slug === slug || (event.marketId && m.id === event.marketId));
      if (match && !match.closed) {
        match.closed = true;
        // Store winning asset ID for position resolution
        if (event.winningAssetId) {
          this.state.marketResolutions.set(slug, event.winningAssetId);
          this.log(`[WS] Market resolved: ${slug} (winner: ${event.winningAssetId.slice(0, 8)}...)`);
        } else {
          this.log(`[WS] Market resolved: ${slug}`);
        }
      }
      return;
    }

    if (eventType === "new_market") {
      if (!event.assetsIds || event.assetsIds.length < 2) return;
      if (this.state.markets.some(m => m.slug === slug)) return;

      const match = slug.match(/btc-updown-15m-(\d+)/);
      if (!match) return;

      const startTimestamp = parseInt(match[1], 10) * 1000;
      const endDate = new Date(startTimestamp + 15 * 60 * 1000).toISOString();
      const outcomes = event.outcomes && event.outcomes.length >= 2 ? event.outcomes : ["Up", "Down"];

      const market: Market = {
        id: event.id || event.marketId || slug,
        slug,
        question: event.question || slug,
        endDate,
        outcomes,
        outcomePrices: [],
        clobTokenIds: event.assetsIds,
        active: true,
        closed: false
      };

      this.state.markets.push(market);
      this.state.markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
      this.log(`[WS] New BTC 15m market: ${slug}`);
      this.subscribeToMarkets([market]).catch((err) => {
        this.log(`Error subscribing to new market: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  private findPositionByLimitOrderId(orderId: string): Position | null {
    for (const position of this.state.positions.values()) {
      if (position.limitOrderId === orderId) {
        return position;
      }
    }
    return null;
  }

  private getWsLimitFill(orderId: string, requiredShares: number): { filledShares: number; avgPrice: number } | null {
    const fill = this.wsLimitFills.get(orderId);
    if (!fill) return null;
    return fill.filledShares >= requiredShares * 0.99 ? fill : null;
  }

  private recordWsLimitFill(orderId: string, matchedShares: number, price: number): void {
    if (!orderId || !Number.isFinite(matchedShares) || !Number.isFinite(price) || matchedShares <= 0 || price <= 0) return;

    const position = this.findPositionByLimitOrderId(orderId);
    if (!position) return;

    const existing = this.wsLimitFills.get(orderId);
    const prevShares = existing?.filledShares || 0;
    const totalShares = prevShares + matchedShares;
    const avgPrice = existing
      ? (existing.avgPrice * prevShares + price * matchedShares) / totalShares
      : price;

    // Enforce memory limit - clean up old entries
    if (this.wsLimitFills.size >= MAX_LIMIT_FILLS_CACHE && !existing) {
      this.cleanupOldLimitFills();
    }

    this.wsLimitFills.set(orderId, { filledShares: totalShares, avgPrice, timestamp: Date.now() });

    if (totalShares >= position.shares * 0.99) {
      this.wsLimitFills.delete(orderId);
      this.processLimitFill(position, avgPrice, "WS").catch((err) => {
        this.log(`Error processing limit fill: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /**
   * Clean up old limit fill entries (older than 1 hour)
   */
  private cleanupOldLimitFills(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [orderId, fill] of this.wsLimitFills) {
      if (fill.timestamp < oneHourAgo) {
        this.wsLimitFills.delete(orderId);
      }
    }
  }

  private async processLimitFill(position: Position, exitPrice: number, source: "WS" | "REST"): Promise<void> {
    if (this.pendingLimitFills.has(position.tokenId)) return;
    const current = this.state.positions.get(position.tokenId);
    if (!current) return;

    this.pendingLimitFills.add(position.tokenId);
    try {
      const pnl = (exitPrice - current.entryPrice) * current.shares;
      closeTrade(current.tradeId, exitPrice, "RESOLVED");
      this.state.positions.delete(position.tokenId);
      if (current.limitOrderId) {
        this.wsLimitFills.delete(current.limitOrderId);
      }

      this.log(`[${source}] Limit order filled @ $${exitPrice.toFixed(2)}! PnL: $${pnl.toFixed(2)}`, {
        marketSlug: current.marketSlug,
        tokenId: current.tokenId,
        tradeId: current.tradeId
      });
      const newBalance = await this.trader.getBalance();
      if (newBalance !== null) {
        this.state.balance = newBalance;
      }
    } finally {
      this.pendingLimitFills.delete(position.tokenId);
    }
  }

  private handleUserTrade(event: UserTradeEvent): void {
    if (this.config.paperTrading) return;

    if (Array.isArray(event.maker_orders)) {
      for (const maker of event.maker_orders) {
        const orderId = maker.order_id;
        const matchedShares = parseFloat(maker.matched_amount || "0");
        const price = parseFloat(maker.price || event.price || "0");
        this.recordWsLimitFill(orderId || "", matchedShares, price);
      }
    }

    if (event.taker_order_id) {
      const matchedShares = parseFloat(event.size || "0");
      const price = parseFloat(event.price || "0");
      this.recordWsLimitFill(event.taker_order_id, matchedShares, price);
    }
  }

  private handleUserOrder(event: UserOrderEvent): void {
    if (this.config.paperTrading) return;

    const orderId = event.id;
    if (!orderId) return;

    const position = this.findPositionByLimitOrderId(orderId);
    if (!position) return;

    const sizeMatched = parseFloat(event.size_matched || "0");
    const originalSize = parseFloat(event.original_size || "0");
    const status = (event.status || "").toUpperCase();
    const filled = status === "MATCHED" || (originalSize > 0 && sizeMatched >= originalSize);

    if (filled) {
      const price = parseFloat(event.price || "0") || this.getProfitTarget();
      this.processLimitFill(position, price, "WS").catch((err) => {
        this.log(`Error processing order fill: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /**
   * Check if balance exceeds compound limit and take profit if so
   * For PAPER trading: Resets trading balance to base and saves the profit
   */
  private checkCompoundLimit(): void {
    const { compoundLimit, baseBalance } = this.config;

    // Skip if compound limit is disabled (0 or not set)
    if (!compoundLimit || compoundLimit <= 0) return;

    // Check if balance exceeds the limit
    if (this.state.balance > compoundLimit) {
      const profit = this.state.balance - baseBalance;
      this.state.savedProfit += profit;
      this.state.balance = baseBalance;

      this.log(`COMPOUND LIMIT: Saved $${profit.toFixed(2)} profit (total saved: $${this.state.savedProfit.toFixed(2)})`);
      this.log(`Reset balance to $${baseBalance.toFixed(2)}`);
    }
  }

  /**
   * Apply compound limit for REAL trading
   * Tracks saved profit but money stays in wallet - we just limit trading amount
   */
  private applyCompoundLimit(walletBalance: number): void {
    const { compoundLimit, baseBalance } = this.config;

    // Skip if compound limit is disabled (0 or not set)
    if (!compoundLimit || compoundLimit <= 0) {
      this.state.balance = walletBalance;
      return;
    }

    // If wallet balance exceeds compound limit
    if (walletBalance > compoundLimit) {
      // Calculate how much is "saved" (not for trading)
      const newSavedProfit = walletBalance - baseBalance;

      // Only log when savedProfit increases
      if (newSavedProfit > this.state.savedProfit + 0.01) {
        const profitIncrease = newSavedProfit - this.state.savedProfit;
        this.log(`COMPOUND LIMIT: +$${profitIncrease.toFixed(2)} saved (total: $${newSavedProfit.toFixed(2)})`);
        this.log(`Trading with $${baseBalance.toFixed(2)}, reserving $${(walletBalance - baseBalance).toFixed(2)}`);
      }

      this.state.savedProfit = newSavedProfit;
      this.state.balance = baseBalance;  // Only trade with base amount
    } else {
      // Under the limit - use full balance
      this.state.balance = walletBalance;
      // Reset saved profit if balance dropped below limit (loss recovery)
      if (this.state.savedProfit > 0 && walletBalance <= baseBalance) {
        this.state.savedProfit = 0;
      }
    }
  }

  private async subscribeToMarkets(markets: Market[]): Promise<void> {
    const tokenIds: string[] = [];
    const marketIds = new Set<string>();
    for (const market of markets) {
      if (market.clobTokenIds) {
        tokenIds.push(...market.clobTokenIds);
      }
      if (market.id) {
        marketIds.add(market.id);
      }
    }

    // CRITICAL: Also subscribe to position tokens for real-time stop-loss monitoring
    // Position tokens may not be in the markets list if markets are closed/expired
    for (const tokenId of this.state.positions.keys()) {
      if (!tokenIds.includes(tokenId)) {
        tokenIds.push(tokenId);
      }
    }
    if (this.userStream) {
      for (const market of this.state.markets) {
        if (market.id) {
          marketIds.add(market.id);
        }
      }
    }
    if (this.userStream && marketIds.size > 0) {
      this.userStream.setMarkets([...marketIds]);
    }
    if (tokenIds.length > 0) {
      this.priceStream.subscribe(tokenIds);
      // Don't log subscription status on every scan - too spammy
      // Only log warnings when there's a real issue
      if (!this.priceStream.isConnected()) {
        this.log(`Warning: WebSocket not connected, prices may be delayed`);
      }
    }
  }

  private getPriceOverrides(): PriceOverride | undefined {
    if (!this.state.wsConnected) return undefined;

    const overrides: PriceOverride = {};
    for (const market of this.state.markets) {
      for (const tokenId of market.clobTokenIds) {
        const wsPrice = this.priceStream.getPrice(tokenId, this.getWsPriceMaxAgeMs());
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
        const walletBalance = await this.trader.getBalance();
        if (walletBalance !== null) {
          this.applyCompoundLimit(walletBalance);
        }
      }

      // Check for limit order fills (profit taking)
      await this.checkLimitOrderFills();

      // Check for expired markets first (close at $0.99)
      await this.checkExpiredPositions();

      // Check stop-losses on open positions
      await this.checkStopLosses();

      // Poll ladder steps if WS is unavailable
      await this.checkLadderStepsPolling();

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
      try {
        if (position.isLadder || this.state.ladderStates.has(tokenId)) {
          continue;
        }

        const profitTarget = this.getProfitTarget();
        if (this.config.paperTrading) {
          // Paper trading: check if price hit profit target
          const wsPrice = this.priceStream.getPrice(tokenId, this.getWsPriceMaxAgeMs());
          if (wsPrice && wsPrice.bestBid >= profitTarget) {
            await this.executeTakeProfit(tokenId, position, wsPrice.bestBid, "WS");
          }
        } else {
          // Real trading: monitor price for profit target (no limit orders)

          // Skip if position has no shares (invalid state)
          if (!position.shares || position.shares < 0.01) {
            this.log(`Removing invalid position with 0 shares`);
            closeTrade(position.tradeId, 0, "RESOLVED");
            this.state.positions.delete(tokenId);
            continue;
          }

          // Check if price hit profit target - market sell immediately
          const wsPrice = this.priceStream.getPrice(tokenId, this.getWsPriceMaxAgeMs());
          let currentBid: number | null = null;
          let source: "WS" | "REST" = "WS";

          if (wsPrice) {
            currentBid = wsPrice.bestBid;
          } else {
            const { bid } = await this.trader.getPrice(tokenId);
            currentBid = bid;
            source = "REST";
          }

          if (currentBid >= profitTarget) {
            await this.executeTakeProfit(tokenId, position, currentBid, source);
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
        this.log(`Market expired for ${position.side} position`, {
          marketSlug: position.marketSlug,
          tokenId,
          tradeId: position.tradeId
        });

        if (this.config.paperTrading) {
          // Paper trading: check WebSocket resolution first, then fall back to API
          let winner: "UP" | "DOWN" | null = null;

          // Check if we have resolution from WebSocket
          const winningTokenId = this.state.marketResolutions.get(position.marketSlug);
          if (winningTokenId) {
            // Determine if UP or DOWN won by matching token ID
            const market = this.state.markets.find(m => m.slug === position.marketSlug);
            if (market && market.clobTokenIds.length >= 2) {
              winner = winningTokenId === market.clobTokenIds[0] ? "UP" : "DOWN";
              this.log(`[WS] Got resolution from WebSocket: ${winner} won`);
            }
          }

          // Fall back to API if no WebSocket resolution
          if (!winner) {
            winner = await fetchMarketResolution(position.marketSlug);
          }

          if (!winner) {
            this.log(`[PAPER] Waiting for market resolution...`);
            continue;
          }

          // We won if our side matches the winner
          const exitPrice = position.side === winner ? 1.00 : 0.00;
          this.log(`[PAPER] Market resolved: ${winner} won - we ${position.side === winner ? "won" : "lost"}`);

          const proceeds = exitPrice * position.shares;
          const pnl = (exitPrice - position.entryPrice) * position.shares;

          closeTrade(position.tradeId, exitPrice, "RESOLVED");
          this.state.positions.delete(tokenId);
          this.state.balance += proceeds;

          this.log(`[PAPER] Market resolved. Sold ${position.shares.toFixed(2)} shares @ $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}`, {
            marketSlug: position.marketSlug,
            tokenId,
            tradeId: position.tradeId
          });
          this.log(`[PAPER] New balance: $${this.state.balance.toFixed(2)}`);
          this.checkCompoundLimit();
        } else {
          // Real trading: try market sell at actual price, then cancel limit order
          try {
            // Market sell at actual bid price
            const result = await this.trader.marketSell(tokenId, position.shares);
            if (result) {
              closeTrade(position.tradeId, result.price, "RESOLVED");
              this.state.positions.delete(tokenId);
              const realPnl = (result.price - position.entryPrice) * position.shares;

              this.log(`Market resolved @ $${result.price.toFixed(2)}. PnL: $${realPnl.toFixed(2)}`, {
                marketSlug: position.marketSlug,
                tokenId,
                tradeId: position.tradeId
              });

              // Sync balance after exit
              const newBalance = await this.trader.getBalance();
              if (newBalance !== null) {
                this.state.balance = newBalance;
              }
            } else {
              // Market sell failed - keep limit order as fallback
              const lastError = this.trader.getLastMarketSellError();
              const detail = lastError ? `: ${lastError}` : "";
              this.log(`Market sell failed for expired position${detail}, keeping limit order`, {
                marketSlug: position.marketSlug,
                tokenId,
                tradeId: position.tradeId
              });
            }
          } catch (err) {
            this.log(`Error selling expired position: ${err}`);
          }
        }
      }
    }
  }

  /**
   * Real-time stop-loss check triggered by WebSocket price updates
   * This fires IMMEDIATELY when prices change, no polling delay
   */
  private async checkStopLossRealtime(tokenId: string, currentBid: number): Promise<void> {
    // Only check if we have a position for this token and bot is running
    if (!this.state.running || !this.state.tradingEnabled) return;

    const position = this.state.positions.get(tokenId);
    if (!position) return;
    if (position.isLadder || this.state.ladderStates.has(tokenId)) return;

    const activeConfig = this.getActiveConfig();

    // Check if price is below stop-loss threshold - execute immediately
    if (currentBid <= activeConfig.stopLoss) {
      await this.executeStopLoss(tokenId, position, currentBid);
    }
  }

  /**
   * Real-time profit target check triggered by WebSocket price updates
   * This fires IMMEDIATELY when prices change, no polling delay
   */
  private async checkProfitTargetRealtime(tokenId: string, currentBid: number): Promise<void> {
    // Only check if we have a position for this token and bot is running
    if (!this.state.running || !this.state.tradingEnabled) return;

    // Skip profit target check for ladder positions (they use step-based exits)
    const ladderState = this.state.ladderStates.get(tokenId);
    if (ladderState) return;

    const position = this.state.positions.get(tokenId);
    if (!position) return;

    const profitTarget = this.getProfitTarget();

    // Check if price is at or above profit target - execute immediately
    if (currentBid >= profitTarget) {
      await this.executeTakeProfit(tokenId, position, currentBid, "WS");
    }
  }

  // ============================================================================
  // LADDER MODE METHODS
  // ============================================================================

  /**
   * Real-time ladder step check triggered by WebSocket price updates
   */
  private async checkLadderStepRealtime(tokenId: string, currentBid: number, currentAsk: number): Promise<void> {
    // Only process if bot is running and we have an active ladder for this token
    if (!this.state.running || !this.state.tradingEnabled) return;

    const ladderState = this.state.ladderStates.get(tokenId);
    if (!ladderState) return;
    if (!ladderState.currentStepPhase) {
      ladderState.currentStepPhase = "buy";
    }

    const ladderConfig = this.getLadderConfig();
    if (!ladderConfig) return;

    const hasValidBid = currentBid > 0;
    const hasValidAsk = currentAsk > 0;

    // Priority 1: Step stop-loss (only if we have shares)
    const hasShares = ladderState.totalShares - ladderState.totalSharesSold > 0.01;
    const stopLossStep = this.getActiveStopLossStep(ladderState, ladderConfig);
    if (hasShares && hasValidBid && stopLossStep && currentBid <= stopLossStep.stopLoss) {
      await this.executeLadderStopLoss(tokenId, ladderState, currentBid, stopLossStep);
      return;
    }

    // Ignore invalid prices for step logic
    if (!hasValidBid && !hasValidAsk) return;

    if (ladderState.status !== "active") return;

    // Priority 2: Recovery check (after stop-loss reset)
    // Wait for price to rise ABOVE first buy trigger before allowing re-entry
    if (ladderState.needsRecovery) {
      const firstBuyStep = ladderConfig.steps.find(s => s.enabled);
      if (firstBuyStep && hasValidAsk && currentAsk > firstBuyStep.buy.triggerPrice) {
        // Price has recovered above trigger, ready to trade again
        ladderState.needsRecovery = false;
        ladderState.lastStepTime = Date.now();
        this.persistLadderState(ladderState);
        this.log(`[LADDER] Price recovered to $${currentAsk.toFixed(2)} - ready for step 1 @ $${firstBuyStep.buy.triggerPrice.toFixed(2)}`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });
      } else {
        // Still waiting for recovery
        return;
      }
    }

    // Get next pending step
    const nextStep = this.getActiveStep(ladderState, ladderConfig);
    if (!nextStep) {
      // All steps completed or skipped
      if (ladderState.status === "active") {
        ladderState.status = "completed";
        this.lockLadderMarket(ladderState.marketSlug);
        const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
        const totalPnl = ladderState.totalSellProceeds - ladderState.totalCostBasis;
        if (remainingShares < 0.01) {
          this.log(`[LADDER] Completed all steps. Total PnL: $${totalPnl.toFixed(2)}`, {
            marketSlug: ladderState.marketSlug,
            tokenId
          });
          this.state.ladderStates.delete(tokenId);
        } else {
          this.log(`[LADDER] Completed all steps with ${remainingShares.toFixed(2)} shares remaining - ladder set to completed`, {
            marketSlug: ladderState.marketSlug,
            tokenId
          });
        }
        this.persistLadderState(ladderState);
      }
      return;
    }

    // Check trigger conditions based on current step phase
    // Log current step being checked (for debugging)
    const stepIndex = ladderState.currentStepIndex + 1;
    const totalSteps = ladderConfig.steps.length;

    const stepPhase = ladderState.currentStepPhase ?? "buy";
    if (stepPhase === "buy") {
      // Buy triggers when ask price drops to or below trigger
      if (hasValidAsk && currentAsk <= nextStep.buy.triggerPrice) {
        this.log(`[LADDER] Step ${stepIndex}/${totalSteps} "${nextStep.id}" buy triggered: ask $${currentAsk.toFixed(2)} <= $${nextStep.buy.triggerPrice.toFixed(2)}`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });
        await this.executeLadderBuyStep(tokenId, ladderState, nextStep, currentAsk, ladderConfig);
      }
    } else if (stepPhase === "sell") {
      // Sell triggers when bid price rises to or above trigger
      if (hasValidBid && currentBid >= nextStep.sell.triggerPrice) {
        this.log(`[LADDER] Step ${stepIndex}/${totalSteps} "${nextStep.id}" sell triggered: bid $${currentBid.toFixed(2)} >= $${nextStep.sell.triggerPrice.toFixed(2)}`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });
        await this.executeLadderSellStep(tokenId, ladderState, nextStep, currentBid, ladderConfig);
      }
    }
  }

  /**
   * Get the active step in sequence (strictly ordered)
   * Only returns the step at currentStepIndex - steps MUST execute in order
   */
  private getActiveStep(ladderState: LadderState, config: LadderModeConfig): LadderStep | null {
    // Strict sequential order: only look at the current step index
    if (ladderState.currentStepIndex >= config.steps.length) {
      return null; // All steps completed
    }

    const step = config.steps[ladderState.currentStepIndex];

    // Skip disabled steps
    if (!step.enabled) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, config); // Recurse to next step
    }

    // Skip already completed steps (safety check)
    if (ladderState.completedSteps.includes(step.id)) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, config);
    }

    // Skip already skipped steps
    if (ladderState.skippedSteps.includes(step.id)) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, config);
    }

    return step;
  }

  /**
   * Get the step whose stop-loss should be active right now
   * Uses the next enabled step; if all steps are done, falls back to last enabled step
   */
  private getActiveStopLossStep(ladderState: LadderState, config: LadderModeConfig): LadderStep | null {
    let index = ladderState.currentStepIndex;
    while (index < config.steps.length) {
      const step = config.steps[index];
      if (!step.enabled) {
        index++;
        continue;
      }
      if (ladderState.completedSteps.includes(step.id) || ladderState.skippedSteps.includes(step.id)) {
        index++;
        continue;
      }
      return step;
    }

    // Fallback: last enabled step for safety if all steps are done
    for (let i = config.steps.length - 1; i >= 0; i--) {
      const step = config.steps[i];
      if (step.enabled) {
        return step;
      }
    }

    return null;
  }

  /**
   * Skip a ladder step with a reason
   */
  private skipLadderStep(ladderState: LadderState, stepId: string, reason: string): void {
    ladderState.skippedSteps.push(stepId);
    ladderState.skippedReasons.set(stepId, reason);
    this.log(`[LADDER] Skipped step "${stepId}": ${reason}`, {
      marketSlug: ladderState.marketSlug,
      tokenId: ladderState.tokenId
    });
    this.persistLadderState(ladderState);
  }

  /**
   * Calculate step size based on sizeType and sizeValue
   */
  private calculateStepSize(
    side: "buy" | "sell",
    stepConfig: { sizeType: "percent" | "fixed"; sizeValue: number },
    ladderState: LadderState,
    availableBalance: number,
    currentPrice: number
  ): number {
    if (side === "buy") {
      if (stepConfig.sizeType === "percent") {
        return availableBalance * (stepConfig.sizeValue / 100);
      }
      return Math.min(stepConfig.sizeValue, availableBalance);
    }

    const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
    if (stepConfig.sizeType === "percent") {
      return remainingShares * (stepConfig.sizeValue / 100);
    }
    return Math.min(stepConfig.sizeValue / currentPrice, remainingShares);
  }

  /**
   * Execute a ladder buy step
   */
  private async executeLadderBuyStep(
    tokenId: string,
    ladderState: LadderState,
    step: LadderStep,
    askPrice: number,
    config: LadderModeConfig
  ): Promise<void> {
    // SKIP CHECK: Don't execute if step is already completed or skipped
    if (ladderState.completedSteps.includes(step.id)) {
      this.log(`[LADDER] Step "${step.id}" already completed - skipping`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });
      return;
    }
    if (ladderState.skippedSteps.includes(step.id)) {
      return; // Already skipped, no need to log again
    }

    // MUTEX: Prevent concurrent operations on same token
    if (this.state.pendingEntries.has(tokenId)) return;
    this.state.pendingEntries.add(tokenId);

    try {
      const availableBalance = this.getAvailableBalance();
      const buyAmount = this.calculateStepSize("buy", step.buy, ladderState, availableBalance, askPrice);

      // Check minimum order requirements
      const estimatedShares = buyAmount / askPrice;
      if (buyAmount < 1 || estimatedShares < MIN_ORDER_SIZE) {
        this.skipLadderStep(ladderState, step.id, "insufficient_balance");
        ladderState.currentStepIndex++;
        ladderState.currentStepPhase = "buy";
        this.persistLadderState(ladderState);
        return;
      }

      this.log(`[LADDER] Executing buy step "${step.id}" @ $${askPrice.toFixed(2)} ($${buyAmount.toFixed(2)})`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });

      if (this.config.paperTrading) {
        // Reserve balance to prevent overspending across concurrent ladders
        this.state.reservedBalance += buyAmount;
        // Paper trading: simulate buy
        try {
          const paperFeeRate = this.getPaperFeeRate();
          const shares = (buyAmount / askPrice) * (1 - paperFeeRate);

          // Record trade
          const tradeId = insertTrade({
            market_slug: ladderState.marketSlug,
            token_id: tokenId,
            side: ladderState.side,
            entry_price: askPrice,
            shares,
            cost_basis: buyAmount,
            created_at: new Date().toISOString(),
            market_end_date: ladderState.marketEndDate.toISOString()
          });

          // Mark as ladder trade
          markAsLadderTrade(tradeId, step.id);
          ladderState.tradeIds.push(tradeId);

          // Update ladder state
          ladderState.totalShares += shares;
          ladderState.totalCostBasis += buyAmount;
          ladderState.averageEntryPrice = ladderState.totalCostBasis / ladderState.totalShares;

          // Deduct from balance
          this.state.balance -= buyAmount;

          this.log(`[PAPER] Bought ${shares.toFixed(2)} shares @ $${askPrice.toFixed(2)} (step: ${step.id})`, {
            marketSlug: ladderState.marketSlug,
            tokenId,
            tradeId
          });

          // Update or create position
        const existingPosition = this.state.positions.get(tokenId);
        if (existingPosition) {
          existingPosition.shares = ladderState.totalShares;
          existingPosition.entryPrice = ladderState.averageEntryPrice;
          existingPosition.isLadder = true;
        } else {
          this.state.positions.set(tokenId, {
            tradeId,
            tokenId,
            shares: ladderState.totalShares,
            entryPrice: ladderState.averageEntryPrice,
              side: ladderState.side,
              marketSlug: ladderState.marketSlug,
              marketEndDate: ladderState.marketEndDate,
              isLadder: true
            });
          }
        } finally {
          this.state.reservedBalance -= buyAmount;
        }
      } else {
        // Real trading
        this.state.reservedBalance += buyAmount;
        try {
          const result = await this.trader.buy(tokenId, askPrice, buyAmount);
          if (!result) {
            this.skipLadderStep(ladderState, step.id, "buy_failed");
            ladderState.currentStepIndex++;
            ladderState.currentStepPhase = "buy";
            this.persistLadderState(ladderState);
            return;
          }

          const fillInfo = await this.trader.waitForFill(result.orderId, 10000);
          if (!fillInfo || fillInfo.filledShares <= 0) {
            await this.trader.cancelOrder(result.orderId);
            this.skipLadderStep(ladderState, step.id, "order_not_filled");
            ladderState.currentStepIndex++;
            ladderState.currentStepPhase = "buy";
            this.persistLadderState(ladderState);
            return;
          }

          const actualShares = fillInfo.filledShares;
          const actualEntryPrice = fillInfo.avgPrice || askPrice;
          const actualCost = actualShares * actualEntryPrice;

          const tradeId = insertTrade({
            market_slug: ladderState.marketSlug,
            token_id: tokenId,
            side: ladderState.side,
            entry_price: actualEntryPrice,
            shares: actualShares,
            cost_basis: actualCost,
            created_at: new Date().toISOString(),
            market_end_date: ladderState.marketEndDate.toISOString()
          });

          // Mark as ladder trade
          markAsLadderTrade(tradeId, step.id);
          ladderState.tradeIds.push(tradeId);
          ladderState.totalShares += actualShares;
          ladderState.totalCostBasis += actualCost;
          ladderState.averageEntryPrice = ladderState.totalCostBasis / ladderState.totalShares;

          this.log(`Bought ${actualShares.toFixed(2)} shares @ $${actualEntryPrice.toFixed(2)} (step: ${step.id})`, {
            marketSlug: ladderState.marketSlug,
            tokenId,
            tradeId
          });

          // Update or create position
          const existingPosition = this.state.positions.get(tokenId);
          if (existingPosition) {
            existingPosition.shares = ladderState.totalShares;
            existingPosition.entryPrice = ladderState.averageEntryPrice;
            existingPosition.isLadder = true;
          } else {
            this.state.positions.set(tokenId, {
              tradeId,
              tokenId,
              shares: ladderState.totalShares,
              entryPrice: ladderState.averageEntryPrice,
              side: ladderState.side,
              marketSlug: ladderState.marketSlug,
              marketEndDate: ladderState.marketEndDate,
              isLadder: true
            });
          }

          const newBalance = await this.trader.getBalance();
          if (newBalance !== null) {
            this.state.balance = newBalance;
          }
        } finally {
          this.state.reservedBalance -= buyAmount;
        }
      }

      // Move to sell phase within this step
      ladderState.currentStepPhase = "sell";
      ladderState.lastStepTime = Date.now();
      ladderState.lastStepPrice = askPrice;
      this.persistLadderState(ladderState);

    } finally {
      this.state.pendingEntries.delete(tokenId);
    }
  }

  /**
   * Execute a ladder sell step
   */
  private async executeLadderSellStep(
    tokenId: string,
    ladderState: LadderState,
    step: LadderStep,
    bidPrice: number,
    config: LadderModeConfig
  ): Promise<void> {
    // SKIP CHECK: Don't execute if step is already completed or skipped
    if (ladderState.completedSteps.includes(step.id)) {
      this.log(`[LADDER] Step "${step.id}" already completed - skipping`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });
      return;
    }
    if (ladderState.skippedSteps.includes(step.id)) {
      return; // Already skipped, no need to log again
    }

    // MUTEX: Prevent concurrent operations on same token
    if (this.state.pendingExits.has(tokenId)) return;
    this.state.pendingExits.add(tokenId);

    try {
      const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
      const sellShares = this.calculateStepSize("sell", step.sell, ladderState, 0, bidPrice);

      // Check if we have shares to sell
      if (sellShares < 0.01 || remainingShares < 0.01) {
        this.skipLadderStep(ladderState, step.id, "insufficient_shares");
        ladderState.currentStepIndex++;
        ladderState.currentStepPhase = "buy";
        this.persistLadderState(ladderState);
        return;
      }

      const actualSellShares = Math.min(sellShares, remainingShares);

      this.log(`[LADDER] Executing sell step "${step.id}" @ $${bidPrice.toFixed(2)} (${actualSellShares.toFixed(2)} shares)`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });

      if (this.config.paperTrading) {
        // Paper trading: simulate sell
        const proceeds = actualSellShares * bidPrice;

        // Calculate PnL for this portion
        const costBasisPortion = (actualSellShares / ladderState.totalShares) * ladderState.totalCostBasis;
        const pnl = proceeds - costBasisPortion;

        this.closeLadderTradesForSell(ladderState, actualSellShares, bidPrice, "RESOLVED", step.id);

        ladderState.totalSharesSold += actualSellShares;
        ladderState.totalSellProceeds += proceeds;
        this.state.balance += proceeds;

        this.log(`[PAPER] Sold ${actualSellShares.toFixed(2)} shares @ $${bidPrice.toFixed(2)}. Step PnL: $${pnl.toFixed(2)} (step: ${step.id})`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });

        // Update position
        const position = this.state.positions.get(tokenId);
        if (position) {
          position.shares = ladderState.totalShares - ladderState.totalSharesSold;
          if (position.shares < 0.01) {
            this.state.positions.delete(tokenId);
          }
        }

        this.checkCompoundLimit();
      } else {
        // Real trading
        const result = await this.trader.marketSell(tokenId, actualSellShares, bidPrice);
        if (!result) {
          this.skipLadderStep(ladderState, step.id, "sell_failed");
          ladderState.currentStepIndex++;
          ladderState.currentStepPhase = "buy";
          this.persistLadderState(ladderState);
          return;
        }

        const proceeds = actualSellShares * result.price;
        ladderState.totalSharesSold += actualSellShares;
        ladderState.totalSellProceeds += proceeds;

        const costBasisPortion = (actualSellShares / ladderState.totalShares) * ladderState.totalCostBasis;
        const pnl = proceeds - costBasisPortion;

        this.log(`Sold ${actualSellShares.toFixed(2)} shares @ $${result.price.toFixed(2)}. Step PnL: $${pnl.toFixed(2)} (step: ${step.id})`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });

        this.closeLadderTradesForSell(ladderState, actualSellShares, result.price, "RESOLVED", step.id);

        // Update position
        const position = this.state.positions.get(tokenId);
        if (position) {
          position.shares = ladderState.totalShares - ladderState.totalSharesSold;
          if (position.shares < 0.01) {
            this.state.positions.delete(tokenId);
          }
        }

        const newBalance = await this.trader.getBalance();
        if (newBalance !== null) {
          this.state.balance = newBalance;
        }
      }

      // Mark step completed
      ladderState.completedSteps.push(step.id);
      ladderState.currentStepIndex++;
      ladderState.currentStepPhase = "buy";
      ladderState.lastStepTime = Date.now();
      ladderState.lastStepPrice = bidPrice;

      // Log that this sell step completed - ladder continues to next step
      const remainingAfterSell = ladderState.totalShares - ladderState.totalSharesSold;
      if (remainingAfterSell < 0.01) {
        const stepPnl = ladderState.totalSellProceeds - ladderState.totalCostBasis;
        this.log(`[LADDER] Sell step "${step.id}" completed. Cycle PnL: $${stepPnl.toFixed(2)}. Ready for next buy step.`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });
        // Reset for next buy/sell cycle but keep ladder active
        ladderState.totalShares = 0;
        ladderState.totalCostBasis = 0;
        ladderState.totalSharesSold = 0;
        ladderState.totalSellProceeds = 0;
        ladderState.tradeIds = [];
      }

      this.persistLadderState(ladderState);

    } finally {
      this.state.pendingExits.delete(tokenId);
    }
  }

  /**
   * Execute step stop-loss for ladder position (sells ALL remaining shares)
   * After stop-loss, resets the ladder to step 1 to allow re-entry
   */
  private async executeLadderStopLoss(
    tokenId: string,
    ladderState: LadderState,
    currentBid: number,
    step: LadderStep
  ): Promise<void> {
    // MUTEX: Prevent concurrent operations on same token
    if (this.state.pendingExits.has(tokenId)) return;
    this.state.pendingExits.add(tokenId);

    try {
      const openShares = this.getOpenLadderShares(ladderState);
      const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
      const sharesToSell = openShares > 0 ? openShares : remainingShares;
      if (sharesToSell < 0.01) {
        // No shares to sell, just reset the ladder
        this.clearLadderMarketLock(ladderState.marketSlug, "stop_loss");
        this.resetLadderState(ladderState);
        this.log(`[LADDER] Reset to step 1 - waiting for new entry`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });
        this.persistLadderState(ladderState);
        return;
      }

      this.log(`[LADDER] STEP STOP-LOSS TRIGGERED (${step.id}) @ $${currentBid.toFixed(2)} <= $${step.stopLoss.toFixed(2)} - selling ALL ${sharesToSell.toFixed(2)} shares`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });

      if (this.config.paperTrading) {
        // Paper trading: simulate emergency sell
        const proceeds = sharesToSell * currentBid;
        ladderState.totalSharesSold += sharesToSell;
        ladderState.totalSellProceeds += proceeds;
        this.state.balance += proceeds;

        const totalPnl = ladderState.totalSellProceeds - ladderState.totalCostBasis;
        this.log(`[PAPER] Emergency sold ${sharesToSell.toFixed(2)} shares @ $${currentBid.toFixed(2)}. Total PnL: $${totalPnl.toFixed(2)}`, {
          marketSlug: ladderState.marketSlug,
          tokenId
        });

        // Close all open trades for this ladder
        this.closeAllOpenLadderTrades(ladderState, currentBid, "STOPPED");

        this.state.positions.delete(tokenId);
        this.checkCompoundLimit();
      } else {
        // Real trading: market sell all remaining shares
        const result = await this.trader.marketSell(tokenId, sharesToSell, currentBid);
        if (result) {
          const proceeds = sharesToSell * result.price;
          ladderState.totalSharesSold += sharesToSell;
          ladderState.totalSellProceeds += proceeds;

          const totalPnl = ladderState.totalSellProceeds - ladderState.totalCostBasis;
          this.log(`[STOP-LOSS] Emergency sold ${sharesToSell.toFixed(2)} shares @ $${result.price.toFixed(2)}. Total PnL: $${totalPnl.toFixed(2)}`, {
            marketSlug: ladderState.marketSlug,
            tokenId
          });

          this.closeAllOpenLadderTrades(ladderState, result.price, "STOPPED");

          this.state.positions.delete(tokenId);

          const newBalance = await this.trader.getBalance();
          if (newBalance !== null) {
            this.state.balance = newBalance;
          }
        } else {
          this.log(`[STOP-LOSS] Market sell failed - will retry on next tick`, {
            marketSlug: ladderState.marketSlug,
            tokenId
          });
          return; // Don't reset, will retry
        }
      }

      // Reset the ladder to step 1 instead of deleting it
      this.clearLadderMarketLock(ladderState.marketSlug, "stop_loss");
      this.resetLadderState(ladderState);
      this.log(`[LADDER] Reset to step 1 - waiting for new entry @ $${this.getLadderConfig()?.steps[0]?.buy.triggerPrice.toFixed(2) || '?'}`, {
        marketSlug: ladderState.marketSlug,
        tokenId
      });
      this.persistLadderState(ladderState);

    } finally {
      this.state.pendingExits.delete(tokenId);
    }
  }

  /**
   * Reset ladder state to step 1 (used after stop-loss or completion)
   */
  private resetLadderState(ladderState: LadderState): void {
    ladderState.currentStepIndex = 0;
    ladderState.currentStepPhase = "buy";
    ladderState.completedSteps = [];
    ladderState.skippedSteps = [];
    ladderState.skippedReasons.clear();
    ladderState.totalShares = 0;
    ladderState.totalCostBasis = 0;
    ladderState.averageEntryPrice = 0;
    ladderState.totalSharesSold = 0;
    ladderState.totalSellProceeds = 0;
    ladderState.lastStepTime = Date.now();
    ladderState.lastStepPrice = 0;
    ladderState.tradeIds = [];
    ladderState.needsRecovery = true; // Wait for price to recover before re-entering
    ladderState.status = "active";
  }

  /**
   * Initialize a new ladder state for a position
   */
  private initializeLadderState(
    tokenId: string,
    side: "UP" | "DOWN",
    marketSlug: string,
    marketEndDate: Date
  ): LadderState {
    const now = Date.now();
    return {
      tokenId,
      side,
      marketSlug,
      marketEndDate,
      currentStepIndex: 0,
      currentStepPhase: "buy",
      completedSteps: [],
      skippedSteps: [],
      skippedReasons: new Map(),
      totalShares: 0,
      totalCostBasis: 0,
      averageEntryPrice: 0,
      totalSharesSold: 0,
      totalSellProceeds: 0,
      ladderStartTime: now,
      lastStepTime: now,
      lastStepPrice: 0,
      tradeIds: [],
      needsRecovery: false, // New ladders don't need recovery
      status: "active"
    };
  }

  /**
   * Execute stop-loss sell (called from real-time or polling check)
   */
  private async executeStopLoss(tokenId: string, position: Position, currentBid: number): Promise<void> {
    // MUTEX: Prevent concurrent exits for same token (race condition fix)
    if (this.state.pendingExits.has(tokenId)) {
      return;
    }

    // Validate position has shares
    if (!position.shares || position.shares < 0.01) {
      this.log(`[STOP-LOSS] Invalid position with 0 shares - removing`);
      closeTrade(position.tradeId, 0, "RESOLVED");
      this.state.positions.delete(tokenId);
      return;
    }

    this.state.pendingExits.add(tokenId);

    try {
      this.log(`[WS] Stop-loss TRIGGERED for ${position.side} @ $${currentBid.toFixed(2)}`, {
        marketSlug: position.marketSlug,
        tokenId: position.tokenId,
        tradeId: position.tradeId
      });

      if (this.config.paperTrading) {
        // Paper trading: simulate sell at bid price
        const exitPrice = currentBid;
        const proceeds = exitPrice * position.shares;
        closeTrade(position.tradeId, exitPrice, "STOPPED");
        this.state.positions.delete(tokenId);
        this.state.balance += proceeds;
        const pnl = (exitPrice - position.entryPrice) * position.shares;
        this.log(`[PAPER] Sold ${position.shares.toFixed(2)} shares @ $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}`, {
          marketSlug: position.marketSlug,
          tokenId: position.tokenId,
          tradeId: position.tradeId
        });

        this.checkCompoundLimit();
      } else {
        // Real trading: market sell immediately (no limit orders to worry about)
        try {
          // SECURITY FIX: Skip stop-loss on empty order book (bid = 0)
          // This prevents triggering on temporary book clearing
          if (currentBid === 0) {
            this.log(`[STOP-LOSS] Skipping: order book empty (bid = 0)`);
            return;
          }

          const result = await this.trader.marketSell(tokenId, position.shares, currentBid);
          if (result) {
            closeTrade(position.tradeId, result.price, "STOPPED");
            this.state.positions.delete(tokenId);
            const pnl = (result.price - position.entryPrice) * position.shares;
            this.log(`[STOP-LOSS] Sold ${position.shares.toFixed(2)} shares @ $${result.price.toFixed(2)}. PnL: $${pnl.toFixed(2)}`, {
              marketSlug: position.marketSlug,
              tokenId: position.tokenId,
              tradeId: position.tradeId
            });

            // Sync balance after exit
            const newBalance = await this.trader.getBalance();
            if (newBalance !== null) {
              this.state.balance = newBalance;
            }
          } else {
            const lastError = this.trader.getLastMarketSellError();
            const detail = lastError ? `: ${lastError}` : "";
            this.log(`[STOP-LOSS] Market sell failed${detail} - will retry on next tick`, {
              marketSlug: position.marketSlug,
              tokenId: position.tokenId,
              tradeId: position.tradeId
            });
          }
        } catch (err) {
          this.log(`[STOP-LOSS] Error: ${err instanceof Error ? err.message : err}`, {
            marketSlug: position.marketSlug,
            tokenId: position.tokenId,
            tradeId: position.tradeId
          });
        }
      }
    } finally {
      // MUTEX: Always release the lock
      this.state.pendingExits.delete(tokenId);
    }
  }

  /**
   * Execute profit target sell (called from real-time or polling check)
   */
  private async executeTakeProfit(
    tokenId: string,
    position: Position,
    currentBid: number,
    source: "WS" | "REST"
  ): Promise<void> {
    // MUTEX: Prevent concurrent exits for same token (race condition fix)
    if (this.state.pendingExits.has(tokenId)) {
      return;
    }

    // Validate position has shares
    if (!position.shares || position.shares < 0.01) {
      this.log(`[TAKE-PROFIT] Invalid position with 0 shares - removing`);
      closeTrade(position.tradeId, 0, "RESOLVED");
      this.state.positions.delete(tokenId);
      return;
    }

    this.state.pendingExits.add(tokenId);

    try {
      const profitTarget = this.getProfitTarget();

      if (this.config.paperTrading) {
        // Paper trading: simulate limit order fill at profit target
        const exitPrice = profitTarget;
        const proceeds = exitPrice * position.shares;
        const pnl = (exitPrice - position.entryPrice) * position.shares;

        closeTrade(position.tradeId, exitPrice, "RESOLVED");
        this.state.positions.delete(tokenId);
        this.state.balance += proceeds;

        this.log(`[PAPER] Limit order filled @ $${exitPrice.toFixed(2)}! PnL: $${pnl.toFixed(2)}`, {
          marketSlug: position.marketSlug,
          tokenId,
          tradeId: position.tradeId
        });
        this.log(`[PAPER] New balance: $${this.state.balance.toFixed(2)}`);
        this.checkCompoundLimit();
        return;
      }

      this.log(`[TAKE-PROFIT] (${source}) Price $${currentBid.toFixed(2)} hit target $${profitTarget.toFixed(2)} - selling`, {
        marketSlug: position.marketSlug,
        tokenId,
        tradeId: position.tradeId
      });

      // Market sell at current price
      const result = await this.trader.marketSell(tokenId, position.shares, currentBid);
      if (result) {
        const pnl = (result.price - position.entryPrice) * position.shares;
        closeTrade(position.tradeId, result.price, "RESOLVED");
        this.state.positions.delete(tokenId);

        this.log(`[TAKE-PROFIT] Sold ${position.shares.toFixed(2)} shares @ $${result.price.toFixed(2)}! PnL: $${pnl.toFixed(2)}`, {
          marketSlug: position.marketSlug,
          tokenId,
          tradeId: position.tradeId
        });
        const newBalance = await this.trader.getBalance();
        if (newBalance !== null) {
          this.state.balance = newBalance;
        }
      } else {
        const lastError = this.trader.getLastMarketSellError();
        const detail = lastError ? `: ${lastError}` : "";
        this.log(`[TAKE-PROFIT] Market sell failed${detail} - will retry on next tick`, {
          marketSlug: position.marketSlug,
          tokenId,
          tradeId: position.tradeId
        });
      }
    } catch (err) {
      this.log(`[TAKE-PROFIT] Error: ${err instanceof Error ? err.message : err}`, {
        marketSlug: position.marketSlug,
        tokenId,
        tradeId: position.tradeId
      });
    } finally {
      // MUTEX: Always release the lock
      this.state.pendingExits.delete(tokenId);
    }
  }

  private async checkStopLosses(): Promise<void> {
    const activeConfig = this.getActiveConfig();

    for (const [tokenId, position] of this.state.positions) {
      try {
        if (position.isLadder || this.state.ladderStates.has(tokenId)) {
          continue;
        }

        // Use WebSocket price if available, otherwise fall back to REST API
        let currentBid: number;
        const wsPrice = this.priceStream.getPrice(tokenId, this.getWsPriceMaxAgeMs());
        if (wsPrice && this.state.wsConnected) {
          currentBid = wsPrice.bestBid;
        } else if (!this.config.paperTrading) {
          const { bid } = await this.trader.getPrice(tokenId);
          currentBid = bid;
        } else {
          continue; // Skip if no price available in paper mode
        }

        // Check if price is below stop-loss threshold - execute immediately
        if (currentBid <= activeConfig.stopLoss) {
          await this.executeStopLoss(tokenId, position, currentBid);
        }
      } catch (err) {
        this.log(`Error checking stop-loss: ${err}`);
      }
    }
  }

  private async checkLadderStepsPolling(): Promise<void> {
    if (!this.isLadderMode()) return;
    if (this.state.ladderStates.size === 0) return;

    for (const [tokenId] of this.state.ladderStates) {
      try {
        const wsPrice = this.priceStream.getPrice(tokenId, this.getWsPriceMaxAgeMs());
        if (wsPrice && this.state.wsConnected) {
          // Real-time WS handler will process steps
          continue;
        }

        if (this.config.paperTrading) {
          continue; // No REST fallback in paper mode
        }

        const { bid, ask } = await this.trader.getPrice(tokenId);
        await this.checkLadderStepRealtime(tokenId, bid, ask);
      } catch (err) {
        this.log(`[LADDER] Error checking ladder steps (polling): ${err}`);
      }
    }
  }

  /**
   * Real-time entry check triggered by WebSocket price updates
   * This fires IMMEDIATELY when prices change to catch entry opportunities
   */
  private async checkEntryRealtime(tokenId: string, bestBid: number, bestAsk: number): Promise<void> {
    // Only check if bot is running and trading enabled
    if (!this.state.running || !this.state.tradingEnabled) return;

    // Skip if no balance
    if (this.state.balance < 1) return;

    // Skip if balance too low for minimum order size (5 shares)
    // Quick estimate: need at least MIN_ORDER_SIZE * askPrice USDC
    const minUsdcNeeded = MIN_ORDER_SIZE * bestAsk;
    if (this.state.balance < minUsdcNeeded) return;

    // Skip if we already have a position for this token (enterPosition also checks, but early exit is faster)
    if (this.state.positions.has(tokenId)) return;

    // Skip if we already have an active ladder for this token
    if (this.state.ladderStates.has(tokenId)) return;

    // Find the market for this token
    const market = this.state.markets.find(m =>
      m.clobTokenIds.includes(tokenId)
    );
    if (!market) return;

    if (this.isLadderMode() && this.isLadderMarketLocked(market.slug)) return;

    const activeConfig = this.getActiveConfig();
    const now = Date.now();

    // Check time window (time remaining until market ends)
    // market.endDate may be a Date object or string depending on source
    const endTime = market.endDate instanceof Date ? market.endDate.getTime() : new Date(market.endDate).getTime();
    const timeRemaining = endTime - now;
    if (timeRemaining <= 0 || timeRemaining > activeConfig.timeWindowMs) return;

    // Determine which side this token is (UP or DOWN)
    const isUpToken = market.clobTokenIds[0] === tokenId;
    const side: "UP" | "DOWN" = isUpToken ? "UP" : "DOWN";

    // Check spread
    const spread = bestAsk - bestBid;
    if (spread > activeConfig.maxSpread) return;

    // Check entry threshold (ask must be >= threshold and <= max)
    if (bestAsk < activeConfig.entryThreshold || bestAsk > activeConfig.maxEntryPrice) return;

    // Don't buy if price is at or above profit target (only for normal mode)
    // Ladder mode doesn't use profit target - it uses step-based triggers
    if (!this.isLadderMode() && bestAsk >= this.getProfitTarget()) return;

    // Build eligible market object for enterPosition
    const marketEndDate = market.endDate instanceof Date ? market.endDate : new Date(market.endDate);
    const eligibleMarket: EligibleMarket = {
      slug: market.slug,
      question: market.question,
      endDate: marketEndDate,
      upTokenId: market.clobTokenIds[0],
      downTokenId: market.clobTokenIds[1],
      upBid: isUpToken ? bestBid : 0,
      upAsk: isUpToken ? bestAsk : 1,
      downBid: isUpToken ? 0 : bestBid,
      downAsk: isUpToken ? 1 : bestAsk,
      timeRemaining,
      eligibleSide: side
    };

    // Don't log every WS signal - too spammy. Only log when actually entering.
    await this.enterPosition(eligibleMarket);
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
        // Skip if we already have a position or ladder in this market
        const tokenId = market.eligibleSide === "UP" ? market.upTokenId : market.downTokenId;
        if (this.state.positions.has(tokenId)) continue;
        if (this.state.ladderStates.has(tokenId)) continue;
        if (this.isLadderMode() && this.isLadderMarketLocked(market.slug)) continue;

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
    // Normalize endDate to Date object (may be string from API)
    const endDate = market.endDate instanceof Date ? market.endDate : new Date(market.endDate);

    // Check if we're in ladder mode
    const isLadder = this.isLadderMode();
    const ladderConfig = isLadder ? this.getLadderConfig() : null;

    // EARLY EXITS (before mutex) - these checks don't need mutex protection
    // and checking them first avoids unnecessary mutex churn
    if (isLadder && this.isLadderMarketLocked(market.slug)) return;
    if (this.state.pendingEntries.has(tokenId)) return;
    if (this.state.positions.has(tokenId)) return;
    if (this.state.ladderStates.has(tokenId)) return; // Already have ladder for this token
    if (this.state.positions.size >= this.config.maxPositions) return;

    // For normal mode, skip if at or above profit target
    if (!isLadder && askPrice >= this.getProfitTarget()) return;

    if (askPrice > activeConfig.maxEntryPrice) return;
    if (askPrice < activeConfig.entryThreshold) return;
    if ((askPrice - bidPrice) > activeConfig.maxSpread) return;

    // Only enter OPPOSITE side of last WINNING trade IN THE SAME MARKET
    const lastWinningTrade = getLastWinningTradeInMarket(market.slug, side);
    if (lastWinningTrade) return;

    // MUTEX: Now we're actually going to try to enter
    this.state.pendingEntries.add(tokenId);

    try {
      // Double-check position count with mutex held (race condition protection)
      const currentPositionCount = this.state.positions.size + this.state.pendingEntries.size - 1;
      if (currentPositionCount >= this.config.maxPositions) {
        return;
      }

      // Log entry attempt (only fires when we're actually going to try)
      this.log(`Entry signal: ${side} @ $${askPrice.toFixed(2)} ask (${Math.floor(market.timeRemaining / 1000)}s remaining)`, {
        marketSlug: market.slug,
        tokenId
      });

      // LADDER MODE: Initialize ladder state and wait for first step trigger
      if (isLadder && ladderConfig) {
        this.log(`[LADDER] Entry signal detected for ${side} @ ask=$${askPrice.toFixed(2)} bid=$${bidPrice.toFixed(2)}`, {
          marketSlug: market.slug,
          tokenId
        });

        const firstEnabledIndex = ladderConfig.steps.findIndex(s => s.enabled);
        if (firstEnabledIndex === -1) {
          this.log(`[LADDER] No enabled steps found - skipping`, {
            marketSlug: market.slug,
            tokenId
          });
          return;
        }

        const firstStep = ladderConfig.steps[firstEnabledIndex];

        // Initialize ladder state
        const ladderState = this.initializeLadderState(tokenId, side, market.slug, endDate);
        ladderState.lastStepPrice = askPrice;

        // Only start ladder if price is ABOVE the first buy trigger (we want to catch the drop)
        // If price is already at or below the trigger, skip - we missed the entry
        if (askPrice < firstStep.buy.triggerPrice) {
          this.log(`[LADDER] Price $${askPrice.toFixed(2)} already below first step trigger $${firstStep.buy.triggerPrice.toFixed(2)} - skipping`, {
            marketSlug: market.slug,
            tokenId
          });
          return;
        }

        // Store ladder state and wait for price to drop to trigger
        this.state.ladderStates.set(tokenId, ladderState);

        // Check if current price is exactly at the trigger (within small tolerance)
        const priceTolerance = 0.005; // $0.005 tolerance
        if (Math.abs(askPrice - firstStep.buy.triggerPrice) <= priceTolerance) {
          this.log(`[LADDER] Starting ladder - first buy step triggered @ $${askPrice.toFixed(2)}`, {
            marketSlug: market.slug,
            tokenId
          });

          // Execute the first buy step
          await this.executeLadderBuyStep(tokenId, ladderState, firstStep, askPrice, ladderConfig);
        } else {
          // Price is above trigger - wait for it to drop
          this.log(`[LADDER] Waiting for first step trigger @ $${firstStep.buy.triggerPrice.toFixed(2)} (current: $${askPrice.toFixed(2)})`, {
            marketSlug: market.slug,
            tokenId
          });
        }

        // Ensure token is subscribed for ladder monitoring
        if (this.priceStream.isConnected()) {
          this.priceStream.subscribe([tokenId]);
        }

        return; // Ladder mode handles its own entry via executeLadderBuyStep
      }

      // NORMAL MODE: Original entry logic
      if (this.config.paperTrading) {
        // Paper trading: simulate buy at ask price
        const availableBalance = this.getAvailableBalance();
        if (availableBalance < 1) {
          this.log("Insufficient paper balance");
          return;
        }

        // Reserve the balance to prevent concurrent overspending
        this.state.reservedBalance += availableBalance;

        try {
          // Calculate shares: balance / askPrice
          const rawShares = availableBalance / askPrice;
          // Apply paper trading fee (simulates Polymarket's ~1% taker fee)
          const paperFeeRate = this.getPaperFeeRate();
          const shares = rawShares * (1 - paperFeeRate);

          // Check minimum order size (Polymarket requires at least 5 shares)
          if (shares < MIN_ORDER_SIZE) {
            const minUsdc = MIN_ORDER_SIZE * askPrice / (1 - paperFeeRate);
            this.log(`[PAPER] Insufficient balance for ${MIN_ORDER_SIZE} shares (need $${minUsdc.toFixed(2)}, have $${availableBalance.toFixed(2)})`);
            return;
          }

          // Record paper trade
          const tradeId = insertTrade({
            market_slug: market.slug,
            token_id: tokenId,
            side,
            entry_price: askPrice,
            shares,
            cost_basis: availableBalance,
            created_at: new Date().toISOString(),
            market_end_date: endDate.toISOString()
          });

          this.state.positions.set(tokenId, {
            tradeId,
            tokenId,
            shares,
            entryPrice: askPrice,
            side,
            marketSlug: market.slug,
            marketEndDate: endDate
            // No limit orders - using WebSocket monitoring instead
          });

          // Ensure tokenId is subscribed for real-time stop-loss monitoring
          if (this.priceStream.isConnected()) {
            this.priceStream.subscribe([tokenId]);
          }

          // Deduct from paper balance
          this.state.balance -= availableBalance;

          this.log(`[PAPER] Bought ${shares.toFixed(2)} shares of ${side} @ $${askPrice.toFixed(2)} ask (fee: ${(paperFeeRate * 100).toFixed(1)}%)`, {
            marketSlug: market.slug,
            tokenId,
            tradeId
          });
          this.log(`[PAPER] Monitoring for exit: profit @ $${this.getProfitTarget().toFixed(2)}, stop-loss @ $${this.getActiveConfig().stopLoss.toFixed(2)}`);
        } finally {
          // Release the reserved balance
          this.state.reservedBalance -= availableBalance;
        }
      } else {
        // Real trading - use compound-limited balance (set by applyCompoundLimit in tick)
        const availableBalance = this.getAvailableBalance();
        if (availableBalance < 1) {
          this.log("Insufficient balance");
          return;
        }

        // Check minimum order size before attempting trade
        const estimatedShares = availableBalance / askPrice;
        if (estimatedShares < MIN_ORDER_SIZE) {
          const minUsdc = MIN_ORDER_SIZE * askPrice;
          this.log(`Insufficient balance for ${MIN_ORDER_SIZE} shares (need $${minUsdc.toFixed(2)}, have $${availableBalance.toFixed(2)})`);
          return;
        }

        // Reserve the balance to prevent concurrent overspending
        this.state.reservedBalance += availableBalance;

        try {
          const result = await this.trader.buy(tokenId, askPrice, availableBalance);
          if (!result) {
            this.log("Order failed");
            return;
          }

          // Wait for order to fill (with 10s timeout)
          this.log(`Order placed, waiting for fill...`);
          const fillInfo = await this.trader.waitForFill(result.orderId, 10000);

          if (!fillInfo || fillInfo.filledShares <= 0) {
            // Order didn't fill - cancel it and abort
            this.log("Order did not fill, cancelling...");
            await this.trader.cancelOrder(result.orderId);
            return;
          }

          // Use actual fill data instead of assumed values
          const actualShares = fillInfo.filledShares;
          const actualEntryPrice = fillInfo.avgPrice || askPrice;
          const actualCost = actualShares * actualEntryPrice;

          this.log(`Order filled: ${actualShares.toFixed(2)} shares @ $${actualEntryPrice.toFixed(2)}`, {
            marketSlug: market.slug,
            tokenId
          });

          // Wait for position to settle before placing limit sell
          this.log(`Waiting for position settlement...`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3s initial delay

          // Get ACTUAL position balance (may differ from calculated due to fees)
          // Use polling to wait for settlement (API may take time to reflect new position)
          let actualPositionBalance: number | null = null;
          for (let attempt = 1; attempt <= 5; attempt++) {
            actualPositionBalance = await this.trader.getPositionBalance(tokenId);
            if (actualPositionBalance !== null && actualPositionBalance > 0) break;
            if (attempt < 5) {
              await new Promise(resolve => setTimeout(resolve, 1000)); // 1s between attempts
            }
          }
          const sharesToSell = (actualPositionBalance !== null && actualPositionBalance > 0)
            ? actualPositionBalance
            : actualShares;

          if (Math.abs(sharesToSell - actualShares) > 0.01) {
            this.log(`Adjusted shares: ${actualShares.toFixed(2)} → ${sharesToSell.toFixed(2)} (actual balance)`);
          }

          // NO LIMIT ORDER - monitor via WebSocket for profit target and stop-loss
          // This avoids shares being locked by limit orders, which blocks stop-loss execution
          this.log(`Monitoring for exit: profit @ $${this.getProfitTarget().toFixed(2)}, stop-loss @ $${this.getActiveConfig().stopLoss.toFixed(2)}`);

          // Record trade with actual position balance (accounts for fees)
          const tradeId = insertTrade({
            market_slug: market.slug,
            token_id: tokenId,
            side,
            entry_price: actualEntryPrice,
            shares: sharesToSell, // Use actual position balance, not calculated
            cost_basis: actualCost,
            created_at: new Date().toISOString(),
            market_end_date: endDate.toISOString()
          });

          this.state.positions.set(tokenId, {
            tradeId,
            tokenId,
            shares: sharesToSell, // Use actual position balance for stop-loss
            entryPrice: actualEntryPrice,
            side,
            marketSlug: market.slug,
            marketEndDate: endDate
            // No limitOrderId - using WebSocket monitoring instead
          });

          // Ensure tokenId is subscribed for real-time stop-loss monitoring
          if (this.priceStream.isConnected()) {
            this.priceStream.subscribe([tokenId]);
          }

          // Sync balance after trade
          const newBalance = await this.trader.getBalance();
          if (newBalance !== null) {
            this.state.balance = newBalance;
          }
          this.log(`Balance after trade: $${this.state.balance.toFixed(2)}`);
        } finally {
          // Release reserved balance
          this.state.reservedBalance -= availableBalance;
        }
      }
    } finally {
      // MUTEX: Always release the lock
      this.state.pendingEntries.delete(tokenId);
    }
  }

  getState(): BotState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  getWsStats(): WsStats {
    return {
      marketConnected: this.state.wsConnected,
      marketLastMessageAt: this.priceStream.getLastMessageAt(),
      marketSubscriptionCount: this.priceStream.getSubscriptionCount(),
      marketPriceCount: this.priceStream.getPriceCount(),
      userConnected: this.state.userWsConnected,
      userLastMessageAt: this.userStream ? this.userStream.getLastMessageAt() : 0,
      userMarketCount: this.userStream ? this.userStream.getMarketCount() : 0,
      priceMaxAgeMs: this.getWsPriceMaxAgeMs()
    };
  }

  async getMarketOverview(): Promise<EligibleMarket[]> {
    const activeConfig = this.getActiveConfig();

    // Only refresh markets periodically, not every UI render
    const now = new Date();
    const shouldRefresh = !this.lastMarketRefresh ||
                         (now.getTime() - this.lastMarketRefresh.getTime()) > this.getMarketRefreshInterval();

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

  /**
   * Get the ConfigManager instance (for UI display)
   */
  getConfigManager(): ConfigManager {
    return this.configManager;
  }
}
