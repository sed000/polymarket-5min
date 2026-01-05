import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const CLOB_API = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon

export interface Position {
  tokenId: string;
  side: "UP" | "DOWN";
  shares: number;
  entryPrice: number;
  marketSlug: string;
}

export class Trader {
  private client: ClobClient | null = null;
  private signer: Wallet;
  private initialized = false;
  private initError: string | null = null;

  constructor(privateKey: string) {
    this.signer = new Wallet(privateKey);
  }

  async init(): Promise<void> {
    try {
      // Create temp client to get API credentials
      const tempClient = new ClobClient(CLOB_API, CHAIN_ID, this.signer);
      const apiCreds = await tempClient.createOrDeriveApiKey();

      // Create authenticated client
      this.client = new ClobClient(
        CLOB_API,
        CHAIN_ID,
        this.signer,
        apiCreds,
        0 // EOA signature type
      );
      this.initialized = true;
    } catch (err: any) {
      this.initError = err?.response?.data?.error || err?.message || "Unknown error";
      console.error(`[CLOB Client] ${this.initError}`);
      // Continue without trading capability - can still view markets
    }
  }

  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  getInitError(): string | null {
    return this.initError;
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
