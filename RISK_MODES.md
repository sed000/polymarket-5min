# Risk Modes

Normal and ladder modes are supported for live trading and backtesting.

Configure parameters in `trading.config.json` under `modes.normal`.
Ladder mode uses `modes.ladder` with per-step buy/sell/stop-loss settings.

For backtesting, set `backtest.mode` to `normal` or `ladder` (or pass `--mode` on the CLI).
