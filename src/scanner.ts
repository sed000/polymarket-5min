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
  upPrice: number;
  downPrice: number;
  eligibleSide: "UP" | "DOWN" | null;
}

// Generate potential BTC 15-min market slugs based on current time
function generatePotentialSlugs(): string[] {
  const now = Date.now();
  const slugs: string[] = [];

  // Generate slugs for next few 15-minute intervals
  for (let i = 0; i < 10; i++) {
    // Round to 15-minute intervals
    const timestamp = Math.floor((now + i * 15 * 60 * 1000) / (15 * 60 * 1000)) * (15 * 60);
    slugs.push(`btc-updown-15m-${timestamp}`);
  }

  return slugs;
}

export async function fetchBtc15MinMarkets(): Promise<Market[]> {
  const markets: Market[] = [];

  // Method 1: Query the series directly
  try {
    const seriesRes = await fetch(`${GAMMA_API}/events?slug=btc-up-or-down-15m&active=true&closed=false&limit=20`);
    if (seriesRes.ok) {
      const events = await seriesRes.json();
      for (const event of events) {
        if (event.slug?.includes("btc-updown-15m") || event.slug?.includes("btc-up-or-down")) {
          for (const market of event.markets || []) {
            if (!market.closed && market.active) {
              markets.push(parseMarket(event, market));
            }
          }
        }
      }
    }
  } catch (e) {
    // Continue to other methods
  }

  // Method 2: Try specific slug queries for upcoming intervals
  const potentialSlugs = generatePotentialSlugs();
  for (const slug of potentialSlugs) {
    try {
      const res = await fetch(`${GAMMA_API}/events?slug=${slug}`);
      if (res.ok) {
        const events = await res.json();
        for (const event of events) {
          if (!event.closed && event.active !== false) {
            for (const market of event.markets || []) {
              if (!market.closed && market.active !== false) {
                // Check if not already added
                if (!markets.find(m => m.id === market.id)) {
                  markets.push(parseMarket(event, market));
                }
              }
            }
          }
        }
      }
    } catch {
      // Skip this slug
    }
  }

  // Method 3: Search all events and filter
  try {
    const allRes = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=200`);
    if (allRes.ok) {
      const events = await allRes.json();
      for (const event of events) {
        if (event.slug?.includes("btc-updown-15m") ||
            event.title?.toLowerCase().includes("bitcoin up or down")) {
          for (const market of event.markets || []) {
            if (!market.closed && !markets.find(m => m.id === market.id)) {
              markets.push(parseMarket(event, market));
            }
          }
        }
      }
    }
  } catch {
    // Ignore
  }

  return markets;
}

function parseMarket(event: any, market: any): Market {
  // Parse outcomes from string if needed
  let outcomes: string[] = [];
  let outcomePrices: string[] = [];
  let clobTokenIds: string[] = [];

  try {
    outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []);
    outcomePrices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices || []);
    clobTokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);
  } catch {
    outcomes = market.outcomes || [];
    outcomePrices = market.outcomePrices || [];
    clobTokenIds = market.clobTokenIds || [];
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
}

export function analyzeMarket(market: Market, config: { entryThreshold: number; timeWindowMs: number }): EligibleMarket {
  const endDate = new Date(market.endDate);
  const now = new Date();
  const timeRemaining = endDate.getTime() - now.getTime();

  // Parse prices - outcomes are typically ["Up", "Down"]
  const upIndex = market.outcomes.findIndex(o => o.toLowerCase() === "up");
  const downIndex = market.outcomes.findIndex(o => o.toLowerCase() === "down");

  const upPrice = upIndex >= 0 ? parseFloat(market.outcomePrices[upIndex]) : 0;
  const downPrice = downIndex >= 0 ? parseFloat(market.outcomePrices[downIndex]) : 0;

  const upTokenId = upIndex >= 0 ? market.clobTokenIds[upIndex] : "";
  const downTokenId = downIndex >= 0 ? market.clobTokenIds[downIndex] : "";

  let eligibleSide: "UP" | "DOWN" | null = null;

  if (timeRemaining > 0 && timeRemaining <= config.timeWindowMs) {
    if (upPrice >= config.entryThreshold) {
      eligibleSide = "UP";
    } else if (downPrice >= config.entryThreshold) {
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
    upPrice,
    downPrice,
    eligibleSide
  };
}

export async function findEligibleMarkets(config: { entryThreshold: number; timeWindowMs: number }): Promise<EligibleMarket[]> {
  const markets = await fetchBtc15MinMarkets();
  const analyzed = markets.map(m => analyzeMarket(m, config));
  return analyzed.filter(m => m.eligibleSide !== null);
}

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
