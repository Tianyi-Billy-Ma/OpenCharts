# Requirements: OpenCharts as a free, self-hosted trading desk for AI agents

Status: draft v0.2 (2026-11-05). Owner: Billy.

Changes from v0.1: the open questions are answered (section 9), the project is
scoped as an open-source app anyone can self-host (section 2), Billy's own setup
moves to a reference deployment (section 7), and the terminal gets a read-only
public viewing mode for a personal domain (section 5.3).

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

## 2. Product principles (open source)

Billy's desk is the first user, but the project is built as an open-source app
for anyone who wants a free charting terminal and MCP server for their own AI
agents. That means:

1. **Ten-minute quickstart.** A new user with only free Alpaca paper keys runs
   one command (`docker compose up`, or `uv run` plus `npm run build`) and sees
   live charts. No other account, domain or tunnel is needed to try it.
2. **One config file.** Everything user-specific lives in `opencharts.yaml`
   (watchlist, Desk Signal parameters, risk limits, webhook targets, viewing
   mode) plus a `.env` for secrets. Nothing personal is hard-coded: no host
   names, domains, bot names or file paths from Billy's setup.
3. **Agent-agnostic.** The MCP server works with any MCP client (Grok Bot,
   Claude, others). Webhooks are plain HTTP POSTs with a configurable body
   template; the Grok Bot HANDOFF format is the default template, not a
   requirement.
4. **Broker behind an interface.** Alpaca is the only broker we build, but data
   and order code sit behind a small provider interface so others can add one.
5. **Safe defaults.** Paper account by default, read-only MCP by default, order
   tools off until the user turns them on, and hard risk limits always on.
6. **Documented.** Install, configure, connect an agent, and deploy behind a
   domain are each a short page in `docs/`.

## 3. Goals

1. A web charting terminal to watch the same stocks and coins the bots trade,
   with real data from Alpaca.
2. A service the bots call (MCP) that provides everything the post gets from
   TradingView's MCP: bars, indicators, a screener, news and alerts.
3. The "Desk Signal" entry trigger from the post, computed server-side.
4. A webhook push that wakes the Trader bot when Desk Signal fires on an
   approved ticker.
5. A read-only viewing mode so the terminal can be shown on a public domain.
6. Paper trading first. Live trading only after the go-live gate.

## 4. Non-goals (for now)

- High-frequency or intraday scalping. The desk swing trades, 2 to 10 day holds.
- Pine Script compatibility. Indicators are written in our own code.
- Multi-user accounts or a hosted SaaS. Each user self-hosts their own copy.
- Options, margin, shorting (forbidden by the desk rules anyway).
- Recreating TradingView's branding or look. OpenCharts' own UI is used.

## 5. Scope

### 5.1 Data sources (all free)

| Need | Source |
| --- | --- |
| US stock and ETF bars, quotes | Alpaca Market Data API, free Basic plan (IEX real-time, SIP delayed 15 min) |
| Crypto bars | Alpaca crypto data; Coinbase public API as fallback |
| News | Alpaca news API |
| Fundamentals, filings | SEC EDGAR |
| Fed and CPI dates | Published Fed and BLS schedules (static list, refreshed monthly) |

Known limit: free stock volume is IEX only (about 2% to 3% of US volume), so
volume rules use daily bars or are backtested on the same feed.

### 5.2 Default watchlist

The shipped `opencharts.yaml` starts with an AI-themed watchlist, which users
can replace.

- **Stocks:** NVDA, MSFT, GOOGL, AMZN, META, AMD, AVGO, TSM, PLTR.
- **Crypto:** BTC/USD, ETH/USD, SOL/USD.

OpenAI and Anthropic are private and cannot be traded. MSFT (OpenAI's largest
backer) and AMZN and GOOGL (Anthropic's largest backers) are the closest listed
exposure. If either company lists, add it to the watchlist.

### 5.3 Backend service (new, in this repo)

A small Python service (managed with `uv`, also shipped as a Docker image). It
is the only component that holds broker keys; the browser never sees them.

- **Market data proxy** for the web terminal: symbols, candles (seconds,
  oldest first, `toMs` exclusive, per the adapter contract), and a live tick
  stream (Alpaca websocket relayed over our own websocket).
- **Indicators**: SMA, EMA, RSI, MACD, ATR, Bollinger, volume vs average,
  swing highs and lows.
- **Desk Signal** (from the post; every number is a config default):
  - Trend: EMA 8, 21, 50, 200; bullish when stacked in that order, bearish when reversed.
  - BUY: close above the 20-bar high, volume at least 1.5x its 20-bar average, RSI(14) above 50.
  - SELL: the exact opposite.
  - Zones: last confirmed swing high and swing low.
  - Filter: no signal when ATR(14) is in its top 10% of the last 100 bars.
- **Screener**: filter the watchlist or a universe by price, volume, trend and RSI.
- **Signal scanner**: every 15 minutes in market hours (crypto 24/7), run Desk
  Signal on the watchlist and record new signals.
- **Webhook sender**: on a new BUY or SELL for an approved ticker, POST to each
  configured webhook.
  - Default body: the Grok Bot HANDOFF format `TICKER | IDEA | EVIDENCE | NEXT STEP`.
  - At most one POST per ticker per bar (dedupe stored locally).
  - Retry 3 times, then log the failure and show it in the terminal.
  - Signed with an HMAC header so receivers can verify it came from us.
- **MCP server** (Streamable HTTP, bearer-token auth) exposing:
  `get_bars`, `get_quote`, `get_indicators`, `desk_signal`, `screen`,
  `get_news`, `get_events`, `list_signals`, `get_positions`.
  Order tools (`place_order`, `cancel_order`) exist but are off by default;
  see 5.5.
- **Storage**: SQLite. It is the source of truth for signals, the journal,
  drawings and settings.

### 5.4 Web terminal (this fork)

- An `AlpacaAdapter` implementing the OpenCharts adapter contract
  (`src/adapter/types.ts`) against our backend, following
  `examples/binance-adapter/` as the pattern. It must pass the bundled
  conformance suite (`runAdapterConformance`).
- `marketData`: required. `trading`: Alpaca paper account, behind the backend.
  `storage`: backend key/value so drawings and the journal survive across devices.
- Show Desk Signal on the chart: EMA ribbon, BUY and SELL markers, swing zones.
- A signals panel listing recent Desk Signal events and whether a webhook was sent.
- Default to the Alpaca paper account; the UI must clearly show PAPER vs LIVE.
- **Two modes**, set in config:
  - `owner`: full terminal, including order tickets and settings. Requires login.
  - `viewer` (for a public domain): charts, signals, and optionally positions
    and P&L. No order buttons, no settings, no account numbers or keys. The
    backend enforces this, not only the UI: in viewer mode it serves read-only
    routes and refuses everything else.

### 5.5 Trading and safety

- Orders go through Alpaca. Two supported paths:
  1. **Alpaca's official MCP server** (default for Billy's desk). The Trader
     bot uses it directly.
  2. **Our MCP order tools**, for users who want the backend to enforce limits
     before an order reaches the broker. Off until enabled in config.
