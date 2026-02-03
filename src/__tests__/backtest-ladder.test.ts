import { describe, test, expect } from "bun:test";
import { runBacktest } from "../backtest/engine";
import type { BacktestConfig, HistoricalMarket, PriceTick } from "../backtest/types";

const BASE_START = new Date("2024-01-01T00:00:00Z");
const BASE_END = new Date("2024-01-01T00:15:00Z");

function makeTick(timestamp: number, bid: number, ask: number): PriceTick {
  return {
    timestamp,
    tokenId: "UP",
    marketSlug: "btc-updown-15m-1",
    bestBid: bid,
    bestAsk: ask,
    midPrice: (bid + ask) / 2,
  };
}

function makeMarket(ticks: PriceTick[], outcome: "UP" | "DOWN" | null = null): HistoricalMarket {
  return {
    slug: "btc-updown-15m-1",
    question: "BTC up or down?",
    startDate: BASE_START,
    endDate: BASE_END,
    upTokenId: "UP",
    downTokenId: "DOWN",
    outcome,
    priceTicks: ticks,
  };
}

function makeConfig(): BacktestConfig {
  return {
    entryThreshold: 0.5,
    maxEntryPrice: 0.9,
    stopLoss: 0.4,
    maxSpread: 0.05,
    timeWindowMs: 15 * 60 * 1000,
    profitTarget: 0.99,
    startingBalance: 100,
    startDate: BASE_START,
    endDate: BASE_END,
    slippage: 0,
    compoundLimit: 0,
    baseBalance: 10,
    riskMode: "ladder",
    ladderSteps: [
      {
        id: "step1",
        stopLoss: 0.4,
        enabled: true,
        buy: { triggerPrice: 0.6, sizeType: "percent", sizeValue: 100 },
        sell: { triggerPrice: 0.7, sizeType: "percent", sizeValue: 100 },
      },
    ],
  };
}

describe("Backtest ladder mode", () => {
  test("entry gating requires price above first buy trigger", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.54, 0.55),
      makeTick(BASE_START.getTime() + 120_000, 0.49, 0.50),
      makeTick(BASE_START.getTime() + 180_000, 0.52, 0.53),
    ];
    const market = makeMarket(ticks);
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(0);
  });

  test("buy and sell triggers create a ladder step trade", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.64, 0.65),
      makeTick(BASE_START.getTime() + 120_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 180_000, 0.70, 0.71),
    ];
    const market = makeMarket(ticks);
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].exitReason).toBe("LADDER_STEP_SELL");
    expect(result.trades[0].ladderStepId).toBe("step1");
  });

  test("buy trigger uses ask price and full balance sizing", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.64, 0.65),
      makeTick(BASE_START.getTime() + 120_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 180_000, 0.70, 0.71),
    ];
    const market = makeMarket(ticks);
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].entryPrice).toBeCloseTo(0.60, 2);
    expect(result.trades[0].shares).toBeCloseTo(100 / 0.60, 2);
  });

  test("step stop-loss sells all remaining shares", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.64, 0.65),
      makeTick(BASE_START.getTime() + 120_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 180_000, 0.39, 0.40),
    ];
    const market = makeMarket(ticks);
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].exitReason).toBe("LADDER_STOP_LOSS");
  });

  test("recovery gating prevents immediate re-entry after stop-loss", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.64, 0.65),
      makeTick(BASE_START.getTime() + 120_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 180_000, 0.39, 0.40),
      makeTick(BASE_START.getTime() + 240_000, 0.57, 0.58),
      makeTick(BASE_START.getTime() + 300_000, 0.70, 0.71),
      makeTick(BASE_START.getTime() + 360_000, 0.61, 0.62),
      makeTick(BASE_START.getTime() + 420_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 480_000, 0.70, 0.71),
    ];
    const market = makeMarket(ticks);
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(2);
    expect(result.trades[0].exitReason).toBe("LADDER_STOP_LOSS");
    expect(result.trades[1].exitReason).toBe("LADDER_STEP_SELL");
  });

  test("market expiry closes ladder at outcome price", () => {
    const ticks = [
      makeTick(BASE_START.getTime() + 60_000, 0.64, 0.65),
      makeTick(BASE_START.getTime() + 120_000, 0.59, 0.60),
      makeTick(BASE_START.getTime() + 840_000, 0.59, 0.60),
      makeTick(BASE_END.getTime() + 60_000, 0.50, 0.51),
    ];
    const market = makeMarket(ticks, "UP");
    const result = runBacktest(makeConfig(), [market]);
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].exitReason).toBe("MARKET_RESOLVED");
    expect(result.trades[0].exitPrice).toBeCloseTo(0.99, 2);
  });
});
