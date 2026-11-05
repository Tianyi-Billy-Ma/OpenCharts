// @vitest-environment node
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  MarketData,
  Order,
  OrderRequest,
  Trading,
} from "../../server/alpaca.ts";
import { createApp } from "../../server/app.ts";
import { DEFAULT_CONFIG } from "../../server/config.ts";
import { createOrderDesk } from "../../server/orders.ts";
import { openStore } from "../../server/store.ts";
import { createAlpacaTrading } from "../adapter/alpaca.ts";

const order = (o: Partial<Order>): Order => ({
  id: "entry-1",
  symbol: "NVDA",
  side: "buy",
  type: "market",
  qty: 10,
  filledQty: 0,
  notional: null,
  filledAvgPrice: null,
  status: "accepted",
  stopPrice: null,
  limitPrice: null,
  orderClass: "bracket",
  legs: [],
  ...o,
});

const placed: OrderRequest[] = [];
const cancelled: string[] = [];
const trading: Trading = {
  getAccount: async () => ({
    equity: 100_000,
    lastEquity: 100_000,
    buyingPower: 100_000,
    tradingBlocked: false,
  }),
  getPositions: async () => [
    {
      symbol: "BTCUSD",
      qty: 0.5,
      side: "long",
      avgEntryPrice: 60_000,
      currentPrice: 61_000,
      marketValue: 30_500,
      unrealizedPl: 500,
      unrealizedPlPct: 0.016,
      assetClass: "crypto",
    },
  ],
  getOpenOrders: async () => [
    order({}),
    order({
      id: "btc-stop",
      symbol: "BTC/USD",
      side: "sell",
      type: "stop_limit",
      qty: 0.5,
      stopPrice: 57_000,
      limitPrice: 56_430,
      orderClass: "simple",
    }),
  ],
  getOrder: async (id) => order({ id }),
  placeOrder: async (req) => {
    placed.push(req);
    return order({ id: `placed-${placed.length}` });
  },
  cancelOrder: async (id) => void cancelled.push(id),
  closePosition: async () => {},
};
const marketData = {
  getQuote: async (symbol: string) => ({
    symbol,
    bid: 99.9,
    ask: 100,
    timestamp: Date.now(),
  }),
  getBars: async () => [],
  streamQuotes: () => () => {},
  getNews: async () => [],
  getPositions: async () => [],
} as unknown as MarketData;

const store = openStore(":memory:");
const orders = createOrderDesk({
  config: DEFAULT_CONFIG,
  marketData,
  trading,
  store,
  blockedReason: () => null,
});
const withOrders = createApp({
  config: DEFAULT_CONFIG,
  marketData,
  hasKeys: true,
  trading: { trading, orders, mode: "paper" },
});
const readOnly = createApp({
  config: DEFAULT_CONFIG,
  marketData,
  hasKeys: true,
  trading: { trading, mode: "paper" },
});

const urlOf = (app: typeof withOrders) =>
  `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
beforeAll(async () => {
  for (const app of [withOrders, readOnly])
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
});
afterAll(() => {
  withOrders.close();
  readOnly.close();
});

describe("terminal trading", () => {
  it("shows the account as PAPER and the crypto stop on its position", async () => {
    const gateway = createAlpacaTrading({ baseUrl: urlOf(withOrders) });
    const [account] = await gateway.getAccounts();
    expect(account).toMatchObject({
      label: "Alpaca PAPER",
      phase: "PAPER",
      equity: 100_000,
    });
    const [btc] = await gateway.getPositions(account!.id);
    expect(btc).toMatchObject({ id: "BTCUSD", side: "LONG", stopLoss: 57_000 });
    const listed = await gateway.getOrders(account!.id);
    expect(listed.map((o) => o.id)).toEqual(["entry-1", "btc-stop"]);
  });

  it("sends BUYs through the order desk, so approval and stop rules apply", async () => {
    const gateway = createAlpacaTrading({ baseUrl: urlOf(withOrders) });
    const input = {
      accountId: "x",
      symbol: "NVDA",
      side: "BUY" as const,
      type: "MARKET" as const,
      quantity: 10,
      stopLoss: 95,
    };
    await expect(gateway.placeOrder(input)).rejects.toThrow(/approval/);
    store.setApproval("NVDA", Date.now() + 86_400_000, Date.now());
    await expect(
      gateway.placeOrder({ ...input, stopLoss: undefined }),
    ).rejects.toThrow(/needs a stop/);
    const placedOrder = await gateway.placeOrder(input);
    expect(placedOrder.symbolName).toBe("NVDA");
    expect(placed.at(-1)).toMatchObject({
      order_class: "oto",
      time_in_force: "gtc",
      stop_loss: { stop_price: 95 },
    });
    expect(
      store.listJournal({ limit: 5 }).some((r) => r.agent === "terminal"),
    ).toBe(true);
  });

  it("refuses shorts and cancelling a stop", async () => {
    const gateway = createAlpacaTrading({ baseUrl: urlOf(withOrders) });
    await expect(
      gateway.placeOrder({
        accountId: "x",
        symbol: "NVDA",
        side: "SELL",
        type: "MARKET",
        quantity: 1,
      }),
    ).rejects.toThrow(/long only/);
    await expect(gateway.cancelOrder("btc-stop")).rejects.toThrow(
      /Close the position/,
    );
    await gateway.cancelOrder("entry-1");
    expect(cancelled).toEqual(["entry-1"]);
  });

  it("needs the x-opencharts header, and orders.enabled, to write", async () => {
    const post = (base: string, headers: Record<string, string>) =>
      fetch(`${base}/api/trading/orders/entry-1/cancel`, {
        method: "POST",
        headers,
      });
    expect((await post(urlOf(withOrders), {})).status).toBe(403);
    const off = await post(urlOf(readOnly), { "x-opencharts": "1" });
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toMatch(
      /orders.enabled/,
    );
    expect((await fetch(`${urlOf(readOnly)}/api/trading/account`)).status).toBe(
      200,
    );
  });
});
