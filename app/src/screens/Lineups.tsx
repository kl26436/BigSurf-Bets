import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Entries } from "../components/Entries";
import { GamesPicker } from "../components/GamesPicker";
import { Empty, ErrorNote, Facts, Loading, Sheet, Stepper } from "../components/ui";
import { useDismissJob, useJobs, usePool, useRequestJob, useSets } from "../lib/api";
import { ago, dayName, pts, slateTitle, usd } from "../lib/format";
import { DEFAULT_MIN_SPEND, DEFAULT_PER_TEAM, buildCards, describeSettings, isShowdown, onePerPlayer, visibleSets, type BuildCard } from "../lib/lineup";
import { useSheet, useTitle } from "../lib/nav";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import { useScratches } from "../lib/scratches";
import type { LineupSet, Slate } from "../lib/types";

export const MODE: Record<string, string> = { gpp: "Tournament set", cash: "Cash-game set", manual: "Built by hand" };
export const SOURCE: Record<string, string> = { auto: "Automatic", user: "Your build", manual: "By hand" };
/** What a set is called: the name it was given, else its kind. */
export const setName = (s: Pick<LineupSet, "label" | "mode"> | null | undefined) => s?.label || MODE[s?.mode ?? ""] || "Lineup set";
/** How long a build takes, measured on real requests (GitHub start plus the build itself). */
export const BUILD_TIME = "about a minute";

function SetCard({ s }: { s: LineupSet }) {
  const sm = (s.summary ?? {}) as Record<string, number>;
  const built = describeSettings(s);
  return (
    <Link className="card card--pad" to={`/lineups/${s.id}`}>
      <div className="card__head">
        <h2 className="h2">{setName(s)}</h2>
        <span className="small muted">{ago(s.created_at)}</span>
      </div>
      <Facts className="small" items={[`${s.n_lineups} ${s.n_lineups === 1 ? "lineup" : "lineups"}`, sm.avg_proj ? `${pts(sm.avg_proj)} expected on average` : null, sm.players_used ? `${sm.players_used} players` : null]} />
      <Facts items={built} />
      <div className="inline">
        <span className="pill">{SOURCE[s.source] ?? s.source}</span>
        {s.entered && <span className="pill pill--ok">Entered</span>}
        {s.archived_at && <span className="pill">Archived</span>}
        <span className={`pill ${s.on_latest_projections ? "pill--accent" : "pill--warn"}`}>{s.on_latest_projections ? "Uses the latest numbers" : "Built on older numbers"}</span>
      </div>
    </Link>
  );
}

/** A build request: under way, finished (open it), or failed (say why, let it be cleared). */
function RequestCard({ card }: { card: BuildCard }) {
  const dismiss = useDismissJob();
  const { job, state } = card;
  const clear = <button className="btn btn--sm btn--quiet" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ job_id: job.id })}>Dismiss</button>;
  if (state === "ready") {
    return (
      <div className="card card--pad" role="status">
        <div className="spread"><p className="strong">Your lineups are ready</p><span className="pill pill--ok">Done</span></div>
        <p className="small muted">Asked for {ago(job.created_at)}.</p>
        <div className="inline"><Link className="btn btn--sm btn--primary" to={`/lineups/${card.setId}`}>Open them</Link>{clear}</div>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="card card--pad" role="alert">
        <div className="spread"><p className="strong">A lineup build didn't finish</p><span className="pill pill--bad">{job.status === "needs_setup" ? "Needs setup" : "Failed"}</span></div>
        <p className="small muted">Asked for {ago(job.created_at)}. {card.why ?? "No reason was recorded."}</p>
        <div className="inline">{clear}</div>
      </div>
    );
  }
  return (
    <div className="card card--pad" role="status">
      <div className="spread"><p className="strong">Building your lineups</p><span className="pill pill--warn">{job.status === "running" ? "Running" : "Starting"}</span></div>
      <p className="small muted">Asked for {ago(job.created_at)}. Builds take {BUILD_TIME}; this page updates by itself.</p>
    </div>
  );
}

/** Entered lineups with a player who has since been ruled out: the one thing on this screen that can't wait. */
function ScratchAlert({ slate, sets }: { slate: Slate; sets: LineupSet[] }) {
  const sc = useScratches(slate, sets);
  if (!sc || sc.hit === 0) return null;
  return (
    <div className="card card--pad" role="alert">
      <p className="strong bad">{sc.hit === 1 ? "One entered lineup has" : `${sc.hit} entered lineups have`} a player who is ruled out</p>
      <p className="small">{sc.names.join(", ")}</p>
      <Link className="btn btn--sm btn--primary" to="/lineups/swap">Swap them out</Link>
    </div>
  );
}

