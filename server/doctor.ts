import { alpacaCredentialsFromEnv, createAlpacaClient } from "./alpaca.ts";
import { loadConfig } from "./config.ts";
import { createSheetsExporter, sheetsFromEnv } from "./sheets.ts";
import { deliverWebhook, webhooksFromEnv } from "./webhooks.ts";

/**
 * `npm run doctor`: check the secrets in the environment without printing
 * them, reach the Alpaca paper account, send a signed test webhook, and
 * check the Google Sheet the journal is copied to.
 * With 1Password: `op run --env-file=.env.op -- npm run doctor`.
 */

const env = process.env;
const config = await loadConfig();
let failed = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const warn = (m: string) => console.log(`  warn  ${m}`);
const fail = (m: string) => {
  failed++;
  console.log(`  FAIL  ${m}`);
};

console.log("Alpaca");
const credentials = alpacaCredentialsFromEnv(env);
if (!credentials) fail("no keys: set ALPACA_KEY_ID and ALPACA_SECRET_KEY");
else ok("keys are set");
const base = env.APCA_API_BASE_URL ?? env.ALPACA_BASE_URL;
if (base && !base.includes("paper"))
  warn(
    "a non-paper base URL is set; OpenCharts ignores it and always trades paper",
  );
if (credentials) {
  const alpaca = createAlpacaClient({ credentials, log: () => {} });
  try {
    const account = await alpaca.getAccount();
    if (account.tradingBlocked)
      fail("paper account reached, but Alpaca has blocked trading");
    else ok("paper account reached, trading allowed");
  } catch (err) {
    fail(`paper account: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await alpaca.getQuote("NVDA");
    ok("stock data reached (NVDA quote)");
  } catch (err) {
    fail(`stock data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log("MCP tokens");
const tokens = [
  "OPENCHARTS_MCP_TOKEN",
  "OPENCHARTS_RISK_TOKEN",
  "OPENCHARTS_TRADER_TOKEN",
];
const seen = new Map<string, string>();
for (const name of tokens) {
  const token = env[name];
  if (!token) warn(`${name} is not set`);
  else if (token.length < 32) fail(`${name} is shorter than 32 characters`);
  else if (seen.has(token))
    fail(`${name} is the same as ${seen.get(token)}; each role needs its own`);
  else ok(`${name} is set`);
  if (token) seen.set(token, name);
}

console.log("Webhooks");
const { webhooks, warning } = webhooksFromEnv(env);
if (warning) fail(warning);
else if (!webhooks)
  warn("OPENCHARTS_WEBHOOK_URLS is not set, so signals are not sent anywhere");
else {
  const body = JSON.stringify({ type: "test", text: "OpenCharts doctor test" });
  for (const url of webhooks.urls) {
    const r = await deliverWebhook(
      url,
      body,
      webhooks.secret,
      `test:${Date.now()}`,
      {
        retryDelaysMs: [],
      },
    );
    if (r.ok) ok(`test webhook delivered to ${r.host}`);
    else fail(`test webhook to ${r.host}: ${r.error}`);
  }
}

console.log("Google Sheets");
const sheets = sheetsFromEnv(env, config.sheets.tab);
if (sheets.warning) fail(sheets.warning);
else if (!sheets.target)
  warn(
    "OPENCHARTS_SHEETS_ID is not set, so the journal is not copied to Sheets",
  );
else {
  const exporter = createSheetsExporter({
    target: sheets.target,
    store: { listJournal: () => [] },
  });
  try {
    const title = await exporter.checkAccess();
    ok(
      `spreadsheet "${title}" reached; the journal goes to its "${config.sheets.tab}" tab`,
    );
  } catch (err) {
    fail(
      `Sheets: ${err instanceof Error ? err.message : String(err)}. Share the sheet with ${sheets.target.credentials.client_email} as an Editor.`,
    );
  }
}

console.log(failed ? `\n${failed} problem(s) found.` : "\nAll good.");
process.exit(failed ? 1 : 0);
