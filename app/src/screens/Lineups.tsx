import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, PlayerName, PosTag, Sheet, Stepper } from "../components/ui";
import {
  useArchiveSet, useDeleteLineup, useDeleteSet, useDismissJob, useJobs, usePool, useRenameSet, useRequestJob, useSet, useSetEntered, useSets,
} from "../lib/api";
import { ago, pct, pts, slateTitle, usd } from "../lib/format";
import { SLOT_LABEL, buildCards, describeSettings, exposure, rebuildPayload, toDkCsv, visibleSets, type BuildCard, type Slot } from "../lib/lineup";
import { useGoUp, useSheet, useTitle } from "../lib/nav";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import type { LineupSet } from "../lib/types";
import { download } from "./Builder";

export const MODE: Record<string, string> = { gpp: "Tournament set", cash: "Cash-game set", manual: "Built by hand" };
const SOURCE: Record<string, string> = { auto: "Automatic", user: "Your build", manual: "By hand" };
/** What a set is called: the name it was given, else its kind. */
export const setName = (s: Pick<LineupSet, "label" | "mode"> | null | undefined) => s?.label || MODE[s?.mode ?? ""] || "Lineup set";
/** How long a build takes, measured on real requests (GitHub start plus the build itself). */
const BUILD_TIME = "about a minute";

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
        <div className="inline">
          <button className="btn btn--primary" onClick={() => openBuild()}>Build a set</button>
          <Link className="btn" to="/lineups/build">Build one by hand</Link>
        </div>
      </div>
      {requests.map((c) => <RequestCard key={c.job.id} card={c} />)}
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

type SetSheet = { kind: "rename" } | { kind: "delete" } | { kind: "remove"; lineup: number };

