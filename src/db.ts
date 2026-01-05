import { Database } from "bun:sqlite";

const db = new Database("trades.db");

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
    closed_at TEXT
  )
`);

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
}

export function insertTrade(trade: Omit<Trade, "id" | "exit_price" | "pnl" | "closed_at" | "status">): number {
  const stmt = db.prepare(`
    INSERT INTO trades (market_slug, token_id, side, entry_price, shares, cost_basis, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `);
  const result = stmt.run(
    trade.market_slug,
    trade.token_id,
    trade.side,
    trade.entry_price,
    trade.shares,
    trade.cost_basis,
    trade.created_at
  );
  return Number(result.lastInsertRowid);
}

export function closeTrade(id: number, exitPrice: number, status: "STOPPED" | "RESOLVED"): void {
  const trade = getTradeById(id);
  if (!trade) return;

  const pnl = (exitPrice - trade.entry_price) * trade.shares;
  const stmt = db.prepare(`
    UPDATE trades SET exit_price = ?, status = ?, pnl = ?, closed_at = ?
    WHERE id = ?
  `);
  stmt.run(exitPrice, status, pnl, new Date().toISOString(), id);
}

export function getTradeById(id: number): Trade | null {
  const stmt = db.prepare("SELECT * FROM trades WHERE id = ?");
  return stmt.get(id) as Trade | null;
}

export function getOpenTrades(): Trade[] {
  const stmt = db.prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC");
  return stmt.all() as Trade[];
}

export function getRecentTrades(limit = 10): Trade[] {
  const stmt = db.prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?");
  return stmt.all(limit) as Trade[];
}

export function getTotalPnL(): number {
  const stmt = db.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL");
  const result = stmt.get() as { total: number };
  return result.total;
}

export function getTradeStats() {
  const total = db.prepare("SELECT COUNT(*) as count FROM trades").get() as { count: number };
  const wins = db.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl > 0").get() as { count: number };
  const losses = db.prepare("SELECT COUNT(*) as count FROM trades WHERE pnl < 0").get() as { count: number };
  const open = db.prepare("SELECT COUNT(*) as count FROM trades WHERE status = 'OPEN'").get() as { count: number };

  return {
    total: total.count,
    wins: wins.count,
    losses: losses.count,
    open: open.count,
    winRate: total.count > 0 ? (wins.count / (wins.count + losses.count)) * 100 : 0
  };
}
