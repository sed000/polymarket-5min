/**
 * Simple rate limiter to prevent API throttling
 * Uses token bucket algorithm with configurable rate
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxRequestsPerSecond: number = 5) {
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a request can be made
   * Returns immediately if tokens available, otherwise waits
   */
  async acquire(): Promise<void> {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time until next token
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
    await new Promise(resolve => setTimeout(resolve, waitMs));

    this.refillTokens();
    this.tokens -= 1;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Shared rate limiters for different APIs
// Gamma API: 10 req/s limit (conservative: 5)
export const gammaLimiter = new RateLimiter(5);

// CLOB API: 10 req/s limit (conservative: 5)
export const clobLimiter = new RateLimiter(5);

/**
 * Wrapper to execute a function with rate limiting
 */
export async function withRateLimit<T>(
  limiter: RateLimiter,
  fn: () => Promise<T>
): Promise<T> {
  await limiter.acquire();
  return fn();
}
