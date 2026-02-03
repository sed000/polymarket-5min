import { Database } from "bun:sqlite";

let db: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Initialize the database for trading mode
 * - Real trading: trades_real.db
 * - Paper trading: trades_paper_normal.db
 */
export function initDatabase(paperTrading: boolean): void {
  const dbPath = paperTrading ? "trades_paper_normal.db" : "trades_real.db";

  // Skip if already using this database
  if (currentDbPath === dbPath && db) {
    return;
  }

  // Close existing connection if any
  if (db) {
    db.close();
  }

  currentDbPath = dbPath;
  db = new Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_slug TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      shares REAL NOT NULL,
      cost_basis REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      pnl REAL,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      market_end_date TEXT
    )
  `);

  // Add market_end_date column if it doesn't exist (for existing DBs)
  try {
    db.run("ALTER TABLE trades ADD COLUMN market_end_date TEXT");
  } catch (err) {
    // Column already exists - this is expected for existing databases
    // Only log if it's an unexpected error
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }

  // Add ladder mode columns (for existing DBs)
  try {
    db.run("ALTER TABLE trades ADD COLUMN is_ladder_trade INTEGER DEFAULT 0");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }
  try {
    db.run("ALTER TABLE trades ADD COLUMN ladder_step_id TEXT");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }
  try {
    db.run("ALTER TABLE trades ADD COLUMN ladder_state_json TEXT");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }

  // Ladder market locks (prevent re-entry after ladder completion)
  db.run(`
    CREATE TABLE IF NOT EXISTS ladder_market_locks (
      market_slug TEXT PRIMARY KEY,
      locked_at TEXT NOT NULL
    )
  `);

  // Activity logs table for persistent logging
  db.run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      timestamp_unix INTEGER NOT NULL,
      message TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'INFO',
      market_slug TEXT,
      token_id TEXT,
      trade_id INTEGER,
      metadata TEXT
    )
  `);

  // Create indexes for efficient querying
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON activity_logs(timestamp_unix DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_market ON activity_logs(market_slug)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_level ON activity_logs(level)`);

  console.log(`Database initialized: ${dbPath}`);
}

export function getDbPath(): string {
  return currentDbPath || "not initialized";
}

function ensureDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export interface Trade {
  id: number;
  market_slug: string;
  token_id: string;
  side: "UP" | "DOWN";
  entry_price: number;
  exit_price: number | null;
  shares: number;
  cost_basis: number;
  status: "OPEN" | "STOPPED" | "RESOLVED";
  pnl: number | null;
  created_at: string;
  closed_at: string | null;
  market_end_date: string | null;
  // Ladder mode fields
  is_ladder_trade?: number;
  ladder_step_id?: string | null;
  ladder_state_json?: string | null;
}

export function insertTrade(trade: Omit<Trade, "id" | "exit_price" | "pnl" | "closed_at" | "status">): number {
  try {
    const database = ensureDb();
    const stmt = database.prepare(`
      INSERT INTO trades (market_slug, token_id, side, entry_price, shares, cost_basis, status, created_at, market_end_date)
      VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `);
    const result = stmt.run(
      trade.market_slug,
      trade.token_id,
      trade.side,
      trade.entry_price,
      trade.shares,
      trade.cost_basis,
      trade.created_at,
      trade.market_end_date
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.error(`[DB] CRITICAL: Failed to insert trade: ${err instanceof Error ? err.message : err}`);
    throw err; // Re-throw to ensure caller knows trade wasn't recorded
  }
}

export function closeTrade(id: number, exitPrice: number, status: "STOPPED" | "RESOLVED"): void {
  try {
    const trade = getTradeById(id);
    if (!trade) {
      console.warn(`[DB] closeTrade called for non-existent trade ID: ${id}`);
      return;
    }

    const database = ensureDb();
    const pnl = (exitPrice - trade.entry_price) * trade.shares;
    const stmt = database.prepare(`
      UPDATE trades SET exit_price = ?, status = ?, pnl = ?, closed_at = ?
      WHERE id = ?
    `);
    stmt.run(exitPrice, status, pnl, new Date().toISOString(), id);
  } catch (err) {
    console.error(`[DB] CRITICAL: Failed to close trade ${id}: ${err instanceof Error ? err.message : err}`);
    throw err; // Re-throw to ensure caller knows trade wasn't closed
  }
}

/**
 * Update an open trade's shares and cost basis (used for partial ladder sells)
 */
export function updateTradeShares(tradeId: number, shares: number, costBasis: number): void {
  try {
    const trade = getTradeById(tradeId);
    if (!trade) {
      console.warn(`[DB] updateTradeShares called for non-existent trade ID: ${tradeId}`);
      return;
    }
    if (trade.status !== "OPEN") {
      console.warn(`[DB] updateTradeShares called for non-open trade ID: ${tradeId}`);
      return;
    }
    const database = ensureDb();
    const stmt = database.prepare(`
      UPDATE trades SET shares = ?, cost_basis = ? WHERE id = ?
    `);
    stmt.run(shares, costBasis, tradeId);
  } catch (err) {
    console.error(`[DB] Failed to update trade ${tradeId} shares: ${err instanceof Error ? err.message : err}`);
  }
}

export function getTradeById(id: number): Trade | null {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades WHERE id = ?");
  return stmt.get(id) as Trade | null;
}

/**
 * Update a trade's ladder state JSON
 * Used to persist ladder progress for recovery
 */
export function updateLadderState(tradeId: number, stateJson: string): void {
  try {
    const database = ensureDb();
    const stmt = database.prepare(`
      UPDATE trades SET ladder_state_json = ? WHERE id = ?
    `);
    stmt.run(stateJson, tradeId);
  } catch (err) {
    console.error(`[DB] Failed to update ladder state for trade ${tradeId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Mark a trade as a ladder trade with its step ID
 */
export function markAsLadderTrade(tradeId: number, stepId: string): void {
  try {
    const database = ensureDb();
    const stmt = database.prepare(`
      UPDATE trades SET is_ladder_trade = 1, ladder_step_id = ? WHERE id = ?
    `);
    stmt.run(stepId, tradeId);
  } catch (err) {
    console.error(`[DB] Failed to mark trade ${tradeId} as ladder: ${err instanceof Error ? err.message : err}`);
  }
}

export function getOpenTrades(): Trade[] {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC");
  return stmt.all() as Trade[];
}

export function getRecentTrades(limit = 10): Trade[] {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?");
  return stmt.all(limit) as Trade[];
}

export function getTotalPnL(): number {
  const database = ensureDb();
  const stmt = database.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL");
  const result = stmt.get() as { total: number };
  return result.total;
}

export function getTradeStats() {
  const database = ensureDb();
  const stats = database.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open
    FROM trades
  `).get() as { total: number; wins: number; losses: number; open: number };

  const closedTrades = stats.wins + stats.losses;
  return {
    total: stats.total,
    wins: stats.wins,
    losses: stats.losses,
    open: stats.open,
    winRate: closedTrades > 0 ? (stats.wins / closedTrades) * 100 : 0
  };
}

export function getLastClosedTrade(): Trade | null {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades WHERE status != 'OPEN' ORDER BY closed_at DESC LIMIT 1");
  return stmt.get() as Trade | null;
}

/**
 * Get the last winning trade for a specific side in a specific market
 * Used by opposite-side rule to prevent chasing after wins
 */
export function getLastWinningTradeInMarket(marketSlug: string, side: "UP" | "DOWN"): Trade | null {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT * FROM trades
    WHERE market_slug = ? AND side = ? AND status != 'OPEN' AND pnl > 0
    ORDER BY closed_at DESC LIMIT 1
  `);
  return stmt.get(marketSlug, side) as Trade | null;
}

// ============================================================================
// LADDER MARKET LOCKS
// ============================================================================

export function getLadderMarketLocks(): string[] {
  const database = ensureDb();
  const rows = database.prepare(`
    SELECT market_slug FROM ladder_market_locks
  `).all() as Array<{ market_slug: string }>;
  return rows.map(row => row.market_slug);
}

export function setLadderMarketLock(marketSlug: string): void {
  const database = ensureDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO ladder_market_locks (market_slug, locked_at)
    VALUES (?, ?)
  `);
  stmt.run(marketSlug, new Date().toISOString());
}

export function clearLadderMarketLock(marketSlug: string): void {
  const database = ensureDb();
  const stmt = database.prepare(`
    DELETE FROM ladder_market_locks WHERE market_slug = ?
  `);
  stmt.run(marketSlug);
}

// ============================================================================
// ACTIVITY LOGS
// ============================================================================

export type LogLevel = "INFO" | "WARN" | "ERROR" | "TRADE" | "SIGNAL" | "WS";

export interface ActivityLog {
  id: number;
  timestamp: string;
  timestamp_unix: number;
  message: string;
  level: LogLevel;
  market_slug: string | null;
  token_id: string | null;
  trade_id: number | null;
  metadata: string | null;
}

export interface LogEntry {
  message: string;
  level?: LogLevel;
  marketSlug?: string;
  tokenId?: string;
  tradeId?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a log entry into the activity_logs table
 */
export function insertLog(entry: LogEntry): number {
  try {
    const database = ensureDb();
    const now = new Date();
    const stmt = database.prepare(`
      INSERT INTO activity_logs (timestamp, timestamp_unix, message, level, market_slug, token_id, trade_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      now.toISOString(),
      now.getTime(),
      entry.message,
      entry.level || "INFO",
      entry.marketSlug || null,
      entry.tokenId || null,
      entry.tradeId || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    // Don't throw on log failures - just console.warn
    console.warn(`[DB] Failed to insert log: ${err instanceof Error ? err.message : err}`);
    return -1;
  }
}

/**
 * Get recent activity logs
 */
export function getRecentLogs(limit = 100): ActivityLog[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT * FROM activity_logs
    ORDER BY timestamp_unix DESC
    LIMIT ?
  `);
  return stmt.all(limit) as ActivityLog[];
}

/**
 * Get logs for a specific market
 */
export function getLogsByMarket(marketSlug: string, limit = 50): ActivityLog[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT * FROM activity_logs
    WHERE market_slug = ?
    ORDER BY timestamp_unix DESC
    LIMIT ?
  `);
  return stmt.all(marketSlug, limit) as ActivityLog[];
}

