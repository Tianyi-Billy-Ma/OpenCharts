// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  Account,
  MarketData,
  Order,
  OrderRequest,
  Position,
  Trading,
} from "../../server/alpaca.ts";
import { DEFAULT_CONFIG } from "../../server/config.ts";
import { createGuard } from "../../server/guard.ts";
import { createOrderDesk } from "../../server/orders.ts";
import { journalCsv, openStore } from "../../server/store.ts";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const DAY = 86_400;

const order = (o: Partial<Order>): Order => ({
  id: "00000000-0000-0000-0000-000000000001",
  symbol: "NVDA",
  side: "buy",
  type: "market",
  qty: 1,
  filledQty: 0,
  notional: null,
  status: "accepted",
  stopPrice: null,
  limitPrice: null,
  orderClass: "simple",
  legs: [],
  ...o,
});

const position = (p: Partial<Position>): Position => ({
  symbol: "NVDA",
  qty: 10,
  side: "long",
  avgEntryPrice: 100,
  currentPrice: 100,
  marketValue: 1000,
  unrealizedPl: 0,
  unrealizedPlPct: 0,
  assetClass: "us_equity",
  ...p,
});

/** A fake Alpaca account that records every order request. */
function fakeTrading(state: {
  account?: Partial<Account>;
  positions?: Position[];
  open?: Order[];
}) {
  const placed: OrderRequest[] = [];
  const cancelled: string[] = [];
  const closed: string[] = [];
  let fail = 0;
  const trading: Trading = {
    getAccount: async () => ({
      equity: 100_000,
      lastEquity: 100_000,
      buyingPower: 100_000,
      tradingBlocked: false,
      ...state.account,
    }),
    getPositions: async () => state.positions ?? [],
    getOpenOrders: async () => state.open ?? [],
    getOrder: async (id) => order({ id, symbol: "BTC/USD", status: "filled", qty: 0.5 }),
    placeOrder: async (req) => {
      if (fail > 0) {
        fail--;
        throw new Error("Alpaca 422: insufficient qty");
      }
      placed.push(req);
      return order({
        id: `00000000-0000-0000-0000-00000000000${placed.length + 1}`,
        status: "accepted",
      });
    },
    cancelOrder: async (id) => void cancelled.push(id),
    closePosition: async (s) => void closed.push(s),
  };
  return { trading, placed, cancelled, closed, failNext: (n: number) => (fail = n) };
}

const marketData = {
  getQuote: async (symbol: string) => ({ symbol, bid: 99.9, ask: 100, timestamp: NOW }),
  getBars: async ({ limit = 500 }) =>
    Array.from({ length: 300 }, (_, i) => {
      const close = 100 + Math.sin(i / 3) * 2;
      return {
        time: NOW / 1000 - (300 - i) * DAY - DAY,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
      };
    }).slice(-limit),
} as unknown as MarketData;

function setup(state: Parameters<typeof fakeTrading>[0] = {}, blocked: string | null = null) {
  const store = openStore(":memory:");
  const fake = fakeTrading(state);
  const desk = createOrderDesk({
    config: DEFAULT_CONFIG,
    marketData,
    trading: fake.trading,
    store,
    blockedReason: () => blocked,
    now: () => NOW,
    sleep: async () => {},
  });
  return { store, desk, ...fake };
}

const buy = { ticker: "NVDA", side: "buy" as const, qty: 10, stop: 95, reason: "breakout" };

