import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { constants, Contract, Wallet, providers } from "ethers";
import { clobLimiter } from "./rate-limiter";

const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const CHAIN_ID = 137; // Polygon
const DEFAULT_RPC_URL = "https://polygon-rpc.com";

// Polygon contracts used for redemption (EOA wallets only)
const CONDITIONAL_TOKENS_ADDRESS = "0x4D97Dcd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERAL_TOKEN_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC
const REDEEM_POSITIONS_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
];

const MARKET_RULES_TTL_MS = 30_000;
const FAST_FILL_TIMEOUT_MS = 1_500;

// Fallback only. Actual minimum order size is fetched per token from CLOB.
export const MIN_ORDER_SIZE = 5;

// Signature types for different wallet types
// 0 = EOA (MetaMask direct)
// 1 = Poly Proxy (Magic.link / email sign-up)
// 2 = Gnosis Safe
export type SignatureType = 0 | 1 | 2;

interface TokenMarketRules {
  minOrderSize: number;
  tickSize: number;
  fetchedAt: number;
}

export interface MarketSellResult {
  orderId: string;
  price: number;
  soldShares: number;
  fullyFilled: boolean;
}

interface RedeemablePositionRow {
  conditionId?: string;
  condition_id?: string;
  redeemable?: boolean | string;
}