/**
 * Get logs by level (e.g., all ERROR logs)
 */
export function getLogsByLevel(level: LogLevel, limit = 100): ActivityLog[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT * FROM activity_logs
    WHERE level = ?
    ORDER BY timestamp_unix DESC
    LIMIT ?
  `);
  return stmt.all(level, limit) as ActivityLog[];
}

/**
 * Get logs within a time range
 */
export function getLogsByTimeRange(startTime: Date, endTime: Date, limit = 500): ActivityLog[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT * FROM activity_logs
    WHERE timestamp_unix >= ? AND timestamp_unix <= ?
    ORDER BY timestamp_unix ASC
    LIMIT ?
  `);
  return stmt.all(startTime.getTime(), endTime.getTime(), limit) as ActivityLog[];
}

/**
 * Get log count by level (for stats)
 */
export function getLogStats(): { level: string; count: number }[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT level, COUNT(*) as count
    FROM activity_logs
    GROUP BY level
    ORDER BY count DESC
  `);
  return stmt.all() as { level: string; count: number }[];
}

/**
 * Clear old logs (older than specified days)
 */
export function clearOldLogs(daysToKeep = 30): number {
  const database = ensureDb();
  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  const stmt = database.prepare(`
    DELETE FROM activity_logs
    WHERE timestamp_unix < ?
  `);
  const result = stmt.run(cutoff);
  return result.changes;
}

/**
 * Clear all activity logs
 */
export function clearAllLogs(): void {
  const database = ensureDb();
  database.run("DELETE FROM activity_logs");
  console.log("Activity logs cleared");
}

// ============================================================================
// BACKTEST DATABASE
// ============================================================================

let backtestDb: Database | null = null;
const BACKTEST_DB_PATH = "backtest.db";

/**
 * Initialize the backtest database with all required tables
 */
export function initBacktestDatabase(): void {
  if (backtestDb) return;

  backtestDb = new Database(BACKTEST_DB_PATH);

  // Historical price data for replay
  backtestDb.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      best_bid REAL NOT NULL,
      best_ask REAL NOT NULL,
      mid_price REAL NOT NULL,
      UNIQUE(token_id, timestamp)
    )
  `);

  // Create indexes for fast queries
  backtestDb.run(`CREATE INDEX IF NOT EXISTS idx_price_history_token_ts ON price_history(token_id, timestamp)`);
  backtestDb.run(`CREATE INDEX IF NOT EXISTS idx_price_history_slug ON price_history(market_slug)`);

  // Historical market metadata
  backtestDb.run(`
    CREATE TABLE IF NOT EXISTS historical_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_slug TEXT NOT NULL UNIQUE,
      question TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      up_token_id TEXT NOT NULL,
      down_token_id TEXT NOT NULL,
      outcome TEXT,
      fetched_at TEXT NOT NULL
    )
  `);

  // Backtest runs
  backtestDb.run(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      config_json TEXT NOT NULL,
      markets_tested INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT DEFAULT 'RUNNING'
    )
  `);

  // Backtest trades
  backtestDb.run(`
    CREATE TABLE IF NOT EXISTS backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      market_slug TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL,
      shares REAL NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      exit_timestamp INTEGER,
      exit_reason TEXT,
      pnl REAL,
      is_ladder_trade INTEGER DEFAULT 0,
      ladder_step_id TEXT,
      FOREIGN KEY (run_id) REFERENCES backtest_runs(id)
    )
  `);

  backtestDb.run(`CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id)`);

  // Add ladder columns for existing DBs
  try {
    backtestDb.run("ALTER TABLE backtest_trades ADD COLUMN is_ladder_trade INTEGER DEFAULT 0");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }
  try {
    backtestDb.run("ALTER TABLE backtest_trades ADD COLUMN ladder_step_id TEXT");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("duplicate column")) {
      console.warn(`[DB] ALTER TABLE warning: ${errMsg}`);
    }
  }

  console.log(`Backtest database initialized: ${BACKTEST_DB_PATH}`);
}

function ensureBacktestDb(): Database {
  if (!backtestDb) {
    initBacktestDatabase();
  }
  return backtestDb!;
}

// ============================================================================
// Price History Functions
// ============================================================================

export interface PriceHistoryRow {
  id: number;
  token_id: string;
  market_slug: string;
  timestamp: number;
  best_bid: number;
  best_ask: number;
  mid_price: number;
}

export function storePriceTicks(
  marketSlug: string,
  tokenId: string,
  ticks: Array<{ timestamp: number; bestBid: number; bestAsk: number; midPrice: number }>
): void {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO price_history (token_id, market_slug, timestamp, best_bid, best_ask, mid_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction(() => {
    for (const tick of ticks) {
      stmt.run(tokenId, marketSlug, tick.timestamp, tick.bestBid, tick.bestAsk, tick.midPrice);
    }
  });

  insertMany();
}

export function loadPriceTicks(
  tokenId: string,
  startTs?: number,
  endTs?: number
): PriceHistoryRow[] {
  const database = ensureBacktestDb();

  let query = "SELECT * FROM price_history WHERE token_id = ?";
  const params: (string | number)[] = [tokenId];

  if (startTs !== undefined) {
    query += " AND timestamp >= ?";
    params.push(startTs);
  }
  if (endTs !== undefined) {
    query += " AND timestamp <= ?";
    params.push(endTs);
  }

  query += " ORDER BY timestamp ASC";

  const stmt = database.prepare(query);
  return stmt.all(...params) as PriceHistoryRow[];
}

export function getPriceTickCount(marketSlug: string): number {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM price_history WHERE market_slug = ?");
  const result = stmt.get(marketSlug) as { count: number };
  return result.count;
}

// ============================================================================
// Historical Market Functions
// ============================================================================

export interface HistoricalMarketRow {
  id: number;
  market_slug: string;
  question: string | null;
  start_date: string;
  end_date: string;
  up_token_id: string;
  down_token_id: string;
  outcome: string | null;
  fetched_at: string;
}

export function storeHistoricalMarket(market: {
  slug: string;
  question?: string;
  startDate: Date;
  endDate: Date;
  upTokenId: string;
  downTokenId: string;
  outcome?: "UP" | "DOWN" | null;
}): void {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO historical_markets
    (market_slug, question, start_date, end_date, up_token_id, down_token_id, outcome, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    market.slug,
    market.question || null,
    market.startDate.toISOString(),
    market.endDate.toISOString(),
    market.upTokenId,
    market.downTokenId,
    market.outcome || null,
    new Date().toISOString()
  );
}

export function getHistoricalMarket(slug: string): HistoricalMarketRow | null {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT * FROM historical_markets WHERE market_slug = ?");
  return stmt.get(slug) as HistoricalMarketRow | null;
}

export function loadHistoricalMarketsInRange(startDate: Date, endDate: Date): HistoricalMarketRow[] {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    SELECT * FROM historical_markets
    WHERE end_date >= ? AND start_date <= ?
    ORDER BY start_date ASC
  `);
  return stmt.all(startDate.toISOString(), endDate.toISOString()) as HistoricalMarketRow[];
}

