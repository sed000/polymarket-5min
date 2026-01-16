import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { Bot, type BotConfig, type BotState, type WsStats } from "./bot";
import { getRecentTrades, getTotalPnL, getTradeStats, type Trade } from "./db";
import { formatTimeRemaining, type EligibleMarket } from "./scanner";

interface AppProps {
  bot: Bot;
}

function Header({ state, config }: { state: BotState; config: BotConfig }) {
  const isSuperRisk = config.riskMode === "super-risk";
  const isDynamicRisk = config.riskMode === "dynamic-risk";
  const borderColor = isDynamicRisk ? "blue" : isSuperRisk ? "magenta" : state.paperTrading ? "yellow" : "cyan";

  // Get active config values based on risk mode
  // Claude-mode: dynamic entry threshold based on consecutive losses
  const dynamicBaseThreshold = 0.70;
  const dynamicLossAdjustment = Math.min(state.consecutiveLosses * 0.05, 0.15);
  const dynamicThreshold = dynamicBaseThreshold + dynamicLossAdjustment;

  const activeEntry = isDynamicRisk ? dynamicThreshold : isSuperRisk ? 0.70 : config.entryThreshold;
  const activeMaxEntry = isDynamicRisk ? 0.95 : isSuperRisk ? 0.95 : config.maxEntryPrice;
  const activeStop = isDynamicRisk ? "dynamic" : isSuperRisk ? 0.40 : config.stopLoss;
  const activeDelay = isDynamicRisk ? 2000 : isSuperRisk ? 0 : config.stopLossDelayMs;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={borderColor}>
          POLYMARKET BTC 15-MIN BOT {state.paperTrading && "[PAPER]"}
        </Text>
        <Box gap={2}>
          {isSuperRisk && (
            <Text color="magenta" bold>SUPER-RISK</Text>
          )}
          {isDynamicRisk && (
            <Text color="blue" bold>DYNAMIC</Text>
          )}
          <Text color={state.wsConnected ? "green" : "yellow"}>
            {state.wsConnected ? "WS" : "REST"}
          </Text>
          {!state.paperTrading && (
            <Text color={state.userWsConnected ? "cyan" : "gray"}>
              USER
            </Text>
          )}
          {state.paperTrading && (
            <Text color="yellow" bold>PAPER</Text>
          )}
          {!state.tradingEnabled && !state.paperTrading && (
            <Text color="yellow">WATCH</Text>
          )}
          <Text color={state.running ? "green" : "red"}>
            {state.running ? "● RUN" : "○ STOP"}
          </Text>
        </Box>
      </Box>
      {state.initError && (
        <Box marginTop={1}>
          <Text color="red" wrap="truncate">Error: {state.initError}</Text>
        </Box>
      )}
      <Box marginTop={1} gap={4}>
        <Text>Balance: <Text color="green">${state.balance.toFixed(2)}</Text></Text>
        {state.savedProfit > 0 && (
          <Text>Saved: <Text color="cyan">${state.savedProfit.toFixed(2)}</Text></Text>
        )}
        <Text>Entry: <Text color={isDynamicRisk ? "blue" : isSuperRisk ? "magenta" : "yellow"}>${activeEntry.toFixed(2)}-{activeMaxEntry.toFixed(2)}</Text></Text>
        <Text>Stop: <Text color="red">{isDynamicRisk ? "32.5%" : `≤$${activeStop.toFixed(2)}`}</Text></Text>
        {activeDelay > 0 && <Text>Delay: <Text color="cyan">{activeDelay / 1000}s</Text></Text>}
        <Text>Pos: <Text color="cyan">{state.positions.size}</Text></Text>
        {isDynamicRisk && (
          <Text>
            Streak: <Text color={state.consecutiveLosses > 0 ? "red" : "green"}>
              {state.consecutiveLosses > 0 ? `L${state.consecutiveLosses}` : `W${state.consecutiveWins}`}
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

function MarketsTable({ markets }: { markets: EligibleMarket[] }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold color="white">Active BTC 15-Min Markets (Bid/Ask)</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={12}><Text color="gray">Time</Text></Box>
          <Box width={14}><Text color="gray">Up</Text></Box>
          <Box width={14}><Text color="gray">Down</Text></Box>
          <Box width={8}><Text color="gray">Signal</Text></Box>
        </Box>
        {markets.length === 0 ? (
          <Text color="gray">No active markets found</Text>
        ) : (
          markets.slice(0, 5).map((m, i) => (
            <Box key={i}>
              <Box width={12}>
                <Text color={m.timeRemaining < 300000 ? "yellow" : "white"}>
                  {formatTimeRemaining(m.timeRemaining)}
                </Text>
              </Box>
              <Box width={14}>
                <Text color={m.upAsk >= 0.95 ? "green" : "white"}>
                  {m.upBid.toFixed(2)}/{m.upAsk.toFixed(2)}
                </Text>
              </Box>
              <Box width={14}>
                <Text color={m.downAsk >= 0.95 ? "green" : "white"}>
                  {m.downBid.toFixed(2)}/{m.downAsk.toFixed(2)}
                </Text>
              </Box>
              <Box width={8}>
                {m.eligibleSide ? (
                  <Text color="green" bold>{m.eligibleSide}</Text>
                ) : (
                  <Text color="gray">-</Text>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function PositionsTable({ state, config }: { state: BotState; config: BotConfig }) {
  const positions = Array.from(state.positions.values());

  // Get active stop-loss based on risk mode
  const isSuperRisk = config.riskMode === "super-risk";
  const isDynamicRisk = config.riskMode === "dynamic-risk";
  const defaultStopLoss = isSuperRisk ? 0.40 : config.stopLoss;
  const profitTarget = 0.99;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold color="white">Open Positions</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={6}><Text color="gray">Side</Text></Box>
          <Box width={8}><Text color="gray">Entry</Text></Box>
          <Box width={8}><Text color="gray">Shares</Text></Box>
          <Box width={8}><Text color="gray">Stop</Text></Box>
          <Box width={10}><Text color="gray">Win</Text></Box>
          <Box width={10}><Text color="gray">Loss</Text></Box>
        </Box>
        {positions.length === 0 ? (
          <Text color="gray">No open positions</Text>
        ) : (
          positions.map((p, i) => {
            // Use dynamic stop-loss if available (dynamic-risk), else use default
            const stopLoss = p.dynamicStopLoss || defaultStopLoss;
            const potentialWin = (profitTarget - p.entryPrice) * p.shares;
            const potentialLoss = (p.entryPrice - stopLoss) * p.shares;
            return (
              <Box key={i}>
                <Box width={6}>
                  <Text color={p.side === "UP" ? "green" : "red"}>{p.side}</Text>
                </Box>
                <Box width={8}>
                  <Text>${p.entryPrice.toFixed(2)}</Text>
                </Box>
                <Box width={8}>
                  <Text>{p.shares.toFixed(1)}</Text>
                </Box>
                <Box width={8}>
                  <Text color="red">${stopLoss.toFixed(2)}</Text>
                </Box>
                <Box width={10}>
                  <Text color="green">+${potentialWin.toFixed(2)}</Text>
                </Box>
                <Box width={10}>
                  <Text color="red">-${potentialLoss.toFixed(2)}</Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}

function TradesTable({ trades }: { trades: Trade[] }) {
  const stats = getTradeStats();
  const totalPnL = getTotalPnL();

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="white">Recent Trades</Text>
        <Text>
          Total PnL: <Text color={totalPnL >= 0 ? "green" : "red"}>${totalPnL.toFixed(2)}</Text>
          {" "}| Win Rate: <Text color="cyan">{stats.winRate.toFixed(0)}%</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={8}><Text color="gray">Status</Text></Box>
          <Box width={8}><Text color="gray">Side</Text></Box>
          <Box width={10}><Text color="gray">Entry</Text></Box>
          <Box width={10}><Text color="gray">Exit</Text></Box>
          <Box width={12}><Text color="gray">PnL</Text></Box>
        </Box>
        {trades.length === 0 ? (
          <Text color="gray">No trades yet</Text>
        ) : (
          trades.slice(0, 5).map((t, i) => (
            <Box key={i}>
              <Box width={8}>
                <Text color={t.status === "OPEN" ? "yellow" : t.status === "RESOLVED" ? "green" : "red"}>
                  {t.status}
                </Text>
              </Box>
              <Box width={8}>
                <Text color={t.side === "UP" ? "green" : "red"}>{t.side}</Text>
              </Box>
              <Box width={10}>
                <Text>${t.entry_price.toFixed(2)}</Text>
              </Box>
              <Box width={10}>
                <Text>{t.exit_price ? `$${t.exit_price.toFixed(2)}` : "-"}</Text>
              </Box>
              <Box width={12}>
                {t.pnl !== null ? (
                  <Text color={t.pnl >= 0 ? "green" : "red"}>${t.pnl.toFixed(2)}</Text>
                ) : (
                  <Text color="gray">-</Text>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function Logs({ logs }: { logs: string[] }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} height={8}>
      <Text bold color="white">Activity Log</Text>
      <Box flexDirection="column" marginTop={1}>
        {logs.slice(-5).map((log, i) => (
          <Text key={i} color="gray" wrap="truncate">{log}</Text>
        ))}
      </Box>
    </Box>
  );
}

function WsPanel({ stats }: { stats: WsStats }) {
  const formatAge = (timestamp: number): string => {
    if (!timestamp) return "n/a";
    const ageMs = Date.now() - timestamp;
    if (!Number.isFinite(ageMs) || ageMs < 0) return "0s";
    const ageSec = Math.floor(ageMs / 1000);
    return `${ageSec}s`;
  };

  const marketAge = formatAge(stats.marketLastMessageAt);
  const userAge = formatAge(stats.userLastMessageAt);
  const maxAgeSec = Math.round(stats.priceMaxAgeMs / 1000);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold color="white">WebSocket Status</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={10}><Text color="gray">Channel</Text></Box>
          <Box width={10}><Text color="gray">Status</Text></Box>
          <Box width={12}><Text color="gray">Last Msg</Text></Box>
          <Box width={8}><Text color="gray">Subs</Text></Box>
          <Box width={8}><Text color="gray">Prices</Text></Box>
          <Box width={10}><Text color="gray">Markets</Text></Box>
        </Box>
        <Box>
          <Box width={10}><Text>Market</Text></Box>
          <Box width={10}><Text color={stats.marketConnected ? "green" : "yellow"}>{stats.marketConnected ? "ON" : "OFF"}</Text></Box>
          <Box width={12}><Text color="cyan">{marketAge}</Text></Box>
          <Box width={8}><Text>{stats.marketSubscriptionCount}</Text></Box>
          <Box width={8}><Text>{stats.marketPriceCount}</Text></Box>
          <Box width={10}><Text color="gray">-</Text></Box>
        </Box>
        <Box>
          <Box width={10}><Text>User</Text></Box>
          <Box width={10}><Text color={stats.userConnected ? "green" : "yellow"}>{stats.userConnected ? "ON" : "OFF"}</Text></Box>
          <Box width={12}><Text color="cyan">{userAge}</Text></Box>
          <Box width={8}><Text color="gray">-</Text></Box>
          <Box width={8}><Text color="gray">-</Text></Box>
          <Box width={10}><Text>{stats.userMarketCount}</Text></Box>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Price max age: {maxAgeSec}s</Text>
      </Box>
    </Box>
  );
}

function Controls() {
  return (
    <Box marginTop={1} gap={2}>
      <Text color="gray">[s] Start/Stop</Text>
      <Text color="gray">[r] Refresh</Text>
      <Text color="gray">[q] Quit</Text>
    </Box>
  );
}

function App({ bot }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<BotState>(bot.getState());
  const [wsStats, setWsStats] = useState<WsStats>(bot.getWsStats());
  const [markets, setMarkets] = useState<EligibleMarket[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  const refresh = async () => {
    setState({ ...bot.getState() });
    setWsStats(bot.getWsStats());
    setTrades(getRecentTrades(10));
    try {
      const m = await bot.getMarketOverview();
      setMarkets(m);
    } catch {
      // Ignore market fetch errors
    }
  };

  useEffect(() => {
    refresh();
    // Refresh every 2 seconds (fetching from Gamma API)
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  useInput((input) => {
    if (input === "q") {
      bot.stop();
      exit();
    } else if (input === "s") {
      if (bot.getState().running) {
        bot.stop();
        refresh();
      } else {
        bot.start().then(() => refresh()).catch(() => refresh());
      }
    } else if (input === "r") {
      refresh();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header state={state} config={bot.getConfig()} />
      <Box>
        <Box flexDirection="column" width="50%">
          <MarketsTable markets={markets} />
          <PositionsTable state={state} config={bot.getConfig()} />
        </Box>
        <Box flexDirection="column" width="50%" marginLeft={1}>
          <TradesTable trades={trades} />
          <WsPanel stats={wsStats} />
          <Logs logs={state.logs} />
        </Box>
      </Box>
      <Controls />
    </Box>
  );
}

export function renderUI(bot: Bot): void {
  render(<App bot={bot} />);
}
