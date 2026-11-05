/**
 * Scheduled US macro events that move the whole market: FOMC rate decisions
 * and CPI releases. Times are New York time.
 *
 * Sources: federalreserve.gov/monetarypolicy/fomccalendars.htm (2027 dates are
 * tentative until confirmed) and bls.gov/schedule/news_release/cpi.htm.
 * shortcut: a hand-kept list, checked 2026-11-05; refresh it when the Fed or BLS publish new dates.
 */

export interface MacroEvent {
  /** YYYY-MM-DD, New York date. */
  date: string;
  /** HH:MM, New York time. */
  time: string;
  kind: "FOMC" | "CPI";
  title: string;
}

// Decision day (the second day of each meeting); the statement comes at 14:00.
const FOMC = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
  "2027-01-27",
  "2027-03-17",
  "2027-04-28",
  "2027-06-09",
  "2027-07-28",
  "2027-09-15",
  "2027-10-27",
  "2027-12-08",
];

// Release date and the month it reports on; released at 08:30.
const CPI: Array<[string, string]> = [
  ["2026-11-10", "October 2026"],
  ["2026-12-10", "November 2026"],
  ["2027-01-13", "December 2026"],
  ["2027-02-11", "January 2027"],
  ["2027-03-10", "February 2027"],
  ["2027-04-13", "March 2027"],
  ["2027-05-12", "April 2027"],
  ["2027-06-10", "May 2027"],
  ["2027-07-14", "June 2027"],
  ["2027-08-11", "July 2027"],
  ["2027-09-14", "August 2027"],
  ["2027-10-14", "September 2027"],
  ["2027-11-10", "October 2027"],
  ["2027-12-10", "November 2027"],
];

export const MACRO_EVENTS: MacroEvent[] = [
  ...FOMC.map((date) => ({
    date,
    time: "14:00",
    kind: "FOMC" as const,
    title: "FOMC rate decision",
  })),
  ...CPI.map(([date, month]) => ({
    date,
    time: "08:30",
    kind: "CPI" as const,
    title: `CPI for ${month}`,
  })),
].sort((a, b) => a.date.localeCompare(b.date));

/** Events from `fromDate` (inclusive) through the next `days` days. */
export function upcomingEvents(fromDate: string, days: number): MacroEvent[] {
  const end = new Date(Date.parse(`${fromDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return MACRO_EVENTS.filter((e) => e.date >= fromDate && e.date <= end);
}

/** Today's date in New York, YYYY-MM-DD. */
export const newYorkDate = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(ms);
