import { createAlpacaClient } from "./alpaca.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

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

const app = createApp({
  config,
  marketData: createAlpacaClient({ credentials }),
  hasKeys: Boolean(credentials),
  staticDir: "dist",
});

app.server.listen(port, host, () => {
  console.log(`[opencharts] http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close();
    process.exit(0);
  });
}
