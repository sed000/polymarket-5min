# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Trading Bot - An automated trading bot for Polymarket's BTC 15-minute prediction markets. The bot monitors Bitcoin price prediction markets, executes trades based on configurable thresholds, and supports paper trading, backtesting, and real trading modes.

## Commands

### Running the Bot
```bash
bun install          # Install dependencies
bun dev              # Run with auto-reload (development)
bun start            # Run production
```

### Database Queries
```bash
bun run db:paper     # View paper trading results (normal mode)
bun run db:real      # View real trading results
bun run db:stats:paper  # Paper trading statistics
bun run db:stats:real   # Real trading statistics
bun run db:reset:*      # Reset specific database
```

### Backtesting
```bash
bun run backtest:run      # Run backtest with current config
bun run backtest:fetch    # Fetch historical data
bun run backtest:optimize # Parameter optimization
bun run backtest:stats    # View backtest statistics
bun run backtest:history  # View historical runs
```

## Architecture

### Core Components

**src/config.ts** - Configuration manager with hot-reload support. Loads `trading.config.json`, validates settings, emits change events for live updates.

**src/index.ts** - Entry point. Loads configuration from `trading.config.json`, initializes database, creates Bot instance, and renders terminal UI.

**src/bot.ts** - Main trading logic (`Bot` class):
- Position management with mutex-protected entry/exit to prevent race conditions
- Real-time price monitoring via WebSocket with fallback to REST API
- Immediate stop-loss execution when price drops below threshold
- Profit target limit orders at $0.99
- Compound limit system (take profit when balance exceeds threshold)
- Paper trading simulation with virtual balance

**src/trader.ts** - Polymarket CLOB API wrapper. Handles order execution, wallet interaction, signature types (EOA, Magic.link proxy, Gnosis Safe).

**src/scanner.ts** - Market discovery. Fetches BTC 15-min markets from Gamma API, analyzes for entry signals based on price thresholds and spread filters.

**src/websocket.ts** - WebSocket connection for real-time orderbook prices. Maintains subscription state, handles reconnection.

**src/db.ts** - SQLite database layer using `bun:sqlite`. Two database systems:
- Trading DB: `trades_real.db`, `trades_paper_normal.db`
- Backtest DB: `backtest.db` with price history, historical markets, and run results
- Backtest tables: `backtest_runs`, `backtest_trades`, `historical_markets`, `price_history`

**src/ui.tsx** - Terminal UI using Ink (React for CLI). Displays market overview, positions, logs, and stats.

### Backtest System (src/backtest/)

- **index.ts** - CLI entry point for backtest commands
- **engine.ts** - Simulation engine replaying historical price ticks
- **data-fetcher.ts** - Fetches and caches historical market data
- **optimizer.ts** - Grid search for optimal parameters
- **reporter.ts** - Performance metrics and reporting
- **types.ts** - Type definitions and default configs

## Key Configuration

Configuration is stored in `trading.config.json` with hot-reload support. Edit the file while the bot is running and changes apply immediately.

### Config File Structure (`trading.config.json`)
```json
{
  "trading": {
    "paperTrading": true,       // Enable paper trading mode
    "paperBalance": 100,        // Starting balance for paper trading
    "maxPositions": 1,          // Max concurrent positions
    "pollIntervalMs": 10000     // Market scan interval
  },
  "wallet": {
    "signatureType": 0,         // 0=EOA, 1=Magic.link proxy, 2=Gnosis Safe
    "funderAddress": null       // Required for signature type 1
  },
  "profitTaking": {
    "compoundLimit": 0,         // Take profit when balance exceeds this (0=disabled)
    "baseBalance": 10           // Reset to this after taking profit
  },
  "activeMode": "normal",       // Current trading mode
  "modes": {
    "normal": { ... }           // Mode parameters
  },
  "backtest": {
    "mode": "normal",           // Mode to use for backtesting
    "startingBalance": 100,
    "days": 7,
    "slippage": 0.001
  },
  "advanced": {
    "wsPriceMaxAgeMs": 5000,
    "marketRefreshInterval": 30000,
    "paperFeeRate": 0.01
  }
}
```

### Mode Configuration
Normal mode defines trading parameters:
- `entryThreshold` - Minimum price to enter (e.g., 0.95)
- `maxEntryPrice` - Maximum price to enter (e.g., 0.98)
- `stopLoss` - Exit trigger price (e.g., 0.80)
- `profitTarget` - Limit order price for profit taking
- `maxSpread` - Max bid-ask spread to accept
- `timeWindowMs` - Time remaining before market close to enter

### Environment Variables
Only secrets remain in `.env`:
- `PRIVATE_KEY` - Wallet private key (required for real trading)
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` - API credentials

### Hot-Reload Behavior
**Safe to change live:**
- Mode parameters (thresholds, stops, spreads)
- `compoundLimit`, `baseBalance`
- `maxPositions` (affects new entries only)
- `pollIntervalMs` (restarts polling)

**Require restart:**
- `paperTrading` (changes database)
- `signatureType`, `funderAddress` (wallet config)

## Important Patterns

- **Position mutex**: `pendingEntries` and `pendingExits` Sets prevent race conditions in concurrent WebSocket callbacks
- **Opposite-side rule**: After a winning trade, only enter the opposite side in the same market (prevents chasing)
- **Market slug format**: `btc-updown-15m-{unix_timestamp}` where timestamp is interval start
- **Price data flow**: WebSocket preferred → REST API fallback → Gamma API for market discovery
