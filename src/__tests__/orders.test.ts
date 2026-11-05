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
  filledAvgPrice: null,
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
    getOrder: async (id) =>
      order({ id, symbol: "BTC/USD", status: "filled", qty: 0.5 }),
    placeOrder: async (req) => {
      if (fail > 0) {
        fail--;
        throw Object.assign(new Error("Alpaca 422: insufficient qty"), {
          status: 422,
        });
      }
      placed.push(req);
      return order({
        id: `00000000-0000-0000-0000-00000000000${placed.length + 1}`,
        status: "accepted",
      });
    },
    getOrderByClientId: async () => null,
    cancelOrder: async (id) => {
      cancelled.push(id);
      // Alpaca drops a cancelled order, and a cancelled parent takes its legs with it.
      state.open = (state.open ?? [])
        .filter((o) => o.id !== id)
        .map((o) => ({ ...o, legs: o.legs.filter((l) => l.id !== id) }));
    },
    closePosition: async (s) => void closed.push(s),
  };
  return {
    trading,
    placed,
    cancelled,
    closed,
    failNext: (n: number) => (fail = n),
  };
}

const marketData = {
  getQuote: async (symbol: string) => ({
    symbol,
    bid: 99.9,
    ask: 100,
    timestamp: NOW,
  }),
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

function setup(
  state: Parameters<typeof fakeTrading>[0] = {},
  blocked: string | null = null,
) {
  const store = openStore(":memory:");
  const fake = fakeTrading(state);
  const desk = createOrderDesk({
    config: DEFAULT_CONFIG,
    marketData,
    trading: fake.trading,
    store,
    blockedReason: () => blocked,
    guardActive: true,
    now: () => NOW,
    sleep: async () => {},
  });
  return { store, desk, ...fake };
}

const buy = {
  ticker: "NVDA",
  side: "buy" as const,
  qty: 10,
  stop: 95,
  reason: "breakout",
};

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
        client_order_id: expect.any(String),
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
    expect(
      (await desk.place({ ...buy, qty: 50 }, "trader")).rejected,
    ).toContain("position would be 11.0% of equity (limit 10%)");
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
    expect(over.rejected).toContain(
      "position would be 10.1% of equity (limit 10%)",
    );
  });

  it("subtracts what a notional BUY actually paid, not today's price", async () => {
    // $9,000 order, 40 filled at $100 ($5,000 left); those shares now worth $4,400 at $110.
    const { store, desk } = setup({
      positions: [position({ qty: 40, marketValue: 4400, currentPrice: 110 })],
      open: [
        order({
          symbol: "NVDA",
          qty: 0,
          notional: 9000,
          filledQty: 40,
          filledAvgPrice: 100,
        }),
      ],
    });
    marketData.getQuote = async (symbol: string) => ({
      symbol,
      bid: 109.9,
      ask: 110,
      timestamp: NOW,
    });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    try {
      // 4,400 + 5,000 + 9 x 110 = 10,390: over the 10% limit.
      const r = await desk.place({ ...buy, qty: 9, stop: 100 }, "trader");
      expect(r.rejected).toContain(
        "position would be 10.4% of equity (limit 10%)",
      );
    } finally {
      marketData.getQuote = async (symbol: string) => ({
        symbol,
        bid: 99.9,
        ask: 100,
        timestamp: NOW,
      });
    }
  });

  it("counts symbols with unfilled BUYs as open positions", async () => {
    const open = ["AAPL", "MSFT", "GOOGL", "AMZN", "META"].map((symbol) =>
      order({ symbol }),
    );
    const { store, desk } = setup({ open });
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    expect((await desk.place(buy, "trader")).rejected).toContain(
      "already at the limit of 5 open positions",
    );
  });

  it("buys crypto at market, then places a separate stop-limit once filled", async () => {
    // Alpaca takes the fee out of the coins, so less than the 0.5 ordered is held.
    const { store, desk, placed } = setup({
      positions: [
        position({ symbol: "BTCUSD", assetClass: "crypto", qty: 0.49875 }),
      ],
    });
    store.setApproval("BTC/USD", NOW + DAY * 1000, NOW);
    const r = await desk.place(
      { ticker: "BTC/USD", side: "buy", qty: 0.5, stop: 90, reason: "x" },
      "trader",
    );
    expect(r.ok).toBe(true);
    expect(placed).toEqual([
      {
        symbol: "BTC/USD",
        qty: "0.5",
        side: "buy",
        type: "market",
        time_in_force: "gtc",
        client_order_id: expect.any(String),
      },
      {
        symbol: "BTC/USD",
        qty: "0.49875",
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
    expect(store.listJournal({ limit: 1 })[0]!.outcome).toMatch(
      /^rejected: Alpaca refused/,
    );
  });

  it("still reports and journals a crypto BUY when the fill check fails", async () => {
    const { store, desk, placed, trading } = setup();
    let journaledBeforePoll = false;
    trading.getOrder = async () => {
      // A guard run during this wait must already see the planned stop.
      journaledBeforePoll =
        store.listJournal({ action: "order" })[0]?.stop === 90;
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
    expect(journaledBeforePoll).toBe(true);
    const [row] = store.listJournal({ action: "order" });
    expect(row).toMatchObject({ stop: 90 });
    expect(row!.outcome).toMatch(/^placed /);
    expect(store.listJournal({ action: "stop" })[0]!.outcome).toMatch(
      /^waiting: .*fill check failed/,
    );
  });

  it("sells by cancelling the position's open orders and closing it; never shorts", async () => {
    const legs = order({
      id: "00000000-0000-0000-0000-0000000000aa",
      side: "sell",
      type: "stop",
    });
    const { desk, cancelled, closed } = setup({
      positions: [position({})],
      open: [legs],
    });
    const r = await desk.place(
      { ticker: "NVDA", side: "sell", reason: "SELL signal" },
      "trader",
    );
    expect(r.ok).toBe(true);
    expect(cancelled).toEqual([legs.id]);
    expect(closed).toEqual(["NVDA"]);

    const none = await desk.place(
      { ticker: "AMD", side: "sell", reason: "x" },
      "trader",
    );
    expect(none.rejected[0]).toMatch(/does not short/);
  });
});

describe("order desk safety", () => {
  it("waits for a pending cancel to finish before closing the position", async () => {
    const store = openStore(":memory:");
    const fake = fakeTrading({ positions: [position({})] });
    let open = [order({ id: "stop-1", side: "sell", type: "stop", qty: 10 })];
    fake.trading.getOpenOrders = async () => open;
    // Alpaca answers the DELETE at once; the order stays pending_cancel for a while.
    fake.trading.cancelOrder = async () => {};
    let openAtClose: Order[] | null = null;
    fake.trading.closePosition = async () => void (openAtClose = open);
    let sleeps = 0;
    const desk = createOrderDesk({
      config: DEFAULT_CONFIG,
      marketData,
      trading: fake.trading,
      store,
      blockedReason: () => null,
      guardActive: true,
      now: () => NOW,
      sleep: async () => {
        if (++sleeps === 2) open = [];
      },
    });
    const r = await desk.place(
      { ticker: "NVDA", side: "sell", reason: "x" },
      "trader",
    );
    expect(r.ok).toBe(true);
    expect(sleeps).toBe(2);
    expect(openAtClose).toEqual([]);
  });

  it("cancels a filled bracket's legs, not just its parent, before closing", async () => {
    const bracket = order({
      id: "parent",
      status: "filled",
      qty: 10,
      filledQty: 10,
      orderClass: "bracket",
      legs: [
        order({ id: "leg-stop", side: "sell", type: "stop", qty: 10 }),
        order({ id: "leg-target", side: "sell", type: "limit", qty: 10 }),
      ],
    });
    const { desk, cancelled, closed } = setup({
      positions: [position({})],
      open: [bracket],
    });
    await desk.place({ ticker: "NVDA", side: "sell", reason: "x" }, "trader");
    expect(cancelled).toEqual(
      expect.arrayContaining(["leg-stop", "leg-target"]),
    );
    expect(closed).toEqual(["NVDA"]);
  });

  it("journals a SELL that fails, then rethrows", async () => {
    const { desk, trading, store } = setup({ positions: [position({})] });
    trading.closePosition = async () => {
      throw new Error("Alpaca 403: insufficient qty available");
    };
    await expect(
      desk.place({ ticker: "NVDA", side: "sell", reason: "x" }, "trader"),
    ).rejects.toThrow(/403/);
    expect(store.listJournal({ action: "order" })[0]!.outcome).toMatch(
      /^failed: Alpaca 403/,
    );
  });

  it("looks a BUY up by its client order id when the answer is lost", async () => {
    const { desk, trading, store } = setup();
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    let sentId = "";
    trading.placeOrder = async (req) => {
      sentId = String(req.client_order_id);
      throw new Error("fetch failed: socket hang up");
    };
    trading.getOrderByClientId = async (id) =>
      id === sentId ? order({ id: "live-1" }) : null;
    const r = await desk.place(buy, "trader");
    expect(r).toMatchObject({ ok: true, orders: [{ id: "live-1" }] });
    expect(store.listJournal({ action: "order" })[0]!.outcome).toBe(
      "placed live-1",
    );

    // When the lookup fails too, the outcome is unknown, never "rejected".
    trading.getOrderByClientId = async () => {
      throw new Error("still down");
    };
    const unknown = await desk.place(buy, "trader");
    expect(unknown.ok).toBe(false);
    expect(unknown.rejected[0]).toMatch(/unknown whether Alpaca took/);
    expect(store.listJournal({ action: "order" })[0]!.outcome).toMatch(
      /^unknown: /,
    );
  });

  it("refuses crypto BUYs when no position guard runs", async () => {
    const store = openStore(":memory:");
    const fake = fakeTrading({});
    const desk = createOrderDesk({
      config: DEFAULT_CONFIG,
      marketData,
      trading: fake.trading,
      store,
      blockedReason: () => null,
      guardActive: false,
      now: () => NOW,
      sleep: async () => {},
    });
    store.setApproval("BTC/USD", NOW + DAY * 1000, NOW);
    const r = await desk.place(
      { ticker: "BTC/USD", side: "buy", qty: 0.5, stop: 90, reason: "x" },
      "trader",
    );
    expect(r.rejected.join()).toMatch(/position guard/);
    expect(fake.placed).toEqual([]);
  });

  it("checks the stop after rounding, as Alpaca will see it", async () => {
    const { desk, store, placed } = setup();
    store.setApproval("NVDA", NOW + DAY * 1000, NOW);
    // The ask is 100; 99.996 rounds to 100.00, which is not below it.
    const r = await desk.place({ ...buy, stop: 99.996 }, "trader");
    expect(r.rejected.join()).toMatch(/stop 100 must be below/);
    expect(placed).toEqual([]);
  });

  it("cancels only unfilled entries, never a stop or target", async () => {
    const stop = order({ id: "stop-1", side: "sell", type: "stop" });
    const entry = order({ id: "entry-1" });
    const { desk, cancelled } = setup({ open: [stop, entry] });
    expect(await desk.cancel("stop-1", "trader")).toMatchObject({
      status: 422,
    });
    expect(await desk.cancel("nope", "trader")).toMatchObject({
      status: 404,
    });
    expect(await desk.cancel("entry-1", "trader")).toEqual({
      cancelled: "entry-1",
    });
    expect(cancelled).toEqual(["entry-1"]);
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
      config: {
        ...DEFAULT_CONFIG,
        guard: { ...DEFAULT_CONFIG.guard, missingStop },
      },
      marketData,
      trading: fake.trading,
      store,
      alert: async (t) => void alerts.push(t),
      now: () => NOW,
      sleep: async () => {},
      log: () => {},
    });
    return { store, guard, alerts, ...fake };
  }

  it("leaves a position alone when a bracket leg already holds its stop", async () => {
    const parent = order({
      orderClass: "bracket",
      legs: [order({ side: "sell", type: "stop", qty: 10 })],
    });
    const { guard, placed } = guardSetup({
      positions: [position({})],
      open: [parent],
    });
    await guard.runOnce();
    expect(placed).toEqual([]);
  });

  it("does not count a held bracket leg (entry not fully filled) as a stop", async () => {
    const parent = order({
      orderClass: "bracket",
      status: "partially_filled",
      legs: [order({ side: "sell", type: "stop", qty: 10, status: "held" })],
    });
    const { guard, placed } = guardSetup({
      positions: [position({ qty: 4 })],
      open: [parent],
    });
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
        order({
          side: "sell",
          type: "stop",
          qty: 14,
          filledQty: 8,
          status: "partially_filled",
        }),
      ],
    });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "4", type: "stop" });
  });

  it("places a missing stop from the journal's plan", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 93.5 },
      NOW,
    );
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
    expect(store.listJournal({ action: "stop" })[0]!.evidence).toBe(
      "stop from journal plan",
    );
  });

  it("still finds the plan after many newer journal rows", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 93.5 },
      NOW,
    );
    for (let i = 1; i <= 60; i++)
      store.addJournal(
        { agent: "scanner", ticker: "NVDA", action: "signal" },
        NOW + i,
      );
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ qty: "10", stop_price: 93.5 });
  });

  it("cancels a working target that holds the shares, then places the stop", async () => {
    const target = order({
      id: "target-1",
      side: "sell",
      type: "limit",
      qty: 10,
      limitPrice: 120,
    });
    const { guard, placed, cancelled, store } = guardSetup({
      positions: [position({})],
      open: [target],
    });
    await guard.runOnce();
    expect(cancelled).toEqual(["target-1"]);
    expect(placed[0]).toMatchObject({ side: "sell", type: "stop", qty: "10" });
    expect(store.listJournal({ action: "stop" })[0]!.evidence).toMatch(
      /cancelled 1 target/,
    );
  });

  it("keeps an OCO group whose stop covers part of the position", async () => {
    const oco = order({
      id: "oco-1",
      side: "sell",
      type: "limit",
      qty: 4,
      orderClass: "oco",
      legs: [order({ id: "oco-stop", side: "sell", type: "stop", qty: 4 })],
    });
    const { guard, placed, cancelled } = guardSetup({
      positions: [position({})],
      open: [oco],
    });
    await guard.runOnce();
    expect(cancelled).toEqual([]);
    expect(placed[0]).toMatchObject({ type: "stop", qty: "6" });
  });

  it("leaves a queued market SELL alone: the position is already closing", async () => {
    const exit = order({ id: "exit-1", side: "sell", type: "market", qty: 10 });
    const { guard, placed, cancelled } = guardSetup({
      positions: [position({})],
      open: [exit],
    });
    await guard.runOnce();
    expect(cancelled).toEqual([]);
    expect(placed).toEqual([]);
  });

  it("falls back to an ATR stop, and uses a stop-limit for crypto", async () => {
    const { guard, placed } = guardSetup({
      positions: [
        position({
          symbol: "BTCUSD",
          assetClass: "crypto",
          qty: 0.5,
          currentPrice: 100,
        }),
      ],
    });
    await guard.runOnce();
    expect(placed[0]).toMatchObject({
      symbol: "BTC/USD",
      qty: "0.5",
      type: "stop_limit",
    });
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

  it("ignores the plan of a trade that has since been closed", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 60 },
      NOW - 2000,
    );
    store.addJournal(
      {
        agent: "trader",
        ticker: "NVDA",
        action: "order",
        reason: "SELL: exit",
        outcome: "closed 10, cancelled 1 open order(s)",
      },
      NOW - 1000,
    );
    await guard.runOnce();
    expect(placed[0]!.stop_price).not.toBe(60);
  });

  it("forgets a plan once the guard has seen the position go flat", async () => {
    const state: { positions: Position[] } = { positions: [position({})] };
    const { store, guard, placed } = guardSetup(state);
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 60 },
      NOW - 1000,
    );
    await guard.runOnce();
    expect(placed[0]!.stop_price).toBe(60);
    state.positions = [];
    await guard.runOnce();
    state.positions = [position({})]; // bought again elsewhere, with no new plan
    placed.length = 0;
    await guard.runOnce();
    expect(placed[0]!.stop_price).not.toBe(60);
  });

  it("keeps a plan logged for the next entry after the old position closed", async () => {
    const store = openStore(":memory:");
    const state: { positions: Position[] } = { positions: [position({})] };
    const fake = fakeTrading(state);
    let t = NOW;
    const guard = createGuard({
      config: DEFAULT_CONFIG,
      marketData,
      trading: fake.trading,
      store,
      alert: async () => {},
      now: () => t,
      sleep: async () => {},
      log: () => {},
    });
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 60 },
      t - 1000,
    );
    await guard.runOnce(); // old trade, stop 60
    state.positions = []; // it closes
    t += 60_000;
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 94 },
      t,
    ); // plan for the next entry, before the guard notices the close
    t += 60_000;
    await guard.runOnce(); // flat
    state.positions = [position({})];
    fake.placed.length = 0;
    t += 60_000;
    await guard.runOnce();
    expect(fake.placed[0]!.stop_price).toBe(94);
  });

  it("finds the placed BUY's stop past many rejected attempts", async () => {
    const { store, guard, placed } = guardSetup({ positions: [position({})] });
    store.addJournal(
      {
        agent: "trader",
        ticker: "NVDA",
        action: "order",
        stop: 91,
        reason: "BUY: x",
        outcome: "placed abc",
      },
      NOW - 10_000,
    );
    for (let i = 0; i < 600; i++)
      store.addJournal(
        {
          agent: "trader",
          ticker: "NVDA",
          action: "order",
          reason: "BUY: retry",
          outcome: "rejected: limit",
        },
        NOW - 9000 + i,
      );
    await guard.runOnce();
    expect(placed[0]).toMatchObject({ stop_price: 91 });
  });

  it("leaves the target in place when it cannot work out a stop", async () => {
    const target = order({ id: "t1", side: "sell", type: "limit", qty: 10 });
    const store = openStore(":memory:");
    const fake = fakeTrading({ positions: [position({})], open: [target] });
    const guard = createGuard({
      config: DEFAULT_CONFIG,
      marketData: {
        ...marketData,
        getBars: async () => {
          throw new Error("bars down");
        },
      } as unknown as MarketData,
      trading: fake.trading,
      store,
      alert: async () => {},
      now: () => NOW,
      sleep: async () => {},
      log: () => {},
    });
    await guard.runOnce();
    expect(fake.cancelled).toEqual([]);
    expect(fake.placed).toEqual([]);
  });

  it("cancels the rest of a partly filled bracket entry, then covers what filled", async () => {
    const entry = order({
      id: "entry-1",
      qty: 10,
      filledQty: 4,
      status: "partially_filled",
      orderClass: "bracket",
      legs: [
        order({
          id: "held-stop",
          side: "sell",
          type: "stop",
          qty: 10,
          status: "held",
        }),
      ],
    });
    const { guard, placed, cancelled, store } = guardSetup({
      positions: [position({ qty: 4, marketValue: 400 })],
      open: [entry],
    });
    store.addJournal(
      { agent: "trader", ticker: "NVDA", action: "plan", stop: 95 },
      NOW - 1000,
    );
    await guard.runOnce();
    expect(cancelled).toEqual(["entry-1"]);
    expect(placed).toEqual([
      expect.objectContaining({ qty: "4", type: "stop", stop_price: 95 }),
    ]);
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
    store.addJournal(
      { agent: "Analyst", action: "idea", reason: 'say "hi", ok' },
      NOW,
    );
    store.addJournal(
      { agent: "x", action: "note", evidence: "=HYPERLINK(1)", entry: -5 },
      NOW + 1,
    );
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
