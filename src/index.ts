import { Bot, type BotConfig } from "./bot";
import { renderUI } from "./ui";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY environment variable is required");
  console.error("Create a .env file with your wallet private key:");
  console.error("  PRIVATE_KEY=0x...");
  process.exit(1);
}

const config: BotConfig = {
  entryThreshold: parseFloat(process.env.ENTRY_THRESHOLD || "0.95"),
  stopLoss: parseFloat(process.env.STOP_LOSS || "0.85"),
  timeWindowMs: parseInt(process.env.TIME_WINDOW_MINS || "5") * 60 * 1000,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000")
};

async function main() {
  console.log("Initializing Polymarket BTC Bot...\n");

  const bot = new Bot(PRIVATE_KEY, config, () => {
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
