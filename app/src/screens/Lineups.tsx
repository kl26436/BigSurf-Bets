import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Entries } from "../components/Entries";
import { GamesPicker } from "../components/GamesPicker";
import { Empty, ErrorNote, Loading, Sheet, Stepper } from "../components/ui";
import { useDismissJob, useJobs, usePool, useRequestJob, useSets, useSetsDetail } from "../lib/api";
import { ago, pts, slateTitle } from "../lib/format";
import { buildCards, describeSettings, visibleSets, type BuildCard } from "../lib/lineup";
import { useSheet, useTitle } from "../lib/nav";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import { isOut } from "../lib/swap";
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
      <p className="small">{s.n_lineups} {s.n_lineups === 1 ? "lineup" : "lineups"}{sm.avg_proj ? ` · ${pts(sm.avg_proj)} expected on average` : ""}{sm.players_used ? ` · ${sm.players_used} players` : ""}</p>
      {built.length > 0 && <p className="small muted">{built.join(" · ")}</p>}
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
  const entered = sets.filter((s) => s.entered && !s.archived_at);
  const many = useSetsDetail(entered.map((s) => s.id));
  const pool = usePool(slate.id);
  if (!slate.upcoming || entered.length === 0 || !many.data || !pool.data?.length) return null;
  const byId = new Map(pool.data.map((p) => [p.dk_id, p]));
  const played = new Set(many.data.lineups.filter((l) => l.entered).map((l) => `${l.set_id}:${l.lineup_no}`));
  const out = many.data.players.filter((p) => played.has(`${p.set_id}:${p.lineup_no}`) && isOut(byId.get(p.dk_id)));
  if (out.length === 0) return null;
  const hit = new Set(out.map((p) => `${p.set_id}:${p.lineup_no}`)).size;
  return (
    <div className="card card--pad" role="alert">
      <p className="strong bad">{hit === 1 ? "One entered lineup has" : `${hit} entered lineups have`} a player who is ruled out</p>
      <p className="small">{[...new Set(out.map((p) => p.name))].join(", ")}</p>
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

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">DraftKings · {slateTitle(slate.starts_at, slate.n_games)}</p>
        <h1 className="title">Lineups</h1>
        <GamesPicker />
        {slate.upcoming ? (
          <div className="inline">
            <button className="btn btn--primary" onClick={() => openBuild()}>Build a set</button>
            <Link className="btn" to="/lineups/build">Build one by hand</Link>
          </div>
        ) : (
          <p className="small muted" role="status">These games have started. Their lineups are kept here with what they scored; nothing new can be built for them.</p>
        )}
      </div>
      <ScratchAlert slate={slate} sets={all} />
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
      <Entries slate={slate} sets={[...mine, ...auto]} />
      {archived.length > 0 && (
        <section className="stack stack--tight" aria-label="Archived sets">
          <button className="btn btn--quiet btn--sm" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
          </button>
          {showArchived && archived.map((s) => <SetCard key={s.id} s={s} />)}
        </section>
      )}
      {building && <BuildSheet slateId={slate.id} onClose={closeBuild} />}
    </div>
  );
}

function BuildSheet({ slateId, onClose }: { slateId: number; onClose: () => void }) {
  const pool = usePool(slateId);
  const request = useRequestJob();
  const { marks, clearMarks, say } = useStore();
  const [mode, setMode] = useState<"gpp" | "cash">("gpp");
  const [n, setN] = useState(20);
  const [share, setShare] = useState(0.5);
  const [unique, setUnique] = useState(3);
  const [stack, setStack] = useState(true);
  const [bringBack, setBringBack] = useState(false);
  const [name, setName] = useState("");
  const names = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p.name])), [pool.data]);
  const live = Object.entries(marks).filter(([id]) => names.has(id));
  const lock = live.filter(([, m]) => m === "lock").map(([id]) => id);
  const exclude = live.filter(([, m]) => m === "exclude").map(([id]) => id);

  function submit() {
    const label = name.trim();
    const payload = { slate_id: slateId, mode, n, max_exposure: share, min_unique: unique, qb_stack: stack ? 1 : 0, bring_back: bringBack ? 1 : 0, lock, exclude,
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
          <button className="chip" aria-pressed={mode === "gpp"} onClick={() => { setMode("gpp"); setN(20); setShare(0.5); setStack(true); }}>Tournaments</button>
          <button className="chip" aria-pressed={mode === "cash"} onClick={() => { setMode("cash"); setN(3); setShare(0.67); setStack(false); }}>Cash games</button>
        </div>
        <p className="small muted">{mode === "gpp" ? "Tournaments pay the top few, so lineups chase a big score: quarterback paired with his receiver, each lineup built for a different way Sunday could go." : "50/50s and head-to-heads pay about half the field, so lineups take the highest expected points."}</p>
        <label className="field"><span>Name</span>
          <input className="input" type="text" maxLength={60} placeholder="Optional — to tell this set from the others" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Stepper label="Lineups" value={n} onChange={setN} min={1} max={150} step={n >= 20 ? 10 : 1} />
        <Stepper label="Most lineups any one player can be in" value={share} onChange={setShare} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
        <Stepper label="Players that must differ between any two lineups" value={unique} onChange={setUnique} min={1} max={6} />
        <label className="check"><input type="checkbox" checked={stack} onChange={(e) => setStack(e.target.checked)} />Pair the quarterback with one of his receivers</label>
        <label className="check"><input type="checkbox" checked={bringBack} onChange={(e) => setBringBack(e.target.checked)} />Add a player from the other team in that game</label>
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
