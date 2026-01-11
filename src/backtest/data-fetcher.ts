import type { HistoricalMarket, PriceTick } from "./types";
import {
  storeHistoricalMarket,
  storePriceTicks,
  getHistoricalMarket,
  loadPriceTicks,
  getPriceTickCount,
  initBacktestDatabase,
} from "../db";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Rate limiting
const RATE_LIMIT_DELAY = 100; // ms between requests
let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    await sleep(RATE_LIMIT_DELAY - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
  return fetch(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate all market slugs for BTC 15-min markets in a date range
 */
export function generateMarketSlugs(startDate: Date, endDate: Date): string[] {
  const slugs: string[] = [];
  const intervalSec = 15 * 60; // 15 minutes

  // Round start to nearest 15-min interval
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);

  const firstInterval = Math.ceil(startTs / intervalSec) * intervalSec;

  for (let ts = firstInterval; ts <= endTs; ts += intervalSec) {
    slugs.push(`btc-updown-15m-${ts}`);
  }

  return slugs;
}

/**
 * Fetch market metadata from Gamma API
 */
async function fetchMarketFromGamma(slug: string): Promise<{
  question: string;
  endDate: Date;
  upTokenId: string;
  downTokenId: string;
} | null> {
  try {
    const res = await rateLimitedFetch(`${GAMMA_API}/events?slug=${slug}`);
    if (!res.ok) return null;

    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    const event = events[0];
    if (!event.markets || !Array.isArray(event.markets) || event.markets.length === 0) {
      return null;
    }

    const market = event.markets[0];

    // Parse outcomes and token IDs
    let outcomes: string[] = [];
    let clobTokenIds: string[] = [];

    if (typeof market.outcomes === "string") {
      outcomes = JSON.parse(market.outcomes);
    } else if (Array.isArray(market.outcomes)) {
      outcomes = market.outcomes;
    }

    if (typeof market.clobTokenIds === "string") {
      clobTokenIds = JSON.parse(market.clobTokenIds);
    } else if (Array.isArray(market.clobTokenIds)) {
      clobTokenIds = market.clobTokenIds;
    }

    if (outcomes.length < 2 || clobTokenIds.length < 2) {
      return null;
    }

    const upIndex = outcomes.findIndex(o => o.toLowerCase() === "up");
    const downIndex = outcomes.findIndex(o => o.toLowerCase() === "down");

    if (upIndex === -1 || downIndex === -1) {
      return null;
    }

    return {
      question: market.question || event.title,
      endDate: new Date(market.endDate || event.endDate),
      upTokenId: clobTokenIds[upIndex],
      downTokenId: clobTokenIds[downIndex],
    };
  } catch {
    return null;
  }
}

/**
 * Fetch price history from CLOB API
 * @param tokenId - The token ID to fetch prices for
 * @param startTs - Start timestamp in seconds
 * @param endTs - End timestamp in seconds
 * @param fidelity - Time resolution in minutes (default 1)
 */
async function fetchPriceHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity: number = 1
): Promise<Array<{ t: number; p: number }>> {
  try {
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
    const res = await rateLimitedFetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    if (!data.history || !Array.isArray(data.history)) {
      return [];
    }

    return data.history;
  } catch {
    return [];
  }
}

/**
 * Determine market outcome based on final prices
 * If UP token resolved to ~$1, UP won; if DOWN resolved to ~$1, DOWN won
 */
function determineOutcome(
  upPrices: Array<{ t: number; p: number }>,
  downPrices: Array<{ t: number; p: number }>
): "UP" | "DOWN" | null {
  if (upPrices.length === 0 && downPrices.length === 0) {
    return null;
  }

  // Get last prices
  const lastUpPrice = upPrices.length > 0 ? upPrices[upPrices.length - 1].p : 0;
  const lastDownPrice = downPrices.length > 0 ? downPrices[downPrices.length - 1].p : 0;

  // The winning outcome should have price near $1
  if (lastUpPrice >= 0.95) return "UP";
  if (lastDownPrice >= 0.95) return "DOWN";

  // If neither is decisive, check which is higher
  if (lastUpPrice > lastDownPrice && lastUpPrice > 0.5) return "UP";
  if (lastDownPrice > lastUpPrice && lastDownPrice > 0.5) return "DOWN";

  return null;
}

