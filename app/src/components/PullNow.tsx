import { useJobs, usePulls } from "../lib/api";
import { ago } from "../lib/format";
import { allowanceNote, pullState } from "../lib/pulls";
import type { PullStatus } from "../lib/types";
import { useAsk } from "../screens/Week";

const WHAT: Record<"refresh_league" | "refresh_odds" | "refresh_status", { feeds: PullStatus["job"][]; names: string[]; button: string; started: string }> = {
  refresh_league: { feeds: ["sleeper.league"], names: ["Sleeper"], button: "Refresh league", started: "Reading your league — about two minutes" },
  refresh_odds: { feeds: ["odds.oddslink", "odds.oddspapi"], names: ["Game prices", "Player bets"], button: "Refresh prices", started: "Fetching prices — about two minutes" },
  refresh_status: { feeds: [], names: [], button: "Check statuses", started: "Checking player statuses — about two minutes" },
};

/** The refresh button on its own, for wherever something stale is shown. */
export function RefreshButton({ kind, className = "btn btn--sm" }: { kind: keyof typeof WHAT; className?: string }) {
  const jobs = useJobs();
  const pulls = usePulls();
  const ask = useAsk();
  const w = WHAT[kind];
  const { busy } = pullState(kind, jobs.data ?? []);
  // how many refreshes of player bets are left this month is said when one is spent, not all the time
  const spare = kind === "refresh_odds" ? allowanceNote((pulls.data ?? []).find((p) => p.job === "odds.oddspapi")) : null;
  return <button className={className} disabled={busy} onClick={() => ask(kind, undefined, spare ? `${w.started}. ${spare}` : w.started)}>{busy ? "On its way…" : w.button}</button>;
}

/** One line on how old what you are looking at is, and a button to refresh it.
 *  `seen` is the age of the prices on screen; without it the line says when the feed was last read. */
export function PullNow({ kind, seen }: { kind: keyof typeof WHAT; seen?: string | null }) {
  const pulls = usePulls();
  const jobs = useJobs();
  const w = WHAT[kind];
  const { busy, problem } = pullState(kind, jobs.data ?? []);
  const row = (job: PullStatus["job"]) => (pulls.data ?? []).find((p) => p.job === job);
  const hours = seen ? (Date.now() - Date.parse(seen)) / 3600e3 : 0;
  const line = seen ? `Prices from ${ago(seen)}.${hours > 12 ? " They've likely moved: check the sportsbook before betting." : ""}`
    : w.feeds.map((f, i) => `${w.names[i]} checked ${ago(row(f)?.checked_at)}`).join(" · ");
  const papi = kind === "refresh_odds" ? row("odds.oddspapi") : undefined;
  return (
    <div className="stack stack--tight">
      <div className="inline">
        <RefreshButton kind={kind} />
        <span className={`small ${hours > 12 ? "warn" : "muted"}`} role="status">{busy ? "This screen updates when it lands." : line}</span>
      </div>
      {problem && <p className="small warn" role="alert">{problem}</p>}
      {papi && papi.pulls_left != null && papi.pulls_left <= 0 && <p className="small muted">{allowanceNote(papi)}</p>}
    </div>
  );
}
