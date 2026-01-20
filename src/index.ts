import { Bot, type BotConfig } from "./bot";
import { renderUI } from "./ui";
import { initDatabase } from "./db";

const parseEnvFloat = (key: string, defaultVal: string): number =>
  parseFloat(process.env[key] || defaultVal);

const parseEnvInt = (key: string, defaultVal: string): number =>
  parseInt(process.env[key] || defaultVal);

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
  entryThreshold: parseEnvFloat("ENTRY_THRESHOLD", "0.95"),
  maxEntryPrice: parseEnvFloat("MAX_ENTRY_PRICE", "0.98"),
  stopLoss: parseEnvFloat("STOP_LOSS", "0.80"),
  maxSpread: parseEnvFloat("MAX_SPREAD", "0.03"),
  timeWindowMs: parseEnvInt("TIME_WINDOW_MINS", "5") * 60 * 1000,
  pollIntervalMs: parseEnvInt("POLL_INTERVAL_MS", "10000"),
  paperTrading,
  paperBalance: parseEnvFloat("PAPER_BALANCE", "100"),
  riskMode: (process.env.RISK_MODE || "normal") as "normal" | "super-risk" | "dynamic-risk" | "safe",
  compoundLimit: parseEnvFloat("COMPOUND_LIMIT", "0"),
  baseBalance: parseEnvFloat("BASE_BALANCE", "10"),
  signatureType: parseEnvInt("SIGNATURE_TYPE", "1") as 0 | 1 | 2,
  funderAddress: process.env.FUNDER_ADDRESS,
  maxPositions: parseEnvInt("MAX_POSITIONS", "1")
};

// Validate configuration to catch invalid env vars early
const validateRange = (val: number, min: number, max: number): boolean =>
  !isNaN(val) && val >= min && val <= max;

function validateConfig(config: BotConfig): void {
  const errors: string[] = [];

  if (!validateRange(config.entryThreshold, 0, 1)) {
    errors.push("ENTRY_THRESHOLD must be a number between 0 and 1");
  }
  if (!validateRange(config.stopLoss, 0, 1)) {
    errors.push("STOP_LOSS must be a number between 0 and 1");
  }
  if (!validateRange(config.maxEntryPrice, 0, 1)) {
    errors.push("MAX_ENTRY_PRICE must be a number between 0 and 1");
  }
  if (config.stopLoss >= config.entryThreshold) {
    errors.push("STOP_LOSS must be less than ENTRY_THRESHOLD");
  }
  if (!validateRange(config.paperBalance, 0, Infinity)) {
    errors.push("PAPER_BALANCE must be a positive number");
  }
  if (!validateRange(config.maxPositions, 1, Infinity)) {
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
