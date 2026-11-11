import { useState } from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorNote, Facts, Fresh, Icon, Loading } from "../components/ui";
import { useBets, useEntries, useEvents, useGames, useHealth, useJobs, usePool, usePropEdges, useQuotes, useRequestJob, useSets, useSettings } from "../lib/api";
import { ago, kickoff, pts, signed, slateTitle } from "../lib/format";
import { visibleSets } from "../lib/lineup";
import { useTitle } from "../lib/nav";
import { useScratches } from "../lib/scratches";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS, type FeedHealth, type Job } from "../lib/types";
import { goodPriceCount, nextStep, weekSteps, type Step } from "../lib/week";

const STATE: Record<FeedHealth["state"], { label: string; tone: string }> = {
  ok: { label: "Fresh", tone: "pill--ok" }, stale: { label: "Out of date", tone: "pill--warn" },
  failing: { label: "Last run failed", tone: "pill--bad" }, never: { label: "Never ran", tone: "pill--bad" },
};
export const JOB_NAME: Record<string, string> = {
  build_lineups: "Lineup build", import_slate: "Salary upload", refresh_status: "Player status check",
  refresh_odds: "Price refresh", refresh_stats: "Stats refresh", project: "Expected points re-run", notify_test: "Test notification",
};
export const JOB_STATE: Record<Job["status"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "pill--warn" }, dispatched: { label: "Starting", tone: "pill--warn" }, running: { label: "Running", tone: "pill--warn" },
  done: { label: "Done", tone: "pill--ok" }, failed: { label: "Failed", tone: "pill--bad" }, needs_setup: { label: "Needs setup", tone: "pill--bad" },
};

export function useAsk() {
  const request = useRequestJob();
  const { say } = useStore();
  return (kind: string, payload?: Record<string, unknown>, started = "Started — ready in a few minutes") =>
    request.mutate({ kind, payload }, { onSuccess: () => say(started), onError: (e) => say(`Couldn't start it — ${e.message}`, true) });
}

