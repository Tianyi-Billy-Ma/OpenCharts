// @vitest-environment node
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSheetsExporter,
  journalRows,
  sheetsFromEnv,
} from "../../server/sheets.ts";
import { openStore } from "../../server/store.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = {
  client_email: "bot@x.iam.gserviceaccount.com",
  private_key: key,
};

function fakeGoogle(tabs: string[]) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    calls.push({
      method,
      url,
      body: raw.startsWith("{") ? JSON.parse(raw) : raw,
    });
    if (url.includes("oauth2")) {
      const jwt = new URLSearchParams(raw).get("assertion")!.split(".");
      const valid = createVerify("RSA-SHA256")
        .update(`${jwt[0]}.${jwt[1]}`)
        .verify(publicKey, Buffer.from(jwt[2]!, "base64url"));
      if (!valid) return new Response("bad jwt", { status: 401 });
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (method === "GET")
      return Response.json({
        sheets: tabs.map((title) => ({ properties: { title } })),
      });
    return Response.json({});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Sheets export", () => {
  it("adds its own tab, writes RAW rows oldest first, and skips when nothing changed", async () => {
    const store = openStore(":memory:");
    store.addJournal(
      { agent: "risk", action: "approve", ticker: "NVDA" },
      1_000,
    );
    store.addJournal(
      {
        agent: "trader",
        action: "order",
        ticker: "NVDA",
        reason: "=HYPERLINK(1)",
      },
      2_000,
    );
    const google = fakeGoogle(["Trade Journal"]);
    const exporter = createSheetsExporter({
      target: {
        spreadsheetId: "sheet1",
        tab: "OpenCharts Journal",
        credentials,
      },
      store,
      fetchImpl: google.fetchImpl,
    });

    expect(await exporter.exportNow()).toEqual({ rows: 2, skipped: false });
    const methods = google.calls.map(
      (c) =>
        `${c.method} ${decodeURIComponent(c.url.split("sheet1")[1] ?? "token")}`,
    );
    expect(methods).toEqual([
      "POST token",
      "GET ?fields=sheets.properties.title",
      "POST :batchUpdate",
      "POST /values/'OpenCharts Journal':clear",
      "PUT /values/'OpenCharts Journal'!A1?valueInputOption=RAW",
    ]);
    expect(google.calls[2]!.body).toEqual({
      requests: [{ addSheet: { properties: { title: "OpenCharts Journal" } } }],
    });
    const { values } = google.calls[4]!.body as { values: unknown[][] };
    expect(values[0]![2]).toBe("agent");
    expect(values.slice(1).map((r) => r[4])).toEqual(["approve", "order"]);
    // RAW input: the formula is stored as text, unchanged.
    expect(values[2]![9]).toBe("=HYPERLINK(1)");

    const before = google.calls.length;
    expect(await exporter.exportNow()).toEqual({ rows: 2, skipped: true });
    expect(google.calls.length).toBe(before);
  });

  it("never touches the bots' own tab", async () => {
    const store = openStore(":memory:");
    store.addJournal({ agent: "risk", action: "approve" });
    const google = fakeGoogle(["Trade Journal", "OpenCharts Journal"]);
    await createSheetsExporter({
      target: { spreadsheetId: "s", tab: "OpenCharts Journal", credentials },
      store,
      fetchImpl: google.fetchImpl,
    }).exportNow();
    const writes = google.calls.filter((c) => c.url.includes("/values/"));
    expect(
      writes.every((c) =>
        decodeURIComponent(c.url).includes("'OpenCharts Journal'"),
      ),
    ).toBe(true);
    expect(google.calls.some((c) => c.url.includes("batchUpdate"))).toBe(false);
  });

  it("reads its settings from the environment", () => {
    expect(sheetsFromEnv({}, "t")).toEqual({});
    expect(sheetsFromEnv({ OPENCHARTS_SHEETS_ID: "x" }, "t").warning).toMatch(
      /both/,
    );
    expect(
      sheetsFromEnv(
        { OPENCHARTS_SHEETS_ID: "x", GOOGLE_SERVICE_ACCOUNT_JSON: "{bad" },
        "t",
      ).warning,
    ).toMatch(/not a service account key/);
    const ok = sheetsFromEnv(
      {
        OPENCHARTS_SHEETS_ID: "x",
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials),
      },
      "t",
    );
    expect(ok.target?.credentials.client_email).toBe(credentials.client_email);
    expect(journalRows([])).toHaveLength(1);
  });
});
