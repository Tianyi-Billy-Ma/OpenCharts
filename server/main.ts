import { readFileSync } from "node:fs";
import { createAlpacaClient } from "./alpaca.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDeskTools } from "./desk-tools.ts";
import { createMcpHandler, type McpToken } from "./mcp.ts";
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

const app = createApp({
  config,
  marketData,
  hasKeys: Boolean(credentials),
  staticDir: "dist",
  mcp,
});

app.server.listen(port, host, () => {
  console.log(`[opencharts] http://${host}:${port}${mcp ? ` (MCP at /mcp)` : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close();
    store.close();
    process.exit(0);
  });
}
