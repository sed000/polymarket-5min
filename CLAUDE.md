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
bun run db:risk      # View risk mode results (super-risk)
bun run db:dynamic   # View dynamic-risk mode results
bun run db:real      # View real trading results
bun run db:stats:paper  # Paper trading statistics
bun run db:stats:risk   # Risk mode statistics
bun run db:stats:dynamic # Dynamic-risk mode statistics
bun run db:stats:real   # Real trading statistics
bun run db:reset:*      # Reset specific database
```

### Backtesting
```bash
bun run backtest:run      # Run backtest with current config
bun run backtest:fetch    # Fetch historical data
bun run backtest:optimize # Parameter optimization
bun run backtest:compare  # Compare backtest runs
bun run backtest:stats    # View backtest statistics
bun run backtest:history  # View historical runs
```

## Architecture

### Core Components

**src/index.ts** - Entry point. Loads environment config, validates parameters, initializes database, creates Bot instance, and renders terminal UI.

**src/bot.ts** - Main trading logic (`Bot` class):
- Position management with mutex-protected entry/exit to prevent race conditions
- Three risk modes: "normal" (conservative), "super-risk" (aggressive), and "dynamic-risk" (adaptive)
- Real-time price monitoring via WebSocket with fallback to REST API
- Stop-loss with configurable confirmation delay
- Profit target limit orders at $0.99
- Compound limit system (take profit when balance exceeds threshold)
- Paper trading simulation with virtual balance
- Consecutive loss/win tracking for dynamic-risk mode

**src/trader.ts** - Polymarket CLOB API wrapper. Handles order execution, wallet interaction, signature types (EOA, Magic.link proxy, Gnosis Safe).

**src/scanner.ts** - Market discovery. Fetches BTC 15-min markets from Gamma API, analyzes for entry signals based on price thresholds and spread filters.

**src/websocket.ts** - WebSocket connection for real-time orderbook prices. Maintains subscription state, handles reconnection.

**src/db.ts** - SQLite database layer using `bun:sqlite`. Two database systems:
- Trading DB: `trades_real.db`, `trades_paper_normal.db`, `trades_paper_risk.db`, `trades_paper_dynamic.db`
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

Environment variables control trading behavior (see `.env.example`):
- `PAPER_TRADING` - Enable paper trading mode
- `PAPER_BALANCE` - Starting balance for paper trading (default: 100)
- `RISK_MODE` - "normal", "super-risk", or "dynamic-risk"
- `MAX_POSITIONS` - Maximum concurrent positions (default: 1)
- `ENTRY_THRESHOLD` - Minimum price to enter (e.g., 0.95)
- `MAX_ENTRY_PRICE` - Maximum price to enter (e.g., 0.98)
- `STOP_LOSS` - Exit trigger price (e.g., 0.80)
- `STOP_LOSS_DELAY_MS` - Confirmation delay before stop-loss
- `COMPOUND_LIMIT` / `BASE_BALANCE` - Profit taking system
- `SIGNATURE_TYPE` - 0=EOA, 1=Magic.link proxy, 2=Gnosis Safe

### Backtest-Specific Variables
- `BACKTEST_MODE` - Risk mode for backtesting
- `BACKTEST_ENTRY_THRESHOLD` / `BACKTEST_MAX_ENTRY_PRICE` - Entry prices
- `BACKTEST_STOP_LOSS` / `BACKTEST_STOP_LOSS_DELAY_MS` - Stop-loss config
- `BACKTEST_PROFIT_TARGET` - Target exit price (default: 0.98)
- `BACKTEST_MAX_SPREAD` / `BACKTEST_TIME_WINDOW_MINS` - Filters
- `BACKTEST_STARTING_BALANCE` / `BACKTEST_DAYS` - Simulation settings

## Important Patterns

- **Position mutex**: `pendingEntries` and `pendingExits` Sets prevent race conditions in concurrent WebSocket callbacks
- **Opposite-side rule**: After a winning trade, only enter the opposite side in the same market (prevents chasing)
- **Market slug format**: `btc-updown-15m-{unix_timestamp}` where timestamp is interval start
- **Price data flow**: WebSocket preferred → REST API fallback → Gamma API for market discovery

### Dynamic-Risk Mode Strategy
- **Adaptive entry threshold**: Base $0.70, increases +$0.05 per consecutive loss (capped at $0.85)
- **Position-relative stop-loss**: 32.5% max drawdown per trade (calculated from entry price)
- **Loss streak tracking**: `consecutiveLosses` / `consecutiveWins` in BotState
- **Recovery behavior**: Win streak resets threshold to base, preventing "revenge trading"
- **Stop-loss delay**: 2 seconds (vs 0ms for super-risk)
