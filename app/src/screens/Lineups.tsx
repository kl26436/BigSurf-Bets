import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, PosTag, Sheet, StatusPill, Stepper } from "../components/ui";
import { useJobs, usePool, useRequestJob, useSet, useSetEntered, useSets } from "../lib/api";
import { ago, pct, pts, slateTitle, usd } from "../lib/format";
import { SLOT_LABEL, exposure, toDkCsv, type Slot } from "../lib/lineup";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import type { LineupSet } from "../lib/types";
import { download } from "./Builder";
import { JOB_STATE } from "./Week";

export const MODE: Record<string, string> = { gpp: "Tournament set", cash: "Cash-game set", manual: "Built by hand" };
const SOURCE: Record<string, string> = { auto: "Automatic", user: "Your build", manual: "By hand" };

function SetCard({ s }: { s: LineupSet }) {
  const sm = (s.summary ?? {}) as Record<string, number>;
  return (
    <Link className="card card--pad" to={`/lineups/${s.id}`}>
      <div className="card__head">
        <h2 className="h2">{s.label || MODE[s.mode] || s.mode}</h2>
        <span className="small muted">{ago(s.created_at)}</span>
      </div>
      <p className="small">{s.n_lineups} {s.n_lineups === 1 ? "lineup" : "lineups"}{sm.avg_proj ? ` · ${pts(sm.avg_proj)} expected on average` : ""}{sm.players_used ? ` · ${sm.players_used} players` : ""}</p>
      <div className="inline">
        <span className="pill">{SOURCE[s.source] ?? s.source}</span>
        {s.entered && <span className="pill pill--ok">Entered</span>}
        <span className={`pill ${s.on_latest_projections ? "pill--accent" : "pill--warn"}`}>{s.on_latest_projections ? "Uses the latest numbers" : "Built on older numbers"}</span>
      </div>
    </Link>
  );
}