export function Week() {
  const health = useHealth();
  const games = useGames();
  const { slate } = useCurrentSlate();
  const pool = usePool(slate?.id);
  const sets = useSets(slate?.id);
  const jobs = useJobs();
  const ask = useAsk();
  const entries = useEntries(slate?.id);
  const quotes = useQuotes();
  const props = usePropEdges();
  const settings = useSettings();
  const bets = useBets();
  const scratches = useScratches(slate, sets.data ?? []);
  const events = useEvents();
  const [allEvents, setAllEvents] = useState(false);
  useTitle("This week");
  if (health.isLoading || games.isLoading) return <Loading />;
  if (health.error) return <ErrorNote error={health.error} />;

  const feeds = (health.data ?? []).filter((f) => f.job !== "optimizer.lineups" || slate?.upcoming);
  const old = feeds.filter((f) => f.state !== "ok");
  const week = games.data?.[0];
  const byTotal = [...(games.data ?? [])].sort((a, b) => (b.total_line ?? 0) - (a.total_line ?? 0));
  const withPoints = (pool.data ?? []).filter((p) => p.dk_mean != null).length;
  const questionable = (pool.data ?? []).filter((p) => p.dk_mean != null && p.dk_status === "Q").length;
  const recent = (jobs.data ?? []).filter((j) => !j.dismissed_at).slice(0, 4);
  const shown = sets.data ? visibleSets(sets.data) : null;      // the same sets the Lineups screen lists
  const steps = weekSteps({
    games: !slate ? "none" : slate.upcoming ? "upcoming" : "started",
    staleFeeds: old.map((f) => f.label.toLowerCase()),
    sets: shown ? shown.auto.length + shown.mine.length : 0,
    setsOnOldNumbers: shown ? shown.mine.filter((x) => !x.on_latest_projections).length : 0,
    enteredLineups: scratches?.entered ?? 0,
    entries: entries.data?.length ?? 0,
    scratched: scratches?.hit ?? 0, scratchedNames: scratches?.names ?? [],
    goodPrices: goodPriceCount(quotes.data ?? [], props.data ?? [], (settings.data ?? DEFAULT_SETTINGS).books),
    openBets: (bets.data ?? []).filter((b) => b.result === "open").length,
  });
  const next = nextStep(steps);
  const changed = events.data ?? [];

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">NFL{week ? ` · Week ${week.week}` : ""}</p>
        <h1 className="title">This week</h1>
      </div>

      <section className="card card--pad" aria-label="What to do now">
        <div className="card__head"><h2 className="h2">{next ? "What to do now" : "You're set"}</h2>
          <span className="small muted">{steps.filter((x) => x.state === "done").length} of {steps.length} done</span></div>
        <ol className="steps">
          {steps.map((x) => <StepRow key={x.key} step={x} next={next?.key === x.key} />)}
        </ol>
      </section>

      <section aria-label="What changed">
        <div className="card__head"><h2 className="h2">What changed</h2>
          {changed.length > 0 && <span className="small muted">latest {ago(changed[0].created_at)}</span>}</div>
        {changed.length === 0 ? <Empty title="Nothing new" why="Players ruled out, injury tags and expected points that moved are listed here as they happen." /> : (
          <div className="card">
            {changed.slice(0, allEvents ? changed.length : 5).map((e) => (
              <Link className="rowline rowline--tap" key={e.id} to={e.url ?? "/"}>
                <div className="grow"><p className={`strong ${e.severity === "alert" ? "bad" : ""}`}>{e.title}</p>{e.body && <p className="small muted">{e.body}</p>}</div>
                <span className="small muted right">{ago(e.created_at)}</span>
              </Link>
            ))}
          </div>
        )}
        {changed.length > 5 && <button className="btn btn--sm btn--quiet" onClick={() => setAllEvents(!allEvents)}>{allEvents ? "Show fewer" : `Show all ${changed.length}`}</button>}
      </section>

      <div className="cols cols--2">
        <section className="card card--pad" aria-label="DraftKings games">
          {slate ? (
            <>
              <div className="card__head">
                <h2 className="h2">{slateTitle(slate.starts_at, slate.n_games)}</h2>
                <span className={`pill ${slate.upcoming ? "pill--accent" : ""}`}>{slate.upcoming ? `Locks ${kickoff(slate.starts_at)}` : "Started"}</span>
              </div>
              <dl className="kv kv--3">
                <div><dt>Players</dt><dd className="big num">{withPoints || "–"}</dd></div>
                <div><dt>Questionable</dt><dd className="big num">{questionable}</dd></div>
                <div><dt>Lineup sets</dt><dd className="big big--accent num">{shown ? shown.auto.length + shown.mine.length : "–"}</dd></div>
              </dl>
              <p className="small muted">Salaries loaded {ago(slate.imported_at)}. {withPoints} of {slate.n_players} players have expected points; the rest are out or haven't played this season.</p>
              <div className="inline">
                <Link className="btn btn--primary" to="/lineups">See lineups</Link>
                <Link className="btn" to="/players">Browse players</Link>
              </div>
            </>
          ) : (
            <Empty title="No DraftKings games loaded" why="Lineups need this week's salaries from a DraftKings export." how={<Link className="accent" to="/more/settings">Add a salary file</Link>} />
          )}
        </section>

        <section className="card card--pad" aria-label="Data freshness">
          <div className="card__head"><h2 className="h2">Is the data fresh?</h2></div>
          {feeds.map((f) => (
            <div className="rowline" key={f.job}>
              <div className="grow">
                <p className="strong">{f.label}</p>
                <Fresh at={f.last_ok_at} label={f.last_ok_at ? "Updated" : "Not yet —"} />
              </div>
              <span className={`pill ${STATE[f.state].tone}`}>{STATE[f.state].label}</span>
            </div>
          ))}
          <div className="inline">
            <button className="btn btn--sm" onClick={() => ask("refresh_status")}>Check player statuses</button>
            <button className="btn btn--sm" onClick={() => ask("refresh_odds")}>Refresh prices</button>
            <button className="btn btn--sm" onClick={() => ask("project")}>Re-run expected points</button>
          </div>
        </section>
      </div>

      <section aria-label="Games">
        <div className="card__head"><h2 className="h2">Games by expected scoring</h2><span className="small muted">Team totals from the betting line</span></div>
        {byTotal.length === 0 ? <Empty title="No games on the schedule" why="The season schedule hasn't loaded for this week." /> : (
          <div className="card">
            {byTotal.map((g) => (
              <div className="rowline" key={g.game_id}>
                <div className="grow">
                  <p className="strong">{g.away_team} at {g.home_team}</p>
                  <Facts items={[kickoff(g.kickoff_at), `${g.home_team} ${signed(g.spread_line == null ? null : -g.spread_line)}`, `Total ${pts(g.total_line)}`]} />
                </div>
                <div className="right num">
                  <p className="strong">{g.home_team} {pts(g.home_implied)}</p>
                  <p className="small muted">{g.away_team} {pts(g.away_implied)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section aria-label="Recent requests">
          <div className="card__head"><h2 className="h2">Your recent requests</h2></div>
          <div className="card">
            {recent.map((j) => (
              <div className="rowline" key={j.id}>
                <div className="grow">
                  <p className="strong">{JOB_NAME[j.kind] ?? j.kind}</p>
                  <p className="small muted">{ago(j.created_at)}{j.error ? ` · ${j.error}` : ""}</p>
                </div>
                <span className={`pill ${JOB_STATE[j.status].tone}`}>{JOB_STATE[j.status].label}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const STEP_WORD: Record<Step["state"], string> = { done: "Done", todo: "To do", alert: "Needs attention", later: "Later" };
function StepRow({ step, next }: { step: Step; next: boolean }) {
  return (
    <li className={`step step--${step.state}`} aria-current={next ? "step" : undefined}>
      <span className="step__mark" title={STEP_WORD[step.state]}>
        {step.state === "done" ? <Icon name="check" /> : step.state === "alert" ? <Icon name="alert" /> : null}
        <span className="sr-only">{STEP_WORD[step.state]}: </span>
      </span>
      <div className="grow"><p className="strong">{step.title}</p><p className="small muted">{step.detail}</p></div>
      {step.to && <Link className={`btn btn--sm ${next ? "btn--primary" : "btn--quiet"}`} to={step.to}>{step.action}</Link>}
    </li>
  );
}
