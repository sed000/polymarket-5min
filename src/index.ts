import { Bot } from "./bot";
import { renderUI } from "./ui";
import { initDatabase } from "./db";
import { getConfigManager } from "./config";

// Load configuration from trading.config.json
const configManager = getConfigManager();
const config = configManager.toBotConfig();

// PRIVATE_KEY stays in .env for security
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY && !config.paperTrading) {
  console.error("Error: PRIVATE_KEY environment variable is required for real trading");
  console.error("Create a .env file with your wallet private key:");
  console.error("  PRIVATE_KEY=0x...");
  console.error("\nOr enable paper trading mode in trading.config.json:");
  console.error('  "trading": { "paperTrading": true }');
  process.exit(1);
}

async function main() {
  // Global error handlers for unhandled rejections and exceptions
  // SECURITY FIX: Prevent crashes from unhandled async errors
  process.on("unhandledRejection", (reason, promise) => {
    console.error("[CRITICAL] Unhandled Promise Rejection:", reason);
    // Don't exit - try to keep running, but log the error
  });

  process.on("uncaughtException", (error) => {
    console.error("[CRITICAL] Uncaught Exception:", error);
    // Exit on uncaught exceptions - state may be corrupted
    process.exit(1);
  });

  // Track bot instance for graceful shutdown
  let bot: Bot | null = null;
  let isShuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[${signal}] Initiating graceful shutdown...`);

    // Stop config file watching
    configManager.stopWatching();

    if (bot) {
      try {
        bot.stop();
        console.log("Bot stopped");

        const state = bot.getState();
        if (state.positions.size > 0) {
          console.log(`\nWARNING: ${state.positions.size} open position(s) remain:`);
          for (const [tokenId, pos] of state.positions) {
            console.log(`  - ${pos.side} @ $${pos.entryPrice.toFixed(2)} (${pos.shares.toFixed(2)} shares)`);
          }
          console.log("Positions will continue to be managed by limit orders on Polymarket.");
        }
      } catch (err) {
        console.error("Error during shutdown:", err);
      }
    }

    console.log("Shutdown complete.");
    process.exit(0);
  };

  // Register shutdown handlers
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Initializing Polymarket BTC Bot...\n");
  console.log(`Config: ${configManager.getConfigPath()}`);
  console.log(`Mode: ${config.riskMode}`);

  // Initialize database based on mode
  initDatabase(config.paperTrading);

  // In paper trading mode, use a placeholder key (no real transactions)
  // For real trading, PRIVATE_KEY is validated at startup
  const privateKey = PRIVATE_KEY || "paper-trading-mode";

  bot = new Bot(privateKey, configManager, () => {
    // Logs are handled by UI
  });

  // Start watching config file for hot-reload
  configManager.startWatching();

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
