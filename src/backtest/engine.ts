import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  HistoricalMarket,
  PerformanceMetrics,
  PriceTick,
  SimulatedPosition,
  ExitReason,
} from "./types";

interface EquityPoint {
  timestamp: number;
  balance: number;
}

interface DrawdownPoint {
  timestamp: number;
  drawdown: number;
}

/**
 * Core backtesting engine that simulates trading logic
 * Mirrors the exact behavior from bot.ts
 */
export class BacktestEngine {
  private config: BacktestConfig;
  private balance: number;
  private savedProfit: number = 0; // Profit taken out via compound limit
  private position: SimulatedPosition | null = null;
  private trades: BacktestTrade[] = [];
  private equityCurve: EquityPoint[] = [];
  private peakBalance: number;
  private lastTrade: BacktestTrade | null = null;
  private currentMarket: HistoricalMarket | null = null;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.balance = config.startingBalance;
    this.peakBalance = config.startingBalance;
    this.savedProfit = 0;
  }

  /**
   * Run backtest on a set of historical markets
   * Processes ALL ticks chronologically across ALL markets (like real bot)
   */
  run(markets: HistoricalMarket[]): BacktestResult {
    // Reset state
    this.balance = this.config.startingBalance;
    this.savedProfit = 0;
    this.position = null;
    this.trades = [];
    this.equityCurve = [];
    this.peakBalance = this.config.startingBalance;
    this.lastTrade = null;

    // Build a map of markets by slug for quick lookup
    const marketMap = new Map<string, HistoricalMarket>();
    for (const market of markets) {
      marketMap.set(market.slug, market);
    }

    // Collect ALL ticks from ALL markets with their market reference
    const allTicks: { tick: PriceTick; market: HistoricalMarket }[] = [];
    for (const market of markets) {
      for (const tick of market.priceTicks) {
        allTicks.push({ tick, market });
      }
    }

    // Sort ALL ticks chronologically
    allTicks.sort((a, b) => a.tick.timestamp - b.tick.timestamp);

    // Track which markets have expired (to force close positions)
    const expiredMarkets = new Set<string>();

    // Process all ticks in chronological order
    for (const { tick, market } of allTicks) {
      // Check if any market has expired and we have a position in it
      if (this.position && !expiredMarkets.has(this.position.marketSlug)) {
        const positionMarket = marketMap.get(this.position.marketSlug);
        if (positionMarket && tick.timestamp >= positionMarket.endDate.getTime()) {
          this.closePositionAtExpiry(positionMarket);
          expiredMarkets.add(this.position?.marketSlug || positionMarket.slug);
        }
      }

      // Skip ticks from expired markets
      if (expiredMarkets.has(market.slug)) {
        continue;
      }

      // Mark market as expired if this tick is at or after end time
      if (tick.timestamp >= market.endDate.getTime()) {
        if (this.position && this.position.marketSlug === market.slug) {
          this.closePositionAtExpiry(market);
        }
        expiredMarkets.add(market.slug);
        continue;
      }

      this.currentMarket = market;
      this.processTick(tick, market);
    }

    // Force close any remaining open position
    if (this.position) {
      const market = marketMap.get(this.position.marketSlug);
      if (market) {
        this.closePositionAtExpiry(market);
      }
    }

    // Calculate metrics
    const metrics = this.calculateMetrics();

    return {
      config: this.config,
      metrics,
      trades: this.trades,
      equityCurve: this.equityCurve,
      drawdownCurve: this.calculateDrawdownCurve(),
      savedProfit: this.savedProfit,
      finalBalance: this.balance,
    };
  }

  /**
   * Process a single price tick
   */
  private processTick(tick: PriceTick, market: HistoricalMarket): void {
    // If we have a position for this token, check exit conditions
    if (this.position && this.position.tokenId === tick.tokenId) {
      // Check profit target
      if (tick.bestBid >= this.config.profitTarget) {
        this.executeExit(this.config.profitTarget, tick.timestamp, "PROFIT_TARGET");
        return;
      }

      // Check stop-loss
      this.checkStopLoss(tick);
      return;
    }

    // If no position, check entry conditions
    if (!this.position && this.balance >= 1) {
      this.checkEntry(tick, market);
    }
  }

  /**
   * Check stop-loss conditions - execute immediately if triggered
   */
  private checkStopLoss(tick: PriceTick): void {
    if (!this.position) return;

    const currentBid = tick.bestBid;

    // Check if price is below stop-loss threshold - execute immediately
    if (currentBid <= this.config.stopLoss) {
      this.executeExit(currentBid, tick.timestamp, "STOP_LOSS");
    }
  }

  /**
   * Check entry conditions
   */
  private checkEntry(tick: PriceTick, market: HistoricalMarket): void {
    const now = tick.timestamp;
    const marketEndTime = market.endDate.getTime();

    // Check time window (within configured window before market end)
    const timeRemaining = marketEndTime - now;
    if (timeRemaining <= 0 || timeRemaining > this.config.timeWindowMs) {
      return;
    }

    // Determine which side this token is
    const isUpToken = tick.tokenId === market.upTokenId;
    const side: "UP" | "DOWN" = isUpToken ? "UP" : "DOWN";

    // Check spread
    const spread = tick.bestAsk - tick.bestBid;
    if (spread > this.config.maxSpread) {
      return;
    }

    // Check entry threshold
    const askPrice = tick.bestAsk;
    if (askPrice < this.config.entryThreshold || askPrice > this.config.maxEntryPrice) {
      return;
    }

    // Don't buy if already at profit target
    if (askPrice >= this.config.profitTarget) {
      return;
    }

    // Check opposite-side rule
    // If last trade on same market was a WIN (sold at 99), skip same side
    if (
      this.lastTrade &&
      this.lastTrade.marketSlug === market.slug &&
      this.lastTrade.side === side &&
      this.lastTrade.exitPrice >= this.config.profitTarget
    ) {
      return;
    }

    // All conditions met - enter position
    this.executeEntry(tick, market, side);
  }

  /**
   * Execute entry (buy)
   */
  private executeEntry(
    tick: PriceTick,
    market: HistoricalMarket,
    side: "UP" | "DOWN"
  ): void {
    // Apply slippage to entry price
    const entryPrice = Math.min(
      tick.bestAsk * (1 + this.config.slippage),
      0.99
    );

    // Calculate shares
    const shares = this.balance / entryPrice;

    // Create position
    this.position = {
      tokenId: tick.tokenId,
      marketSlug: market.slug,
      side,
      shares,
      entryPrice,
      entryTimestamp: tick.timestamp,
    };

    // Deduct from balance
    this.balance = 0;
  }

  /**
   * Execute exit (sell)
   */
  private executeExit(
    exitPrice: number,
    exitTimestamp: number,
    exitReason: ExitReason
  ): void {
    if (!this.position) return;

    // Apply slippage for stop-loss exits (market sells)
    const finalExitPrice =
      exitReason === "STOP_LOSS"
        ? Math.max(exitPrice * (1 - this.config.slippage), 0.01)
        : exitPrice;

    // Calculate PnL
    const pnl = (finalExitPrice - this.position.entryPrice) * this.position.shares;

    // Create trade record
    const trade: BacktestTrade = {
      marketSlug: this.position.marketSlug,
      tokenId: this.position.tokenId,
      side: this.position.side,
      entryPrice: this.position.entryPrice,
      exitPrice: finalExitPrice,
      shares: this.position.shares,
      entryTimestamp: this.position.entryTimestamp,
      exitTimestamp,
      exitReason,
      pnl,
    };

    this.trades.push(trade);
    this.lastTrade = trade;

    // Update balance
    const proceeds = finalExitPrice * this.position.shares;
    this.balance = proceeds;

    // Update equity curve
    this.equityCurve.push({
      timestamp: exitTimestamp,
      balance: this.balance,
    });

    // Update peak for drawdown calculation
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    // Clear position
    this.position = null;

    // Check compound limit (take profits if balance exceeds limit)
    this.checkCompoundLimit();
  }

  /**
   * Check compound limit and take profits if balance exceeds threshold
   * Mirrors bot.ts behavior
   */
  private checkCompoundLimit(): void {
    if (this.config.compoundLimit <= 0) return; // Disabled
    if (this.balance <= this.config.compoundLimit) return; // Not exceeded

    // Take profit: move excess to savedProfit, reset to baseBalance
    const profit = this.balance - this.config.baseBalance;
    this.savedProfit += profit;
    this.balance = this.config.baseBalance;
  }

  /**
   * Force close position at market expiry
   */
  private closePositionAtExpiry(market: HistoricalMarket): void {
    if (!this.position) return;

    // Determine outcome - if market outcome matches our side, we win
    let exitPrice: number;
    if (market.outcome === this.position.side) {
      exitPrice = this.config.profitTarget; // Won - resolves at $0.99
    } else if (market.outcome) {
      exitPrice = 0.01; // Lost - resolves near $0
    } else {
      // Unknown outcome - assume it resolved at current price
      exitPrice = this.config.profitTarget; // Assume win if entry was high
    }

    this.executeExit(exitPrice, market.endDate.getTime(), "MARKET_RESOLVED");
  }

  /**
   * Calculate performance metrics
   */
  private calculateMetrics(): PerformanceMetrics {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

    // Win rate
    const winRate = this.trades.length > 0 ? wins.length / this.trades.length : 0;

    // Max drawdown
    const { maxDrawdown, maxDrawdownPercent } = this.calculateMaxDrawdown();

    // Sharpe ratio (assuming risk-free rate of 0)
    const returns = this.trades.map(t => t.pnl / this.config.startingBalance);
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdDev = returns.length > 0
      ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(returns.length) : 0;

    // Profit factor
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Consecutive wins/losses
    const { maxConsecutiveWins, maxConsecutiveLosses } = this.calculateConsecutive();

    // Expectancy
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

    // Return on capital
    const returnOnCapital = totalPnL / this.config.startingBalance;

    return {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnL,
      maxDrawdown,
      maxDrawdownPercent,
      sharpeRatio,
      profitFactor,
      avgWin,
      avgLoss,
      avgTradeReturn: this.trades.length > 0 ? totalPnL / this.trades.length : 0,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      expectancy,
      returnOnCapital,
    };
  }

  /**
   * Calculate max drawdown from equity curve
   */
  private calculateMaxDrawdown(): { maxDrawdown: number; maxDrawdownPercent: number } {
    if (this.equityCurve.length === 0) {
      return { maxDrawdown: 0, maxDrawdownPercent: 0 };
    }

    let peak = this.config.startingBalance;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;

    for (const point of this.equityCurve) {
      if (point.balance > peak) {
        peak = point.balance;
      }
      const drawdown = peak - point.balance;
      const drawdownPercent = peak > 0 ? drawdown / peak : 0;

      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = drawdownPercent;
      }
    }

    return { maxDrawdown, maxDrawdownPercent };
  }

  /**
   * Calculate drawdown curve
   */
  private calculateDrawdownCurve(): DrawdownPoint[] {
    if (this.equityCurve.length === 0) {
      return [];
    }

    const drawdownCurve: DrawdownPoint[] = [];
    let peak = this.config.startingBalance;

    for (const point of this.equityCurve) {
      if (point.balance > peak) {
        peak = point.balance;
      }
      const drawdown = peak > 0 ? (peak - point.balance) / peak : 0;
      drawdownCurve.push({
        timestamp: point.timestamp,
        drawdown,
      });
    }

    return drawdownCurve;
  }

  /**
   * Calculate consecutive wins and losses
   */
  private calculateConsecutive(): { maxConsecutiveWins: number; maxConsecutiveLosses: number } {
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentWins = 0;
    let currentLosses = 0;

    for (const trade of this.trades) {
      if (trade.pnl > 0) {
        currentWins++;
        currentLosses = 0;
        if (currentWins > maxConsecutiveWins) {
          maxConsecutiveWins = currentWins;
        }
      } else {
        currentLosses++;
        currentWins = 0;
        if (currentLosses > maxConsecutiveLosses) {
          maxConsecutiveLosses = currentLosses;
        }
      }
    }

    return { maxConsecutiveWins, maxConsecutiveLosses };
  }
}

/**
 * Run a single backtest with given config and markets
 */
export function runBacktest(
  config: BacktestConfig,
  markets: HistoricalMarket[]
): BacktestResult {
  const engine = new BacktestEngine(config);
  return engine.run(markets);
}