/**
 * Convert price history to price ticks with bid/ask simulation
 * Since we only get mid prices, we simulate bid/ask with a small spread
 */
function convertToPriceTicks(
  marketSlug: string,
  tokenId: string,
  history: Array<{ t: number; p: number }>,
  spreadSimulation: number = 0.01
): PriceTick[] {
  return history.map(h => {
    const midPrice = h.p;
    const halfSpread = spreadSimulation / 2;
    return {
      timestamp: h.t * 1000, // Convert to ms
      tokenId,
      marketSlug,
      bestBid: Math.max(0.01, midPrice - halfSpread),
      bestAsk: Math.min(0.99, midPrice + halfSpread),
      midPrice,
    };
  });
}

export interface FetchProgress {
  current: number;
  total: number;
  slug: string;
  status: "fetching" | "cached" | "failed" | "no_data";
}

export type ProgressCallback = (progress: FetchProgress) => void;

/**
 * Fetch historical data for a single market
 */
export async function fetchMarketData(
  slug: string,
  forceRefetch: boolean = false
): Promise<HistoricalMarket | null> {
  // Check cache first
  const cached = getHistoricalMarket(slug);
  if (cached && !forceRefetch) {
    // Load price ticks from database
    const tickCount = getPriceTickCount(slug);
    if (tickCount > 0) {
      const upTicks = loadPriceTicks(cached.up_token_id);
      const downTicks = loadPriceTicks(cached.down_token_id);

      return {
        slug: cached.market_slug,
        question: cached.question || "",
        startDate: new Date(cached.start_date),
        endDate: new Date(cached.end_date),
        upTokenId: cached.up_token_id,
        downTokenId: cached.down_token_id,
        outcome: cached.outcome as "UP" | "DOWN" | null,
        priceTicks: [...upTicks.map(t => ({
          timestamp: t.timestamp,
          tokenId: t.token_id,
          marketSlug: t.market_slug,
          bestBid: t.best_bid,
          bestAsk: t.best_ask,
          midPrice: t.mid_price,
        })), ...downTicks.map(t => ({
          timestamp: t.timestamp,
          tokenId: t.token_id,
          marketSlug: t.market_slug,
          bestBid: t.best_bid,
          bestAsk: t.best_ask,
          midPrice: t.mid_price,
        }))].sort((a, b) => a.timestamp - b.timestamp),
      };
    }
  }

  // Fetch from API
  const marketMeta = await fetchMarketFromGamma(slug);
  if (!marketMeta) {
    return null;
  }

  // Calculate market start time (15 min before end)
  const startDate = new Date(marketMeta.endDate.getTime() - 15 * 60 * 1000);
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(marketMeta.endDate.getTime() / 1000);

  // Fetch price history for both tokens
  const [upHistory, downHistory] = await Promise.all([
    fetchPriceHistory(marketMeta.upTokenId, startTs, endTs),
    fetchPriceHistory(marketMeta.downTokenId, startTs, endTs),
  ]);

  if (upHistory.length === 0 && downHistory.length === 0) {
    return null;
  }

  // Determine outcome
  const outcome = determineOutcome(upHistory, downHistory);

  // Convert to price ticks
  const upTicks = convertToPriceTicks(slug, marketMeta.upTokenId, upHistory);
  const downTicks = convertToPriceTicks(slug, marketMeta.downTokenId, downHistory);

  // Store in database
  storeHistoricalMarket({
    slug,
    question: marketMeta.question,
    startDate,
    endDate: marketMeta.endDate,
    upTokenId: marketMeta.upTokenId,
    downTokenId: marketMeta.downTokenId,
    outcome,
  });

  storePriceTicks(slug, marketMeta.upTokenId, upTicks.map(t => ({
    timestamp: t.timestamp,
    bestBid: t.bestBid,
    bestAsk: t.bestAsk,
    midPrice: t.midPrice,
  })));

  storePriceTicks(slug, marketMeta.downTokenId, downTicks.map(t => ({
    timestamp: t.timestamp,
    bestBid: t.bestBid,
    bestAsk: t.bestAsk,
    midPrice: t.midPrice,
  })));

  return {
    slug,
    question: marketMeta.question,
    startDate,
    endDate: marketMeta.endDate,
    upTokenId: marketMeta.upTokenId,
    downTokenId: marketMeta.downTokenId,
    outcome,
    priceTicks: [...upTicks, ...downTicks].sort((a, b) => a.timestamp - b.timestamp),
  };
}

