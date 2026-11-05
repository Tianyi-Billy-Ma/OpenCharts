// @vitest-environment node
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketData } from "../../server/alpaca.ts";
import { createApp } from "../../server/app.ts";
import { DEFAULT_CONFIG } from "../../server/config.ts";
import { createDeskTools } from "../../server/desk-tools.ts";
import { createMcpHandler } from "../../server/mcp.ts";
import { addTradingDays, openStore } from "../../server/store.ts";

const DESK = "d".repeat(40);
const RISK = "r".repeat(40);
const TRADER = "t".repeat(40);
const NOW = Date.parse("2026-11-06T21:00:00Z"); // a Friday

/** Daily bars ending well before NOW, so every one is closed. */
const marketData: MarketData = {
  getBars: async ({ limit = 100 }) => {
    const start = NOW / 1000 - 400 * 86_400;
    return Array.from({ length: 300 }, (_, i) => {
      const close = 100 + i * 0.2 + Math.sin(i / 5) * 3;
      return {
        time: start + i * 86_400,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
      };
    }).slice(-limit);
  },
  getQuote: async (symbol) => ({ symbol, bid: 1, ask: 2, timestamp: NOW }),
  streamQuotes: () => () => {},
  getNews: async () => [
    { headline: "h", summary: "", source: "s", url: "u", symbols: ["NVDA"], time: NOW },
  ],
  getPositions: async () => [],
};

const store = openStore(":memory:");
const tools = createDeskTools({ config: DEFAULT_CONFIG, marketData, store, now: () => NOW });
const app = createApp({
  config: DEFAULT_CONFIG,
  marketData,
  hasKeys: true,
  mcp: createMcpHandler({
    tools,
    tokens: [
      { token: DESK, role: "desk" },
      { token: RISK, role: "risk" },
      { token: TRADER, role: "trader" },
    ],
    version: "test",
  }),
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => {
  app.close();
  store.close();
});

let nextId = 1;
async function rpc(token: string, method: string, params?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return (await res.json()) as { result?: any; error?: { message: string } };
}
const call = async (token: string, name: string, args: Record<string, unknown> = {}) =>
  (await rpc(token, "tools/call", { name, arguments: args })).result as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: { result: any };
  };