describe("order desk", () => {
  it("places an approved stock BUY as a GTC bracket and journals it", async () => {
    const { store, desk, placed } = setup();
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    const r = await desk.place({ ...buy, target: 120 }, "trader");
    expect(r).toMatchObject({ ok: true, rejected: [] });
    expect(placed).toEqual([
      {
        symbol: "NVDA",
        qty: "10",
        side: "buy",
        type: "market",
        time_in_force: "gtc",
        order_class: "bracket",
        stop_loss: { stop_price: 95 },
        take_profit: { limit_price: 120 },
      },
    ]);
    expect(store.listJournal()[0]).toMatchObject({
      agent: "trader",
      action: "order",
      ticker: "NVDA",
      entry: 100,
      stop: 95,
      outcome: expect.stringMatching(/^placed /),
    });
  });

  it("rejects orders that break the rules, and journals why", async () => {
    const { store, desk, placed } = setup({
      account: { equity: 100_000, lastEquity: 103_000 },
      positions: [1, 2, 3, 4, 5].map((i) => position({ symbol: `X${i}` })),
    });
    const r = await desk.place({ ...buy, qty: 200.5, stop: 101 }, "trader");
    expect(r.ok).toBe(false);
    expect(r.rejected.join("\n")).toMatch(/no live Risk Officer approval/);
    expect(r.rejected.join("\n")).toMatch(/whole shares/);
    expect(r.rejected.join("\n")).toMatch(/stop 101 must be below/);
    expect(r.rejected.join("\n")).toMatch(/daily loss stop/);
    expect(r.rejected.join("\n")).toMatch(/limit of 5 open positions/);
    expect(r.rejected.join("\n")).toMatch(/% of equity/);
    expect(placed).toEqual([]);
    expect(store.listJournal()[0]!.outcome).toMatch(/^rejected: /);
  });

  it("refuses new entries while the guard has them blocked", async () => {
    const { store, desk } = setup({}, "no stop on AMD");
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    const r = await desk.place(buy, "trader");
    expect(r.rejected).toEqual(["new entries are blocked: no stop on AMD"]);
  });

  it("rechecks approval after its lookups, so a revoke mid-check still stops the BUY", async () => {
    const { store, desk, placed, trading } = setup();
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    const getAccount = trading.getAccount;
    trading.getAccount = async () => {
      store.revokeApproval("NVDA", NOW);
      return getAccount();
    };
    const res = await desk.place(buy, "trader");
    expect(res.ok).toBe(false);
    expect(placed).toEqual([]);
  });

  it("counts unfilled BUYs against the limits, and runs concurrent BUYs one at a time", async () => {
    const open: Order[] = [order({ symbol: "NVDA", qty: 60 })];
    const { store, desk, placed, trading } = setup({ open });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    // 60 queued + 50 more at $100 is 11% of $100k equity.
    expect((await desk.place({ ...buy, qty: 50 }, "trader")).rejected).toContain(
      "position would be 11.0% of equity (limit 10%)",
    );
    open.length = 0;
    // Each order shows up as open once placed; the second must see the first.
    const placeOrder = trading.placeOrder;
    trading.placeOrder = async (req) => {
      const o = await placeOrder(req);
      open.push(order({ symbol: String(req.symbol), qty: Number(req.qty) }));
      return o;
    };
    const both = await Promise.all([
      desk.place({ ...buy, qty: 60 }, "trader"),
      desk.place({ ...buy, qty: 60 }, "trader"),
    ]);
    expect(both.map((r) => r.ok)).toEqual([true, false]);
    expect(placed).toHaveLength(1);
  });

  it("reserves only the unfilled part of a partly filled BUY", async () => {
    // 60 of 80 filled (in the position), 20 still working, 10 more: 9% of equity.
    const { store, desk } = setup({
      positions: [position({ qty: 60, marketValue: 6000 })],
      open: [order({ symbol: "NVDA", qty: 80, filledQty: 60 })],
    });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    expect((await desk.place(buy, "trader")).ok).toBe(true);
  });

  it("reserves the dollar amount of a pending notional BUY", async () => {
    // $9,000 queued (qty null at Alpaca) + 10 shares at $100 = 10% is fine; 11 shares is not.
    const { store, desk } = setup({
      open: [order({ symbol: "NVDA", qty: 0, notional: 9000 })],
    });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    expect((await desk.place(buy, "trader")).ok).toBe(true);
    const over = await desk.place({ ...buy, qty: 11 }, "trader");
    expect(over.rejected).toContain("position would be 10.1% of equity (limit 10%)");
  });

  it("counts symbols with unfilled BUYs as open positions", async () => {
    const open = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"].map((symbol) => order({ symbol }));
    const { store, desk } = setup({ open });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    expect((await desk.place(buy, "trader")).rejected).toContain(
      "already at the limit of 5 open positions",
    );
  });

  it("buys crypto at market, then places a separate stop-limit once filled", async () => {
    const { store, desk, placed } = setup();
    store.setApproval("BTC/USD", NOW + DAY * 1000, NOW);
    const r = await desk.place(
      { ticker: "BTC/USD", side: "buy", qty: 0.5, stop: 90, reason: "x" },
      "trader",
    );
    expect(r.ok).toBe(true);
    expect(placed).toEqual([
      { symbol: "BTC/USD", qty: "0.5", side: "buy", type: "market", time_in_force: "gtc" },
      {
        symbol: "BTC/USD",
        qty: "0.5",
        side: "sell",
        type: "stop_limit",
        stop_price: 90,
        limit_price: 89.1,
        time_in_force: "gtc",
      },
    ]);
  });

  it("journals a BUY that Alpaca refuses", async () => {
    const { store, desk, failNext } = setup();
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    failNext(1);
    const r = await desk.place(buy, "trader");
    expect(r).toMatchObject({ ok: false, orders: [] });
    expect(r.rejected[0]).toMatch(/Alpaca refused the order: Alpaca 422/);
    expect(store.listJournal({ limit: 1 })[0]!.outcome).toMatch(/^rejected: Alpaca refused/);
  });

  it("still reports and journals a crypto BUY when the fill check fails", async () => {
    const { store, desk, placed, trading } = setup();
    trading.getOrder = async () => {
      throw new Error("Alpaca 503: unavailable");
    };
    store.setApproval("BTC/USD", NOW + DAY * 1000, NOW);
    const r = await desk.place(
      { ticker: "BTC/USD", side: "buy", qty: 0.5, stop: 90, reason: "x" },
      "trader",
    );
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/fill check failed: Alpaca 503.*position guard/);
    expect(placed).toHaveLength(1);
    const [row] = store.listJournal({ limit: 1 });
    expect(row).toMatchObject({ action: "order", stop: 90 });
    expect(row!.outcome).toMatch(/^placed /);
  });

  it("sells by cancelling the position's open orders and closing it; never shorts", async () => {
    const legs = order({ id: "00000000-0000-0000-0000-0000000000aa", side: "sell", type: "stop" });
    const { desk, cancelled, closed } = setup({ positions: [position({})], open: [legs] });
    const r = await desk.place({ ticker: "NVDA", side: "sell", reason: "SELL signal" }, "trader");
    expect(r.ok).toBe(true);
    expect(cancelled).toEqual([legs.id]);
    expect(closed).toEqual(["NVDA"]);

    const none = await desk.place({ ticker: "AMD", side: "sell", reason: "x" }, "trader");
    expect(none.rejected[0]).toMatch(/does not short/);
  });
});