export function Lineups() {
  const { slate, isLoading } = useCurrentSlate();
  const sets = useSets(slate?.id);
  const jobs = useJobs();
  const [building, openBuild, closeBuild] = useSheet("build");
  const [showArchived, setShowArchived] = useState(false);
  useTitle("Lineups");
  if (isLoading || sets.isLoading) return <Loading />;
  if (sets.error) return <ErrorNote error={sets.error} />;
  if (!slate) return <Empty title="No DraftKings games loaded" why="Lineups are built from this week's salaries." how={<Link className="accent" to="/more/settings">Add a salary file</Link>} />;

  const all = sets.data ?? [];
  const { auto, mine, archived } = visibleSets(all);
  const requests = buildCards(jobs.data ?? [], all);
  const single = isShowdown(slate);

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">DraftKings · {single ? `${dayName(slate.starts_at) || "Upcoming"} · one game, captain format` : slateTitle(slate.starts_at, slate.n_games)}</p>
        <h1 className="title">Lineups</h1>
        <GamesPicker />
        {slate.upcoming ? (
          <div className="inline">
            <button className="btn btn--primary" onClick={() => openBuild()}>Build a set</button>
            {!single && <Link className="btn" to="/lineups/build">Build one by hand</Link>}
          </div>
        ) : (
          <p className="small muted" role="status">These games have started. Their lineups are kept here with what they scored; nothing new can be built for them.</p>
        )}
      </div>
      {single && slate.upcoming && <p className="small muted">Six players from one game. The captain costs 1.5 times his salary and scores 1.5 times his points. Building by hand, swaps and the entries file aren't available for this format yet.</p>}
      {!single && <ScratchAlert slate={slate} sets={all} />}
      {slate.upcoming && requests.map((c) => <RequestCard key={c.job.id} card={c} />)}
      <section className="stack stack--tight" aria-label="Automatic sets">
        <p className="eyebrow">Rebuilt whenever the numbers change</p>
        {auto.length === 0 ? (slate.upcoming
          ? <Empty title="No lineups yet" why="They're built right after expected points are ready for these games." how="Check back in a few minutes, or build a set yourself." />
          : <Empty title="No lineups were kept for these games" />) : auto.map((s) => <SetCard key={s.id} s={s} />)}
      </section>
      {mine.length > 0 && (
        <section className="stack stack--tight" aria-label="Your sets">
          <p className="eyebrow">Yours</p>
          {mine.map((s) => <SetCard key={s.id} s={s} />)}
        </section>
      )}
      {!single && <Entries slate={slate} sets={[...mine, ...auto]} />}
      {archived.length > 0 && (
        <section className="stack stack--tight" aria-label="Archived sets">
          <button className="btn btn--quiet btn--sm" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </button>
          {showArchived && archived.map((s) => <SetCard key={s.id} s={s} />)}
        </section>
      )}
      {building && <BuildSheet slateId={slate.id} single={single} onClose={closeBuild} />}
    </div>
  );
}