export function getHistoricalMarketCount(): number {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM historical_markets");
  const result = stmt.get() as { count: number };
  return result.count;
}

export function isMarketCached(slug: string): boolean {
  return getHistoricalMarket(slug) !== null;
}

// ============================================================================
// Backtest Run Functions
// ============================================================================

export interface BacktestRunRow {
  id: number;
  name: string | null;
  config_json: string;
  markets_tested: number;
  created_at: string;
  completed_at: string | null;
  status: string;
}

export function insertBacktestRun(
  config: object,
  marketsCount: number,
  name?: string
): number {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    INSERT INTO backtest_runs (name, config_json, markets_tested, created_at, status)
    VALUES (?, ?, ?, ?, 'RUNNING')
  `);
  const result = stmt.run(
    name || null,
    JSON.stringify(config),
    marketsCount,
    new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

export function updateBacktestRunStatus(
  runId: number,
  status: "COMPLETED" | "FAILED"
): void {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    UPDATE backtest_runs SET status = ?, completed_at = ? WHERE id = ?
  `);
  stmt.run(status, new Date().toISOString(), runId);
}

export function getBacktestRun(runId: number): BacktestRunRow | null {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT * FROM backtest_runs WHERE id = ?");
  return stmt.get(runId) as BacktestRunRow | null;
}

