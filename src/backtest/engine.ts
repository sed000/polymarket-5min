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
import type { LadderStep } from "../config";

interface EquityPoint {
  timestamp: number;
  balance: number;
}

interface DrawdownPoint {
  timestamp: number;
  drawdown: number;
}

interface LadderState {
  tokenId: string;
  side: "UP" | "DOWN";
  marketSlug: string;
  marketEndDate: Date;
  currentStepIndex: number;
  currentStepPhase: "buy" | "sell";
  completedSteps: string[];
  skippedSteps: string[];
  skippedReasons: Map<string, string>;
  totalShares: number;
  totalCostBasis: number;
  averageEntryPrice: number;
  totalSharesSold: number;
  totalSellProceeds: number;
  ladderStartTime: number;
  lastStepTime: number;
  lastStepPrice: number;
  needsRecovery: boolean;
  status: "active" | "completed" | "stopped";
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
  private ladderState: LadderState | null = null;
  private ladderMarketLocks: Set<string> = new Set();
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
    this.ladderState = null;
    this.ladderMarketLocks = new Set();
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

      // Check if any market has expired and we have an active ladder in it
      if (this.ladderState && !expiredMarkets.has(this.ladderState.marketSlug)) {
        const ladderMarket = marketMap.get(this.ladderState.marketSlug);
        if (ladderMarket && tick.timestamp >= ladderMarket.endDate.getTime()) {
          this.closeLadderAtExpiry(ladderMarket);
          expiredMarkets.add(this.ladderState?.marketSlug || ladderMarket.slug);
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
        if (this.ladderState && this.ladderState.marketSlug === market.slug) {
          this.closeLadderAtExpiry(market);
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
    if (this.ladderState) {
      const market = marketMap.get(this.ladderState.marketSlug);
      if (market) {
        this.closeLadderAtExpiry(market);
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
    if (this.config.riskMode === "ladder") {
      this.processLadderTick(tick, market);
      return;
    }

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

    // Check opposite-side rule (using PnL for parity with bot.ts)
    // If last trade on same market was a WIN (positive PnL), skip same side
    if (
      this.lastTrade &&
      this.lastTrade.marketSlug === market.slug &&
      this.lastTrade.side === side &&
      this.lastTrade.pnl > 0
    ) {
      return;
    }

    // All conditions met - enter position
    this.executeEntry(tick, market, side);
  }

  // ============================================================================
  // LADDER MODE METHODS
  // ============================================================================

  private isLadderMarketLocked(marketSlug: string): boolean {
    return this.ladderMarketLocks.has(marketSlug);
  }

  private lockLadderMarket(marketSlug: string): void {
    this.ladderMarketLocks.add(marketSlug);
  }

  private clearLadderMarketLock(marketSlug: string): void {
    this.ladderMarketLocks.delete(marketSlug);
  }

  private processLadderTick(tick: PriceTick, market: HistoricalMarket): void {
    const ladderSteps = this.config.ladderSteps ?? [];
    if (ladderSteps.length === 0) {
      return;
    }

    // Active ladder state: only process ticks for its token
    if (this.ladderState) {
      if (tick.tokenId !== this.ladderState.tokenId) return;
      this.processLadderStateTick(tick, market, ladderSteps);
      return;
    }

    // No active ladder - check entry conditions
    if (this.balance < 1) return;
    if (this.isLadderMarketLocked(market.slug)) return;

    const now = tick.timestamp;
    const marketEndTime = market.endDate.getTime();
    const timeRemaining = marketEndTime - now;
    if (timeRemaining <= 0 || timeRemaining > this.config.timeWindowMs) {
      return;
    }

    const spread = tick.bestAsk - tick.bestBid;
    if (spread > this.config.maxSpread) {
      return;
    }

    const askPrice = tick.bestAsk;
    if (askPrice < this.config.entryThreshold || askPrice > this.config.maxEntryPrice) {
      return;
    }

    const isUpToken = tick.tokenId === market.upTokenId;
    const side: "UP" | "DOWN" = isUpToken ? "UP" : "DOWN";

    if (
      this.lastTrade &&
      this.lastTrade.marketSlug === market.slug &&
      this.lastTrade.side === side &&
      this.lastTrade.pnl > 0
    ) {
      return;
    }

    const firstEnabledStep = ladderSteps.find(step => step.enabled);
    if (!firstEnabledStep) return;

    // Only start ladder if price is ABOVE the first buy trigger (we want to catch the drop)
    if (askPrice < firstEnabledStep.buy.triggerPrice) {
      return;
    }

    const ladderState = this.initializeLadderState(tick.tokenId, side, market.slug, market.endDate);
    ladderState.lastStepPrice = askPrice;
    ladderState.lastStepTime = tick.timestamp;
    this.ladderState = ladderState;

    const priceTolerance = 0.005;
    if (Math.abs(askPrice - firstEnabledStep.buy.triggerPrice) <= priceTolerance) {
      this.executeLadderBuyStep(tick, ladderState, firstEnabledStep);
    }
  }

  private processLadderStateTick(
    tick: PriceTick,
    _market: HistoricalMarket,
    ladderSteps: LadderStep[]
  ): void {
    if (!this.ladderState) return;

    if (!this.ladderState.currentStepPhase) {
      this.ladderState.currentStepPhase = "buy";
    }

    const hasShares = this.getOpenLadderShares(this.ladderState) > 0.01;
    const stopLossStep = this.getActiveStopLossStep(this.ladderState, ladderSteps);
    if (hasShares && stopLossStep && tick.bestBid > 0 && tick.bestBid <= stopLossStep.stopLoss) {
      this.executeLadderStopLoss(tick, this.ladderState, stopLossStep);
      return;
    }

    if (this.ladderState.status !== "active") return;

    // Recovery gating after stop-loss
    if (this.ladderState.needsRecovery) {
      const firstBuyStep = ladderSteps.find(s => s.enabled);
      if (firstBuyStep && tick.bestAsk > 0 && tick.bestAsk > firstBuyStep.buy.triggerPrice) {
        this.ladderState.needsRecovery = false;
        this.ladderState.lastStepTime = tick.timestamp;
      } else {
        return;
      }
    }

    const nextStep = this.getActiveStep(this.ladderState, ladderSteps);
    if (!nextStep) {
      if (this.ladderState.status === "active") {
        this.ladderState.status = "completed";
        this.lockLadderMarket(this.ladderState.marketSlug);
        const remainingShares = this.ladderState.totalShares - this.ladderState.totalSharesSold;
        if (remainingShares < 0.01) {
          this.ladderState = null;
        }
      }
      return;
    }

    const stepPhase = this.ladderState.currentStepPhase ?? "buy";
    if (stepPhase === "buy") {
      if (tick.bestAsk > 0 && tick.bestAsk <= nextStep.buy.triggerPrice) {
        this.executeLadderBuyStep(tick, this.ladderState, nextStep);
      }
    } else if (stepPhase === "sell") {
      if (tick.bestBid > 0 && tick.bestBid >= nextStep.sell.triggerPrice) {
        this.executeLadderSellStep(tick, this.ladderState, nextStep);
      }
    }
  }

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
      needsRecovery: false,
      status: "active",
    };
  }

  private getActiveStep(ladderState: LadderState, steps: LadderStep[]): LadderStep | null {
    if (ladderState.currentStepIndex >= steps.length) {
      return null;
    }

    const step = steps[ladderState.currentStepIndex];
    if (!step.enabled) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, steps);
    }
    if (ladderState.completedSteps.includes(step.id)) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, steps);
    }
    if (ladderState.skippedSteps.includes(step.id)) {
      ladderState.currentStepIndex++;
      return this.getActiveStep(ladderState, steps);
    }

    return step;
  }

  private getActiveStopLossStep(ladderState: LadderState, steps: LadderStep[]): LadderStep | null {
    let index = ladderState.currentStepIndex;
    while (index < steps.length) {
      const step = steps[index];
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

    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step.enabled) {
        return step;
      }
    }

    return null;
  }

  private skipLadderStep(ladderState: LadderState, stepId: string, reason: string): void {
    ladderState.skippedSteps.push(stepId);
    ladderState.skippedReasons.set(stepId, reason);
  }

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

  private executeLadderBuyStep(
    tick: PriceTick,
    ladderState: LadderState,
    step: LadderStep
  ): void {
    if (ladderState.completedSteps.includes(step.id)) {
      return;
    }
    if (ladderState.skippedSteps.includes(step.id)) {
      return;
    }

    const availableBalance = this.balance;
    const buyAmount = this.calculateStepSize("buy", step.buy, ladderState, availableBalance, tick.bestAsk);

    if (buyAmount < 1) {
      this.skipLadderStep(ladderState, step.id, "insufficient_balance");
      ladderState.currentStepIndex++;
      ladderState.currentStepPhase = "buy";
      return;
    }

    const entryPrice = Math.min(
      tick.bestAsk * (1 + this.config.slippage),
      0.99
    );
    const shares = buyAmount / entryPrice;

    ladderState.totalShares += shares;
    ladderState.totalCostBasis += buyAmount;
    ladderState.averageEntryPrice = ladderState.totalCostBasis / ladderState.totalShares;
    ladderState.lastStepTime = tick.timestamp;
    ladderState.lastStepPrice = tick.bestAsk;

    this.balance -= buyAmount;

    ladderState.currentStepPhase = "sell";
  }

  private executeLadderSellStep(
    tick: PriceTick,
    ladderState: LadderState,
    step: LadderStep
  ): void {
    if (ladderState.completedSteps.includes(step.id)) {
      return;
    }
    if (ladderState.skippedSteps.includes(step.id)) {
      return;
    }

    const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;
    const sellShares = this.calculateStepSize("sell", step.sell, ladderState, 0, tick.bestBid);

    if (sellShares < 0.01 || remainingShares < 0.01) {
      this.skipLadderStep(ladderState, step.id, "insufficient_shares");
      ladderState.currentStepIndex++;
      ladderState.currentStepPhase = "buy";
      return;
    }

    const actualSellShares = Math.min(sellShares, remainingShares);
    const proceeds = actualSellShares * tick.bestBid;

    const costBasisPortion =
      ladderState.totalShares > 0
        ? (actualSellShares / ladderState.totalShares) * ladderState.totalCostBasis
        : 0;
    const pnl = proceeds - costBasisPortion;

    ladderState.totalSharesSold += actualSellShares;
    ladderState.totalSellProceeds += proceeds;
    this.balance += proceeds;

    const trade: BacktestTrade = {
      marketSlug: ladderState.marketSlug,
      tokenId: ladderState.tokenId,
      side: ladderState.side,
      entryPrice: ladderState.averageEntryPrice,
      exitPrice: tick.bestBid,
      shares: actualSellShares,
      entryTimestamp: ladderState.lastStepTime,
      exitTimestamp: tick.timestamp,
      exitReason: "LADDER_STEP_SELL",
      pnl,
      ladderStepId: step.id,
    };
    this.recordLadderTrade(trade);

    ladderState.completedSteps.push(step.id);
    ladderState.currentStepIndex++;
    ladderState.currentStepPhase = "buy";
    ladderState.lastStepTime = tick.timestamp;
    ladderState.lastStepPrice = tick.bestBid;

    const remainingAfterSell = ladderState.totalShares - ladderState.totalSharesSold;
    if (remainingAfterSell < 0.01) {
      ladderState.totalShares = 0;
      ladderState.totalCostBasis = 0;
      ladderState.averageEntryPrice = 0;
      ladderState.totalSharesSold = 0;
      ladderState.totalSellProceeds = 0;
    }

    this.checkCompoundLimit();
  }

  private executeLadderStopLoss(
    tick: PriceTick,
    ladderState: LadderState,
    step: LadderStep
  ): void {
    const openShares = this.getOpenLadderShares(ladderState);
    if (openShares < 0.01) {
      this.clearLadderMarketLock(ladderState.marketSlug);
      this.resetLadderState(ladderState);
      return;
    }

    const exitPrice = Math.max(tick.bestBid * (1 - this.config.slippage), 0.01);
    const proceeds = openShares * exitPrice;
    const costBasisPortion =
      ladderState.totalShares > 0
        ? (openShares / ladderState.totalShares) * ladderState.totalCostBasis
        : 0;
    const pnl = proceeds - costBasisPortion;

    ladderState.totalSharesSold += openShares;
    ladderState.totalSellProceeds += proceeds;
    this.balance += proceeds;

    const trade: BacktestTrade = {
      marketSlug: ladderState.marketSlug,
      tokenId: ladderState.tokenId,
      side: ladderState.side,
      entryPrice: ladderState.averageEntryPrice,
      exitPrice,
      shares: openShares,
      entryTimestamp: ladderState.lastStepTime,
      exitTimestamp: tick.timestamp,
      exitReason: "LADDER_STOP_LOSS",
      pnl,
      ladderStepId: step.id,
    };
    this.recordLadderTrade(trade);

    this.checkCompoundLimit();
    this.clearLadderMarketLock(ladderState.marketSlug);
    this.resetLadderState(ladderState);
  }

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
    ladderState.needsRecovery = true;
    ladderState.status = "active";
  }

  private getOpenLadderShares(ladderState: LadderState): number {
    return Math.max(0, ladderState.totalShares - ladderState.totalSharesSold);
  }

  private recordLadderTrade(trade: BacktestTrade): void {
    this.trades.push(trade);
    this.lastTrade = trade;

    this.equityCurve.push({
      timestamp: trade.exitTimestamp,
      balance: this.balance,
    });

    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }
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
   * Force close ladder position at market expiry
   */
  private closeLadderAtExpiry(market: HistoricalMarket): void {
    if (!this.ladderState) return;

    const ladderState = this.ladderState;
    const remainingShares = ladderState.totalShares - ladderState.totalSharesSold;

    if (remainingShares < 0.01) {
      this.ladderState = null;
      return;
    }

    let exitPrice: number;
    if (market.outcome === ladderState.side) {
      exitPrice = this.config.profitTarget;
    } else if (market.outcome) {
      exitPrice = 0.01;
    } else {
      exitPrice = this.config.profitTarget;
    }

    const proceeds = remainingShares * exitPrice;
    const costBasisPortion =
      ladderState.totalShares > 0
        ? (remainingShares / ladderState.totalShares) * ladderState.totalCostBasis
        : 0;
    const pnl = proceeds - costBasisPortion;

    ladderState.totalSharesSold += remainingShares;
    ladderState.totalSellProceeds += proceeds;
    this.balance += proceeds;

    const trade: BacktestTrade = {
      marketSlug: ladderState.marketSlug,
      tokenId: ladderState.tokenId,
      side: ladderState.side,
      entryPrice: ladderState.averageEntryPrice,
      exitPrice,
      shares: remainingShares,
      entryTimestamp: ladderState.lastStepTime,
      exitTimestamp: market.endDate.getTime(),
      exitReason: "MARKET_RESOLVED",
      pnl,
    };
    this.recordLadderTrade(trade);

    this.checkCompoundLimit();
    this.ladderState = null;
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
