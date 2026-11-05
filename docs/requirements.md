# Requirements: OpenCharts as a free, self-hosted trading desk for AI agents

Status: draft v0.3 (2026-11-05). Owner: Billy.

Changes from v0.2 (after a review with Billy): the backend is TypeScript and
reuses the frontend's indicators, Desk Signal runs on closed bars only, the
Risk Officer approves tickers through MCP, the backtest is part of the backend,
and the public viewer mode is dropped because the whole site sits behind
Cloudflare Access. All decisions are listed in section 9.

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

Contribution rule, for people and AI agents alike: never push to, or open pull
requests or issues against, the upstream repository. All branches and pull
requests go to this fork (`Tianyi-Billy-Ma/OpenCharts`). Pulling upstream
changes in is fine.

## 2. Product principles (open source)

Billy's desk is the first user, but the project is built as an open-source app
for anyone who wants a free charting terminal and MCP server for their own AI
agents. That means:

1. **Ten-minute quickstart.** A new user with only free Alpaca paper keys runs
   one command (`docker compose up`, or `npm run build && npm run server`) and sees
   live charts. No other account, domain or tunnel is needed to try it.
2. **One config file.** Everything user-specific lives in `opencharts.yaml`
   (watchlist, Desk Signal parameters and timeframe, approval length, risk
   limits, webhook targets) plus a `.env` for secrets. Nothing personal is hard-coded: no host
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
5. Paper trading first. Live trading only after the go-live gate.

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

A small Node service written in TypeScript, in the `server/` folder of this
repository and shipped with it (also as a Docker image). It reuses the
frontend's indicator code (`src/lib/indicators.ts`), so the chart and the bots
always see the same numbers. It is the only component that holds broker keys;
the browser never sees them.

- **Market data proxy** for the web terminal: symbols, candles (seconds,
  oldest first, `toMs` exclusive, per the adapter contract), and a live tick
  stream (Alpaca websocket relayed over our own websocket).
- **Indicators**: SMA, EMA, RSI, MACD, ATR, Bollinger (already in
  `src/lib/indicators.ts`), plus volume vs average and swing highs and lows
  (new, added to the same file).
- **Desk Signal** (from the post; every number is a config default):
  - Trend: EMA 8, 21, 50, 200; bullish when stacked in that order, bearish when reversed.
  - BUY: close above the 20-bar high, volume at least 1.5x its 20-bar average, RSI(14) above 50.
  - SELL: the exact opposite.
  - Zones: last confirmed swing high and swing low.
  - Filter: no signal when ATR(14) is in its top 10% of the last 100 bars.
  - **Closed bars only** ("bar close confirmation"). A bar that is still open
    can cross a level and fall back before it closes, which gives a false
    signal that the backtest would never show. Default timeframe: daily.
    Configurable (for example 4h or 1h), always evaluated after the bar closes.
- **Screener**: filter the watchlist or a universe by price, volume, trend and RSI.
- **Signal scanner**: runs after each bar closes. With daily bars: after the US
  close (16:00 New York, a few minutes later so the final bar is published) for
  stocks, and at 00:00 UTC for crypto. Records new signals.
- **Approvals**: the Risk Officer approves or revokes tickers through MCP. An
  approval lasts 5 trading days by default (configurable), can be renewed, and
  can be revoked at any time. Webhooks fire only for tickers with a live
  approval.
- **Webhook sender**: on a new BUY or SELL for an approved ticker, POST to each
  configured webhook.
  - Default body: the Grok Bot HANDOFF format `TICKER | IDEA | EVIDENCE | NEXT STEP`.
  - At most one POST per ticker per bar (dedupe stored locally).
  - Retry 3 times, then log the failure and show it in the terminal.
  - Signed with an HMAC header so receivers can verify it came from us.
- **MCP server** (Streamable HTTP, bearer-token auth) exposing:
  `get_bars`, `get_quote`, `get_indicators`, `desk_signal`, `screen`,
  `get_news`, `get_events`, `list_signals`, `get_positions`, plus the write
  tools `set_approval(ticker, until?)` and `revoke_approval(ticker)`, which only
  the Risk Officer's token may call.
  Order tools (`place_order`, `cancel_order`) exist but are off by default;
  see 5.5.
- **Storage**: SQLite. It is the source of truth for signals, approvals, the
  journal, drawings and settings.
