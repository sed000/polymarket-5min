import { Database } from "bun:sqlite";

let db: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Initialize the database based on trading mode
 * - Real trading: trades_real.db
 * - Paper + normal: trades_paper_normal.db
 * - Paper + super-risk: trades_paper_risk.db
 */
export function initDatabase(paperTrading: boolean, riskMode: "normal" | "super-risk"): void {
  let dbPath: string;

  if (!paperTrading) {
    dbPath = "trades_real.db";
  } else if (riskMode === "super-risk") {
    dbPath = "trades_paper_risk.db";
  } else {
    dbPath = "trades_paper_normal.db";
  }

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
  } catch {
    // Column already exists
  }

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
}

export function insertTrade(trade: Omit<Trade, "id" | "exit_price" | "pnl" | "closed_at" | "status">): number {
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
}

export function closeTrade(id: number, exitPrice: number, status: "STOPPED" | "RESOLVED"): void {
  const trade = getTradeById(id);
  if (!trade) return;

  const database = ensureDb();
  const pnl = (exitPrice - trade.entry_price) * trade.shares;
  const stmt = database.prepare(`
    UPDATE trades SET exit_price = ?, status = ?, pnl = ?, closed_at = ?
    WHERE id = ?
  `);
  stmt.run(exitPrice, status, pnl, new Date().toISOString(), id);
}

export function getTradeById(id: number): Trade | null {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades WHERE id = ?");
  return stmt.get(id) as Trade | null;
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
  const total = database.prepare("SELECT COUNT(*) as count FROM trades").get() as { count: number };
  const wins = database.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl > 0").get() as { count: number };
  const losses = database.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl < 0").get() as { count: number };
  const open = database.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'").get() as { count: number };

  const closedTrades = wins.count + losses.count;
  return {
    total: total.count,
    wins: wins.count,
    losses: losses.count,
    open: open.count,
    winRate: closedTrades > 0 ? (wins.count / closedTrades) * 100 : 0
  };
}

export function getLastClosedTrade(): Trade | null {
  const database = ensureDb();
  const stmt = database.prepare("SELECT * FROM trades WHERE status != 'OPEN' ORDER BY closed_at DESC LIMIT 1");
  return stmt.get() as Trade | null;
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
      FOREIGN KEY (run_id) REFERENCES backtest_runs(id)
    )
  `);

  backtestDb.run(`CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id)`);

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
  }
): number {
  const database = ensureBacktestDb();
  const stmt = database.prepare(`
    INSERT INTO backtest_trades
    (run_id, market_slug, token_id, side, entry_price, exit_price, shares, entry_timestamp, exit_timestamp, exit_reason, pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    trade.pnl
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
