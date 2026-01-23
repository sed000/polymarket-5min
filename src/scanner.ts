import { gammaLimiter } from "./rate-limiter";

const GAMMA_API = "https://gamma-api.polymarket.com";

function parseJsonField<T>(value: unknown): T[] {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  if (Array.isArray(value)) {
    return value as T[];
  }
  return [];
}

export interface Market {
  id: string;
  slug: string;
  question: string;
  endDate: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
}

export interface EligibleMarket {
  slug: string;
  question: string;
  endDate: Date;
  timeRemaining: number; // ms
  upTokenId: string;
  downTokenId: string;
  upAsk: number;  // Best ask - price to buy Up
  downAsk: number; // Best ask - price to buy Down
  upBid: number;  // Best bid - price to sell Up
  downBid: number; // Best bid - price to sell Down
  eligibleSide: "UP" | "DOWN" | null;
}

export async function fetchBtc15MinMarkets(): Promise<Market[]> {
  const markets: Market[] = [];

  const nowSec = Math.floor(Date.now() / 1000);
  const intervalSec = 15 * 60;
  const currentIntervalStart = Math.floor(nowSec / intervalSec) * intervalSec;

  // Fetch current and next interval
  for (let i = 0; i < 2; i++) {
    const timestamp = currentIntervalStart + (i * intervalSec);
    const slug = `btc-updown-15m-${timestamp}`;

    try {
      // Rate limit API calls
      await gammaLimiter.acquire();
      const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
      if (!res.ok) continue;

      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) continue;

      for (const event of events) {
        if (!event.markets || !Array.isArray(event.markets)) continue;

        for (const market of event.markets) {
          if (market.closed) continue;

          const parsed = parseMarket(event, market);
          if (parsed && !markets.find(m => m.id === parsed.id)) {
            markets.push(parsed);
          }
        }
      }
    } catch (err) {
      console.warn(`[Scanner] Failed to fetch market ${slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  return markets;
}

function parseMarket(event: any, market: any): Market | null {
  try {
    const outcomes = parseJsonField<string>(market.outcomes);
    const outcomePrices = parseJsonField<string>(market.outcomePrices);
    const clobTokenIds = parseJsonField<string>(market.clobTokenIds);

    if (outcomes.length < 2 || clobTokenIds.length < 2) {
      return null;
    }

    return {
      id: market.id,
      slug: event.slug,
      question: market.question || event.title,
      endDate: market.endDate || event.endDate,
      outcomes,
      outcomePrices,
      clobTokenIds,
      active: market.active !== false,
      closed: market.closed === true
    };
  } catch (err) {
    console.warn(`[Scanner] Error parsing market: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface PriceData {
  bestBid: number;
  bestAsk: number;
}

export interface PriceOverride {
  [tokenId: string]: PriceData;
}

export interface MarketFilterConfig {
  entryThreshold: number;   // Min entry price (0.95)
  maxEntryPrice: number;    // Max entry price (0.98)
  maxSpread: number;        // Max bid-ask spread (0.03)
  timeWindowMs: number;
}

export function analyzeMarket(
  market: Market,
  config: { entryThreshold: number; timeWindowMs: number; maxEntryPrice?: number; maxSpread?: number },
  priceOverrides?: PriceOverride
): EligibleMarket {
  const endDate = new Date(market.endDate);
  const now = new Date();
  const timeRemaining = endDate.getTime() - now.getTime();

  const upIndex = market.outcomes.findIndex(o => o.toLowerCase() === "up");
  const downIndex = market.outcomes.findIndex(o => o.toLowerCase() === "down");

  const upTokenId = upIndex >= 0 ? market.clobTokenIds[upIndex] : "";
  const downTokenId = downIndex >= 0 ? market.clobTokenIds[downIndex] : "";

  // Get bid/ask from WebSocket orderbook data
  let upBid = 0, upAsk = 0;
  let downBid = 0, downAsk = 0;

  if (priceOverrides && upTokenId && priceOverrides[upTokenId]) {
    upBid = priceOverrides[upTokenId].bestBid;
    upAsk = priceOverrides[upTokenId].bestAsk;
  }
  if (priceOverrides && downTokenId && priceOverrides[downTokenId]) {
    downBid = priceOverrides[downTokenId].bestBid;
    downAsk = priceOverrides[downTokenId].bestAsk;
  }

  // Entry signal based on best ask (price you pay to buy)
  // Apply entry threshold, max entry price, and spread filters
  let eligibleSide: "UP" | "DOWN" | null = null;
  const maxEntry = config.maxEntryPrice ?? 0.99;
  const maxSpread = config.maxSpread ?? 1.0;  // Default: no spread filter

  if (timeRemaining > 0 && timeRemaining <= config.timeWindowMs) {
    const upSpread = upAsk - upBid;
    const downSpread = downAsk - downBid;

    // Check UP side: within entry range AND spread OK
    if (upAsk >= config.entryThreshold && upAsk <= maxEntry && upSpread <= maxSpread) {
      eligibleSide = "UP";
    }
    // Check DOWN side: within entry range AND spread OK
    else if (downAsk >= config.entryThreshold && downAsk <= maxEntry && downSpread <= maxSpread) {
      eligibleSide = "DOWN";
    }
  }

  return {
    slug: market.slug,
    question: market.question,
    endDate,
    timeRemaining,
    upTokenId,
    downTokenId,
    upAsk,
    downAsk,
    upBid,
    downBid,
    eligibleSide
  };
}

export function findEligibleMarkets(
  markets: Market[],
  config: { entryThreshold: number; timeWindowMs: number; maxEntryPrice?: number; maxSpread?: number },
  priceOverrides?: PriceOverride
): EligibleMarket[] {
  const analyzed = markets.map(m => analyzeMarket(m, config, priceOverrides));
  return analyzed.filter(m => m.eligibleSide !== null);
}

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Fetch market resolution for a specific market slug
 * Returns the winning side ("UP" or "DOWN") or null if not resolved
 */
export async function fetchMarketResolution(slug: string): Promise<"UP" | "DOWN" | null> {
  try {
    await gammaLimiter.acquire();
    const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
    if (!res.ok) return null;

    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue;

      for (const market of event.markets) {
        const outcomes = parseJsonField<string>(market.outcomes);
        const outcomePrices = parseJsonField<string>(market.outcomePrices);

        if (outcomes.length < 2 || outcomePrices.length < 2) continue;

        // Find UP and DOWN indices
        const upIndex = outcomes.findIndex(o => o.toLowerCase() === "up");
        const downIndex = outcomes.findIndex(o => o.toLowerCase() === "down");

        if (upIndex < 0 || downIndex < 0) continue;

        const upPrice = parseFloat(outcomePrices[upIndex]) || 0;
        const downPrice = parseFloat(outcomePrices[downIndex]) || 0;

        // Winning side has price ~$1, losing side has price ~$0
        if (upPrice > 0.9) return "UP";
        if (downPrice > 0.9) return "DOWN";
      }
    }
  } catch (err) {
    console.warn(`[Scanner] Error fetching resolution for ${slug}: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}
