import { Bot, type BotConfig } from "./bot";
import { renderUI } from "./ui";

const paperTrading = process.env.PAPER_TRADING === "true";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && !paperTrading) {
  console.error("Error: PRIVATE_KEY environment variable is required for real trading");
  console.error("Create a .env file with your wallet private key:");
  console.error("  PRIVATE_KEY=0x...");
  console.error("\nOr enable paper trading mode:");
  console.error("  PAPER_TRADING=true");
  process.exit(1);
}

const config: BotConfig = {
  entryThreshold: parseFloat(process.env.ENTRY_THRESHOLD || "0.95"),
  maxEntryPrice: parseFloat(process.env.MAX_ENTRY_PRICE || "0.98"),
  stopLoss: parseFloat(process.env.STOP_LOSS || "0.80"),
  stopLossDelayMs: parseInt(process.env.STOP_LOSS_DELAY_MS || "5000"),
  maxSpread: parseFloat(process.env.MAX_SPREAD || "0.03"),
  timeWindowMs: parseInt(process.env.TIME_WINDOW_MINS || "5") * 60 * 1000,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000"),
  paperTrading,
  paperBalance: parseFloat(process.env.PAPER_BALANCE || "100"),
  riskMode: (process.env.RISK_MODE || "normal") as "normal" | "super-risk"
};

async function main() {
  console.log("Initializing Polymarket BTC Bot...\n");

  // In paper trading mode, PRIVATE_KEY is optional
  const privateKey = PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

  const bot = new Bot(privateKey, config, () => {
    // Logs are handled by UI
  });

  // Suppress verbose axios errors during init
  const originalError = console.error;
  console.error = (...args: any[]) => {
    const msg = args[0]?.toString() || "";
    // Only suppress axios/CLOB verbose errors
    if (msg.includes("request error") || msg.includes("CLOB Client")) {
      return;
    }
    originalError.apply(console, args);
  };

  try {
    await bot.init();
  } finally {
    console.error = originalError;
  }

  renderUI(bot);
}

main();
