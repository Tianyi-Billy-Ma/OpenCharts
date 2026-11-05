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

The backend's routes, all `GET`:

| Route | Returns |
| --- | --- |
| `/api/health` | `{ ok, keys, symbols }` |
| `/api/symbols` | The watchlist as OpenCharts symbols |
| `/api/candles?symbol&timeframe[&limit][&fromMs][&toMs]` | Bars, oldest first, times in seconds; `toMs` is exclusive |
| `/api/quote?symbol` | Latest bid and ask |
| `/api/stream` | Server-Sent Events, one `{"type":"tick",...}` per quote |
| `/api/desk-signal?symbol[&timeframe][&limit]` | Desk Signal per closed bar: trend, BUY/SELL, swing zones, EMAs, RSI, ATR |

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
| `list_approvals` | any | Live approvals and when each ends |
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

## Known limits

- Free stock data is the IEX feed only, about 2% to 3% of US volume. Prices
  track the market closely; volume is much lower than the consolidated tape.
- The free plan allows one live stream connection per feed, so run one backend
  per set of keys.
- The terminal is read-only for now. Trading through Alpaca's paper account
  comes in a later milestone.
