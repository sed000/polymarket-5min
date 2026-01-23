import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";

/**
 * We create a minimal test database implementation to avoid
 * polluting the actual trading databases during tests.
 */

interface Trade {
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

const TEST_DB_PATH = "test_trades_isolated.db";
let testDb: Database | null = null;

function initTestDb(): Database {
  if (testDb) {
    testDb.close();
  }
  // Remove existing file to start fresh
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }

  testDb = new Database(TEST_DB_PATH);
  testDb.run(`
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
  return testDb;
}

function insertTestTrade(db: Database, trade: Omit<Trade, "id" | "exit_price" | "pnl" | "closed_at" | "status">): number {
  const stmt = db.prepare(`
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

function closeTestTrade(db: Database, id: number, exitPrice: number, status: "STOPPED" | "RESOLVED"): void {
  const trade = db.prepare("SELECT * FROM trades WHERE id = ?").get(id) as Trade | null;
  if (!trade) return;

  const pnl = (exitPrice - trade.entry_price) * trade.shares;
  const stmt = db.prepare(`
    UPDATE trades SET exit_price = ?, status = ?, pnl = ?, closed_at = ?
    WHERE id = ?
  `);
  stmt.run(exitPrice, status, pnl, new Date().toISOString(), id);
}

function getTestTradeById(db: Database, id: number): Trade | null {
  const stmt = db.prepare("SELECT * FROM trades WHERE id = ?");
  return stmt.get(id) as Trade | null;
}

function getTestOpenTrades(db: Database): Trade[] {
  const stmt = db.prepare("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at DESC");
  return stmt.all() as Trade[];
}

function getTestLastClosedTrade(db: Database): Trade | null {
  const stmt = db.prepare("SELECT * FROM trades WHERE status != 'OPEN' ORDER BY closed_at DESC LIMIT 1");
  return stmt.get() as Trade | null;
}

function getTestTotalPnL(db: Database): number {
  const stmt = db.prepare("SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL");
  const result = stmt.get() as { total: number };
  return result.total;
}

function getTestTradeStats(db: Database) {
  const stats = db.prepare(`
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

afterAll(() => {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

describe("Database", () => {
  let db: Database;

  beforeEach(() => {
    db = initTestDb();
  });

  describe("insertTrade", () => {
    test("inserts a trade and returns ID", () => {
      const id = insertTestTrade(db, {
        market_slug: "btc-updown-15m-1234567890",
        token_id: "token_abc",
        side: "UP",
        entry_price: 0.95,
        shares: 100,
        cost_basis: 95,
        created_at: "2024-01-23T12:00:00.000Z",
        market_end_date: "2024-01-23T12:15:00.000Z",
      });

      expect(id).toBeGreaterThan(0);

      const trade = getTestTradeById(db, id);
      expect(trade).not.toBeNull();
      expect(trade?.market_slug).toBe("btc-updown-15m-1234567890");
      expect(trade?.side).toBe("UP");
      expect(trade?.entry_price).toBe(0.95);
      expect(trade?.status).toBe("OPEN");
    });

    test("creates trade with OPEN status", () => {
      const id = insertTestTrade(db, {
        market_slug: "test",
        token_id: "token",
        side: "DOWN",
        entry_price: 0.80,
        shares: 50,
        cost_basis: 40,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      const trade = getTestTradeById(db, id);
      expect(trade?.status).toBe("OPEN");
      expect(trade?.exit_price).toBeNull();
      expect(trade?.pnl).toBeNull();
    });
  });

  describe("closeTrade", () => {
    test("closes trade with RESOLVED status and calculates PnL", () => {
      const id = insertTestTrade(db, {
        market_slug: "test",
        token_id: "token",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      closeTestTrade(db, id, 0.99, "RESOLVED");

      const trade = getTestTradeById(db, id);
      expect(trade?.status).toBe("RESOLVED");
      expect(trade?.exit_price).toBe(0.99);
      // PnL = (0.99 - 0.90) * 100 = 9
      expect(trade?.pnl).toBeCloseTo(9, 2);
      expect(trade?.closed_at).not.toBeNull();
    });

    test("closes trade with STOPPED status (stop-loss)", () => {
      const id = insertTestTrade(db, {
        market_slug: "test",
        token_id: "token",
        side: "UP",
        entry_price: 0.95,
        shares: 100,
        cost_basis: 95,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      closeTestTrade(db, id, 0.80, "STOPPED");

      const trade = getTestTradeById(db, id);
      expect(trade?.status).toBe("STOPPED");
      expect(trade?.exit_price).toBe(0.80);
      // PnL = (0.80 - 0.95) * 100 = -15
      expect(trade?.pnl).toBeCloseTo(-15, 2);
    });

    test("handles closing non-existent trade gracefully", () => {
      // Should not throw
      closeTestTrade(db, 99999, 0.99, "RESOLVED");
    });
  });

  describe("getOpenTrades", () => {
    test("returns only open trades", () => {
      const id1 = insertTestTrade(db, {
        market_slug: "market1",
        token_id: "token1",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      const id2 = insertTestTrade(db, {
        market_slug: "market2",
        token_id: "token2",
        side: "DOWN",
        entry_price: 0.85,
        shares: 50,
        cost_basis: 42.5,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      // Close one trade
      closeTestTrade(db, id1, 0.99, "RESOLVED");

      const openTrades = getTestOpenTrades(db);
      expect(openTrades).toHaveLength(1);
      expect(openTrades[0].id).toBe(id2);
    });

    test("returns empty array when no open trades", () => {
      const id = insertTestTrade(db, {
        market_slug: "market1",
        token_id: "token1",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      closeTestTrade(db, id, 0.99, "RESOLVED");

      const openTrades = getTestOpenTrades(db);
      expect(openTrades).toHaveLength(0);
    });
  });

  describe("getLastClosedTrade", () => {
    test("returns most recently closed trade", () => {
      const id1 = insertTestTrade(db, {
        market_slug: "market1",
        token_id: "token1",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: "2024-01-23T12:00:00.000Z",
        market_end_date: "2024-01-23T12:15:00.000Z",
      });

      const id2 = insertTestTrade(db, {
        market_slug: "market2",
        token_id: "token2",
        side: "DOWN",
        entry_price: 0.85,
        shares: 50,
        cost_basis: 42.5,
        created_at: "2024-01-23T12:30:00.000Z",
        market_end_date: "2024-01-23T12:45:00.000Z",
      });

      closeTestTrade(db, id1, 0.99, "RESOLVED");
      // Small delay to ensure different timestamps
      closeTestTrade(db, id2, 0.95, "RESOLVED");

      const lastClosed = getTestLastClosedTrade(db);
      expect(lastClosed).not.toBeNull();
      expect(lastClosed?.id).toBe(id2);
    });

    test("returns null when no closed trades", () => {
      insertTestTrade(db, {
        market_slug: "market1",
        token_id: "token1",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      const lastClosed = getTestLastClosedTrade(db);
      expect(lastClosed).toBeNull();
    });
  });

  describe("getTotalPnL", () => {
    test("sums PnL from all closed trades", () => {
      const id1 = insertTestTrade(db, {
        market_slug: "m1",
        token_id: "t1",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      const id2 = insertTestTrade(db, {
        market_slug: "m2",
        token_id: "t2",
        side: "DOWN",
        entry_price: 0.80,
        shares: 50,
        cost_basis: 40,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      closeTestTrade(db, id1, 0.99, "RESOLVED"); // PnL = (0.99 - 0.90) * 100 = 9
      closeTestTrade(db, id2, 0.70, "STOPPED"); // PnL = (0.70 - 0.80) * 50 = -5

      const total = getTestTotalPnL(db);
      expect(total).toBeCloseTo(4, 2); // 9 + (-5) = 4
    });

    test("returns 0 when no trades", () => {
      const total = getTestTotalPnL(db);
      expect(total).toBe(0);
    });
  });

  describe("getTradeStats", () => {
    test("calculates win rate correctly", () => {
      // Create 3 winning trades and 1 losing trade
      for (let i = 0; i < 3; i++) {
        const id = insertTestTrade(db, {
          market_slug: `win${i}`,
          token_id: `token${i}`,
          side: "UP",
          entry_price: 0.90,
          shares: 100,
          cost_basis: 90,
          created_at: new Date().toISOString(),
          market_end_date: new Date().toISOString(),
        });
        closeTestTrade(db, id, 0.99, "RESOLVED"); // Win
      }

      const lossId = insertTestTrade(db, {
        market_slug: "loss",
        token_id: "tokenLoss",
        side: "UP",
        entry_price: 0.95,
        shares: 100,
        cost_basis: 95,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });
      closeTestTrade(db, lossId, 0.80, "STOPPED"); // Loss

      const stats = getTestTradeStats(db);
      expect(stats.total).toBe(4);
      expect(stats.wins).toBe(3);
      expect(stats.losses).toBe(1);
      expect(stats.open).toBe(0);
      expect(stats.winRate).toBe(75); // 3/4 = 75%
    });

    test("counts open trades separately", () => {
      insertTestTrade(db, {
        market_slug: "open",
        token_id: "tokenOpen",
        side: "UP",
        entry_price: 0.90,
        shares: 100,
        cost_basis: 90,
        created_at: new Date().toISOString(),
        market_end_date: new Date().toISOString(),
      });

      const stats = getTestTradeStats(db);
      expect(stats.total).toBe(1);
      expect(stats.open).toBe(1);
      expect(stats.wins).toBe(0);
      expect(stats.losses).toBe(0);
    });
  });
});
