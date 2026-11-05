import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { JOURNAL_COLUMNS, type JournalEntry, type Store } from "./store.ts";

/**
 * Copies the journal into a Google Sheet, on its own tab. The database stays
 * the source of truth; the tab is rewritten whole on every export, so never
 * point it at a tab people or bots write to.
 *
 * Auth is a Google service account: share the spreadsheet with its email as
 * an Editor. No Google SDK; just a signed JWT and two REST calls.
 */

export interface SheetsTarget {
  spreadsheetId: string;
  tab: string;
  credentials: {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
// shortcut: exports the latest 100,000 rows; page it if a journal grows past that.
const MAX_ROWS = 100_000;

/** Reads OPENCHARTS_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON (the key itself, or a path to it). */
export function sheetsFromEnv(
  env: Record<string, string | undefined>,
  tab: string,
): { target?: SheetsTarget; warning?: string } {
  const spreadsheetId = env.OPENCHARTS_SHEETS_ID?.trim();
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!spreadsheetId && !raw) return {};
  if (!spreadsheetId || !raw)
    return {
      warning:
        "Sheets export needs both OPENCHARTS_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON",
    };
  try {
    const json = raw.startsWith("{")
      ? raw
      : existsSync(raw)
        ? readFileSync(raw, "utf8")
        : "";
    const credentials = JSON.parse(json) as SheetsTarget["credentials"];
    if (!credentials.client_email || !credentials.private_key)
      throw new Error("missing fields");
    return { target: { spreadsheetId, tab, credentials } };
  } catch {
    return {
      warning:
        "GOOGLE_SERVICE_ACCOUNT_JSON is not a service account key (JSON, or a path to the file)",
    };
  }
}

/** The journal as sheet rows, oldest first. RAW input, so text is never run as a formula. */
export function journalRows(entries: JournalEntry[]): (string | number)[][] {
  return [
    [...JOURNAL_COLUMNS],
    ...[...entries]
      .reverse()
      .map((e) =>
        JOURNAL_COLUMNS.map((c) =>
          c === "time" ? new Date(e.time).toISOString() : (e[c] ?? ""),
        ),
      ),
  ];
}

const b64url = (data: string | Buffer) =>
  Buffer.from(data).toString("base64url");

export function createSheetsExporter(options: {
  target: SheetsTarget;
  store: Pick<Store, "listJournal">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}) {
  const { target, store } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.log(`[sheets] ${m}`));
  let token: { value: string; expires: number } | null = null;
  let lastExported = "";
  // The tab's id and row count, read once; the grid must fit the rows before writing.
  let tab: { sheetId: number; rows: number } | null = null;

  const accessToken = async () => {
    if (token && token.expires > now() + 60_000) return token.value;
    const {
      client_email,
      private_key,
      token_uri = "https://oauth2.googleapis.com/token",
    } = target.credentials;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({
        iss: client_email,
        scope: SCOPE,
        aud: token_uri,
        iat,
        exp: iat + 3600,
      }),
    )}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(private_key);
    const res = await doFetch(token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
    });
    if (!res.ok) throw new Error(`Google token ${res.status}`);
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    token = {
      value: body.access_token,
      expires: now() + body.expires_in * 1000,
    };
    return token.value;
  };

  const call = async (path: string, method: string, body?: unknown) => {
    const res = await doFetch(
      `${API}/${encodeURIComponent(target.spreadsheetId)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Sheets ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.json() as Promise<unknown>;
  };

  const range = (a1: string) =>
    encodeURIComponent(`'${target.tab.replace(/'/g, "''")}'${a1}`);

  /** Writes the whole journal to the tab. Skips the call when nothing changed. */
  const exportNow = async () => {
    const entries = store.listJournal({ limit: MAX_ROWS });
    const stamp = `${entries.length}:${entries[0]?.id ?? 0}`;
    if (stamp === lastExported) return { rows: entries.length, skipped: true };
    const needed = entries.length + 1;
    if (!tab) {
      const meta = (await call(
        "?fields=sheets.properties(sheetId,title,gridProperties.rowCount)",
        "GET",
      )) as {
        sheets?: Array<{
          properties: {
            sheetId: number;
            title: string;
            gridProperties?: { rowCount?: number };
          };
        }>;
      };
      const found = meta.sheets?.find((s) => s.properties.title === target.tab);
      if (found) {
        tab = {
          sheetId: found.properties.sheetId,
          rows: found.properties.gridProperties?.rowCount ?? 0,
        };
      } else {
        const rows = Math.max(1000, needed);
        const added = (await call(":batchUpdate", "POST", {
          requests: [
            {
              addSheet: {
                properties: {
                  title: target.tab,
                  gridProperties: { rowCount: rows },
                },
              },
            },
          ],
        })) as {
          replies: Array<{ addSheet: { properties: { sheetId: number } } }>;
        };
        tab = { sheetId: added.replies[0]!.addSheet.properties.sheetId, rows };
      }
    }
    if (needed > tab.rows) {
      const rows = needed + 1000;
      await call(":batchUpdate", "POST", {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: tab.sheetId,
                gridProperties: { rowCount: rows },
              },
              fields: "gridProperties.rowCount",
            },
          },
        ],
      });
      tab.rows = rows;
    }
    await call(`/values/${range("")}:clear`, "POST", {});
    await call(`/values/${range("!A1")}?valueInputOption=RAW`, "PUT", {
      values: journalRows(entries),
    });
    lastExported = stamp;
    return { rows: entries.length, skipped: false };
  };

  return {
    exportNow,
    /** Reads the spreadsheet's title, to check the key and the sharing. Writes nothing. */
    async checkAccess() {
      const meta = (await call("?fields=properties.title", "GET")) as {
        properties: { title: string };
      };
      return meta.properties.title;
    },
    /** Export now and every `everyMinutes`. Returns a stop function. */
    start(everyMinutes: number) {
      const run = () =>
        exportNow().catch((err: unknown) => {
          tab = null;
          log(
            `export failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      void run();
      const id = setInterval(run, everyMinutes * 60_000);
      return () => clearInterval(id);
    },
  };
}
