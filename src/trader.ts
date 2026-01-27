import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { clobLimiter } from "./rate-limiter";

const CLOB_API = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon

// Polymarket minimum order size in shares
export const MIN_ORDER_SIZE = 5;

// Fee rate for orders (in basis points)
// feeRateBps: ORDER_FEE_RATE_BPS means max acceptable fee is 10% (1000/10000)
// This is a ceiling - actual fees are typically ~1% for takers
// The CLOB API uses this as a slippage/fee tolerance parameter
export const ORDER_FEE_RATE_BPS = 1000;

// Signature types for different wallet types
// 0 = EOA (MetaMask direct)
// 1 = Poly Proxy (Magic.link / email sign-up)
// 2 = Gnosis Safe
export type SignatureType = 0 | 1 | 2;

export interface Position {
  tokenId: string;
  side: "UP" | "DOWN";
  shares: number;
  entryPrice: number;
  marketSlug: string;
}

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export class Trader {
  private client: ClobClient | null = null;
  private signer: Wallet;
  private initialized = false;
  private initError: string | null = null;
  private apiCreds: ApiCreds | null = null;
  private signatureType: SignatureType;
  private funderAddress: string | undefined;

  constructor(privateKey: string, signatureType: SignatureType = 1, funderAddress?: string) {
    this.signer = new Wallet(privateKey);
    this.signatureType = signatureType;
    this.funderAddress = funderAddress;
  }

  async init(): Promise<void> {
    try {
      let creds: { key: string; secret: string; passphrase: string };

      // Check if API credentials are provided via environment
      const envKey = process.env.POLY_API_KEY;
      const envSecret = process.env.POLY_API_SECRET;
      const envPassphrase = process.env.POLY_API_PASSPHRASE;

      if (envKey && envSecret && envPassphrase) {
        // Use provided credentials
        creds = { key: envKey, secret: envSecret, passphrase: envPassphrase };
      } else {
        // Auto-generate credentials from wallet
        // For proxy wallets, need to pass funder address
        const tempClient = new ClobClient(
          CLOB_API,
          CHAIN_ID,
          this.signer,
          undefined,
          this.signatureType,
          this.funderAddress
        );
        // Use createOrDeriveApiKey - creates if not exists, derives if exists
        creds = await tempClient.createOrDeriveApiKey();
      }

      // Store credentials for WebSocket auth
      this.apiCreds = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase
      };

      // Create authenticated client with funder address for proxy wallets
      this.client = new ClobClient(
        CLOB_API,
        CHAIN_ID,
        this.signer,
        creds,
        this.signatureType, // 0=EOA, 1=Poly Proxy (Magic.link), 2=Gnosis Safe
        this.funderAddress  // Proxy wallet address (required for signature type 1)
      );
      this.initialized = true;
    } catch (err: any) {
      // Extract clean error message
      if (err?.response?.data?.error) {
        this.initError = err.response.data.error;
      } else if (err?.message) {
        this.initError = err.message;
      } else {
        this.initError = "Could not connect to CLOB API";
      }
      // Don't log verbose error - it's handled in bot.ts
    }
  }

  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  getInitError(): string | null {
    return this.initError;
  }

  getApiCreds(): ApiCreds | null {
    return this.apiCreds;
  }

  private ensureClient(): ClobClient {
    if (!this.client) throw new Error("Trader not initialized. Call init() first.");
    return this.client;
  }

  private isBalanceAllowanceError(msg: string): boolean {
    return msg.includes("balance") || msg.includes("allowance");
  }

  private async validateAndAdjustShares(
    tokenId: string,
    shares: number,
    logPrefix = ""
  ): Promise<number | null> {
    const positionBalance = await this.getPositionBalance(tokenId);
    const prefix = logPrefix ? `${logPrefix} ` : "";

    // Handle API error
    if (positionBalance === null) {
      console.error(`${prefix}API error fetching position balance`);
      return null;
    }

    if (positionBalance < 0.01) {
      console.error(`${prefix}No position to sell (balance: ${positionBalance.toFixed(4)})`);
      return null;
    }

    const sharesToSell = Math.min(shares, positionBalance);

    if (sharesToSell < 0.01) {
      console.error(`${prefix}Shares to sell too small: ${sharesToSell.toFixed(4)}`);
      return null;
    }

    if (sharesToSell < MIN_ORDER_SIZE) {
      console.error(`${prefix}Actual balance ${sharesToSell.toFixed(2)} below minimum ${MIN_ORDER_SIZE} shares`);
      return null;
    }

    if (sharesToSell < shares * 0.99) {
      console.log(`${prefix}Adjusted sell: ${shares.toFixed(2)} → ${sharesToSell.toFixed(2)} (actual balance)`);
    }

    return sharesToSell;
  }

  async getBalance(): Promise<number | null> {
    const client = this.ensureClient();
    // Get USDC balance from the exchange
    try {
      await clobLimiter.acquire();
      const balances = await client.getBalanceAllowance({
        asset_type: "COLLATERAL"
      });
      const rawBalance = parseFloat(balances.balance || "0");
      // USDC has 6 decimals on Polygon - API returns raw micro-units
      // 22828636 micro-USDC = $22.83
      return rawBalance / 1_000_000;
    } catch (err) {
      console.error(`[Trader] getBalance API error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Get the position balance for a specific token (outcome shares owned)
   * Returns null on API error (distinguish from actual 0 balance)
   */
  async getPositionBalance(tokenId: string): Promise<number | null> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      const balances = await client.getBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: tokenId
      });
      // Conditional token balances are returned in shares (not micro-units)
      // Note: USDC uses 6 decimals (micro-units), but conditional tokens don't
      const rawBalance = parseFloat(balances.balance || "0");
      return rawBalance;
    } catch (err) {
      console.error(`[Trader] getPositionBalance API error: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Wait for position balance to be available (settlement)
   * Returns true if position settled, false if timeout or API errors persist
   */
  async waitForPositionBalance(tokenId: string, minShares: number, timeoutMs: number = 15000): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 1000; // Check every 1 second
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 3;

    while (Date.now() - startTime < timeoutMs) {
      const balance = await this.getPositionBalance(tokenId);

      if (balance === null) {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.error(`[Trader] waitForPositionBalance: ${maxConsecutiveErrors} consecutive API errors`);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      consecutiveErrors = 0;
      if (balance >= minShares * 0.99) { // Allow 1% tolerance for rounding
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    return false;
  }

  async getPrice(tokenId: string): Promise<{ bid: number; ask: number; mid: number }> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      const book = await client.getOrderBook(tokenId);
      const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : 0;
      const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : 1;
      return {
        bid: bestBid,
        ask: bestAsk,
        mid: (bestBid + bestAsk) / 2
      };
    } catch {
      return { bid: 0, ask: 1, mid: 0.5 };
    }
  }

  async buy(tokenId: string, price: number, usdcAmount: number): Promise<{ orderId: string; shares: number } | null> {
    const client = this.ensureClient();

    // Validate price is within Polymarket's allowed range (0.01 - 0.99)
    if (price < 0.01 || price > 0.99) {
      console.error(`Invalid buy price: $${price.toFixed(4)} (must be 0.01-0.99)`);
      return null;
    }

    // Calculate shares: shares = usdc / price
    const shares = Math.floor((usdcAmount / price) * 100) / 100; // Round down to 2 decimals

    if (shares <= 0) {
      console.error("Insufficient funds for purchase");
      return null;
    }

    // Polymarket minimum order size is 5 shares
    if (shares < MIN_ORDER_SIZE) {
      console.error(`Order size ${shares.toFixed(2)} below minimum ${MIN_ORDER_SIZE} shares (need $${(MIN_ORDER_SIZE * price).toFixed(2)} USDC)`);
      return null;
    }

    try {
      await clobLimiter.acquire();
      const response = await client.createAndPostOrder({
        tokenID: tokenId,
        price,
        size: shares,
        side: Side.BUY,
        feeRateBps: ORDER_FEE_RATE_BPS
      });

      if (response.success) {
        return {
          orderId: response.orderID || "",
          shares
        };
      }
      console.error("Order failed:", response.errorMsg);
      return null;
    } catch (err) {
      console.error("Buy error:", err);
      return null;
    }
  }

  async limitSell(tokenId: string, shares: number, price: number, maxRetries: number = 3): Promise<{ orderId: string; price: number } | null> {
    const client = this.ensureClient();

    // Validate input shares
    if (!shares || shares < 0.01) {
      console.error(`Invalid shares to sell: ${shares}`);
      return null;
    }

    // Polymarket minimum order size is 5 shares
    if (shares < MIN_ORDER_SIZE) {
      console.error(`Limit sell size ${shares.toFixed(2)} below minimum ${MIN_ORDER_SIZE} shares - position too small to sell`);
      return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sharesToSell = await this.validateAndAdjustShares(tokenId, shares, "");
        if (sharesToSell === null) return null;

        // Validate price is within Polymarket's allowed range (0.01 - 0.99)
        if (price < 0.01 || price > 0.99) {
          console.error(`Invalid limit price: $${price.toFixed(4)} (must be 0.01-0.99)`);
          return null;
        }

        await clobLimiter.acquire();
        const response = await client.createAndPostOrder({
          tokenID: tokenId,
          price,
          size: sharesToSell,
          side: Side.SELL,
          feeRateBps: ORDER_FEE_RATE_BPS
        });

        if (response.success) {
          return {
            orderId: response.orderID || "",
            price
          };
        }

        if (this.isBalanceAllowanceError(response.errorMsg || "")) {
          console.log(`Sell failed due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }

        console.error("Limit sell failed:", response.errorMsg);
        return null;
      } catch (err: any) {
        if (this.isBalanceAllowanceError(err?.toString() || "")) {
          console.log(`Sell error due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        console.error("Limit sell error:", err);
        return null;
      }
    }

    console.error("Limit sell failed after all retries");
    return null;
  }

  async marketSell(tokenId: string, shares: number, maxRetries: number = 3): Promise<{ orderId: string; price: number } | null> {
    const client = this.ensureClient();

    // Validate input shares
    if (!shares || shares < 0.01) {
      console.error(`[STOP-LOSS] Invalid shares to sell: ${shares}`);
      return null;
    }

    // Polymarket minimum order size is 5 shares
    if (shares < MIN_ORDER_SIZE) {
      console.error(`[STOP-LOSS] Sell size ${shares.toFixed(2)} below minimum ${MIN_ORDER_SIZE} shares - position too small to sell`);
      return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const sharesToSell = await this.validateAndAdjustShares(tokenId, shares, "[STOP-LOSS]");
        if (sharesToSell === null) return null;

        // Get current bid price for market sell (already rate limited)
        const bidCheck = await this.checkBidValid(tokenId);

        if (!bidCheck.valid) {
          if (bidCheck.reason === "empty_book") {
            console.error(`[STOP-LOSS] Order book empty (bid=0) - market may have resolved or no liquidity`);
          } else {
            console.error(`[STOP-LOSS] Bid price too low: $${bidCheck.bid.toFixed(4)} (min: 0.01) - market may have resolved`);
          }
          // Don't retry if market is likely resolved - return null to trigger redemption flow
          return null;
        }

        let validBid = bidCheck.bid;
        if (validBid > 0.99) {
          // Cap at 0.99 (max allowed)
          console.log(`[STOP-LOSS] Capping bid from $${validBid.toFixed(2)} to $0.99`);
          validBid = 0.99;
        }

        await clobLimiter.acquire();
        const response = await client.createAndPostOrder({
          tokenID: tokenId,
          price: validBid,
          size: sharesToSell,
          side: Side.SELL,
          feeRateBps: ORDER_FEE_RATE_BPS
        });

        if (response.success) {
          return {
            orderId: response.orderID || "",
            price: validBid
          };
        }

        if (this.isBalanceAllowanceError(response.errorMsg || "")) {
          // Exponential backoff: 1s, 2s, 4s
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
          console.log(`[STOP-LOSS] Sell failed due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        console.error("[STOP-LOSS] Sell failed:", response.errorMsg);
        return null;
      } catch (err: any) {
        if (this.isBalanceAllowanceError(err?.toString() || "")) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
          console.log(`[STOP-LOSS] Sell error due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        console.error("[STOP-LOSS] Sell error:", err);
        return null;
      }
    }

    console.error("[STOP-LOSS] Market sell failed after all retries - CRITICAL");
    return null;
  }

  async getOpenOrders(): Promise<any[]> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      const orders = await client.getOpenOrders();
      return orders || [];
    } catch {
      return [];
    }
  }

  async getOrder(orderId: string): Promise<any | null> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      const order = await client.getOrder(orderId);
      return order;
    } catch {
      return null;
    }
  }

  async isOrderFilled(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return false;

    // Order is filled if status is 'MATCHED' or if size_matched equals original_size
    return order.status === "MATCHED" ||
           (order.size_matched && order.original_size &&
            parseFloat(order.size_matched) >= parseFloat(order.original_size));
  }

  /**
   * Get detailed fill information for an order
   * Returns actual filled shares and average fill price
   */
  async getOrderFillInfo(orderId: string): Promise<{ filled: boolean; filledShares: number; avgPrice: number } | null> {
    const order = await this.getOrder(orderId);
    if (!order) return null;

    const filledShares = parseFloat(order.size_matched || "0");
    const originalSize = parseFloat(order.original_size || "0");
    const filled = order.status === "MATCHED" || (filledShares >= originalSize && originalSize > 0);

    // Calculate average fill price from the order
    const avgPrice = parseFloat(order.price || "0");

    return { filled, filledShares, avgPrice };
  }

  /**
   * Wait for an order to fill with timeout
   * Returns fill info or null if timeout/cancelled
   */
  async waitForFill(orderId: string, timeoutMs: number = 10000, pollIntervalMs: number = 500): Promise<{ filledShares: number; avgPrice: number } | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const fillInfo = await this.getOrderFillInfo(orderId);

      if (!fillInfo) {
        // Order not found - may have been cancelled
        return null;
      }

      if (fillInfo.filled && fillInfo.filledShares > 0) {
        return { filledShares: fillInfo.filledShares, avgPrice: fillInfo.avgPrice };
      }

      // Check if order was cancelled or rejected
      const order = await this.getOrder(orderId);
      if (order && (order.status === "CANCELLED" || order.status === "REJECTED")) {
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout - check final state and return partial fill if any
    const finalInfo = await this.getOrderFillInfo(orderId);
    if (finalInfo && finalInfo.filledShares > 0) {
      return { filledShares: finalInfo.filledShares, avgPrice: finalInfo.avgPrice };
    }

    return null;
  }

  async cancelOrder(orderId: string, maxRetries: number = 3): Promise<boolean> {
    const client = this.ensureClient();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await clobLimiter.acquire();
        await client.cancelOrder({ orderID: orderId });
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Check if order is already cancelled/filled (not an error)
        if (errMsg.includes("not found") || errMsg.includes("already") || errMsg.includes("cancelled")) {
          console.log(`[Trader] Order ${orderId.slice(0, 8)}... already cancelled/filled`);
          return true;
        }

        console.error(`[Trader] cancelOrder attempt ${attempt}/${maxRetries} failed: ${errMsg}`);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Backoff
        }
      }
    }

    console.error(`[Trader] cancelOrder FAILED after ${maxRetries} attempts: ${orderId.slice(0, 8)}...`);
    return false;
  }

  /**
   * Verify an order was cancelled by checking its status
   */
  async verifyOrderCancelled(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return true; // Not found = cancelled

    const status = (order.status || "").toUpperCase();
    return status === "CANCELLED" || status === "MATCHED" || status === "REJECTED";
  }

  /**
   * Check if bid price is valid for selling (not an empty book or resolved market)
   */
  async checkBidValid(tokenId: string): Promise<{ valid: boolean; bid: number; reason?: string }> {
    const { bid } = await this.getPrice(tokenId);

    // Empty order book (bid = 0) - could be resolved market or no liquidity
    if (bid === 0) {
      return { valid: false, bid, reason: "empty_book" };
    }

    // Below minimum tradeable price - market likely resolved
    if (bid < 0.01) {
      return { valid: false, bid, reason: "below_minimum" };
    }

    return { valid: true, bid };
  }

  getAddress(): string {
    return this.signer.address;
  }
}
