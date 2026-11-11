import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, PlayerName, PosTag, Sheet } from "../components/ui";
import {
  useArchiveSet, useDeleteLineup, useDeleteSet, usePool, useRenameSet, useRequestJob, useSet, useSetEntered, useSetLineupsEntered, useSets,
} from "../lib/api";
import { ago, pct, pts, usd } from "../lib/format";
import { SLOT_LABEL, describeSettings, exposure, rebuildPayload, toDkCsv, type Slot } from "../lib/lineup";
import { useGoUp, useSheet, useTitle, useWide } from "../lib/nav";
import { useStore } from "../lib/store";
import { isOut, stackOf } from "../lib/swap";
import type { LineupPlayer, LineupRow } from "../lib/types";
import { download } from "./Builder";
import { BUILD_TIME, MODE, SOURCE, setName } from "./Lineups";

type SetSheet = { kind: "rename" } | { kind: "delete" } | { kind: "remove"; lineup: number } | { kind: "compare" };
// The order to read twenty lineups in when choosing the few to enter.
const ORDER = { built: "As built", expected: "Expected", ceiling: "Ceiling", best: "Chance of best" } as const;
type Order = keyof typeof ORDER;
const BY: Record<Order, (l: LineupRow) => number> = {
  built: (l) => -l.lineup_no, expected: (l) => l.proj ?? 0, ceiling: (l) => l.p99 ?? l.p90 ?? 0, best: (l) => l.best_of_set_pct ?? 0,
};