- **Backtest**: a command-line tool in the backend (`npm run backtest NVDA`)
  that runs the same Desk Signal code, on the same configured timeframe, over
  Alpaca's free historical bars (3+ years). The go-live gate compares paper
  results with a backtest on the timeframe actually traded.

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
- The terminal has no login of its own. It is meant for its owner only: run it
  on localhost, or put it behind an auth gate (we document Cloudflare Access).
  The docs must say clearly not to expose it without one.

### 5.5 Trading and safety

- Orders go through Alpaca. Two supported paths:
  1. **Alpaca's official MCP server** (default for Billy's desk). The Trader
     bot uses it directly.
  2. **Our MCP order tools**, for users who want the backend to enforce limits
     before an order reaches the broker. Off until enabled in config.
- No bot other than the Trader gets order tools, on either path.
- Every order carries a stop-loss at placement (Alpaca bracket orders), so
  exits do not depend on any bot or webhook.
- Timing: stock signals arrive after the close, so the Trader places a GTC
  (good-till-canceled) market bracket order. Alpaca queues it, it fills at the
  next open, and the stop and target legs stay live for the whole 2 to 10 day
  hold. A DAY bracket would drop its exits after the first session, so it is
  not allowed.
- Crypto trades 24/7, so it is ordered right away. Alpaca does not offer
  bracket orders for crypto, so the stop is placed as a separate stop-limit
  order (the only stop type Alpaca supports for crypto) right after the fill.
- **Position guard**: a backend job, separate from the daily signal scanner,
  runs every 5 minutes (24/7) and on backend start. It checks every open
  position against Alpaca's open orders. If a position has no live stop, the
  guard places one itself from the journal's planned stop, or from a default
  ATR stop if no plan exists. If placing it fails twice, the guard alerts the
  owner and blocks new entries on our order path until it is resolved.
  Optionally (config `missing_stop: flatten`), it closes the position instead.
- Hard limits (max position size, max open positions, daily loss stop) are set
  in `opencharts.yaml`. Our order path rejects orders that break them. On the
  official-MCP path we cannot block orders, so the position guard checks
  positions against the limits every run and alerts on a breach.
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
- Supported: Docker Compose, or a systemd user service running Node.
- The backend binds to localhost. Public access, if any, goes through a tunnel
  or reverse proxy the user chooses; we document Cloudflare Tunnel.
- The webhook sender only makes outbound calls.

## 7. Reference deployment (Billy's desk)

- **Host:** nd-work2, systemd user service.
- **Exposure:** Cloudflare Tunnel on tianyi-billy-ma.com, so no inbound port is
  opened on nd-work2.
  - `charts.tianyi-billy-ma.com`: the terminal, behind Cloudflare Access
    (free tier, Billy's email only).
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
4. **M3, bots:** MCP server + approvals + signal scanner + webhooks; deploy to
   nd-work2 behind the tunnel.
5. **M4, paper desk:** Alpaca paper trading end to end on both order paths,
   hard limits, journal and Sheets export.
6. **M5, review:** 60 trading days of paper results vs backtest, then the
   go-live decision.

## 9. Decisions

1. **How Grok Bot reaches the MCP server:** Cloudflare Tunnel on an existing
   domain, at `mcp.tianyi-billy-ma.com`.
2. **Watchlist and crypto:** AI-company stocks plus BTC, ETH and SOL, with
   crypto in scope from M1 (section 5.2).
3. **Order path:** Alpaca's official MCP for Billy's desk. Our own order tools
   are also built, off by default (section 5.5).
4. **Journal source of truth:** the backend database. Google Sheets is an export.
5. **Backend language:** TypeScript, reusing `src/lib/indicators.ts`.
6. **Signal timing:** closed bars only, daily by default, timeframe configurable.
7. **Approvals:** MCP write tools for the Risk Officer, 5 trading days by default.
8. **Limits on the official-MCP path:** alerts after the fact are accepted; both
   order paths are built.
9. **Public view:** none. The whole site is behind Cloudflare Access.
10. **Backtest:** a CLI in the backend, using the same Desk Signal code.
11. **Code location:** the backend lives in `server/` in this repository.
12. **Order timing:** GTC market bracket orders after the close for stocks;
    crypto ordered right away with a separate stop, backed by the position
    guard.

## 10. Open questions

None right now.