export function listBacktestRuns(limit = 20): BacktestRunRow[] {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?");
  return stmt.all(limit) as BacktestRunRow[];
}

// ============================================================================
// Backtest Trade Functions
// ============================================================================

export interface BacktestTradeRow {
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
  is_ladder_trade?: number;
  ladder_step_id?: string | null;
}

export function insertBacktestTrade(
  runId: number,
  trade: {
    marketSlug: string;
    tokenId: string;
    side: "UP" | "DOWN";
    entryPrice: number;
    exitPrice: number;
    shares: number;
    entryTimestamp: number;
    exitTimestamp: number;
    exitReason: string;
    pnl: number;
    ladderStepId?: string;
  }
): number {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    INSERT INTO backtest_trades
    (run_id, market_slug, token_id, side, entry_price, exit_price, shares, entry_timestamp, exit_timestamp, exit_reason, pnl, is_ladder_trade, ladder_step_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    runId,
    trade.marketSlug,
    trade.tokenId,
    trade.side,
    trade.entryPrice,
    trade.exitPrice,
    trade.shares,
    trade.entryTimestamp,
    trade.exitTimestamp,
    trade.exitReason,
    trade.pnl,
    trade.ladderStepId ? 1 : 0,
    trade.ladderStepId ?? null
  );
  return Number(result.lastInsertRowid);
}

