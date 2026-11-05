# Requirements: OpenCharts as a free TradingView replacement for an AI trading desk

Status: draft v0.1 (2026-11-05). Owner: Billy.

## 1. Background

Billy wants to run an AI trading desk in Grok Bot, following the setup in
[RohOnChain's post](https://x.com/RohOnChain/status/2117625737792585969):
a Chief of Staff bot plus five specialists (Scout, Chart Analyst, Strategist,
Risk Officer, Trader) that research, plan, approve and place trades on a
schedule.

The post uses TradingView (paid Essential plan, for its MCP server) as the
desk's market data, indicators and alerts, and Alpaca as the broker. The goal
of this project is to replace the TradingView part with free, self-hosted
software, keeping the total cost at $0 during the paper-trading phase.

This repository is a fork of
[dylanpersonguy/OpenCharts](https://github.com/dylanpersonguy/OpenCharts)
(MIT). Upstream is maintained by one person and has unmerged community PRs, so
we maintain this fork ourselves and pull upstream changes only when useful.

## 2. Goals

1. A web charting terminal Billy can open in a browser to watch the same
   stocks and coins the bots trade, with real data from Alpaca.
2. A service the bots call (MCP) that provides everything the post gets from
   TradingView's MCP: bars, indicators, a screener, news and alerts.
3. The "Desk Signal" entry trigger from the post, computed server-side.
4. A webhook push that wakes the Trader bot when Desk Signal fires on an
   approved ticker.
5. Paper trading first. Live trading only after the desk rules' go-live gate.

## 3. Non-goals (for now)

- High-frequency or intraday scalping. The desk swing trades, 2 to 10 day holds.
- Pine Script compatibility. Indicators are written in our own code.
- Multi-user accounts, public hosting, or a hosted SaaS.
- Options, margin, shorting (forbidden by the desk rules anyway).
- Recreating TradingView's branding or look. OpenCharts' own UI is used.

## 4. Users

| User | Uses | Through |
| --- | --- | --- |
| Billy | Watches charts, positions and signals; approves go-live | Web terminal |
| Scout, Chart Analyst, Strategist | Read bars, indicators, screener, news | MCP tools |
| Risk Officer | Reads positions, exposure, events calendar | MCP tools |
| Trader | Receives webhook, checks approval, places orders | Webhook + Alpaca MCP (or ours) |

## 5. Scope

### 5.1 Data sources (all free)

| Need | Source |
| --- | --- |
| US stock and ETF bars, quotes | Alpaca Market Data API, free Basic plan (IEX real-time, SIP delayed 15 min) |
| Crypto bars (BTC, ETH) | Alpaca crypto data; Coinbase public API as fallback |
| News | Alpaca news API |
| Fundamentals, filings | SEC EDGAR |
| Fed and CPI dates | Published Fed and BLS schedules (static list, refreshed monthly) |

Known limit: free stock volume is IEX only (about 2% to 3% of US volume), so
volume rules use daily bars or are backtested on the same feed.

### 5.2 Backend service (new, in this repo)

A small Python service (managed with `uv`) running on oracle-server. It is the
only component that holds Alpaca keys; the browser never sees them.

- **Market data proxy** for the web terminal: symbols, candles (seconds,
  oldest first, `toMs` exclusive, per the adapter contract), and a live tick
  stream (Alpaca websocket relayed over our own websocket).
- **Indicators**: SMA, EMA, RSI, MACD, ATR, Bollinger, volume vs average,
  swing highs and lows.
- **Desk Signal** (from the post):
  - Trend: EMA 8, 21, 50, 200; bullish when stacked in that order, bearish when reversed.
  - BUY: close above the 20-bar high, volume at least 1.5x its 20-bar average, RSI(14) above 50.
  - SELL: the exact opposite.
  - Zones: last confirmed swing high and swing low.
  - Filter: no signal when ATR(14) is in its top 10% of the last 100 bars.
- **Screener**: filter the watchlist or a universe by price, volume, trend and RSI.
- **Signal scanner**: every 15 minutes in market hours (crypto 24/7), run Desk
  Signal on the watchlist and record new signals.
- **Webhook sender**: on a new BUY or SELL for a ticker the Risk Officer has
  approved, POST a HANDOFF message to the Trader's Grok Bot routine webhook.
  - Format: `TICKER | IDEA | EVIDENCE | NEXT STEP`.
  - At most one POST per ticker per bar (dedupe stored locally).
  - Retry 3 times, then log the failure and notify Billy.
- **MCP server** exposing: `get_bars`, `get_quote`, `get_indicators`,
  `desk_signal`, `screen`, `get_news`, `get_events`, `list_signals`,
  `get_positions`. Read-only except where noted in 5.4.

### 5.3 Web terminal (this fork)

- An `AlpacaAdapter` implementing the OpenCharts adapter contract
  (`src/adapter/types.ts`) against our backend, following
  `examples/binance-adapter/` as the pattern. It must pass the bundled
  conformance suite (`runAdapterConformance`).
- `marketData`: required. `trading`: Alpaca paper account, behind the backend.
  `storage`: backend key/value so drawings and the journal survive across devices.
- Show Desk Signal on the chart: EMA ribbon, BUY and SELL markers, swing zones.
- A signals panel listing recent Desk Signal events and whether a webhook was sent.
- Default to the Alpaca paper account; the UI must clearly show PAPER vs LIVE.

### 5.4 Trading and safety

- Order placement goes through Alpaca. The Trader bot uses Alpaca's official
  MCP server or our backend; no other bot gets order tools.
- Every order carries a stop-loss at placement (Alpaca bracket orders), so
  exits do not depend on any bot or webhook.
- The desk rules in `/mnt/project-files/research/trading/desk-rules-compact.md`
  (project files) are the source of truth for limits; the backend enforces the
  hard ones (max position size, max open positions, daily loss stop) and rejects
  orders that break them.
- Secrets (Alpaca keys, webhook URL and secret) live in 1Password and in
  `~/.config/secrets.env` (mode 600) on oracle-server. Never in git, logs,
  chat, the journal, or the Grok Bot computer.
- Live keys are added only after the go-live gate: 60+ paper trading days
  matching the backtest and Billy's written OK.

### 5.5 Journal

- Every idea, approval, rejection, signal, webhook and order is logged with
  time, agent, ticker, action, size, entry, stop, target, reason, evidence and
  outcome.
- Stored by the backend; exported to the Google Sheets "Trade Journal" that the
  bots read and write.

## 6. Deployment

- Backend: oracle-server, systemd user service, reachable by the browser over
  Tailscale only. The webhook sender only makes outbound calls; no inbound port
  is opened to the internet.
- Frontend: static build served by the backend (or `vite preview`) on the same host.
- Grok Bot reaches the MCP server through an authenticated HTTPS endpoint
  (exact exposure method to be decided; see open questions).

## 7. Milestones

1. **M0, verify the fork:** `npm ci`, `npm test`, `npm run build`, `npm run dev` pass on our machine.
2. **M1, data:** backend market data proxy + `AlpacaAdapter`; terminal shows real Alpaca stocks and crypto.
3. **M2, signals:** indicators + Desk Signal in the backend and on the chart; backtest Desk Signal on 3+ years.
4. **M3, bots:** MCP server + signal scanner + webhook to the Trader routine.
5. **M4, paper desk:** Alpaca paper trading wired end to end, hard limits enforced, journal export.
6. **M5, review:** 60 trading days of paper results vs backtest, then the go-live decision.

## 8. Open questions

1. How should Grok Bot reach the MCP server: Tailscale Funnel, Cloudflare
   tunnel on an existing domain, or only via webhook plus Alpaca's own MCP?
2. Watchlist: which tickers to start with, and is crypto in scope from M1?
3. Should the Trader use Alpaca's official MCP or our backend for orders (ours
   can enforce limits; theirs is less code)?
4. Does the Google Sheets journal stay the source of truth, or the backend DB?