describe("position guard", () => {
  function guardSetup(
    state: Parameters<typeof fakeTrading>[0],
    missingStop: "place" | "flatten" = "place",
  ) {
    const store = openStore(":memory:");
    const fake = fakeTrading(state);
    const alerts: string[] = [];
    const guard = createGuard({
      config: { ...DEFAULT_CONFIG, guard: { ...DEFAULT_CONFIG.guard, missingStop } },
      marketData,
      trading: fake.trading,
      store,
      alert: async (t) => void alerts.push(t),
      now: () => NOW,
      log: () => {},
    });
    return { store, guard, alerts, ...fake };
  }

  it("leaves a position alone when a bracket leg already holds its stop", async () => {
    const parent = order({
      orderClass: "bracket",
      legs: [order({ side: "sell", type: "stop", qty: 10 })],
    });
    const { guard, placed } = guardSetup({ positions: [position({})], open: [parent] });
    await guard.runOnce();
    expect(placed).toEqual([]);
  });

  it("does not count a held bracket leg (entry not fully filled) as a stop", async () => {
    const parent = order({
      orderClass: "bracket",
      status: "partially_filled",
      legs: [order({ side: "sell", type: "stop", qty: 10, status: "held" })],
    });
    const { guard, placed } = guardSetup({ positions: [position({ qty: 4 })], open: [parent] });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "4", type: "stop" });
  });

  it("covers only the shares a partial stop leaves unprotected", async () => {
    const { guard, placed } = guardSetup({
      positions: [position({})],
      open: [order({ side: "sell", type: "stop", qty: 4 })],
    });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "6", type: "stop" });
  });

  it("counts only the unsold part of a partly executed stop", async () => {
    const { guard, placed } = guardSetup({
      positions: [position({ qty: 10 })],
      open: [
        order({ side: "sell", type: "stop", qty: 14, filledQty: 8, status: "partially_filled" }),
      ],
    });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "4", type: "stop" });
  });

  it("places a missing stop from the journal's plan", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal({ agent: "trader", ticker: "NVDA", action: "plan", stop: 93.5 }, NOW);
    await guard.runOnce();
    expect(placed).toEqual([
      {
        symbol: "NVDA",
        qty: "10",
        side: "sell",
        time_in_force: "gtc",
        type: "stop",
        stop_price: 93.5,
      },
    ]);
    expect(store.listJournal({ action: "stop" })[0]!.evidence).toBe("stop from journal plan");
  });

  it("still finds the plan after many newer journal rows", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal({ agent: "trader", ticker: "NVDA", action: "plan", stop: 93.5 }, NOW);
    for (let i = 1; i <= 60; i++)
      store.addJournal({ agent: "scanner", ticker: "NVDA", action: "signal" }, NOW + i);
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "10", stop_price: 93.5 });
  });

  it("falls back to an ATR stop, and uses a stop-limit for crypto", async () => {
    const { guard, placed } = guardSetup({
      positions: [
        position({ symbol: "BTCUSD", assetClass: "crypto", qty: 0.5, currentPrice: 100 }),
      ],
    });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ symbol: "BTC/USD", qty: "0.5", type: "stop_limit" });
    expect(placed[0]!.stop_price as number).toBeLessThan(100);
  });

  it("alerts and blocks new entries after two failed attempts, then clears", async () => {
    const state = { positions: [position({})] };
    const { guard, alerts, failNext } = guardSetup(state);
    failNext(2);
    await guard.runOnce();
    expect(guard.blockedReason()).toBeNull();
    await guard.runOnce();
    expect(guard.blockedReason()).toBe("no stop on NVDA");
    expect(alerts).toHaveLength(1);
    await guard.runOnce(); // placing works again
    expect(guard.blockedReason()).toBeNull();
  });

  it("can close an unprotected position instead, cancelling its orders first", async () => {
    const target = order({ id: "t1", side: "sell", type: "limit", qty: 10 });
    const { guard, closed, placed, cancelled } = guardSetup(
      { positions: [position({})], open: [target] },
      "flatten",
    );
    await guard.runOnce();
    expect(cancelled).toEqual(["t1"]);
    expect(closed).toEqual(["NVDA"]);
    expect(placed).toEqual([]);
  });

  it("alerts once a day on limit breaches", async () => {
    const { guard, alerts } = guardSetup({
      account: { equity: 10_000, lastEquity: 10_500 },
      positions: [position({ marketValue: 5000, side: "long" })],
      open: [order({ side: "sell", type: "stop", qty: 10 })],
    });
    await guard.runOnce();
    await guard.runOnce();
    expect(alerts).toEqual([
      "NVDA is 50.0% of equity, over the 10% limit.",
      "Down 4.76% today, past the 2% daily loss stop.",
    ]);
  });
});

describe("journal CSV", () => {
  it("escapes quotes and commas and defuses formulas", () => {
    const store = openStore(":memory:");
    store.addJournal({ agent: "Analyst", action: "idea", reason: 'say "hi", ok' }, NOW);
    store.addJournal({ agent: "x", action: "note", evidence: "=HYPERLINK(1)", entry: -5 }, NOW + 1);
    store.addJournal({ agent: "x", action: "note", reason: "-1+2" }, NOW + 2);
    const csv = journalCsv(store.listJournal());
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "id,time,agent,ticker,action,size,entry,stop,target,reason,evidence,outcome",
    );
    expect(lines[1]).toContain('"say ""hi"", ok"');
    expect(lines[2]).toContain("'=HYPERLINK(1)");
    expect(lines[2]).toContain(",-5,");
    expect(lines[3]).toContain(",'-1+2,");
  });
});
