import { describe, test, expect } from "bun:test";

/**
 * Price validation utilities for testing
 * These functions will be integrated into the websocket module
 */

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0.01 && price <= 0.99;
}

function isValidSpread(spread: number): boolean {
  return Number.isFinite(spread) && spread >= 0 && spread <= 0.98;
}

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === "number" ? value : parseFloat(String(value));

  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 1) return null;

  return parsed;
}

describe("Price Validation", () => {
  describe("isValidPrice", () => {
    test("accepts valid prices in Polymarket range", () => {
      expect(isValidPrice(0.50)).toBe(true);
      expect(isValidPrice(0.01)).toBe(true);
      expect(isValidPrice(0.99)).toBe(true);
      expect(isValidPrice(0.95)).toBe(true);
      expect(isValidPrice(0.05)).toBe(true);
    });

    test("rejects prices outside valid range", () => {
      expect(isValidPrice(0)).toBe(false);
      expect(isValidPrice(1)).toBe(false);
      expect(isValidPrice(0.001)).toBe(false);
      expect(isValidPrice(0.999)).toBe(false);
      expect(isValidPrice(-0.5)).toBe(false);
      expect(isValidPrice(1.5)).toBe(false);
    });

    test("rejects non-finite values", () => {
      expect(isValidPrice(NaN)).toBe(false);
      expect(isValidPrice(Infinity)).toBe(false);
      expect(isValidPrice(-Infinity)).toBe(false);
    });
  });

  describe("isValidSpread", () => {
    test("accepts valid spreads", () => {
      expect(isValidSpread(0)).toBe(true);
      expect(isValidSpread(0.02)).toBe(true);
      expect(isValidSpread(0.05)).toBe(true);
      expect(isValidSpread(0.10)).toBe(true);
    });

    test("rejects invalid spreads", () => {
      expect(isValidSpread(-0.01)).toBe(false);
      expect(isValidSpread(NaN)).toBe(false);
      expect(isValidSpread(1.5)).toBe(false);
    });
  });

  describe("parsePrice", () => {
    test("parses string prices", () => {
      expect(parsePrice("0.95")).toBe(0.95);
      expect(parsePrice("0.5")).toBe(0.5);
      expect(parsePrice("0.01")).toBe(0.01);
    });

    test("passes through number prices", () => {
      expect(parsePrice(0.95)).toBe(0.95);
      expect(parsePrice(0.5)).toBe(0.5);
    });

    test("returns null for invalid inputs", () => {
      expect(parsePrice(null)).toBe(null);
      expect(parsePrice(undefined)).toBe(null);
      expect(parsePrice("invalid")).toBe(null);
      expect(parsePrice("")).toBe(null);
    });

    test("returns null for out-of-range prices", () => {
      expect(parsePrice(-1)).toBe(null);
      expect(parsePrice(2)).toBe(null);
      expect(parsePrice("-0.5")).toBe(null);
      expect(parsePrice("1.5")).toBe(null);
    });

    test("handles edge cases", () => {
      expect(parsePrice(0)).toBe(0);
      expect(parsePrice(1)).toBe(1);
      expect(parsePrice("0")).toBe(0);
      expect(parsePrice("1")).toBe(1);
    });
  });
});

