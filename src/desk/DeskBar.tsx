import { useEffect, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * A thin bar above the terminal for the OpenCharts backend (VITE_ADAPTER=alpaca):
 * which Alpaca account orders go to, and the Desk Signal log with webhook status.
 */

interface Signal {
  id: number;
  symbol: string;
  timeframe: string;
  barTime: number;
  signal: "BUY" | "SELL";
  createdAt: number;
  webhook: string;
  deliveries: Array<{
    host: string;
    ok: boolean;
    attempts: number;
    error?: string;
  }>;
}

interface AccountInfo {
  mode: "paper" | "live";
  ordersEnabled: boolean;
}

const REFRESH_MS = 60_000;

export function DeskBar() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [a, s] = await Promise.all([
        fetch("/api/trading/account").then((r) =>
          r.ok ? (r.json() as Promise<AccountInfo>) : null,
        ),
        fetch("/api/signals").then((r) => {
          if (!r.ok) throw new Error(`signals ${r.status}`);
          return r.json() as Promise<Signal[]>;
        }),
      ]).catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
        return [undefined, undefined] as const;
      });
      if (!alive) return;
      if (a !== undefined) setAccount(a);
      if (s !== undefined) {
        setSignals(s);
        setError(null);
      }
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const live = account?.mode === "live";
  return (
    <div className="relative shrink-0 border-b border-border bg-secondary text-xs">
      <div className="flex items-center gap-3 px-3 py-1">
        <span
          data-testid="account-mode"
          className={cn(
            "rounded px-2 py-0.5 font-bold tracking-wide",
            !account && "bg-muted text-muted-foreground",
            account && !live && "bg-amber-500 text-black",
            live && "bg-red-600 text-white",
          )}
          title={
            account
              ? "Where orders from this terminal go"
              : "No Alpaca account connected"
          }
        >
          {account ? account.mode.toUpperCase() : "NO ACCOUNT"}
        </span>
        {account && !account.ordersEnabled && (
          <span className="text-muted-foreground">
            Read-only: orders are off (orders.enabled in opencharts.config.ts)
          </span>
        )}
        <button
          className="ml-auto rounded px-2 py-0.5 text-foreground hover:bg-card"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          Signals ({signals.length})
        </button>
      </div>
      {open && (
        <div className="absolute right-2 top-full z-50 mt-1 max-h-[60vh] w-[30rem] max-w-[95vw] overflow-auto rounded-md border border-border bg-card shadow-lg">
          {error && (
            <p className="p-3 text-red-500">Could not load signals: {error}</p>
          )}
          {!error && signals.length === 0 && (
            <p className="p-3 text-muted-foreground">No Desk Signals yet.</p>
          )}
          {signals.length > 0 && (
            <table className="w-full">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-1.5 font-normal">Bar</th>
                  <th className="px-3 py-1.5 font-normal">Symbol</th>
                  <th className="px-3 py-1.5 font-normal">Signal</th>
                  <th className="px-3 py-1.5 font-normal">Webhook</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">
                      {new Date(s.barTime * 1000)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")}{" "}
                      {s.timeframe}
                    </td>
                    <td className="px-3 py-1.5">{s.symbol}</td>
                    <td
                      className={cn(
                        "px-3 py-1.5 font-semibold",
                        s.signal === "BUY"
                          ? "text-emerald-500"
                          : "text-red-500",
                      )}
                    >
                      {s.signal}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1.5",
                        s.webhook === "failed" && "text-red-500",
                      )}
                      title={s.deliveries
                        .map(
                          (d) =>
                            `${d.host}: ${d.ok ? "ok" : (d.error ?? "failed")}`,
                        )
                        .join("\n")}
                    >
                      {s.webhook}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
