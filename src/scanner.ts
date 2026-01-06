const GAMMA_API = "https://gamma-api.polymarket.com";

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

  // Get current and next market
  for (let i = 0; i < 2; i++) {
    const timestamp = currentIntervalStart + (i * intervalSec);
    const slug = `btc-updown-15m-${timestamp}`;

    try {
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
    } catch {
      // Skip failed requests
    }
  }

  markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
  return markets;
}

function parseMarket(event: any, market: any): Market | null {
  try {
    let outcomes: string[] = [];
    let outcomePrices: string[] = [];
    let clobTokenIds: string[] = [];

    if (typeof market.outcomes === 'string') {
      outcomes = JSON.parse(market.outcomes);
    } else if (Array.isArray(market.outcomes)) {
      outcomes = market.outcomes;
    }

    if (typeof market.outcomePrices === 'string') {
      outcomePrices = JSON.parse(market.outcomePrices);
    } else if (Array.isArray(market.outcomePrices)) {
      outcomePrices = market.outcomePrices;
    }

    if (typeof market.clobTokenIds === 'string') {
      clobTokenIds = JSON.parse(market.clobTokenIds);
    } else if (Array.isArray(market.clobTokenIds)) {
      clobTokenIds = market.clobTokenIds;
    }

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
  } catch {
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

export function analyzeMarket(
  market: Market,
  config: { entryThreshold: number; timeWindowMs: number },
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
  // If ask >= 0.95, market strongly favors that outcome (95%+ probability)
  let eligibleSide: "UP" | "DOWN" | null = null;

  if (timeRemaining > 0 && timeRemaining <= config.timeWindowMs) {
    if (upAsk >= config.entryThreshold) {
      eligibleSide = "UP";
    } else if (downAsk >= config.entryThreshold) {
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
  config: { entryThreshold: number; timeWindowMs: number },
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
