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

## Known limits

- Free stock data is the IEX feed only, about 2% to 3% of US volume. Prices
  track the market closely; volume is much lower than the consolidated tape.
- The free plan allows one live stream connection per feed, so run one backend
  per set of keys.
- The terminal is read-only for now. Trading through Alpaca's paper account
  comes in a later milestone.