export function SetDetail() {
  const id = Number(useParams().id);
  const goUp = useGoUp();
  const detail = useSet(Number.isFinite(id) ? id : undefined);
  const entered = useSetEntered();
  const rename = useRenameSet();
  const archive = useArchiveSet();
  const del = useDeleteSet();
  const delLineup = useDeleteLineup();
  const request = useRequestJob();
  const { say } = useStore();
  const [picked, setPicked] = useState<number | null | undefined>(undefined);   // undefined: the first lineup, until one is chosen
  const [sheet, openSheet, closeSheet] = useSheet<SetSheet>("set");
  const [draftName, setDraftName] = useState("");
  const set = detail.data?.set ?? null;
  const players = detail.data?.players ?? [];
  const shares = useMemo(() => [...exposure(players).values()].sort((a, b) => b.count - a.count || (b.row.dk_mean ?? 0) - (a.row.dk_mean ?? 0)), [players]);
  useTitle(setName(set));

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const lineups = detail.data?.lineups ?? [];
  if (!set || lineups.length === 0) return <Empty title="This set is gone" why="It was deleted, or it never had a lineup." how={<button className="btn btn--quiet" onClick={() => goUp("/lineups")}>Back to Lineups</button>} />;

  const open = picked === undefined ? lineups[0].lineup_no : picked;
  const file = () => download(`bigsurf-${(set.label || set.mode).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "set"}-${id}.csv`,
    toDkCsv(lineups.map((l) => players.filter((p) => p.lineup_no === l.lineup_no).sort((a, b) => a.slot_no - b.slot_no).map((p) => p.dk_id))));
  const graded = lineups.some((l) => l.actual_points != null);
  const built = describeSettings(set);
  const stale = !set.on_latest_projections && set.source !== "manual";
  // Automatic sets belong to the pipeline: it replaces them whenever the numbers change. Entering one makes it yours.
  const yours = set.source !== "auto" || set.entered;
  const failed = (what: string) => (e: Error) => say(`${what} — ${e.message}`, true);

  function rebuild() {
    request.mutate({ kind: "build_lineups", payload: rebuildPayload(set!) }, {
      onSuccess: () => { say(`Build started — ready in ${BUILD_TIME}`); goUp("/lineups"); },
      onError: failed("Couldn't start the build"),
    });
  }
  function saveName() {
    rename.mutate({ set_id: id, label: draftName.trim() || null }, {
      onSuccess: () => { say(draftName.trim() ? "Renamed" : "Name cleared"); closeSheet(); },
      onError: failed("Couldn't rename it"),
    });
  }
  function setArchived(archived: boolean, leave: boolean) {
    archive.mutate({ set_id: id, archived }, {
      onSuccess: () => { say(archived ? "Archived — it's kept for results" : "Back on the Lineups screen"); if (leave) goUp("/lineups"); },
      onError: failed(archived ? "Couldn't archive it" : "Couldn't restore it"),
    });
  }
  function deleteSet() {
    del.mutate({ set_id: id }, { onSuccess: () => { say("Set deleted"); goUp("/lineups"); }, onError: failed("Couldn't delete it") });
  }
  function removeLineup(lineupNo: number) {
    delLineup.mutate({ set_id: id, lineup_no: lineupNo }, {
      onSuccess: (left) => {
        say(`Lineup ${lineupNo} removed`);
        setPicked(undefined);
        if (left === 0) goUp("/lineups"); else closeSheet();
      },
      onError: failed("Couldn't remove it"),
    });
  }

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">{SOURCE[set.source] ?? set.source} · built {ago(set.created_at)}</p>
        <h1 className="title">{setName(set)}</h1>
        {built.length > 0 && <p className="small muted">{built.join(" · ")}</p>}
        {set.archived_at && (
          <div className="inline" role="status">
            <p className="small">Archived: hidden from Lineups, kept for results.</p>
            <button className="btn btn--sm" disabled={archive.isPending} onClick={() => setArchived(false, false)}>Put it back</button>
          </div>
        )}
        {stale && (
          <div className="inline" role="status">
            <p className="small warn">Built on older numbers. Expected points have changed since{set.source === "auto" ? "; a fresh automatic set follows within minutes." : "."}</p>
            {set.source === "user" && <button className="btn btn--sm" disabled={request.isPending} onClick={rebuild}>{request.isPending ? "Starting…" : "Rebuild with the same settings"}</button>}
          </div>
        )}
        <div className="inline">
          <button className="btn btn--primary" onClick={file}>Download for DraftKings</button>
          <button className="btn" disabled={entered.isPending} onClick={() => entered.mutate({ set_id: id, entered: !set.entered }, { onSuccess: () => say(set.entered ? "Marked as not entered" : "Marked as entered"), onError: failed("Couldn't save that") })}>
            {set.entered ? "Entered — undo" : "Mark as entered"}
          </button>
        </div>
        <p className="small muted">Upload the file on DraftKings: Lineups → Upload lineups. Nothing is entered for you.</p>
        {yours ? (
          <div className="inline" role="group" aria-label="Manage this set">
            <button className="btn btn--sm btn--quiet" onClick={() => { setDraftName(set.label ?? ""); openSheet({ kind: "rename" }); }}>Rename</button>
            {!set.archived_at && <button className="btn btn--sm btn--quiet" disabled={archive.isPending} onClick={() => setArchived(true, true)}>Archive</button>}
            <button className="btn btn--sm btn--quiet bad" onClick={() => openSheet({ kind: "delete" })}>Delete</button>
          </div>
        ) : (
          <p className="small muted">Automatic sets are replaced when the numbers change. Mark this one as entered to keep it.</p>
        )}
      </div>
      <div className="cols cols--wide">
        <section className="card" aria-label="Lineups">
          {lineups.map((l) => {
            const mine = players.filter((p) => p.lineup_no === l.lineup_no);
            return (
              <div key={l.lineup_no} className="rowline">
                <div className="grow">
                  <button className="spread" onClick={() => setPicked(open === l.lineup_no ? null : l.lineup_no)} aria-expanded={open === l.lineup_no}>
                    <span className="strong">Lineup {l.lineup_no}</span>
                    <span className="num small">{usd(l.salary)} · <span className="accent strong">{pts(l.proj)}</span>{l.p10 != null ? ` · ${pts(l.p10, 0)}–${pts(l.p90, 0)}` : ""}{graded ? ` · scored ${pts(l.actual_points)}` : ""}</span>
                  </button>
                  {open === l.lineup_no && mine.map((p) => (
                    <div className="prow" key={p.slot_no}>
                      <span className="tag">{SLOT_LABEL[p.slot as Slot] ?? p.slot}</span>
                      <div className="grow"><PlayerName name={p.name} status={p.status} /><p className="pmeta">{p.team} vs {p.opponent}</p></div>
                      <p className="pnum num">{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                    </div>
                  ))}
                  {open === l.lineup_no && yours && !set.entered && (
                    <button className="btn btn--sm btn--quiet bad" onClick={() => openSheet({ kind: "remove", lineup: l.lineup_no })}>Remove this lineup</button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
        <section className="card card--pad" aria-label="How often each player is used">
          <div className="card__head"><h2 className="h2">Who you're relying on</h2><span className="small muted">Share of lineups</span></div>
          {shares.map((e) => (
            <div className="prow" key={e.row.dk_id}>
              <PosTag pos={e.row.pos} />
              <div className="grow"><PlayerName name={e.row.name} status={e.row.status} /><p className="pmeta">{e.row.team} · {usd(e.row.salary)}</p></div>
              <p className="pnum num">{pct(e.share)}<small>{e.count} of {lineups.length}</small></p>
            </div>
          ))}
        </section>
      </div>

      {sheet?.kind === "rename" && (
        <Sheet title="Name this set" onClose={closeSheet}>
          <form className="stack stack--tight" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
            <label className="field"><span>Name</span>
              <input className="input" type="text" maxLength={60} autoFocus placeholder={MODE[set.mode] ?? "Lineup set"} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            </label>
            <p className="small muted">Leave it empty to go back to "{MODE[set.mode] ?? "Lineup set"}".</p>
            <button className="btn btn--cta" type="submit" disabled={rename.isPending}>{rename.isPending ? "Saving…" : "Save name"}</button>
          </form>
        </Sheet>
      )}
      {sheet?.kind === "delete" && (
        <Sheet title={set.entered ? "This set was entered" : `Delete ${lineups.length === 1 ? "this lineup" : `these ${lineups.length} lineups`}?`} onClose={closeSheet}>
          <div className="stack stack--tight">
            {set.entered ? (
              <>
                <p>It is the record of what you played, so it can't be deleted. Archiving takes it off the Lineups screen and keeps it for results.</p>
                <p className="small muted">To delete it anyway, undo "Entered" first.</p>
                {!set.archived_at && <button className="btn btn--cta" disabled={archive.isPending} onClick={() => setArchived(true, true)}>Archive it</button>}
              </>
            ) : (
              <>
                <p>"{setName(set)}" will be removed for good. It can't be brought back.</p>
                <button className="btn btn--cta btn--cta-danger" disabled={del.isPending} onClick={deleteSet}>{del.isPending ? "Deleting…" : "Delete"}</button>
                {!set.archived_at && <button className="btn" disabled={archive.isPending} onClick={() => setArchived(true, true)}>Archive instead</button>}
              </>
            )}
            <button className="btn btn--quiet" onClick={closeSheet}>Keep it</button>
          </div>
        </Sheet>
      )}
      {sheet?.kind === "remove" && (
        <Sheet title={`Remove lineup ${sheet.lineup}?`} onClose={closeSheet}>
          <div className="stack stack--tight">
            <p>{lineups.length === 1 ? "It is the only lineup here, so the set goes with it." : `The other ${lineups.length - 1} stay.`} It can't be brought back.</p>
            <button className="btn btn--cta btn--cta-danger" disabled={delLineup.isPending} onClick={() => removeLineup(sheet.lineup)}>{delLineup.isPending ? "Removing…" : "Remove"}</button>
            <button className="btn btn--quiet" onClick={closeSheet}>Keep it</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