/**
 * Fetch all historical markets in a date range
 */
export async function fetchHistoricalDataset(
  startDate: Date,
  endDate: Date,
  options: {
    forceRefetch?: boolean;
    onProgress?: ProgressCallback;
  } = {}
): Promise<HistoricalMarket[]> {
  initBacktestDatabase();

  const slugs = generateMarketSlugs(startDate, endDate);
  const markets: HistoricalMarket[] = [];
  let fetchedCount = 0;
  let cachedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];

    // Check if cached
    const cached = getHistoricalMarket(slug);
    const tickCount = cached ? getPriceTickCount(slug) : 0;

    if (cached && tickCount > 0 && !options.forceRefetch) {
      cachedCount++;
      options.onProgress?.({
        current: i + 1,
        total: slugs.length,
        slug,
        status: "cached",
      });

      // Load from cache
      const market = await fetchMarketData(slug, false);
      if (market) {
        markets.push(market);
      }
      continue;
    }

    options.onProgress?.({
      current: i + 1,
      total: slugs.length,
      slug,
      status: "fetching",
    });

    const market = await fetchMarketData(slug, options.forceRefetch);

    if (market) {
      markets.push(market);
      fetchedCount++;
    } else {
      failedCount++;
      options.onProgress?.({
        current: i + 1,
        total: slugs.length,
        slug,
        status: market ? "fetching" : "no_data",
      });
    }
  }

  console.log(`\nFetch complete: ${fetchedCount} fetched, ${cachedCount} cached, ${failedCount} no data`);
  return markets;
}

/**
 * Load cached historical markets from database (no API calls)
 */
export async function loadCachedDataset(
  startDate: Date,
  endDate: Date
): Promise<HistoricalMarket[]> {
  initBacktestDatabase();

  const slugs = generateMarketSlugs(startDate, endDate);
  const markets: HistoricalMarket[] = [];

  for (const slug of slugs) {
    const market = await fetchMarketData(slug, false);
    if (market && market.priceTicks.length > 0) {
      markets.push(market);
    }
  }

  return markets;
}

/**
 * Get summary of cached data
 */
export function getCacheStats(): {
  totalMarkets: number;
  totalPriceTicks: number;
  dateRange: { earliest: Date | null; latest: Date | null };
} {
  initBacktestDatabase();

  const { loadHistoricalMarketsInRange, getHistoricalMarketCount } = require("../db");
  const marketCount = getHistoricalMarketCount();

  // Get date range from all markets
  const allMarkets = loadHistoricalMarketsInRange(new Date(0), new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));

  let totalTicks = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const m of allMarkets) {
    totalTicks += getPriceTickCount(m.market_slug);
    const startDate = new Date(m.start_date);
    const endDate = new Date(m.end_date);

    if (!earliest || startDate < earliest) earliest = startDate;
    if (!latest || endDate > latest) latest = endDate;
  }

  return {
    totalMarkets: marketCount,
    totalPriceTicks: totalTicks,
    dateRange: { earliest, latest },
  };
}
