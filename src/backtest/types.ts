import type { RiskMode } from "../bot";

// Configuration for a single backtest run
export interface BacktestConfig {
  // Strategy parameters
  entryThreshold: number;
  maxEntryPrice: number;
  stopLoss: number;
  maxSpread: number;
  timeWindowMs: number;
  profitTarget: number;

  // Simulation settings
  startingBalance: number;
  startDate: Date;
  endDate: Date;
  slippage: number; // Simulated slippage (e.g., 0.001 = 0.1%)

  // Compounding / profit taking
  compoundLimit: number; // Take profit when balance exceeds this (0 = disabled)
  baseBalance: number; // Reset to this balance after taking profit

  // Risk mode
  riskMode: RiskMode;
}

// Parameter ranges for optimization
export interface OptimizationRanges {
  entryThreshold?: { min: number; max: number; step: number };
  maxEntryPrice?: { min: number; max: number; step: number };
  stopLoss?: { min: number; max: number; step: number };
  maxSpread?: { min: number; max: number; step: number };
  timeWindowMs?: { min: number; max: number; step: number };
}

// Historical price tick
export interface PriceTick {
  timestamp: number;
  tokenId: string;
  marketSlug: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
}

// Market for replay
export interface HistoricalMarket {
  slug: string;
  question: string;
  startDate: Date;
  endDate: Date;
  upTokenId: string;
  downTokenId: string;
  outcome: "UP" | "DOWN" | null;
  priceTicks: PriceTick[];
}

// Simulated position during backtest
export interface SimulatedPosition {
  tokenId: string;
  marketSlug: string;
  side: "UP" | "DOWN";
  shares: number;
  entryPrice: number;
  entryTimestamp: number;
  dynamicStopLoss?: number; // Entry-relative stop-loss for dynamic-risk mode
}

// Exit reasons
export type ExitReason = "PROFIT_TARGET" | "STOP_LOSS" | "MARKET_RESOLVED" | "TIME_EXIT";

// Single trade result
export interface BacktestTrade {
  marketSlug: string;
  tokenId: string;
  side: "UP" | "DOWN";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  entryTimestamp: number;
  exitTimestamp: number;
  exitReason: ExitReason;
  pnl: number;
}

// Performance metrics
export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgTradeReturn: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  expectancy: number;
  returnOnCapital: number;
}

// Full backtest result
export interface BacktestResult {
  runId?: number;
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  trades: BacktestTrade[];
  equityCurve: { timestamp: number; balance: number }[];
  drawdownCurve: { timestamp: number; drawdown: number }[];
  savedProfit: number; // Profit taken out via compound limit
  finalBalance: number; // Balance at end of backtest
}

// Optimization result for a single config
export interface OptimizationResult {
  config: BacktestConfig;
  metrics: PerformanceMetrics;
  rank: number;
}

// Database record for historical market
export interface HistoricalMarketRecord {
  id: number;
  market_slug: string;
  start_date: string;
  end_date: string;
  up_token_id: string;
  down_token_id: string;
  outcome: string | null;
  fetched_at: string;
}

// Database record for price history
export interface PriceHistoryRecord {
  id: number;
  token_id: string;
  market_slug: string;
  timestamp: number;
  best_bid: number;
  best_ask: number;
  mid_price: number;
}

// Database record for backtest run
export interface BacktestRunRecord {
  id: number;
  name: string | null;
  config_json: string;
  markets_tested: number;
  created_at: string;
  completed_at: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED";
}

// Database record for backtest trade
export interface BacktestTradeRecord {
  id: number;
  run_id: number;
  market_slug: string;
  token_id: string;
  side: string;
  entry_price: number;
  exit_price: number | null;
  shares: number;
  entry_timestamp: number;
  exit_timestamp: number | null;
  exit_reason: string | null;
  pnl: number | null;
}

// Default optimization ranges
export const DEFAULT_OPTIMIZATION_RANGES: OptimizationRanges = {
  entryThreshold: { min: 0.70, max: 0.96, step: 0.02 },
  maxEntryPrice: { min: 0.92, max: 0.99, step: 0.01 },
  stopLoss: { min: 0.30, max: 0.80, step: 0.05 },
  maxSpread: { min: 0.02, max: 0.08, step: 0.02 },
  timeWindowMs: { min: 60000, max: 900000, step: 120000 }, // 1-15 minutes
};

// Default backtest config
export const DEFAULT_BACKTEST_CONFIG: Omit<BacktestConfig, "startDate" | "endDate"> = {
  entryThreshold: 0.95,
  maxEntryPrice: 0.98,
  stopLoss: 0.80,
  maxSpread: 0.03,
  timeWindowMs: 5 * 60 * 1000,
  profitTarget: 0.99,
  startingBalance: 100,
  slippage: 0.001,
  compoundLimit: 0, // Disabled by default
  baseBalance: 10,
  riskMode: "normal",
};

// Super-risk preset
export const SUPER_RISK_CONFIG: Partial<BacktestConfig> = {
  entryThreshold: 0.70,
  maxEntryPrice: 0.95,
  stopLoss: 0.40,
  maxSpread: 0.05,
  timeWindowMs: 15 * 60 * 1000,
  riskMode: "super-risk",
};

// Safe preset - conservative with tight stop-loss
export const SAFE_CONFIG: Partial<BacktestConfig> = {
  entryThreshold: 0.95,
  maxEntryPrice: 0.98,
  stopLoss: 0.90,
  profitTarget: 0.98,
  maxSpread: 0.03,
  timeWindowMs: 5 * 60 * 1000,
  riskMode: "safe",
};

/**
 * Dynamic-risk preset - adaptive entry threshold and entry-relative stop-loss
 *
 * This mode mirrors the bot's dynamic-risk behavior:
 * - Base entry threshold: $0.70
 * - Entry threshold increases by $0.05 per consecutive loss (capped at $0.85)
 * - Stop-loss is 32.5% below entry price (entry-relative, not fixed)
 * - Wider spreads trigger +$0.03 threshold adjustment
 *
 * The static config values here are starting points; the backtest engine
 * will dynamically adjust threshold and calculate per-position stop-loss.
 */
export const DYNAMIC_RISK_CONFIG: Partial<BacktestConfig> = {
  entryThreshold: 0.70, // Base threshold - adjusted dynamically per loss streak
  maxEntryPrice: 0.95,
  stopLoss: 0.40, // Fallback only - engine uses entry-relative stop-loss
  profitTarget: 0.98,
  maxSpread: 0.05,
  timeWindowMs: 15 * 60 * 1000,
  riskMode: "dynamic-risk",
};

// Dynamic-risk constants (matching bot.ts)
export const DYNAMIC_RISK_BASE_THRESHOLD = 0.70;
export const DYNAMIC_RISK_THRESHOLD_INCREMENT = 0.05;
export const DYNAMIC_RISK_MAX_THRESHOLD = 0.85;
export const DYNAMIC_RISK_MAX_DRAWDOWN_PERCENT = 0.325; // 32.5%
export const DYNAMIC_RISK_SPREAD_ADJUSTMENT = 0.03;
