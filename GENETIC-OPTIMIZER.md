# Genetic Algorithm Strategy Optimizer

Find the best trading parameters automatically using a genetic algorithm.

## Quick Start

```bash
# Run optimization with defaults (50 population, 100 generations)
bun run backtest:genetic --days 14
```

## Commands

### Basic Usage

```bash
# Optimize using last 14 days of data
bun run backtest:genetic --days 14

# Optimize using last 30 days
bun run backtest:genetic --days 30

# Optimize with specific date range
bun run backtest:genetic --start 2025-12-01 --end 2025-12-31
```

### Advanced Options

```bash
bun run backtest:genetic --days 14 \
  --population 100 \    # More candidates (default: 50)
  --generations 200 \   # More iterations (default: 100)
  --mutation 0.20 \     # Higher mutation rate (default: 0.15)
  --train-split 0.8 \   # 80% train, 20% validate (default: 0.7)
  --elite 10            # Keep top 10 each generation (default: 5)
```

### Export Results

```bash
# Export to JSON
bun run backtest:genetic --days 14 --export results.json

# Export as .env config
bun run backtest:genetic --days 14 --export config.env
```

## What It Does

1. **Splits your data**: 70% for training, 30% for validation
2. **Creates random strategies**: Population of 50 different parameter combinations
3. **Evolves them**: Keeps the best, combines them, adds mutations
4. **Validates**: Tests top strategies on unseen data to prevent overfitting
5. **Reports**: Shows best parameters with in-sample and out-of-sample performance

## Parameters It Optimizes

| Parameter | Range | What It Controls |
|-----------|-------|------------------|
| Entry Threshold | $0.70 - $0.96 | Minimum price to buy |
| Max Entry Price | $0.92 - $0.99 | Maximum price to buy |
| Stop Loss | $0.30 - $0.80 | Exit if price drops below |
| Stop Loss Delay | 0 - 10000ms | Wait before executing stop |
| Max Spread | $0.02 - $0.08 | Max bid-ask spread allowed |
| Time Window | 1 - 15 min | How close to market end to trade |
| Profit Target | $0.98 - $0.99 | Take profit price |

## Understanding the Output

```
--- Best Strategy Parameters ---
  Entry Threshold:     $0.96    <- Only buy when price is >= $0.96
  Max Entry Price:     $0.97    <- Don't buy if price > $0.97
  Stop Loss:           $0.37    <- Sell if price drops to $0.37
  Stop Loss Delay:     5546ms   <- Wait 5.5s before stop loss
  Max Spread:          $0.080   <- Allow up to 8 cent spread
  Time Window:         1.8 min  <- Enter within 1.8 min of market end
  Profit Target:       $0.99    <- Take profit at $0.99

--- In-Sample Performance (Training) ---
  Win Rate:            100.0%   <- Wins on training data
  Total PnL:           $169.11  <- Profit on training data

--- Out-of-Sample Performance (Validation) ---
  Win Rate:            100.0%   <- Wins on NEW unseen data
  Total PnL:           $131.32  <- Profit on unseen data

--- Robustness Analysis ---
  Robustness Score:    96/100   <- Higher = strategy generalizes well
  Status:              Good     <- Safe to use
```

## Using the Optimized Parameters

After running the optimizer, use the best parameters in a backtest:

```bash
# Copy the parameters from the output and run:
bun run backtest:run --days 14 \
  --entry 0.96 \
  --max-entry 0.97 \
  --stop 0.37 \
  --delay 5546 \
  --spread 0.08 \
  --window 108000 \
  --balance 10
```

Or set them in your `.env` file:

```env
BACKTEST_ENTRY_THRESHOLD=0.96
BACKTEST_MAX_ENTRY_PRICE=0.97
BACKTEST_STOP_LOSS=0.37
BACKTEST_STOP_LOSS_DELAY_MS=5546
BACKTEST_MAX_SPREAD=0.08
BACKTEST_TIME_WINDOW_MINS=2
BACKTEST_PROFIT_TARGET=0.99
```

## Tips

1. **More data = better results**: Use `--days 30` or more for reliable optimization
2. **Check robustness score**: If below 70, the strategy may be overfit
3. **Compare in-sample vs out-of-sample**: Big difference = overfitting
4. **Run multiple times**: Genetic algorithms have randomness, results may vary slightly

## Example Workflow

```bash
# 1. Fetch historical data first
bun run backtest:fetch --days 30

# 2. Run genetic optimization
bun run backtest:genetic --days 30 --population 100 --generations 150

# 3. Test the best parameters
bun run backtest:run --days 30 --entry 0.96 --max-entry 0.97 --stop 0.37 ...

# 4. If happy, use in live trading with paper mode first
PAPER_TRADING=true bun start
```