- No bot other than the Trader gets order tools, on either path.
- Every order carries a stop-loss at placement (Alpaca bracket orders), so
  exits do not depend on any bot or webhook.
- Hard limits (max position size, max open positions, daily loss stop) are set
  in `opencharts.yaml`. Our order path rejects orders that break them. On the
  official-MCP path we cannot block orders, so the scanner checks positions
  against the limits every run and alerts on a breach.
- Secrets (broker keys, webhook secrets, MCP token) live only in `.env` (mode
  600) or the user's secret manager. Never in git, logs, chat, the journal, or
  any bot's machine.
- Live keys are added only after the go-live gate: 60+ paper trading days
  matching the backtest and the owner's written OK.

### 5.6 Journal

- Every idea, approval, rejection, signal, webhook and order is logged with
  time, agent, ticker, action, size, entry, stop, target, reason, evidence and
  outcome.
- The backend database is the source of truth. An optional exporter writes it
  to a Google Sheet (Billy's desk uses the "Trade Journal" sheet the bots read).
  CSV export is always available.

## 6. Deployment (generic)

- One host runs the backend, which also serves the static frontend build.
- Supported: Docker Compose, or a systemd user service with `uv`.
- The backend binds to localhost. Public access, if any, goes through a tunnel
  or reverse proxy the user chooses; we document Cloudflare Tunnel.
- The webhook sender only makes outbound calls.

## 7. Reference deployment (Billy's desk)

- **Host:** nd-work2, systemd user service.
- **Exposure:** Cloudflare Tunnel on tianyi-billy-ma.com, so no inbound port is
  opened on nd-work2.
  - `charts.tianyi-billy-ma.com`: the terminal in `viewer` mode, public.
  - `desk.tianyi-billy-ma.com`: the terminal in `owner` mode, behind
    Cloudflare Access (free tier, Billy's email only).
  - `mcp.tianyi-billy-ma.com`: the MCP endpoint for Grok Bot, bearer token
    required.
- **Orders:** Alpaca's official MCP, used only by the Trader bot.
- **Secrets:** 1Password, copied into `.env` on nd-work2.
- **Risk limits:** taken from the desk rules (`desk-rules-compact.md` in the
  project files) into `opencharts.yaml`.

## 8. Milestones

1. **M0, verify the fork:** `npm ci`, `npm test`, `npm run build`, `npm run dev` pass.
2. **M1, data:** backend market data proxy + `AlpacaAdapter`; terminal shows
   real Alpaca stocks and crypto; config file and Docker quickstart.
3. **M2, signals:** indicators + Desk Signal in the backend and on the chart;
   backtest Desk Signal on 3+ years.
4. **M3, bots:** MCP server + signal scanner + webhooks; viewer mode; deploy to
   nd-work2 behind the tunnel.
5. **M4, paper desk:** Alpaca paper trading end to end on both order paths,
   hard limits, journal and Sheets export.
6. **M5, review:** 60 trading days of paper results vs backtest, then the
   go-live decision.

## 9. Decisions (closed questions from v0.1)

1. **How Grok Bot reaches the MCP server:** Cloudflare Tunnel on an existing
   domain, at `mcp.tianyi-billy-ma.com`.
2. **Watchlist and crypto:** AI-company stocks plus BTC, ETH and SOL, with
   crypto in scope from M1 (section 5.2).
3. **Order path:** Alpaca's official MCP for Billy's desk. Our own order tools
   are also built, off by default (section 5.5).
4. **Journal source of truth:** the backend database. Google Sheets is an export.

## 10. Open questions

1. Should viewer mode on the public domain show positions and P&L, or charts
   and signals only? Default: charts and signals only.