function BuildSheet({ slateId, single, onClose }: { slateId: number; single: boolean; onClose: () => void }) {
  const pool = usePool(slateId);
  const request = useRequestJob();
  const { marks, clearMarks, say } = useStore();
  const [mode, setMode] = useState<"gpp" | "cash">("gpp");
  const [n, setN] = useState(single ? 10 : 20);
  const [share, setShare] = useState(single ? 0.6 : 0.5);
  const [unique, setUnique] = useState(single ? 2 : 3);
  const [captains, setCaptains] = useState<string[]>([]);
  const [stack, setStack] = useState(1);
  const [bringBack, setBringBack] = useState(0);
  const [perTeam, setPerTeam] = useState(DEFAULT_PER_TEAM);
  const [minSpend, setMinSpend] = useState(DEFAULT_MIN_SPEND.gpp);
  const [more, setMore] = useState(false);
  const [name, setName] = useState("");
  const names = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p.name])), [pool.data]);
  // the players most likely to be worth the captain's 1.5x: the top of the pool by expected points
  const captainChoices = useMemo(() => onePerPlayer(pool.data ?? []).filter((p) => p.dk_mean != null).sort((a, b) => (b.dk_mean ?? 0) - (a.dk_mean ?? 0)).slice(0, 8), [pool.data]);
  const live = Object.entries(marks).filter(([id]) => names.has(id));
  const lock = live.filter(([, m]) => m === "lock").map(([id]) => id);
  const exclude = live.filter(([, m]) => m === "exclude").map(([id]) => id);

  function submit() {
    const label = name.trim();
    const payload = single
      ? { slate_id: slateId, mode, n, max_exposure: share, min_unique: unique, lock, exclude, ...(captains.length ? { captain: captains } : {}), ...(label ? { label } : {}) }
      : { slate_id: slateId, mode, n, max_exposure: share, min_unique: unique, qb_stack: stack, bring_back: bringBack, max_per_team: perTeam, min_salary: minSpend, lock, exclude,
        ...(label ? { label } : {}) };
    request.mutate({ kind: "build_lineups", payload }, {
      onSuccess: () => { say(`Build started — ready in ${BUILD_TIME}`); onClose(); },
      onError: (e) => say(`Couldn't start the build — ${e.message}`, true),
    });
  }
  return (
    <Sheet title="Build a set of lineups" onClose={onClose}>
      <div className="stack stack--tight">
        <div className="chips" role="group" aria-label="Contest type">
          <button className="chip" aria-pressed={mode === "gpp"} onClick={() => { setMode("gpp"); setN(single ? 10 : 20); setShare(single ? 0.6 : 0.5); setStack(1); setMinSpend(DEFAULT_MIN_SPEND.gpp); }}>Tournaments</button>
          <button className="chip" aria-pressed={mode === "cash"} onClick={() => { setMode("cash"); setN(3); setShare(single ? 1 : 0.67); setStack(0); setBringBack(0); setMinSpend(DEFAULT_MIN_SPEND.cash); }}>Cash games</button>
        </div>
        <p className="small muted">{mode === "gpp" ? (single ? "Tournaments pay the top few, so each lineup is built for a different way the game could go, with a different captain or supporting cast."
          : "Tournaments pay the top few, so lineups chase a big score: quarterback paired with his receiver, each lineup built for a different way Sunday could go.") : "50/50s and head-to-heads pay about half the field, so lineups take the highest expected points."}</p>
        <label className="field"><span>Name</span>
          <input className="input" type="text" maxLength={60} placeholder="Optional — to tell this set from the others" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Stepper label="Lineups" value={n} onChange={setN} min={1} max={150} step={n >= 20 ? 10 : 1} />
        <Stepper label="Most lineups any one player can be in" value={share} onChange={setShare} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
        <Stepper label={single ? "Spots that must differ between any two lineups" : "Players that must differ between any two lineups"} value={unique} onChange={setUnique} min={1} max={single ? 4 : 6} />
        {single && (
          <>
            <p className="eyebrow">Captain</p>
            <div className="chips chips--wrap" role="group" aria-label="Who may be captain">
              {captainChoices.map((p) => (
                <button key={p.dk_id} className="chip" aria-pressed={captains.includes(p.dk_id)}
                  onClick={() => setCaptains(captains.includes(p.dk_id) ? captains.filter((x) => x !== p.dk_id) : [...captains, p.dk_id])}>{p.name}</button>
              ))}
            </div>
            <p className="small muted">{captains.length === 0 ? "Anyone can be captain. Tap names to allow only those." : `Only ${captains.length === 1 ? "this player" : "these players"} as captain.`} The same six with a different captain counts as a different lineup.</p>
          </>
        )}
        {!single && <>
        <Stepper label="Receivers paired with the quarterback" value={stack} onChange={setStack} min={0} max={3} format={(v) => (v === 0 ? "None" : String(v))} />
        <Stepper label="Players from the other team in that game" value={bringBack} onChange={(v) => { setBringBack(v); if (v > 0 && stack === 0) setStack(1); }} min={0} max={2} format={(v) => (v === 0 ? "None" : String(v))} />
        <button className="btn btn--quiet btn--sm" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "Fewer options" : "More options"}</button>
        {more && (
          <>
            <Stepper label="Most players from one team (not counting its defense)" value={perTeam} onChange={setPerTeam} min={2} max={8} />
            <Stepper label="Spend at least" value={minSpend} onChange={setMinSpend} min={45000} max={50000} step={100} format={usd} />
            <p className="small muted">A higher floor keeps lineups from leaving budget unused; too high and few lineups fit. A player is never put against your own defense.</p>
          </>
        )}
        </>}
        {live.length === 0 ? (
          <p className="small muted">Nobody is locked in or left out. Mark players on the Players tab to change that.</p>
        ) : (
          <div className="card card--pad">
            <p className="strong">{lock.length} in every lineup · {exclude.length} left out</p>
            <p className="small muted">{[...lock, ...exclude].map((id) => names.get(id)).join(", ")}</p>
            <button className="btn btn--sm btn--quiet" onClick={clearMarks}>Clear marks</button>
          </div>
        )}
        <button className="btn btn--cta" disabled={request.isPending} onClick={submit}>{request.isPending ? "Starting…" : `Build ${n} ${n === 1 ? "lineup" : "lineups"}`}</button>
      </div>
    </Sheet>
  );
}
