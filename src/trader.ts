import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const CLOB_API = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon

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

  async getBalance(): Promise<number> {
    const client = this.ensureClient();
    // Get USDC balance from the exchange
    try {
      const balances = await client.getBalanceAllowance({
        asset_type: "COLLATERAL"
      });
      return parseFloat(balances.balance || "0");
    } catch {
      return 0;
    }
  }

  async getPrice(tokenId: string): Promise<{ bid: number; ask: number; mid: number }> {
    const client = this.ensureClient();
    try {
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

    // Calculate shares: shares = usdc / price
    const shares = Math.floor((usdcAmount / price) * 100) / 100; // Round down to 2 decimals

    if (shares <= 0) {
      console.error("Insufficient funds for purchase");
      return null;
    }

    try {
      const response = await client.createAndPostOrder({
        tokenID: tokenId,
        price,
        size: shares,
        side: Side.BUY,
        feeRateBps: 0
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

  async limitSell(tokenId: string, shares: number, price: number): Promise<{ orderId: string; price: number } | null> {
    const client = this.ensureClient();

    try {
      const response = await client.createAndPostOrder({
        tokenID: tokenId,
        price,
        size: shares,
        side: Side.SELL,
        feeRateBps: 0
      });

      if (response.success) {
        return {
          orderId: response.orderID || "",
          price
        };
      }
      console.error("Limit sell failed:", response.errorMsg);
      return null;
    } catch (err) {
      console.error("Limit sell error:", err);
      return null;
    }
  }

  async marketSell(tokenId: string, shares: number): Promise<{ orderId: string; price: number } | null> {
    const client = this.ensureClient();

    try {
      // Get current bid price for market sell
      const { bid } = await this.getPrice(tokenId);
      if (bid <= 0) {
        console.error("No bid available");
        return null;
      }

      const response = await client.createAndPostOrder({
        tokenID: tokenId,
        price: bid,
        size: shares,
        side: Side.SELL,
        feeRateBps: 0
      });

      if (response.success) {
        return {
          orderId: response.orderID || "",
          price: bid
        };
      }
      console.error("Sell failed:", response.errorMsg);
      return null;
    } catch (err) {
      console.error("Sell error:", err);
      return null;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    const client = this.ensureClient();
    try {
      const orders = await client.getOpenOrders();
      return orders || [];
    } catch {
      return [];
    }
  }

  async getOrder(orderId: string): Promise<any | null> {
    const client = this.ensureClient();
    try {
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

  async cancelOrder(orderId: string): Promise<boolean> {
    const client = this.ensureClient();
    try {
      await client.cancelOrder({ orderID: orderId });
      return true;
    } catch {
      return false;
    }
  }

  getAddress(): string {
    return this.signer.address;
  }
}
