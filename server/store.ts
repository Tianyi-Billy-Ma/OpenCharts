import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Loaded this way because Vite (tests) cannot resolve "node:sqlite" yet.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/**
 * The backend's SQLite database, the source of truth for approvals (and, in
 * later milestones, signals and the journal). One file, `data/opencharts.db`
 * by default; ":memory:" for tests.
 */

export interface Approval {
  ticker: string;
  /** Epoch ms; the approval is live while now < until. */
  until: number;
  approvedAt: number;
}

export interface Store {
  setApproval(ticker: string, until: number, nowMs?: number): Approval;
  /** True when there was a live approval to revoke. */
  revokeApproval(ticker: string, nowMs?: number): boolean;
  /** Live approvals, soonest to expire first. */
  listApprovals(nowMs?: number): Approval[];
  isApproved(ticker: string, nowMs?: number): boolean;
  close(): void;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      ticker TEXT PRIMARY KEY,
      until_ms INTEGER NOT NULL,
      approved_at_ms INTEGER NOT NULL
    )
  `);
  const upsert = db.prepare(
    `INSERT INTO approvals (ticker, until_ms, approved_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET until_ms = excluded.until_ms, approved_at_ms = excluded.approved_at_ms`,
  );
  // Revoking ends the approval now, keeping the row as a record.
  const revoke = db.prepare(`UPDATE approvals SET until_ms = ? WHERE ticker = ? AND until_ms > ?`);
  const live = db.prepare(
    `SELECT ticker, until_ms, approved_at_ms FROM approvals WHERE until_ms > ? ORDER BY until_ms`,
  );
  const one = db.prepare(`SELECT 1 FROM approvals WHERE ticker = ? AND until_ms > ?`);

  return {
    setApproval(ticker, until, nowMs = Date.now()) {
      upsert.run(ticker, until, nowMs);
      return { ticker, until, approvedAt: nowMs };
    },
    revokeApproval(ticker, nowMs = Date.now()) {
      return Number(revoke.run(nowMs, ticker, nowMs).changes) > 0;
    },
    listApprovals(nowMs = Date.now()) {
      return live.all(nowMs).map((r) => ({
        ticker: String(r.ticker),
        until: Number(r.until_ms),
        approvedAt: Number(r.approved_at_ms),
      }));
    },
    isApproved(ticker, nowMs = Date.now()) {
      return one.get(ticker, nowMs) !== undefined;
    },
    close: () => db.close(),
  };
}

/**
 * `days` trading days after `fromMs`, at the same time of day. Stocks skip
 * weekends; crypto trades every day.
 * shortcut: ignores US market holidays, so a holiday week ends a day late; add a holiday list if that matters.
 */
export function addTradingDays(fromMs: number, days: number, crypto: boolean): number {
  const d = new Date(fromMs);
  for (let left = days; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    const weekday = d.getUTCDay();
    if (crypto || (weekday !== 0 && weekday !== 6)) left--;
  }
  return d.getTime();
}
