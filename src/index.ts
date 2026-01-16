import { Bot, type BotConfig } from "./bot";
import { renderUI } from "./ui";
import { initDatabase } from "./db";

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
  maxSpread: parseFloat(process.env.MAX_SPREAD || "0.03"),
  timeWindowMs: parseInt(process.env.TIME_WINDOW_MINS || "5") * 60 * 1000,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000"),
  paperTrading,
  paperBalance: parseFloat(process.env.PAPER_BALANCE || "100"),
  riskMode: (process.env.RISK_MODE || "normal") as "normal" | "super-risk" | "dynamic-risk",
  compoundLimit: parseFloat(process.env.COMPOUND_LIMIT || "0"),
  baseBalance: parseFloat(process.env.BASE_BALANCE || "10"),
  signatureType: parseInt(process.env.SIGNATURE_TYPE || "1") as 0 | 1 | 2,
  funderAddress: process.env.FUNDER_ADDRESS,
  maxPositions: parseInt(process.env.MAX_POSITIONS || "1")
};

// Validate configuration to catch invalid env vars early
function validateConfig(config: BotConfig): void {
  const errors: string[] = [];

  if (isNaN(config.entryThreshold) || config.entryThreshold < 0 || config.entryThreshold > 1) {
    errors.push("ENTRY_THRESHOLD must be a number between 0 and 1");
  }
  if (isNaN(config.stopLoss) || config.stopLoss < 0 || config.stopLoss > 1) {
    errors.push("STOP_LOSS must be a number between 0 and 1");
  }
  if (isNaN(config.maxEntryPrice) || config.maxEntryPrice < 0 || config.maxEntryPrice > 1) {
    errors.push("MAX_ENTRY_PRICE must be a number between 0 and 1");
  }
  if (config.stopLoss >= config.entryThreshold) {
    errors.push("STOP_LOSS must be less than ENTRY_THRESHOLD");
  }
  if (isNaN(config.paperBalance) || config.paperBalance < 0) {
    errors.push("PAPER_BALANCE must be a positive number");
  }
  if (isNaN(config.maxPositions) || config.maxPositions < 1) {
    errors.push("MAX_POSITIONS must be at least 1");
  }

  if (errors.length > 0) {
    console.error("Configuration errors:");
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}

validateConfig(config);

async function main() {
  console.log("Initializing Polymarket BTC Bot...\n");

  // Initialize database based on mode
  initDatabase(config.paperTrading, config.riskMode);

  // In paper trading mode, use a placeholder key (no real transactions)
  // For real trading, PRIVATE_KEY is validated at startup
  const privateKey = PRIVATE_KEY || "paper-trading-mode";

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
