# Polymarket Trading Bot

Automated trading bot for Polymarket prediction markets with paper trading, backtesting, and live trading support.

**What It Does**
- Scans markets and places trades based on your config
- Supports `normal` and `ladder` modes
- Paper trading and real trading
- Backtesting and parameter optimization
- Stores trades and logs in SQLite

**Quick Start**
1. `bun install`
2. `bun dev`
3. Edit `trading.config.json` to tune thresholds, mode, and paper balance

**How To Use The Bot**
- Run in paper mode first (default) and watch the terminal UI
- Change `trading.paperTrading` to `false` for real trading
- Adjust `activeMode` and the values under `modes` to control entries/exits
- Config reloads automatically while the bot is running

**Configuration**
- The bot uses `trading.config.json` (auto-created if missing)
- Common settings:
- `trading.paperTrading`, `trading.paperBalance`, `trading.maxPositions`
- `activeMode` and `modes.normal` or `modes.ladder`
- `backtest` settings for historical runs

**Environment Variables (Real Trading)**
- `PRIVATE_KEY` is required when `trading.paperTrading` is `false`
- Optional: `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` (auto-derived if not set)

**Commands**
- `bun start` run the bot
- `bun dev` run with auto-reload
- `bun run backtest:run` run a backtest
- `bun run backtest:optimize` optimize parameters
- `bun run db:paper` recent paper trades
- `bun run db:real` recent real trades
- `bun run db:stats:paper` paper trading stats
- `bun run db:stats:real` real trading stats
