import type { Job, PullStatus } from "./types";

const ACTIVE = new Set<Job["status"]>(["queued", "dispatched", "running"]);
/** A problem older than this is yesterday's news: the next pull has likely run since. */
const PROBLEM_MINUTES = 30;

/** Where a refresh stands, from the newest job of its kind. */
export function pullState(kind: string, jobs: Job[], now = Date.now()): { busy: boolean; problem: string | null } {
  const last = jobs.filter((j) => j.kind === kind).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!last) return { busy: false, problem: null };
  if (ACTIVE.has(last.status)) return { busy: true, problem: null };
  const recent = now - Date.parse(last.created_at) < PROBLEM_MINUTES * 60e3;
  if (!recent || last.status === "done") return { busy: false, problem: null };
  return { busy: false, problem: last.status === "needs_setup"
    ? "The refresh couldn't start: the link to GitHub isn't set up."
    : "The last refresh failed. The scheduled one will try again." };
}

/** What a tap on "Refresh prices" will do about props, which come from a feed with a monthly allowance. */
export function allowanceNote(p: PullStatus | undefined): string | null {
  if (!p || p.pulls_left == null || p.monthly == null || p.used == null) return null;
  if (p.pulls_left <= 0) return `Player bets and sharp prices have no spare refresh this month (${p.used} of ${p.monthly} requests used, the rest kept for the scheduled ones). Refreshing still updates game prices.`;
  return `${p.pulls_left} spare ${p.pulls_left === 1 ? "refresh" : "refreshes"} of player bets left this month.`;
}