export function getBacktestTrades(runId: number): BacktestTradeRow[] {
  const database = ensureBacktestDb();
  const stmt = database.prepare("SELECT * FROM backtest_trades WHERE run_id = ? ORDER BY entry_timestamp ASC");
  return stmt.all(runId) as BacktestTradeRow[];
}

export function getBacktestTradeStats(runId: number) {
  const database = ensureBacktestDb();
  const total = database.prepare("SELECT COUNT(*) as count FROM backtest_trades WHERE run_id = ?").get(runId) as { count: number };
  const wins = database.prepare("SELECT COUNT(*) as count FROM backtest_trades WHERE run_id = ? AND pnl > 0").get(runId) as { count: number };
  const losses = database.prepare("SELECT COUNT(*) as count FROM backtest_trades WHERE run_id = ? AND pnl <= 0").get(runId) as { count: number };
  const totalPnl = database.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM backtest_trades WHERE run_id = ?").get(runId) as { total: number };

  return {
    total: total.count,
    wins: wins.count,
    losses: losses.count,
    totalPnL: totalPnl.total,
    winRate: total.count > 0 ? (wins.count / total.count) * 100 : 0
  };
}

export function clearBacktestData(): void {
  const database = ensureBacktestDb();
  database.run("DELETE FROM backtest_trades");
  database.run("DELETE FROM backtest_runs");
  console.log("Backtest runs and trades cleared");
}

export function clearHistoricalData(): void {
  const database = ensureBacktestDb();
  database.run("DELETE FROM price_history");
  database.run("DELETE FROM historical_markets");
  console.log("Historical market data cleared");
}