describe("Entry Signal Validation", () => {
  interface EntryParams {
    askPrice: number;
    bidPrice: number;
    entryThreshold: number;
    maxEntryPrice: number;
    maxSpread: number;
    profitTarget: number;
  }

  function shouldEnter(params: EntryParams): { valid: boolean; reason?: string } {
    const { askPrice, bidPrice, entryThreshold, maxEntryPrice, maxSpread, profitTarget } = params;

    // Check spread
    const spread = askPrice - bidPrice;
    if (spread > maxSpread) {
      return { valid: false, reason: `spread ${spread.toFixed(3)} > max ${maxSpread}` };
    }

    // Check entry threshold
    if (askPrice < entryThreshold) {
      return { valid: false, reason: `ask ${askPrice} < threshold ${entryThreshold}` };
    }

    // Check max entry price
    if (askPrice > maxEntryPrice) {
      return { valid: false, reason: `ask ${askPrice} > max entry ${maxEntryPrice}` };
    }

    // Check profit target ceiling
    if (askPrice >= profitTarget) {
      return { valid: false, reason: `ask ${askPrice} >= profit target ${profitTarget}` };
    }

    return { valid: true };
  }

  describe("normal mode entry conditions", () => {
    const normalConfig = {
      entryThreshold: 0.95,
      maxEntryPrice: 0.98,
      maxSpread: 0.03,
      profitTarget: 0.99,
    };

    test("accepts valid entry in normal range", () => {
      const result = shouldEnter({
        ...normalConfig,
        askPrice: 0.96,
        bidPrice: 0.94,
      });
      expect(result.valid).toBe(true);
    });

    test("rejects entry below threshold", () => {
      const result = shouldEnter({
        ...normalConfig,
        askPrice: 0.93,
        bidPrice: 0.91,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("threshold");
    });

    test("rejects entry above max price", () => {
      const result = shouldEnter({
        ...normalConfig,
        askPrice: 0.985,
        bidPrice: 0.97,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("max entry");
    });

    test("rejects entry when spread too wide", () => {
      const result = shouldEnter({
        ...normalConfig,
        askPrice: 0.96,
        bidPrice: 0.92, // spread = 0.04 > 0.03
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("spread");
    });

    test("rejects entry at or above profit target", () => {
      // First test that max entry check fires before profit target
      const result = shouldEnter({
        ...normalConfig,
        askPrice: 0.99,
        bidPrice: 0.97,
      });
      expect(result.valid).toBe(false);
      // This will fail on max entry first since 0.99 > 0.98
      expect(result.reason).toContain("max entry");

      // Test profit target directly by setting max entry higher
      const result2 = shouldEnter({
        ...normalConfig,
        maxEntryPrice: 0.99,
        askPrice: 0.99,
        bidPrice: 0.97,
      });
      expect(result2.valid).toBe(false);
      expect(result2.reason).toContain("profit target");
    });
  });

  describe("super-risk mode entry conditions", () => {
    const superRiskConfig = {
      entryThreshold: 0.70,
      maxEntryPrice: 0.95,
      maxSpread: 0.05,
      profitTarget: 0.98,
    };

    test("accepts lower threshold entries", () => {
      const result = shouldEnter({
        ...superRiskConfig,
        askPrice: 0.72,
        bidPrice: 0.70,
      });
      expect(result.valid).toBe(true);
    });

    test("accepts wider spreads", () => {
      const result = shouldEnter({
        ...superRiskConfig,
        askPrice: 0.80,
        bidPrice: 0.76, // spread = 0.04
      });
      expect(result.valid).toBe(true);
    });

    test("rejects entry below aggressive threshold", () => {
      const result = shouldEnter({
        ...superRiskConfig,
        askPrice: 0.65,
        bidPrice: 0.63,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("dynamic-risk mode entry conditions", () => {
    function getDynamicThreshold(consecutiveLosses: number): number {
      const base = 0.70;
      const adjustment = Math.min(consecutiveLosses * 0.05, 0.15);
      return base + adjustment;
    }

    test("starts at $0.70 threshold with no losses", () => {
      expect(getDynamicThreshold(0)).toBe(0.70);
    });

    test("increases threshold by $0.05 per loss", () => {
      expect(getDynamicThreshold(1)).toBeCloseTo(0.75, 2);
      expect(getDynamicThreshold(2)).toBeCloseTo(0.80, 2);
    });

    test("caps threshold at $0.85", () => {
      expect(getDynamicThreshold(3)).toBe(0.85);
      expect(getDynamicThreshold(4)).toBe(0.85);
      expect(getDynamicThreshold(10)).toBe(0.85);
    });
  });
});

describe("Stop-Loss Validation", () => {
  function shouldTriggerStopLoss(
    currentBid: number,
    stopLoss: number,
    dynamicStopLoss?: number
  ): boolean {
    const effectiveStopLoss = dynamicStopLoss ?? stopLoss;
    return currentBid <= effectiveStopLoss;
  }

  describe("fixed stop-loss", () => {
    test("triggers when price hits stop-loss", () => {
      expect(shouldTriggerStopLoss(0.80, 0.80)).toBe(true);
    });

    test("triggers when price drops below stop-loss", () => {
      expect(shouldTriggerStopLoss(0.75, 0.80)).toBe(true);
    });

    test("does not trigger above stop-loss", () => {
      expect(shouldTriggerStopLoss(0.85, 0.80)).toBe(false);
    });
  });

  describe("dynamic stop-loss (entry-relative)", () => {
    test("uses dynamic stop-loss when provided", () => {
      const dynamicStop = 0.95 * (1 - 0.325); // ~0.64
      expect(shouldTriggerStopLoss(0.63, 0.40, dynamicStop)).toBe(true);
      expect(shouldTriggerStopLoss(0.65, 0.40, dynamicStop)).toBe(false);
    });

    test("calculates 32.5% drawdown correctly", () => {
      const entryPrice = 0.80;
      const maxDrawdown = 0.325;
      const dynamicStop = entryPrice * (1 - maxDrawdown);

      expect(dynamicStop).toBeCloseTo(0.54, 2);
      expect(shouldTriggerStopLoss(0.53, 0.40, dynamicStop)).toBe(true);
      expect(shouldTriggerStopLoss(0.55, 0.40, dynamicStop)).toBe(false);
    });
  });
});
