import { useEffect, useState } from "react";
import { createDemoAdapter } from "./adapter/demo.ts";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import type { OpenChartsAdapter } from "./adapter/types.ts";
import { Terminal } from "./terminal/Terminal.tsx";

/**
 * The hosted demo's root.
 *
 * Deliberately what an integrator would write: install an adapter, render the
 * terminal. Everything else — query cache, market-data stream, notifications,
 * error boundary — comes from `<OpenChartsProvider>`.
 *
 * `VITE_ADAPTER=binance npm run dev` swaps in the live-market-data example from
 * examples/binance-adapter. `VITE_ADAPTER=alpaca` uses the OpenCharts backend
 * in server/ (Alpaca data). Both load lazily so none of their code reaches the
 * default bundle.
 */

const adapterName = ["alpaca", "binance"].includes(import.meta.env.VITE_ADAPTER ?? "")
  ? (import.meta.env.VITE_ADAPTER as "alpaca" | "binance")
  : null;

function loadAdapter(): Promise<OpenChartsAdapter> {
  if (adapterName === "alpaca") {
    return import("./adapter/alpaca.ts").then(({ createAlpacaAdapter }) => createAlpacaAdapter());
  }
  return import("../examples/binance-adapter/binance-adapter.ts").then(
    ({ createBinancePaperAdapter }) => createBinancePaperAdapter(),
  );
}

export function Root() {
  const [adapter, setAdapter] = useState<OpenChartsAdapter | null>(() =>
    adapterName ? null : createDemoAdapter(),
  );

  useEffect(() => {
    if (!adapterName) return;
    loadAdapter()
      .then(setAdapter)
      .catch((err: unknown) => {
        console.error(`[opencharts] failed to load the ${adapterName} adapter; using the demo`, err);
        setAdapter(createDemoAdapter());
      });
  }, []);

  if (!adapter) return null;
  return (
    <OpenChartsProvider adapter={adapter}>
      <Terminal />
    </OpenChartsProvider>
  );
}
