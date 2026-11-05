# Self-hosting OpenCharts with Alpaca data

The backend in `server/` gives the terminal real market data from
[Alpaca](https://alpaca.markets)'s free plan: US stocks and ETFs (IEX feed) and
crypto. Your Alpaca keys stay on the server; the browser only talks to the
backend.

## 1. Get free Alpaca keys

Sign up at [app.alpaca.markets](https://app.alpaca.markets), switch to **Paper
Trading**, and create an API key. Paper keys are free and cannot move real
money.

## 2. Configure

```bash
cp .env.example .env
```

Put your key ID and secret in `.env`. Never commit it (it is in `.gitignore`).
The names Alpaca's own tools use (`ALPACA_API_KEY`, `APCA_API_KEY_ID`,
`APCA_API_SECRET_KEY`) work too. OpenCharts always trades on the paper
account, whatever base URL is set.

With a secret manager instead of `.env`, pass the secrets in at start, e.g.
1Password: `op run --env-file=.env.op -- npm run server`, where `.env.op`
holds references like `ALPACA_KEY_ID=op://<vault>/<item>/<field>`.

Check the setup with `npm run doctor` (or `op run --env-file=.env.op -- npm run doctor`).
It reaches the Alpaca paper account, checks each MCP token, and sends a signed
test webhook, without printing any secret.

Edit `opencharts.config.ts` to change the watchlist or the port. Stocks use
plain tickers (`"NVDA"`); crypto uses Alpaca pairs (`"BTC/USD"`), shown in the
terminal as `BTCUSD`.

Without keys the backend still starts: crypto charts load, but stock data and
live prices need keys.

## 3. Run

With Node 22.18 or newer:

```bash
npm install
npm run build:desk
npm run server
```

Or with Docker:

```bash
docker compose up -d
```

Open <http://127.0.0.1:8787>.

For frontend development, run `npm run server` in one terminal and
`VITE_ADAPTER=alpaca npm run dev` in another; the dev server proxies `/api` to
the backend.

## 4. Put it behind a login before exposing it

The terminal has no login of its own. It listens on `127.0.0.1` by default, and
Docker publishes it on localhost only. To reach it from elsewhere, put an auth
gate in front, for example a [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
limited to your own email. Do not open the port to the internet directly.

## API

The backend's read routes, all `GET`:

| Route | Returns |
| --- | --- |
| `/api/health` | `{ ok, keys, symbols }` |
| `/api/symbols` | The watchlist as OpenCharts symbols |
| `/api/candles?symbol&timeframe[&limit][&fromMs][&toMs]` | Bars, oldest first, times in seconds; `toMs` is exclusive |
| `/api/quote?symbol` | Latest bid and ask |
| `/api/stream` | Server-Sent Events, one `{"type":"tick",...}` per quote |
| `/api/desk-signal?symbol[&timeframe][&limit]` | Desk Signal per closed bar: trend, BUY/SELL, swing zones, EMAs, RSI, ATR |
| `/api/journal.csv` | The whole journal as CSV |
| `/api/signals[?symbol]` | The 50 latest signals the scanner recorded, with webhook status |
| `/api/trading/account`, `/api/trading/positions`, `/api/trading/orders` | The Alpaca account the terminal trades, when keys are set |

The terminal's order routes are `POST /api/trading/orders`,
`POST /api/trading/orders/:id/cancel` and `POST /api/trading/positions/:symbol/close`.
They need the `x-opencharts: 1` header, which a page on another site cannot
send, and `orders.enabled`.

## Desk Signal

Desk Signal is the swing-trade trigger in `src/lib/desk-signal.ts`: stacked EMAs
(8, 21, 50, 200) for trend, a 20-bar breakout with 1.5x volume and RSI above 50
for BUY (the mirror for SELL), swing highs and lows as zones, and no signal while
ATR is in the top 10% of its last 100 values. It only looks at closed bars.

- **On the chart:** Indicators → Desk Signal draws the EMA ribbon, BUY and SELL
  arrows, and the swing zones. The chart uses the default rules.
- **From the backend:** `/api/desk-signal` uses the timeframe and rules in
  `opencharts.config.ts`.
- **Backtest:** `npm run backtest -- NVDA` (or `BTC/USD`) runs it over 3 years of
  Alpaca history: long only, entry at the next open, stop at the last swing low,
  exit on SELL, the stop, or after 10 bars. Add `--timeframe 4h`, `--years 5`, or
  `--json`.

## MCP server for bots

The backend is also an [MCP](https://modelcontextprotocol.io) server at
`POST /mcp` (Streamable HTTP), so AI agents can read the same data and signals
as the chart. It is off until you set a token in `.env`:

```bash
OPENCHARTS_MCP_TOKEN=$(openssl rand -hex 32)    # read tools, for every bot
OPENCHARTS_RISK_TOKEN=$(openssl rand -hex 32)   # adds the approval tools, for the Risk Officer only
```

Tokens shorter than 32 characters are ignored. Clients send
`Authorization: Bearer <token>`. Requests from browsers (any `Origin` header)
are refused.

| Tool | Token | What it does |
| --- | --- | --- |
| `get_bars` | any | OHLCV bars, oldest first |
| `get_quote` | any | Latest bid and ask |
| `get_indicators` | any | Latest EMA, SMA, RSI, MACD, ATR, Bollinger, volume vs average, swings |
| `desk_signal` | any | Desk Signal on closed bars, and whether the ticker is approved |
| `screen` | any | Filter the watchlist by trend, signal, RSI, price and volume ratio |
| `get_news` | any | Recent Alpaca news |
| `get_positions` | any | Open positions on the Alpaca paper account |
| `list_signals` | any | Signals the scanner recorded, and whether each webhook went out |
| `get_events` | any | Upcoming FOMC decisions and CPI releases |
| `list_approvals` | any | Live approvals and when each ends |
| `add_journal_entry` | any | Log an idea, rejection, plan or note |
| `list_journal` | any | Journal rows, newest first |
| `place_order` | trader | Long-only order with the checks above (only when `orders.enabled`) |
| `cancel_order` | trader | Cancel an open order (only when `orders.enabled`) |
| `set_approval(ticker, until?)` | risk | Approve a watchlist ticker; 5 trading days unless `until` is given; calling again renews |
| `revoke_approval(ticker)` | risk | End an approval now |

Approvals are kept in SQLite at `data/opencharts.db` (change it with
`dataPath` in `opencharts.config.ts`). Docker keeps it in the
`opencharts-data` volume.

Example client setup (any MCP client that supports Streamable HTTP and headers):

```json
{
  "mcpServers": {
    "opencharts": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <OPENCHARTS_MCP_TOKEN>" }
    }
  }
}
```

To reach it from another machine, publish only `/mcp` through your tunnel on
its own hostname. The bearer token is its gate, so do not put it behind a
browser login such as Cloudflare Access.

## Signal scanner and webhooks

While the backend runs, it checks the watchlist every 5 minutes on the
configured timeframe. A bar counts once it has closed and 10 more minutes have
passed, so its final values are in: with daily bars, about 16:10 New York for
stocks and 00:10 UTC for crypto. Each new BUY or SELL is saved once per ticker
and bar. Change the timing under `scanner` in `opencharts.config.ts`.

A signal on a ticker with a live Risk Officer approval is POSTed to every URL in
`OPENCHARTS_WEBHOOK_URLS`. Webhooks stay off until `OPENCHARTS_WEBHOOK_SECRET` is set
(32+ characters). A failed POST is retried 3 times (after 2 s, 10 s and 30 s).
If it still fails, the failure is logged and shown in `/api/signals` and `list_signals`.

The body is JSON. Its `text` field is the HANDOFF line,
`TICKER | IDEA | EVIDENCE | NEXT STEP`, for example:

```text
NVDA | BUY: 1d close broke the 20-bar high | close 145.20 vs 20-bar high 140.10, volume 1.8x its average, RSI 61.2, trend bullish, ATR 3.10 | Trader: if risk allows, GTC bracket order; stop 138.50 (last swing low)
```

The other fields carry the same numbers (`ticker`, `signal`, `timeframe`,
`barTime`, `close`, `stop`, ...).

Every POST is signed. Verify it before trusting it:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(req, rawBody, secret) {
  const ts = req.headers["x-opencharts-timestamp"];
  const sig = req.headers["x-opencharts-signature"] ?? "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // too old
  const want = `sha256=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`;
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
```

To try webhooks locally, run `npm run webhook:receiver` with the same
`OPENCHARTS_WEBHOOK_SECRET`, set `OPENCHARTS_WEBHOOK_URLS=http://127.0.0.1:8788/`,
then `npm run doctor`: the receiver prints each delivery and whether its
signature checks out.

`X-OpenCharts-Delivery` (`symbol:timeframe:barTime`) stays the same across
retries, so receivers can drop duplicates.

## Trading safety

Paper trading is the default. The backend never trades with live keys unless
you give it live keys. These safety features work whichever order path you use.

- **Hard limits:** set them under `limits` in `opencharts.config.ts`:
  - `maxPositionPct`: the largest position as a % of equity (default 10).
  - `maxOpenPositions`: how many positions can be open at once (default 5).
  - `dailyLossPct`: the daily loss stop, as a % of yesterday's equity (default 2).
- **Position guard:** on start and every 5 minutes, it checks that every open position has a live stop at Alpaca. A bracket leg, a stop, a stop-limit and a trailing stop all count.
  - When a stop is missing, the guard places one. It uses the latest planned stop in the journal, or `price - 2 x ATR` when there is none. With `guard.missingStop: "flatten"`, it closes the position instead.
  - If placing a stop fails twice, it alerts you and blocks new entries on our order path until that position has a stop.
  - It also alerts, once a day each, when positions break the hard limits.
  - Alerts go to your webhooks as `{"type":"alert","text":...}` and into the journal. `/api/health` shows the guard's state.
- **Our order tools (optional):**
  - Turn them on with `orders.enabled: true`, and give `OPENCHARTS_TRADER_TOKEN` to the Trader bot only.
  - `place_order` checks for a live approval, a stop below the price, whole shares for stocks, and the hard limits. It also refuses when the guard has entries blocked.
  - Stocks go in as GTC market brackets, or OTO orders when there is no target. Crypto is a market buy, then a separate GTC stop-limit sell, because Alpaca has no crypto brackets.
  - `place_order` with `side: "sell"` closes the whole position. It never shorts.
- **Trading from the terminal:** the bar above the chart shows `PAPER` or `LIVE`, so you always know where orders go.
  - Orders use the same order path and checks as `place_order`, and are journaled with agent `terminal`. So a BUY needs a Risk Officer approval and a stop loss, and the terminal is read-only until `orders.enabled` is on.
  - Only market BUYs. Close a position to sell it; partial closes, shorts and editing stops are not supported. Stops and targets cannot be cancelled on their own.
- **Signals panel:** the **Signals** button above the chart lists the latest Desk Signals and whether each webhook went out.
- **Journal:** approvals, signals, webhooks, orders (placed or rejected), guard stops and alerts are all logged with time, agent, ticker, action, size, entry, stop, target, reason, evidence and outcome.
  - Bots add ideas, rejections and notes with `add_journal_entry`.
  - After an order placed through Alpaca's official MCP, the Trader should log `action: "plan"` with the stop, so the guard can restore it.
  - Download everything with `GET /api/journal.csv`.
  - **Google Sheets copy (optional):** set `OPENCHARTS_SHEETS_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`, and share the sheet with the service account's email as an Editor. Every 15 minutes (`sheets.everyMinutes`) the backend rewrites its own tab, `OpenCharts Journal` by default (`sheets.tab`). It creates the tab if needed and never writes to any other tab, so bots can keep their own tab in the same sheet. Text is written as plain values, never formulas. `npm run doctor` checks the access.

## Deploying

See [deploy.md](deploy.md) to run the backend as a systemd service behind
Cloudflare Tunnel, or behind nginx on another server, with the terminal behind
Cloudflare Access and `/mcp` on its own hostname.

## Known limits

- Free stock data is the IEX feed only, about 2% to 3% of US volume. Prices
  track the market closely; volume is much lower than the consolidated tape.
- The free plan allows one live stream connection per feed, so run one backend
  per set of keys.
- The terminal has no trade history for Alpaca yet; closed trades are in the journal.
