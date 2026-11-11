import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Empty, ErrorNote, Loading, PosTag } from "../components/ui";
import { useEntries, usePool, useReplaceLineup, useSets, useSetsDetail } from "../lib/api";
import { ago, pts, usd } from "../lib/format";
import { SLOT_LABEL, toDkCsv } from "../lib/lineup";
import { useTitle } from "../lib/nav";
import { useCurrentSlate } from "../lib/slate";
import { useStore } from "../lib/store";
import { applySwap, planSwap, toEntriesCsv, type SwapPlan } from "../lib/swap";
import type { LineupPlayer } from "../lib/types";
import { download } from "./Builder";
import { setName } from "./Lineups";

const key = (setId: number, lineupNo: number) => `${setId}:${lineupNo}`;

/** A player in a lineup is ruled out: put the best legal replacement in his slot,
 *  leave the other eight alone, and hand back a file for DraftKings. */
export function Swap() {
  const [params] = useSearchParams();
  const only = params.get("set") ? Number(params.get("set")) : null;
  const { slate, isLoading } = useCurrentSlate();
  const sets = useSets(slate?.id);
  const pool = usePool(slate?.id);
  const entries = useEntries(slate?.id);
  const replace = useReplaceLineup();
  const { say } = useStore();
  const [chosen, setChosen] = useState<Record<string, Record<number, string>>>({});
  const [fixed, setFixed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useTitle("Swap out players");

  // one set when asked for; otherwise every set with a lineup that was entered
  const mine = useMemo(() => (sets.data ?? []).filter((s) => !s.archived_at && (only != null ? s.id === only : s.entered)), [sets.data, only]);
  const many = useSetsDetail(mine.map((s) => s.id));
  const poolById = useMemo(() => new Map((pool.data ?? []).map((p) => [p.dk_id, p])), [pool.data]);
  const players = many.data?.players ?? [];
  const lineups = many.data?.lineups ?? [];
  const of = (setId: number, lineupNo: number): LineupPlayer[] => players.filter((p) => p.set_id === setId && p.lineup_no === lineupNo);
  const plans = useMemo(() => {
    if (poolById.size === 0) return [];
    const out: SwapPlan[] = [];
    for (const s of mine) {
      const rows = lineups.filter((l) => l.set_id === s.id);
      const anyEntered = rows.some((l) => l.entered);
      for (const l of rows) {
        if (anyEntered && !l.entered) continue;            // entered lineups are the ones that matter; with none entered, all of them
        const plan = planSwap(players.filter((p) => p.set_id === s.id && p.lineup_no === l.lineup_no), poolById, { cap: slate?.salary_cap, chosen: chosen[key(s.id, l.lineup_no)] });
        if (plan) out.push(plan);
      }
    }
    return out;
  }, [mine, lineups, players, poolById, chosen, slate?.salary_cap]);

  if (isLoading || sets.isLoading || pool.isLoading || (mine.length > 0 && many.isLoading)) return <Loading />;
  if (many.error) return <ErrorNote error={many.error} />;
  if (!slate) return <Empty title="No DraftKings games loaded" how={<Link className="accent" to="/lineups">Back to Lineups</Link>} />;

  const ready = plans.filter((p) => p.complete);
  const label = (setId: number) => setName(mine.find((s) => s.id === setId));
  const seen = (pool.data ?? []).find((p) => p.projected_at)?.projected_at;
  const held = (entries.data ?? []).filter((e) => e.set_id != null);
  const fixedOnEntries = held.filter((e) => fixed.includes(key(e.set_id!, e.lineup_no!)));

  async function apply() {
    setBusy(true);
    const done: string[] = [];
    try {
      for (const plan of ready) {
        await replace.mutateAsync({ set_id: plan.setId, lineup_no: plan.lineupNo, players: applySwap(of(plan.setId, plan.lineupNo), plan) });
        done.push(key(plan.setId, plan.lineupNo));
      }
      say(`${done.length} ${done.length === 1 ? "lineup" : "lineups"} fixed`);
    } catch (e) {
      say(`Stopped after ${done.length}: ${e instanceof Error ? e.message : "couldn't save a swap"}`, true);
    } finally {
      setFixed((f) => [...new Set([...f, ...done])]);
      setBusy(false);
    }
  }
  const editFile = () => {
    const { csv, rows } = toEntriesCsv(held, (e) => of(e.set_id!, e.lineup_no!).sort((a, b) => a.slot_no - b.slot_no).map((p) => p.dk_id));
    download(`bigsurf-edit-entries-week${slate.week}.csv`, csv);
    say(`${rows} ${rows === 1 ? "entry" : "entries"} in the file`);
  };
  const lineupFile = () => download(`bigsurf-swapped-week${slate.week}.csv`,
    toDkCsv(fixed.map((k) => { const [s, l] = k.split(":").map(Number); return of(s, l).sort((a, b) => a.slot_no - b.slot_no).map((p) => p.dk_id); })));

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">{only != null ? label(only) : "Entered lineups"}{seen ? ` · numbers from ${ago(seen)}` : ""}</p>
        <h1 className="title">Swap out players</h1>
        <p className="small muted">A player who is ruled out is replaced by the best one who fits his spot and the money left, and whose game hasn't started. The other eight stay where they are.</p>
      </div>

      {fixed.length > 0 && (
        <div className="card card--pad" role="status">
          <p className="strong good">{fixed.length} {fixed.length === 1 ? "lineup" : "lineups"} fixed here. DraftKings still has the old ones.</p>
          {fixedOnEntries.length > 0 ? (
            <>
              <p className="small">Upload this on DraftKings: Lineups → Edit Entries → Upload. It carries every entry that holds one of your lineups.</p>
              <button className="btn btn--primary" onClick={editFile}>Download the edit file</button>
            </>
          ) : (
            <>
              <p className="small">Add your DraftKings entries file on the Lineups screen and the app can hand back one file that edits them all. Without it, this file uploads the fixed lineups as new ones and you swap them into your entries on DraftKings.</p>
              <button className="btn btn--primary" onClick={lineupFile}>Download the fixed lineups</button>
            </>
          )}
        </div>
      )}

      {plans.length === 0 ? (
        mine.length === 0
          ? <Empty title="No entered lineups yet" why="Mark the lineups you played as entered and this screen watches them for scratches." how={<Link className="accent" to="/lineups">Back to Lineups</Link>} />
          : <Empty title="Nobody in these lineups is ruled out" why={seen ? `As of the numbers from ${ago(seen)}.` : undefined} how={<Link className="accent" to="/">Check player statuses on the Week tab</Link>} />
      ) : (
        <>
          {plans.map((plan) => (
            <section className="card card--pad" key={key(plan.setId, plan.lineupNo)} aria-label={`${label(plan.setId)} lineup ${plan.lineupNo}`}>
              <div className="card__head">
                <h2 className="h2">{label(plan.setId)} · Lineup {plan.lineupNo}</h2>
                <span className="small muted num">{pts(plan.before)} → <span className={plan.complete ? "accent strong" : ""}>{pts(plan.after)}</span> expected · {usd(plan.salary)}</span>
              </div>
              {plan.swaps.map((s) => (
                <div className="swap" key={s.slotNo}>
                  <div className="prow prow--tight">
                    <span className="tag">{SLOT_LABEL[s.slot]}</span>
                    <div className="grow"><p className="pname"><span className="pname__text">{s.out.name}</span><span className="pill pill--bad">OUT</span></p><p className="pmeta">{s.out.team} vs {s.out.opponent}</p></div>
                    <p className="pnum num">{usd(s.out.salary)}</p>
                  </div>
                  {s.pick ? (
                    <label className="field">
                      <span>Put in</span>
                      <select className="input" value={s.pick.dk_id} aria-label={`Replacement for ${s.out.name}`}
                        onChange={(e) => setChosen((c) => ({ ...c, [key(plan.setId, plan.lineupNo)]: { ...c[key(plan.setId, plan.lineupNo)], [s.slotNo]: e.target.value } }))}>
                        {(s.options.some((o) => o.dk_id === s.pick!.dk_id) ? s.options : [s.pick, ...s.options]).map((o) => (
                          <option key={o.dk_id} value={o.dk_id}>{o.name} · {o.pos} {o.team} · {usd(o.salary)} · {pts(o.dk_mean)} pts</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="small bad" role="alert">Nobody who fits this spot is affordable with the money left. Change it by hand on DraftKings.</p>
                  )}
                </div>
              ))}
              {plan.locked.map((p) => (
                <div className="prow prow--tight" key={p.slot_no}>
                  <PosTag pos={p.pos} />
                  <div className="grow"><p className="pname"><span className="pname__text">{p.name}</span><span className="pill pill--bad">OUT</span></p><p className="pmeta">His game has started, so DraftKings no longer allows a change.</p></div>
                  <span />
                </div>
              ))}
            </section>
          ))}
          <div className="sticky-cta">
            <button className="btn btn--cta" disabled={busy || ready.length === 0} onClick={apply}>
              {busy ? "Saving…" : ready.length === 0 ? "Nothing can be swapped" : `Make ${ready.length === 1 ? "this swap" : `these swaps in ${ready.length} lineups`}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
