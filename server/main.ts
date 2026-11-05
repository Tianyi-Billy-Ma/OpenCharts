import { readFileSync } from "node:fs";
import { createAlpacaClient } from "./alpaca.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDeskTools } from "./desk-tools.ts";
import { createMcpHandler, type McpToken } from "./mcp.ts";
import { createScanner } from "./scanner.ts";
import { openStore } from "./store.ts";

/** `npm run server`: start the backend with opencharts.config.ts and .env. */

const config = await loadConfig();
const port = Number(process.env.PORT ?? config.port);
const host = process.env.HOST ?? config.host;

const keyId = process.env.ALPACA_KEY_ID;
const secretKey = process.env.ALPACA_SECRET_KEY;
const credentials = keyId && secretKey ? { keyId, secretKey } : undefined;
if (!credentials) {
  console.warn(
    "[opencharts] ALPACA_KEY_ID / ALPACA_SECRET_KEY not set: crypto charts work, stocks and live prices do not.",
  );
}

const marketData = createAlpacaClient({ credentials });
const store = openStore(process.env.OPENCHARTS_DB ?? config.dataPath);

// Bots get the desk token; only the Risk Officer gets the risk token.
const tokens: McpToken[] = [];
for (const [env, role] of [
  ["OPENCHARTS_MCP_TOKEN", "desk"],
  ["OPENCHARTS_RISK_TOKEN", "risk"],
] as const) {
  const token = process.env[env];
  if (!token) continue;
  if (token.length < 32) {
    console.warn(`[opencharts] ${env} is shorter than 32 characters, so it is ignored.`);
    continue;
  }
  tokens.push({ token, role });
}
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const mcp = tokens.length
  ? createMcpHandler({ tools: createDeskTools({ config, marketData, store }), tokens, version })
  : undefined;
if (!mcp) console.warn("[opencharts] No MCP token set, so /mcp is off. See .env.example.");

// Webhook URLs can hold tokens, so they live in .env with the signing secret.
const webhookUrls = (process.env.OPENCHARTS_WEBHOOK_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const webhookSecret = process.env.OPENCHARTS_WEBHOOK_SECRET ?? "";
let webhooks: { urls: string[]; secret: string } | null = null;
if (webhookUrls.length) {
  // Never echo the URLs: they can hold tokens.
  const bad = webhookUrls.filter((u) => {
    const url = URL.parse(u);
    return !url || !/^https?:$/.test(url.protocol) || url.username !== "" || url.password !== "";
  });
  if (bad.length)
    console.warn(
      `[opencharts] Webhooks are off: ${bad.length} URL(s) are not http(s) or hold a user:password. Put tokens in the path or query instead.`,
    );
  else if (webhookSecret.length < 32)
    console.warn("[opencharts] Webhooks are off: set OPENCHARTS_WEBHOOK_SECRET (32+ characters).");
  else webhooks = { urls: webhookUrls, secret: webhookSecret };
}
const stopScanner = config.scanner.enabled
  ? createScanner({ config, marketData, store, webhooks }).start()
  : () => {};

const app = createApp({
  config,
  marketData,
  hasKeys: Boolean(credentials),
  staticDir: "dist",
  store,
  mcp,
});

app.server.listen(port, host, () => {
  console.log(`[opencharts] http://${host}:${port}${mcp ? ` (MCP at /mcp)` : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopScanner();
    app.close();
    store.close();
    process.exit(0);
  });
}
