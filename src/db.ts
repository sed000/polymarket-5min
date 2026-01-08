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