export interface RedeemResult {
  attempted: number;
  redeemed: number;
  txHashes: string[];
  errors: string[];
}

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
  private provider: providers.JsonRpcProvider;
  private initialized = false;
  private initError: string | null = null;
  private lastMarketSellError: string | null = null;
  private apiCreds: ApiCreds | null = null;
  private signatureType: SignatureType;
  private funderAddress: string | undefined;
  private tokenRulesCache: Map<string, TokenMarketRules> = new Map();

  constructor(privateKey: string, signatureType: SignatureType = 1, funderAddress?: string) {
    this.provider = new providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || DEFAULT_RPC_URL);
    this.signer = new Wallet(privateKey, this.provider);
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
        creds = { key: envKey, secret: envSecret, passphrase: envPassphrase };
      } else {
        const tempClient = new ClobClient(
          CLOB_API,
          CHAIN_ID,
          this.signer,
          undefined,
          this.signatureType,
          this.funderAddress
        );
        creds = await tempClient.createOrDeriveApiKey();
      }

      this.apiCreds = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase
      };

      this.client = new ClobClient(
        CLOB_API,
        CHAIN_ID,
        this.signer,
        creds,
        this.signatureType,
        this.funderAddress
      );
      this.initialized = true;
    } catch (err: any) {
      if (err?.response?.data?.error) {
        this.initError = err.response.data.error;
      } else if (err?.message) {
        this.initError = err.message;
      } else {
        this.initError = "Could not connect to CLOB API";
      }
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

  getLastMarketSellError(): string | null {
    return this.lastMarketSellError;
  }

  private ensureClient(): ClobClient {
    if (!this.client) throw new Error("Trader not initialized. Call init() first.");
    return this.client;
  }

  private isBalanceAllowanceError(msg: string): boolean {
    return msg.includes("balance") || msg.includes("allowance");
  }

  private parsePositiveNumber(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  private clampPriceToTick(price: number, tickSize: number): number {
    const bounded = Math.min(1 - tickSize, Math.max(tickSize, price));
    const ticks = Math.floor(bounded / tickSize);
    return Number((ticks * tickSize).toFixed(6));
  }

  private async fetchTokenMarketRules(tokenId: string): Promise<TokenMarketRules> {
    const now = Date.now();
    const cached = this.tokenRulesCache.get(tokenId);
    if (cached && now - cached.fetchedAt < MARKET_RULES_TTL_MS) {
      return cached;
    }

    const fallback: TokenMarketRules = {
      minOrderSize: MIN_ORDER_SIZE,
      tickSize: 0.01,
      fetchedAt: now
    };

    try {
      let book: any;
      if (this.client) {
        await clobLimiter.acquire();
        book = await this.client.getOrderBook(tokenId);
      } else {
        await clobLimiter.acquire();
        const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        book = await res.json();
      }

      const minOrderSize = this.parsePositiveNumber(book?.min_order_size) ?? MIN_ORDER_SIZE;
      const tickSize = this.parsePositiveNumber(book?.tick_size) ?? 0.01;

      const rules: TokenMarketRules = {
        minOrderSize,
        tickSize,
        fetchedAt: now
      };
      this.tokenRulesCache.set(tokenId, rules);
      return rules;
    } catch {
      this.tokenRulesCache.set(tokenId, fallback);
      return fallback;
    }
  }

  async getMinOrderSize(tokenId: string): Promise<number> {
    const rules = await this.fetchTokenMarketRules(tokenId);
    return rules.minOrderSize;
  }

  async getTickSize(tokenId: string): Promise<number> {
    const rules = await this.fetchTokenMarketRules(tokenId);
    return rules.tickSize;
  }

  private async validateAndAdjustShares(
    tokenId: string,
    shares: number,
    logPrefix = ""
  ): Promise<{ sharesToSell: number; minOrderSize: number } | null> {
    const positionBalance = await this.getPositionBalance(tokenId);
    const prefix = logPrefix ? `${logPrefix} ` : "";

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

    const minOrderSize = await this.getMinOrderSize(tokenId);
    if (sharesToSell < minOrderSize) {
      console.error(`${prefix}Actual balance ${sharesToSell.toFixed(4)} below token minimum ${minOrderSize.toFixed(4)} shares`);
      return null;
    }

    if (sharesToSell < shares * 0.99) {
      console.log(`${prefix}Adjusted sell: ${shares.toFixed(2)} -> ${sharesToSell.toFixed(2)} (actual balance)`);
    }

    return { sharesToSell, minOrderSize };
  }

  async getBalance(): Promise<number | null> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      const balances = await client.getBalanceAllowance({
        asset_type: "COLLATERAL"
      });
      const rawBalance = parseFloat(balances.balance || "0");
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
      const rawBalance = parseFloat(balances.balance || "0");
      return rawBalance / 1e6;
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
    const pollInterval = 1000;
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
      if (balance >= minShares * 0.99) {
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

    if (price < 0.0001 || price >= 1) {
      console.error(`Invalid buy price: $${price.toFixed(4)}`);
      return null;
    }

    const rules = await this.fetchTokenMarketRules(tokenId);
    const limitPrice = this.clampPriceToTick(price, rules.tickSize);
    const shares = Math.floor((usdcAmount / limitPrice) * 100) / 100;

    if (shares <= 0) {
      console.error("Insufficient funds for purchase");
      return null;
    }

    if (shares < rules.minOrderSize) {
      console.error(
        `Order size ${shares.toFixed(2)} below token minimum ${rules.minOrderSize.toFixed(2)} shares (need ~$${(rules.minOrderSize * limitPrice).toFixed(2)} USDC)`
      );
      return null;
    }

    try {
      await clobLimiter.acquire();
      const response = await client.createAndPostOrder({
        tokenID: tokenId,
        price: limitPrice,
        size: shares,
        side: Side.BUY
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

    if (!shares || shares < 0.01) {
      console.error(`Invalid shares to sell: ${shares}`);
      return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const adjusted = await this.validateAndAdjustShares(tokenId, shares, "");
        if (!adjusted) return null;

        const tickSize = await this.getTickSize(tokenId);
        const limitPrice = this.clampPriceToTick(price, tickSize);

        await clobLimiter.acquire();
        const response = await client.createAndPostOrder({
          tokenID: tokenId,
          price: limitPrice,
          size: adjusted.sharesToSell,
          side: Side.SELL
        });

        if (response.success) {
          return {
            orderId: response.orderID || "",
            price: limitPrice
          };
        }

        if (this.isBalanceAllowanceError(response.errorMsg || "")) {
          const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 2000);
          console.log(`Sell failed due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        console.error("Limit sell failed:", response.errorMsg);
        return null;
      } catch (err: any) {
        if (this.isBalanceAllowanceError(err?.toString() || "")) {
          const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 2000);
          console.log(`Sell error due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        console.error("Limit sell error:", err);
        return null;
      }
    }

    console.error("Limit sell failed after all retries");
    return null;
  }

  async marketSell(
    tokenId: string,
    shares: number,
    bidOverride?: number,
    maxRetries: number = 3
  ): Promise<MarketSellResult | null> {
    const client = this.ensureClient();
    this.lastMarketSellError = null;

    if (!shares || shares < 0.01) {
      const errMsg = `[STOP-LOSS] Invalid shares to sell: ${shares}`;
      this.lastMarketSellError = errMsg;
      throw new Error(errMsg);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const adjusted = await this.validateAndAdjustShares(tokenId, shares, "[STOP-LOSS]");
        if (!adjusted) {
          throw new Error("[STOP-LOSS] Could not validate sell shares");
        }

        const rules = await this.fetchTokenMarketRules(tokenId);
        const orderType = attempt === 1 ? OrderType.FOK : OrderType.FAK;

        let priceCap: number | undefined;
        if (Number.isFinite(bidOverride ?? NaN) && (bidOverride as number) > 0) {
          priceCap = this.clampPriceToTick(bidOverride as number, rules.tickSize);
        }

        await clobLimiter.acquire();
        const response = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            amount: adjusted.sharesToSell,
            side: Side.SELL,
            ...(priceCap ? { price: priceCap } : {}),
            orderType
          },
          undefined,
          orderType
        );

        if (!response.success) {
          if (this.isBalanceAllowanceError(response.errorMsg || "")) {
            const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 2000);
            console.log(`[STOP-LOSS] Sell failed due to balance/allowance (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }

          const errMsg = `[STOP-LOSS] Sell failed: ${response.errorMsg || "unknown error"}`;
          this.lastMarketSellError = errMsg;
          if (attempt < maxRetries) continue;
          return null;
        }

        const orderId = response.orderID || "";
        const fillInfo = await this.waitForFill(orderId, FAST_FILL_TIMEOUT_MS, 150);

        if (!fillInfo || fillInfo.filledShares <= 0) {
          const errMsg = `[STOP-LOSS] Market order had no fills (${orderType})`;
          this.lastMarketSellError = errMsg;
          if (attempt < maxRetries) continue;
          return null;
        }

        const soldShares = Math.min(adjusted.sharesToSell, fillInfo.filledShares);
        const fullyFilled = soldShares >= adjusted.sharesToSell * 0.99;

        if (!fullyFilled && orderType === OrderType.FOK && attempt < maxRetries) {
          continue;
        }

        const execPrice = fillInfo.avgPrice > 0
          ? fillInfo.avgPrice
          : (priceCap ?? bidOverride ?? 0);

        return {
          orderId,
          price: execPrice,
          soldShares,
          fullyFilled
        };
      } catch (err: any) {
        if (this.isBalanceAllowanceError(err?.toString() || "")) {
          const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 2000);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        this.lastMarketSellError = errMsg;
        if (attempt < maxRetries) continue;
        return null;
      }
    }

    const errMsg = "[STOP-LOSS] Market sell failed after retries";
    this.lastMarketSellError = errMsg;
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

    return order.status === "MATCHED" ||
      (order.size_matched && order.original_size &&
        parseFloat(order.size_matched) >= parseFloat(order.original_size));
  }

  /**
   * Get detailed fill information for an order
   * Returns actual filled shares and average fill price
   */
  async getOrderFillInfo(orderId: string): Promise<{ filled: boolean; filledShares: number; avgPrice: number; status: string } | null> {
    const order = await this.getOrder(orderId);
    if (!order) return null;

    const filledShares = parseFloat(order.size_matched || "0");
    const originalSize = parseFloat(order.original_size || "0");
    const filled = order.status === "MATCHED" || (filledShares >= originalSize && originalSize > 0);

    const avgPrice = parseFloat(order.price || "0");
    const status = (order.status || "").toUpperCase();

    return { filled, filledShares, avgPrice, status };
  }

  /**
   * Wait for an order to fill with timeout
   * Returns fill info (including partial fills) or null
   */
  async waitForFill(orderId: string, timeoutMs: number = 10000, pollIntervalMs: number = 500): Promise<{ filledShares: number; avgPrice: number } | null> {
    const startTime = Date.now();
    let consecutiveApiErrors = 0;
    const maxConsecutiveApiErrors = 5;

    while (Date.now() - startTime < timeoutMs) {
      const fillInfo = await this.getOrderFillInfo(orderId);

      if (!fillInfo) {
        consecutiveApiErrors++;
        if (consecutiveApiErrors >= maxConsecutiveApiErrors) {
          return null;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      consecutiveApiErrors = 0;

      if (fillInfo.filled && fillInfo.filledShares > 0) {
        return { filledShares: fillInfo.filledShares, avgPrice: fillInfo.avgPrice };
      }

      if ((fillInfo.status === "CANCELLED" || fillInfo.status === "REJECTED") && fillInfo.filledShares > 0) {
        return { filledShares: fillInfo.filledShares, avgPrice: fillInfo.avgPrice };
      }

      if (fillInfo.status === "CANCELLED" || fillInfo.status === "REJECTED") {
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

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

        if (errMsg.includes("not found") || errMsg.includes("already") || errMsg.includes("cancelled")) {
          return true;
        }

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return false;
  }

  async cancelOrdersForToken(tokenId: string): Promise<boolean> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      await client.cancelMarketOrders({ asset_id: tokenId });
      return true;
    } catch {
      return false;
    }
  }

  async cancelOrdersForMarket(marketId: string): Promise<boolean> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      await client.cancelMarketOrders({ market: marketId });
      return true;
    } catch {
      return false;
    }
  }

  async cancelAllOrders(): Promise<boolean> {
    const client = this.ensureClient();
    try {
      await clobLimiter.acquire();
      await client.cancelAll();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify an order was cancelled by checking its status
   */
  async verifyOrderCancelled(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return true;

    const status = (order.status || "").toUpperCase();
    return status === "CANCELLED" || status === "MATCHED" || status === "REJECTED";
  }

  /**
   * Check if bid price is valid for selling (not an empty book)
   */
  async checkBidValid(tokenId: string): Promise<{ valid: boolean; bid: number; reason?: string }> {
    const { bid } = await this.getPrice(tokenId);

    if (bid <= 0) {
      return { valid: false, bid, reason: "empty_book" };
    }

    return { valid: true, bid };
  }

  private canAutoRedeem(): boolean {
    return this.signatureType === 0 && !this.funderAddress;
  }

  private getInventoryAddress(): string {
    return this.funderAddress || this.signer.address;
  }

  async getRedeemableConditionIds(): Promise<string[]> {
    try {
      const user = this.getInventoryAddress();
      const url = `${DATA_API}/positions?user=${user}&sizeThreshold=0&redeemable=true&limit=500`;
      const res = await fetch(url);
      if (!res.ok) return [];

      const rows = await res.json();
      if (!Array.isArray(rows)) return [];

      const conditionIds = new Set<string>();
      for (const row of rows as RedeemablePositionRow[]) {
        const raw = row.conditionId || row.condition_id;
        if (typeof raw !== "string" || !raw.startsWith("0x") || raw.length !== 66) continue;

        const redeemable = row.redeemable;
        const isRedeemable = redeemable === true || redeemable === "true" || redeemable === undefined;
        if (!isRedeemable) continue;

        conditionIds.add(raw);
      }

      return [...conditionIds];
    } catch {
      return [];
    }
  }

  async redeemCondition(conditionId: string, indexSets: number[] = [1, 2]): Promise<string | null> {
    if (!this.canAutoRedeem()) {
      return null;
    }

    const contract = new Contract(CONDITIONAL_TOKENS_ADDRESS, REDEEM_POSITIONS_ABI, this.signer);
    const tx = await contract.redeemPositions(
      COLLATERAL_TOKEN_ADDRESS,
      constants.HashZero,
      conditionId,
      indexSets
    );
    const receipt = await tx.wait();
    return receipt.transactionHash;
  }

  async redeemAllRedeemablePositions(): Promise<RedeemResult> {
    const result: RedeemResult = {
      attempted: 0,
      redeemed: 0,
      txHashes: [],
      errors: []
    };

    const conditionIds = await this.getRedeemableConditionIds();
    result.attempted = conditionIds.length;

    if (conditionIds.length === 0) {
      return result;
    }

    if (!this.canAutoRedeem()) {
      result.errors.push("Auto-redeem is only supported for signatureType=0 EOA wallets");
      return result;
    }

    for (const conditionId of conditionIds) {
      try {
        const txHash = await this.redeemCondition(conditionId);
        if (txHash) {
          result.redeemed++;
          result.txHashes.push(txHash);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${conditionId}: ${message}`);
      }
    }

    return result;
  }

  getAddress(): string {
    return this.signer.address;
  }
}