describe("MCP server", () => {
  it("needs a valid bearer token and refuses browsers", async () => {
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const wrong = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(40)}` },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    const browser = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${DESK}`, origin: "https://evil.example" },
      body: "{}",
    });
    expect(browser.status).toBe(403);
    expect((await fetch(url, { headers: { authorization: `Bearer ${DESK}` } })).status).toBe(405);
  });

  it("rejects malformed JSON-RPC and unsupported protocol versions", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${RISK}`, ...headers },
        body: JSON.stringify(body),
      });
    const approve = {
      method: "tools/call",
      params: { name: "set_approval", arguments: { ticker: "AMD" } },
    };
    expect((await post({ jsonrpc: "1.0", id: 1, ...approve })).status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: null, ...approve })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: 1, result: {} })).status).toBe(202);
    const badVersion = await post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "mcp-protocol-version": "not-supported" },
    );
    expect(badVersion.status).toBe(400);
    expect(store.isApproved("AMD", NOW)).toBe(false);
  });

  it("initializes, answers notifications with 202 and lists tools by role", async () => {
    const init = await rpc(DESK, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toEqual({});

    const note = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${DESK}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);

    const deskTools = (await rpc(DESK, "tools/list")).result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(deskTools).toContain("desk_signal");
    expect(deskTools).not.toContain("set_approval");
    const riskTools = (await rpc(RISK, "tools/list")).result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(riskTools).toEqual(
      expect.arrayContaining(["set_approval", "revoke_approval", "desk_signal"]),
    );
  });

  it("runs read tools and reports bad arguments as tool errors", async () => {
    const signal = await call(DESK, "desk_signal", { symbol: "nvda", limit: 3 });
    expect(signal.isError).toBeUndefined();
    expect(signal.structuredContent!.result.bars).toHaveLength(3);
    expect(signal.structuredContent!.result.symbol).toBe("NVDA");

    const ind = (await call(DESK, "get_indicators", { symbol: "BTCUSD" })).structuredContent!
      .result;
    expect(ind.symbol).toBe("BTC/USD");
    expect(ind.ema200).toBeTypeOf("number");
    expect(ind.rsi14).toBeTypeOf("number");

    const screen = (await call(DESK, "screen", { trend: "bullish" })).structuredContent!.result;
    expect(screen.matches.every((r: { trend: string }) => r.trend === "bullish")).toBe(true);

    const events = (await call(DESK, "get_events", { days: 10 })).structuredContent!.result;
    expect(events).toEqual([
      { date: "2026-11-10", time: "08:30", kind: "CPI", title: "CPI for October 2026" },
    ]);
    store.recordSignal(
      { symbol: "NVDA", timeframe: "1d", barTime: 1, signal: "BUY", detail: {}, webhook: "sent" },
      NOW,
    );
    const signals = (await call(DESK, "list_signals", { symbol: "NVDA" })).structuredContent!
      .result;
    expect(signals).toMatchObject([{ symbol: "NVDA", signal: "BUY", webhook: "sent" }]);

    const typo = await call(DESK, "screen", { trend: "bullsh" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0]!.text).toContain("trend must be one of");

    const bad = await call(DESK, "get_bars", { symbol: "NVDA", timeframe: "2h" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("Bad timeframe");
  });

  it("lets only the Risk Officer approve and revoke", async () => {
    const denied = await rpc(DESK, "tools/call", {
      name: "set_approval",
      arguments: { ticker: "NVDA" },
    });
    expect(denied.error?.message).toContain("Unknown tool");

    const set = (await call(RISK, "set_approval", { ticker: "NVDA" })).structuredContent!.result;
    expect(set.until).toBe("2026-11-13T21:00:00.000Z"); // 5 trading days after a Friday
    expect(store.listJournal({ action: "approve" })[0]).toMatchObject({
      agent: "risk",
      ticker: "NVDA",
    });
    expect((await call(RISK, "set_approval", { ticker: "SPY" })).isError).toBe(true); // not on the watchlist
    expect(
      (await call(RISK, "set_approval", { ticker: "NVDA", until: "2020-01-01" })).isError,
    ).toBe(true);

    const listed = (await call(DESK, "list_approvals")).structuredContent!.result;
    expect(listed.map((a: { ticker: string }) => a.ticker)).toEqual(["NVDA"]);
    expect(
      (await call(DESK, "desk_signal", { symbol: "NVDA", limit: 1 })).structuredContent!.result
        .approved,
    ).toBe(true);

    expect(
      (await call(RISK, "revoke_approval", { ticker: "NVDA" })).structuredContent!.result.revoked,
    ).toBe(true);
    expect((await call(DESK, "list_approvals")).structuredContent!.result).toEqual([]);
  });
});

describe("get_indicators", () => {
  it("reports RSI and ATR over 14 bars even when Desk Signal uses other periods", async () => {
    const custom = {
      ...DEFAULT_CONFIG,
      deskSignal: {
        ...DEFAULT_CONFIG.deskSignal,
        params: { ...DEFAULT_CONFIG.deskSignal.params, rsiPeriod: 2, atrPeriod: 3 },
      },
    };
    const run = (config: typeof DEFAULT_CONFIG) =>
      createDeskTools({ config, marketData, store, now: () => NOW })
        .find((t) => t.name === "get_indicators")!
        .run({ symbol: "NVDA" }, { role: "desk" }) as Promise<{ rsi14: number; atr14: number }>;
    const [a, b] = await Promise.all([run(DEFAULT_CONFIG), run(custom)]);
    expect(b.rsi14).toBe(a.rsi14);
    expect(b.atr14).toBe(a.atr14);
  });
});

describe("journal and order tools", () => {
  it("exposes order tools only when enabled, and only to the trader role", () => {
    const names = (t: ReturnType<typeof createDeskTools>) => t.map((x) => x.name);
    expect(names(tools)).not.toContain("place_order");
    const withOrders = createDeskTools({
      config: DEFAULT_CONFIG,
      marketData,
      store,
      orders: { place: async () => ({}), cancel: async () => ({}) } as never,
    });
    const place = withOrders.find((t) => t.name === "place_order")!;
    expect(place.role).toBe("trader");
    expect(withOrders.find((t) => t.name === "cancel_order")!.role).toBe("trader");
  });

  it("lets bots journal ideas but not forge order or stop rows", async () => {
    const ok = await call(DESK, "add_journal_entry", {
      agent: "Analyst",
      action: "idea",
      ticker: "nvda",
    });
    expect(ok.structuredContent!.result).toMatchObject({ agent: "Analyst", ticker: "NVDA" });
    const forged = await call(DESK, "add_journal_entry", { agent: "x", action: "order", stop: 1 });
    expect(forged.isError).toBe(true);
    // The guard trusts "plan" stops, so only the Trader's token may log them.
    const plan = { agent: "trader", action: "plan", ticker: "NVDA", stop: 1 };
    expect((await call(DESK, "add_journal_entry", plan)).isError).toBe(true);
    expect((await call(TRADER, "add_journal_entry", plan)).isError).toBeFalsy();
    const rows = (await call(DESK, "list_journal", { ticker: "NVDA" })).structuredContent!.result;
    expect(rows.some((r: { action: string }) => r.action === "idea")).toBe(true);
  });
});

describe("approvals store", () => {
  it("expires approvals and counts trading days", () => {
    const s = openStore(":memory:");
    s.setApproval("ETH/USD", NOW + 1000, NOW);
    expect(s.isApproved("ETH/USD", NOW + 999)).toBe(true);
    expect(s.isApproved("ETH/USD", NOW + 1000)).toBe(false);
    expect(s.revokeApproval("ETH/USD", NOW + 2000)).toBe(false); // already expired
    s.close();

    expect(new Date(addTradingDays(NOW, 1, false)).toISOString()).toBe("2026-11-09T21:00:00.000Z");
    expect(new Date(addTradingDays(NOW, 5, true)).toISOString()).toBe("2026-11-11T21:00:00.000Z");
  });
});
