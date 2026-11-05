import { readFileSync } from "node:fs";
import { alpacaCredentialsFromEnv, createAlpacaClient } from "./alpaca.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDeskTools } from "./desk-tools.ts";
import { createMcpHandler, type McpToken } from "./mcp.ts";
import { createGuard } from "./guard.ts";
import { createOrderDesk } from "./orders.ts";
import { createScanner } from "./scanner.ts";
import { createSheetsExporter, sheetsFromEnv } from "./sheets.ts";
import { openStore } from "./store.ts";
import { deliverWebhook, webhooksFromEnv } from "./webhooks.ts";

/** `npm run server`: start the backend with opencharts.config.ts and .env. */

const config = await loadConfig();
const port = Number(process.env.PORT ?? config.port);
const host = process.env.HOST ?? config.host;

const credentials = alpacaCredentialsFromEnv(process.env);
if (!credentials) {
  console.warn(
    "[opencharts] ALPACA_KEY_ID / ALPACA_SECRET_KEY not set: crypto charts work, stocks and live prices do not.",
  );
}

const marketData = createAlpacaClient({ credentials });
const store = openStore(process.env.OPENCHARTS_DB ?? config.dataPath);

// Webhook URLs can hold tokens, so they live in .env with the signing secret.
const { webhooks, warning } = webhooksFromEnv(process.env);
if (warning) console.warn(`[opencharts] ${warning}`);
const stopScanner = config.scanner.enabled
  ? createScanner({ config, marketData, store, webhooks }).start()
  : () => {};

/** Owner alerts go to the same webhooks, as {"type":"alert","text":...}. */
const alert = async (text: string) => {
  if (!webhooks) return;
  const body = JSON.stringify({ type: "alert", text });
  const id = `alert:${Date.now()}`;
  await Promise.all(
    webhooks.urls.map((url) => deliverWebhook(url, body, webhooks!.secret, id)),
  );
};
const guard =
  config.guard.enabled && credentials
    ? createGuard({ config, marketData, trading: marketData, store, alert })
    : null;
if (config.guard.enabled && !credentials)
  console.warn(
    "[opencharts] The position guard needs Alpaca keys, so it is off.",
  );
const stopGuard = guard ? guard.start() : () => {};
const sheets = sheetsFromEnv(process.env, config.sheets.tab);
if (sheets.warning) console.warn(`[opencharts] ${sheets.warning}`);
const stopSheets = sheets.target
  ? createSheetsExporter({ target: sheets.target, store }).start(
      config.sheets.everyMinutes,
    )
  : () => {};
const orders =
  config.orders.enabled && credentials
    ? createOrderDesk({
        config,
        marketData,
        trading: marketData,
        store,
        blockedReason: () => guard?.blockedReason() ?? null,
        guardActive: guard != null,
      })
    : undefined;

// Bots get the desk token; only the Risk Officer gets the risk token, only the Trader the trader token.
const tokens: McpToken[] = [];
for (const [env, role] of [
  ["OPENCHARTS_MCP_TOKEN", "desk"],
  ["OPENCHARTS_RISK_TOKEN", "risk"],
  // Only used when orders.enabled is on: the Trader's order tools.
  ["OPENCHARTS_TRADER_TOKEN", "trader"],
] as const) {
  const token = process.env[env];
  if (!token) continue;
  if (token.length < 32) {
    console.warn(
      `[opencharts] ${env} is shorter than 32 characters, so it is ignored.`,
    );
    continue;
  }
  tokens.push({ token, role });
}
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};
const mcp = tokens.length
  ? createMcpHandler({
      tools: createDeskTools({ config, marketData, store, orders }),
      tokens,
      version,
    })
  : undefined;
if (!mcp)
  console.warn(
    "[opencharts] No MCP token set, so /mcp is off. See .env.example.",
  );

const app = createApp({
  config,
  marketData,
  hasKeys: Boolean(credentials),
  staticDir: "dist",
  store,
  mcp,
  guardStatus: guard?.status,
  // Paper only: live keys come after the go-live gate (docs/requirements.md 5.5).
  trading: credentials
    ? { trading: marketData, orders, mode: "paper" }
    : undefined,
});

app.server.listen(port, host, () => {
  console.log(
    `[opencharts] http://${host}:${port}${mcp ? ` (MCP at /mcp)` : ""}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopScanner();
    stopGuard();
    stopSheets();
    app.close();
    store.close();
    process.exit(0);
  });
}