export function Lineups() {
  const { slate, isLoading } = useCurrentSlate();
  const sets = useSets(slate?.id);
  const jobs = useJobs();
  const [building, setBuilding] = useState(false);
  if (isLoading || sets.isLoading) return <Loading />;
  if (sets.error) return <ErrorNote error={sets.error} />;
  if (!slate) return <Empty title="No DraftKings games loaded" why="Lineups are built from this week's salaries." how={<Link className="accent" to="/more/settings">Add a salary file</Link>} />;

  const all = sets.data ?? [];
  // newest automatic set per kind, then everything the user asked for or built
  const auto = ["gpp", "cash"].map((m) => all.find((s) => s.source === "auto" && s.mode === m)).filter((s): s is LineupSet => !!s);
  const mine = all.filter((s) => s.source !== "auto");
  const pending = (jobs.data ?? []).filter((j) => j.kind === "build_lineups" && j.status !== "done").slice(0, 3);

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">DraftKings · {slateTitle(slate.starts_at, slate.n_games)}</p>
        <h1 className="title">Lineups</h1>
        <div className="inline">
          <button className="btn btn--primary" onClick={() => setBuilding(true)}>Build a set</button>
          <Link className="btn" to="/lineups/build">Build one by hand</Link>
        </div>
      </div>
      {pending.map((j) => (
        <div className="card card--pad" key={j.id} role="status">
          <div className="spread"><p className="strong">Lineup build requested {ago(j.created_at)}</p><span className={`pill ${JOB_STATE[j.status].tone}`}>{JOB_STATE[j.status].label}</span></div>
          <p className="small muted">{j.error ?? "Builds usually finish in about three minutes. This page updates by itself."}</p>
        </div>
      ))}
      <section className="stack stack--tight" aria-label="Automatic sets">
        <p className="eyebrow">Rebuilt whenever the numbers change</p>
        {auto.length === 0 ? <Empty title="No lineups yet" why="They're built right after expected points are ready for these games." how="Check back in a few minutes, or build a set yourself." /> : auto.map((s) => <SetCard key={s.id} s={s} />)}
      </section>
      {mine.length > 0 && (
        <section className="stack stack--tight" aria-label="Your sets">
          <p className="eyebrow">Yours</p>
          {mine.map((s) => <SetCard key={s.id} s={s} />)}
        </section>
      )}
      {building && <BuildSheet slateId={slate.id} onClose={() => setBuilding(false)} />}
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
  const names = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p.name])), [pool.data]);
  const live = Object.entries(marks).filter(([id]) => names.has(id));
  const lock = live.filter(([, m]) => m === "lock").map(([id]) => id);
  const exclude = live.filter(([, m]) => m === "exclude").map(([id]) => id);

  function submit() {
    const payload = { slate_id: slateId, mode, n, max_exposure: share, min_unique: unique, qb_stack: stack ? 1 : 0, bring_back: bringBack ? 1 : 0, lock, exclude };
    request.mutate({ kind: "build_lineups", payload }, {
      onSuccess: () => { say("Build started — ready in about three minutes"); onClose(); },
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
        <Stepper label="Lineups" value={n} onChange={setN} min={1} max={150} step={n >= 20 ? 10 : 1} />
        <Stepper label="Most lineups any one player can be in" value={share} onChange={setShare} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
        <Stepper label="Players that must differ between any two lineups" value={unique} onChange={setUnique} min={1} max={6} />
        <label className="check"><input type="checkbox" checked={stack} onChange={(e) => setStack(e.target.checked)} />Pair the quarterback with one of his receivers</label>
        <label className="check"><input type="checkbox" checked={bringBack} onChange={(e) => setBringBack(e.target.checked)} />Add a player from the other team in that game</label>
        <div className="card card--pad">
          <p className="strong">{lock.length} in every lineup · {exclude.length} left out</p>
          <p className="small muted">{live.length === 0 ? "Mark players on the Players tab to lock them in or leave them out." : [...lock, ...exclude].map((id) => names.get(id)).join(", ")}</p>
          {live.length > 0 && <button className="btn btn--sm btn--quiet" onClick={clearMarks}>Clear marks</button>}
        </div>
        <button className="btn btn--cta" disabled={request.isPending} onClick={submit}>{request.isPending ? "Starting…" : `Build ${n} ${n === 1 ? "lineup" : "lineups"}`}</button>
      </div>
    </Sheet>
  );
}

export function SetDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { slate } = useCurrentSlate();
  const sets = useSets(slate?.id);
  const detail = useSet(Number.isFinite(id) ? id : undefined);
  const entered = useSetEntered();
  const { say } = useStore();
  const [open, setOpen] = useState<number | null>(1);
  const set = sets.data?.find((s) => s.id === id);
  const players = detail.data?.players ?? [];
  const shares = useMemo(() => [...exposure(players).values()].sort((a, b) => b.count - a.count || (b.row.dk_mean ?? 0) - (a.row.dk_mean ?? 0)), [players]);

  if (detail.isLoading || sets.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const lineups = detail.data?.lineups ?? [];
  if (lineups.length === 0) return <Empty title="This set is empty" how={<button className="btn btn--quiet" onClick={() => nav("/lineups")}>Back to lineups</button>} />;
  const file = () => download(`bigsurf-${set?.mode ?? "set"}-${id}.csv`,
    toDkCsv(lineups.map((l) => players.filter((p) => p.lineup_no === l.lineup_no).sort((a, b) => a.slot_no - b.slot_no).map((p) => p.dk_id))));
  const graded = lineups.some((l) => l.actual_points != null);

  return (
    <div className="stack">
      <div>
        <p className="eyebrow"><Link to="/lineups">Lineups</Link> · {set ? ago(set.created_at) : ""}</p>
        <h1 className="title">{set?.label || MODE[set?.mode ?? ""] || "Lineup set"}</h1>
        {set && !set.on_latest_projections && set.source !== "manual" && (
          <p className="small warn" role="status">Built on older numbers. Expected points have changed since — rebuild before entering.</p>
        )}
        <div className="inline">
          <button className="btn btn--primary" onClick={file}>Download for DraftKings</button>
          {set && (
            <button className="btn" disabled={entered.isPending} onClick={() => entered.mutate({ set_id: id, entered: !set.entered }, { onSuccess: () => say(set.entered ? "Marked as not entered" : "Marked as entered") })}>
              {set.entered ? "Entered — undo" : "Mark as entered"}
            </button>
          )}
        </div>
        <p className="small muted">Upload the file on DraftKings: Lineups → Upload lineups. Nothing is entered for you.</p>
      </div>
      <div className="cols cols--wide">
        <section className="card" aria-label="Lineups">
          {lineups.map((l) => {
            const mine = players.filter((p) => p.lineup_no === l.lineup_no);
            return (
              <div key={l.lineup_no} className="rowline">
                <div className="grow">
                  <button className="spread" onClick={() => setOpen(open === l.lineup_no ? null : l.lineup_no)} aria-expanded={open === l.lineup_no}>
                    <span className="strong">Lineup {l.lineup_no}</span>
                    <span className="num small">{usd(l.salary)} · <span className="accent strong">{pts(l.proj)}</span>{l.p10 != null ? ` · ${pts(l.p10, 0)}–${pts(l.p90, 0)}` : ""}{graded ? ` · scored ${pts(l.actual_points)}` : ""}</span>
                  </button>
                  {open === l.lineup_no && mine.map((p) => (
                    <div className="prow" key={p.slot_no}>
                      <span className="tag">{SLOT_LABEL[p.slot as Slot] ?? p.slot}</span>
                      <div className="grow"><p className="pname ellipsis">{p.name} <StatusPill status={p.status} /></p><p className="pmeta">{p.team} vs {p.opponent}</p></div>
                      <p className="pnum num">{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
        <section className="card card--pad" aria-label="How often each player is used">
          <div className="card__head"><h2 className="h2">Who you're relying on</h2><span className="small muted">Share of lineups</span></div>
          {shares.slice(0, 30).map((e) => (
            <div className="prow" key={e.row.dk_id}>
              <PosTag pos={e.row.pos} />
              <div className="grow"><p className="pname ellipsis">{e.row.name}</p><p className="pmeta">{e.row.team} · {usd(e.row.salary)}</p></div>
              <p className="pnum num">{pct(e.share)}<small>{e.count} of {lineups.length}</small></p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
