import { useJobs, usePulls } from "../lib/api";
import { ago } from "../lib/format";
import { allowanceNote, pullState } from "../lib/pulls";
import type { PullStatus } from "../lib/types";
import { useAsk } from "../screens/Week";

const WHAT: Record<"refresh_league" | "refresh_odds", { feeds: PullStatus["job"][]; names: string[]; button: string; started: string }> = {
  refresh_league: { feeds: ["sleeper.league"], names: ["Sleeper"], button: "Pull from Sleeper", started: "Reading your league — about two minutes" },
  refresh_odds: { feeds: ["odds.oddslink", "odds.oddspapi"], names: ["Game lines", "Player bets"], button: "Pull prices now", started: "Fetching prices — about two minutes" },
};

/** When a feed was last read, and a button to read it now. */
export function PullNow({ kind }: { kind: keyof typeof WHAT }) {
  const pulls = usePulls();
  const jobs = useJobs();
  const ask = useAsk();
  const w = WHAT[kind];
  const { busy, problem } = pullState(kind, jobs.data ?? []);
  const row = (job: PullStatus["job"]) => (pulls.data ?? []).find((p) => p.job === job);
  const checked = w.feeds.map((f, i) => `${w.names[i]} checked ${ago(row(f)?.checked_at)}`).join(" · ");
  const note = kind === "refresh_odds" ? allowanceNote(row("odds.oddspapi")) : null;
  return (
    <div className="stack stack--tight">
      <div className="inline">
        <button className="btn btn--sm" disabled={busy} onClick={() => ask(kind, undefined, w.started)}>{busy ? "Pulling…" : w.button}</button>
        <span className="small muted" role="status">{busy ? "On its way — this screen updates when it lands." : checked}</span>
      </div>
      {problem && <p className="small warn" role="alert">{problem}</p>}
      {note && <p className="small muted">{note}</p>}
    </div>
  );
}