export function SetDetail() {
  const id = Number(useParams().id);
  const goUp = useGoUp();
  const navigate = useNavigate();
  const wide = useWide();
  const detail = useSet(Number.isFinite(id) ? id : undefined);
  const set = detail.data?.set ?? null;
  const pool = usePool(set?.slate_id);
  const others = useSets(set?.slate_id);
  const enterAll = useSetEntered();
  const enterSome = useSetLineupsEntered();
  const rename = useRenameSet();
  const archive = useArchiveSet();
  const del = useDeleteSet();
  const delLineup = useDeleteLineup();
  const request = useRequestJob();
  const { say } = useStore();
  const [order, setOrder] = useState<Order>("built");
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [opened, setOpened] = useState<number | null | undefined>(undefined);   // phone: one lineup open at a time (undefined: the first)
  const [scope, setScope] = useState<"all" | "entered">("all");
  const [sheet, openSheet, closeSheet] = useSheet<SetSheet>("set");
  const [draftName, setDraftName] = useState("");
  const players = detail.data?.players ?? [];
  const lineups = detail.data?.lineups ?? [];
  const byLineup = useMemo(() => {
    const m = new Map<number, LineupPlayer[]>();
    for (const p of players) m.set(p.lineup_no, [...(m.get(p.lineup_no) ?? []), p]);
    for (const v of m.values()) v.sort((a, b) => a.slot_no - b.slot_no);
    return m;
  }, [players]);
  const poolById = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p])), [pool.data]);
  // who is ruled out now (the tag stored with a lineup is from the day it was built)
  const outNow = (p: LineupPlayer) => poolById.size > 0 && isOut(poolById.get(p.dk_id));
  const enteredNos = useMemo(() => new Set(lineups.filter((l) => l.entered).map((l) => l.lineup_no)), [lineups]);
  const inScope = scope === "entered" && enteredNos.size > 0 ? players.filter((p) => enteredNos.has(p.lineup_no)) : players;
  const shares = useMemo(() => [...exposure(inScope).values()].sort((a, b) => b.count - a.count || (b.row.dk_mean ?? 0) - (a.row.dk_mean ?? 0)), [inScope]);
  useTitle(setName(set));

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!set || lineups.length === 0) return <Empty title="This set is gone" why="It was deleted, or it never had a lineup." how={<button className="btn btn--quiet" onClick={() => goUp("/lineups")}>Back to Lineups</button>} />;

  const ordered = [...lineups].sort((a, b) => BY[order](b) - BY[order](a));
  const first = ordered[0].lineup_no;
  const open = opened === undefined ? first : opened;
  const ids = (l: LineupRow) => (byLineup.get(l.lineup_no) ?? []).map((p) => p.dk_id);
  const slug = (set.label || set.mode).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "set";
  const file = (nos?: number[]) => {
    const which = lineups.filter((l) => !nos || nos.includes(l.lineup_no));
    download(`bigsurf-${slug}-${id}${nos ? `-${which.length}of${lineups.length}` : ""}.csv`, toDkCsv(which.map(ids)));
  };
  const graded = lineups.some((l) => l.actual_points != null);
  const built = describeSettings(set);
  const stale = !set.on_latest_projections && set.source !== "manual";
  // Automatic sets belong to the pipeline: it replaces them whenever the numbers change. Entering one makes it yours.
  const yours = set.source !== "auto" || set.entered;
  const hurt = lineups.filter((l) => (enteredNos.size === 0 || l.entered) && (byLineup.get(l.lineup_no) ?? []).some(outNow));
  const allEntered = enteredNos.size === lineups.length;
  const failed = (what: string) => (e: Error) => say(`${what} — ${e.message}`, true);
  const toggle = (no: number) => setChosen((c) => { const n = new Set(c); if (n.has(no)) n.delete(no); else n.add(no); return n; });

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
        setOpened(undefined);
        setChosen((c) => { const n = new Set(c); n.delete(lineupNo); return n; });
        if (left === 0) goUp("/lineups"); else closeSheet();
      },
      onError: failed("Couldn't remove it"),
    });
  }
  function markChosen(entered: boolean) {
    const nos = [...chosen];
    enterSome.mutate({ set_id: id, lineup_nos: nos, entered }, {
      onSuccess: () => { say(`${nos.length} ${nos.length === 1 ? "lineup" : "lineups"} marked as ${entered ? "entered" : "not entered"}`); setChosen(new Set()); },
      onError: failed("Couldn't save that"),
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
          <button className="btn btn--primary" onClick={() => file()}>Download all for DraftKings</button>
          <button className="btn" disabled={enterAll.isPending} onClick={() => enterAll.mutate({ set_id: id, entered: !allEntered }, { onSuccess: () => say(allEntered ? "Marked as not entered" : "All marked as entered"), onError: failed("Couldn't save that") })}>
            {allEntered ? "All entered — undo" : lineups.length === 1 ? "Mark as entered" : "Mark all as entered"}
          </button>
        </div>
        <p className="small muted">Upload the file on DraftKings: Lineups → Upload lineups. Nothing is entered for you. {lineups.length > 1 ? "To enter only some, tick them below." : ""}</p>
        {yours ? (
          <div className="inline" role="group" aria-label="Manage this set">
            <button className="btn btn--sm btn--quiet" onClick={() => { setDraftName(set.label ?? ""); openSheet({ kind: "rename" }); }}>Rename</button>
            <button className="btn btn--sm btn--quiet" onClick={() => openSheet({ kind: "compare" })}>Compare</button>
            {!set.archived_at && <button className="btn btn--sm btn--quiet" disabled={archive.isPending} onClick={() => setArchived(true, true)}>Archive</button>}
            <button className="btn btn--sm btn--quiet bad" onClick={() => openSheet({ kind: "delete" })}>Delete</button>
          </div>
        ) : (
          <div className="inline">
            <button className="btn btn--sm btn--quiet" onClick={() => openSheet({ kind: "compare" })}>Compare</button>
            <p className="small muted">Automatic sets are replaced when the numbers change. Mark a lineup as entered to keep this one.</p>
          </div>
        )}
      </div>

      {hurt.length > 0 && (
        <div className="card card--pad" role="alert">
          <p className="strong bad">{hurt.length === 1 ? "One lineup has" : `${hurt.length} lineups have`} a player who is ruled out</p>
          <p className="small">{[...new Set(hurt.flatMap((l) => (byLineup.get(l.lineup_no) ?? []).filter(outNow).map((p) => p.name)))].join(", ")}. {enteredNos.size > 0 ? "Entered lineups only." : ""}</p>
          <Link className="btn btn--sm btn--primary" to={`/lineups/swap?set=${id}`}>Swap them out</Link>
        </div>
      )}

      <section className="stack stack--tight" aria-label="Lineups">
        <div className="spread">
          <h2 className="h2">{lineups.length} {lineups.length === 1 ? "lineup" : "lineups"}{enteredNos.size > 0 ? ` · ${enteredNos.size} entered` : ""}</h2>
          {lineups.length > 1 && <button className="btn btn--sm btn--quiet" onClick={() => setChosen(chosen.size === lineups.length ? new Set() : new Set(lineups.map((l) => l.lineup_no)))}>{chosen.size === lineups.length ? "Untick all" : "Tick all"}</button>}
        </div>
        {lineups.length > 1 && (
          <div className="chips chips--wrap" role="group" aria-label="Order lineups by">
            {(Object.keys(ORDER) as Order[]).map((k) => <button key={k} className="chip" aria-pressed={order === k} onClick={() => { setOrder(k); setOpened(undefined); }}>{ORDER[k]}</button>)}
          </div>
        )}
        <div className="lgrid">
          {ordered.map((l) => {
            const mine = byLineup.get(l.lineup_no) ?? [];
            const isOpen = wide || open === l.lineup_no;
            return (
              <article key={l.lineup_no} className={`card lcard ${chosen.has(l.lineup_no) ? "lcard--on" : ""}`} aria-label={`Lineup ${l.lineup_no}`}>
                <div className="spread">
                  <label className="check">
                    <input type="checkbox" checked={chosen.has(l.lineup_no)} onChange={() => toggle(l.lineup_no)} aria-label={`Choose lineup ${l.lineup_no}`} />
                    <span className="strong">Lineup {l.lineup_no}</span>
                  </label>
                  <span className="inline">
                    {l.edited_at && <span className="pill">Swapped</span>}
                    {l.entered && <span className="pill pill--ok">Entered</span>}
                    {mine.some(outNow) && <span className="pill pill--bad">Player out</span>}
                  </span>
                </div>
                <button className="lcard__nums" onClick={() => setOpened(open === l.lineup_no ? null : l.lineup_no)} aria-expanded={isOpen} disabled={wide}>
                  <span className="num"><span className="accent strong">{pts(l.proj)}</span> expected · {usd(l.salary)}{graded ? ` · scored ${pts(l.actual_points)}` : ""}</span>
                  {l.p10 != null && (
                    <span className="num small muted">Range {pts(l.p10, 0)}–{pts(l.p90, 0)}{l.p99 != null ? ` · ceiling ${pts(l.p99, 0)}` : ""}{l.best_of_set_pct != null ? ` · best of the set ${pts(l.best_of_set_pct, 1)}% of the time` : ""}</span>
                  )}
                  <span className="small muted">{stackOf(mine)}</span>
                </button>
                {isOpen && mine.map((p) => (
                  <div className="prow prow--tight" key={p.slot_no}>
                    <span className="tag">{SLOT_LABEL[p.slot as Slot] ?? p.slot}</span>
                    <div className="grow"><PlayerName name={p.name} status={outNow(p) ? "OUT" : poolById.get(p.dk_id)?.dk_status ?? p.status} /><p className="pmeta">{p.team} vs {p.opponent}</p></div>
                    <p className="pnum num">{usd(p.salary)}<small>{pts(p.dk_mean)} expected</small></p>
                  </div>
                ))}
                {isOpen && yours && !l.entered && (
                  <button className="btn btn--sm btn--quiet bad" onClick={() => openSheet({ kind: "remove", lineup: l.lineup_no })}>Remove this lineup</button>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card card--pad" aria-label="How often each player is used">
        <div className="card__head"><h2 className="h2">Who you're relying on</h2><span className="small muted">Share of {scope === "entered" && enteredNos.size > 0 ? "entered " : ""}lineups</span></div>
        {enteredNos.size > 0 && !allEntered && (
          <div className="chips" role="group" aria-label="Which lineups">
            <button className="chip" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All {lineups.length}</button>
            <button className="chip" aria-pressed={scope === "entered"} onClick={() => setScope("entered")}>Entered {enteredNos.size}</button>
          </div>
        )}
        <div className="pgrid">
          {shares.map((e) => (
            <div className="prow prow--tight" key={e.row.dk_id}>
              <PosTag pos={e.row.pos} />
              <div className="grow"><PlayerName name={e.row.name} status={outNow(e.row) ? "OUT" : poolById.get(e.row.dk_id)?.dk_status ?? e.row.status} /><p className="pmeta">{e.row.team} · {usd(e.row.salary)}</p></div>
              <p className="pnum num">{pct(e.share)}<small>{e.count} of {scope === "entered" && enteredNos.size > 0 ? enteredNos.size : lineups.length}</small></p>
            </div>
          ))}
        </div>
      </section>

      {chosen.size > 0 && (
        <div className="sticky-cta" role="region" aria-label="Chosen lineups">
          <div className="spread">
            <p className="small strong">{chosen.size} of {lineups.length} ticked</p>
            <button className="btn btn--sm btn--quiet" onClick={() => setChosen(new Set())}>Clear</button>
          </div>
          <div className="inline inline--center">
            <button className="btn btn--primary" onClick={() => file([...chosen])}>Download for DraftKings</button>
            {[...chosen].some((n) => !enteredNos.has(n)) && <button className="btn" disabled={enterSome.isPending} onClick={() => markChosen(true)}>Mark as entered</button>}
            {[...chosen].some((n) => enteredNos.has(n)) && <button className="btn" disabled={enterSome.isPending} onClick={() => markChosen(false)}>Not entered</button>}
          </div>
        </div>
      )}

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
      {sheet?.kind === "compare" && (
        <Sheet title="Compare with which set?" onClose={closeSheet}>
          <div className="stack stack--tight">
            {(others.data ?? []).filter((o) => o.id !== id && !o.archived_at).map((o) => (
              <button key={o.id} className="rowline" onClick={() => navigate(`/lineups/compare/${id}/${o.id}`, { replace: true })}>
                <span className="grow"><span className="strong">{setName(o)}</span><span className="small muted"> · {o.n_lineups} {o.n_lineups === 1 ? "lineup" : "lineups"} · {ago(o.created_at)}</span>
                  {describeSettings(o).length > 0 && <span className="small muted pmeta">{describeSettings(o).join(" · ")}</span>}</span>
                <span className="muted" aria-hidden="true">›</span>
              </button>
            ))}
            {(others.data ?? []).filter((o) => o.id !== id && !o.archived_at).length === 0 && <p className="muted small">There is no other set for these games yet.</p>}
          </div>
        </Sheet>
      )}
      {sheet?.kind === "delete" && (
        <Sheet title={set.entered ? "This set was entered" : `Delete ${lineups.length === 1 ? "this lineup" : `these ${lineups.length} lineups`}?`} onClose={closeSheet}>
          <div className="stack stack--tight">
            {set.entered ? (
              <>
                <p>It is the record of what you played, so it can't be deleted. Archiving takes it off the Lineups screen and keeps it for results.</p>
                <p className="small muted">To delete it anyway, mark its lineups as not entered first.</p>
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
