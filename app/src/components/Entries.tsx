import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAssignEntries, useEntries, useImportEntries, useSetsDetail } from "../lib/api";
import { ago, pts, usd } from "../lib/format";
import { useStore } from "../lib/store";
import { contestRepeats, fillContests, parseEntriesCsv, spreadRepeats, toEntriesCsv } from "../lib/swap";
import type { DkEntry, LineupSet, Slate } from "../lib/types";
import { Facts, Why } from "./ui";
import { download } from "../screens/Builder";
import { setName } from "../screens/Lineups";

/** A contest with more entries than this shows them only when opened. */
const FOLD_OVER = 6;

/** Your DraftKings entries: which contests you are in and which lineup each entry
 *  holds. With them, a swap or a new lineup goes back to DraftKings as one file. */
export function Entries({ slate, sets }: { slate: Slate; sets: LineupSet[] }) {
  const entries = useEntries(slate.id);
  const importer = useImportEntries();
  const assign = useAssignEntries();
  const { say } = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [fillFrom, setFillFrom] = useState<number | "">("");
  const many = useSetsDetail(sets.map((s) => s.id));
  const list = entries.data ?? [];
  const lineups = many.data?.lineups ?? [];
  const idsOf = (setId: number, lineupNo: number) => (many.data?.players ?? []).filter((p) => p.set_id === setId && p.lineup_no === lineupNo)
    .sort((a, b) => a.slot_no - b.slot_no).map((p) => p.dk_id);
  const contests = useMemo(() => {
    const m = new Map<string, DkEntry[]>();
    for (const e of list) m.set(e.contest_id ?? e.contest_name ?? "?", [...(m.get(e.contest_id ?? e.contest_name ?? "?") ?? []), e]);
    return [...m.values()];
  }, [list]);

  async function add(f: File | undefined) {
    if (!f) return;
    const parsed = parseEntriesCsv(await f.text());
    if (file.current) file.current.value = "";
    if (parsed.problem) return say(parsed.problem, true);
    importer.mutate({ slate_id: slate.id, entries: parsed.entries }, {
      onSuccess: (r) => { const out = r as { entries: number; linked: number }; say(`${out.entries} ${out.entries === 1 ? "entry" : "entries"} read · ${out.linked} already hold one of your lineups`); },
      onError: (e) => say(`Couldn't read the entries — ${e.message}`, true),
    });
  }
  function put(e: DkEntry, value: string) {
    const [s, l] = value.split(":").map(Number);
    assign.mutate({ assignments: [value ? { entry_id: e.entry_id, set_id: s, lineup_no: l } : { entry_id: e.entry_id, set_id: null }] },
      { onError: (err) => say(`Couldn't save that — ${err.message}`, true) });
  }
  const repeats = useMemo(() => contestRepeats(list), [list]);
  const wasted = repeats.reduce((a, c) => a + c.repeats.reduce((b, r) => b + r.entries.length - 1, 0), 0);
  function spread() {
    const moves = spreadRepeats(list, lineups);
    if (moves.length === 0) return say("No unused lineup left in that set to move them to", true);
    assign.mutate({ assignments: moves }, {
      onSuccess: () => say(`${moves.length} ${moves.length === 1 ? "entry" : "entries"} moved to a lineup of their own · download the edit file and upload it to DraftKings`),
      onError: (err) => say(`Couldn't move them — ${err.message}`, true),
    });
  }
  function fill() {
    if (fillFrom === "") return;
    const empty = list.filter((e) => e.set_id == null);
    const pairs = fillContests(list, fillFrom, lineups);
    if (pairs.length === 0) return say("That set has no lineup left to give", true);
    assign.mutate({ assignments: pairs }, {
      onSuccess: () => say(`${pairs.length} ${pairs.length === 1 ? "entry" : "entries"} filled${pairs.length < empty.length ? ` · ${empty.length - pairs.length} still empty` : ""}`),
      onError: (err) => say(`Couldn't fill them — ${err.message}`, true),
    });
  }
  const editFile = () => {
    const { csv, rows } = toEntriesCsv(list, (e) => (e.set_id != null && e.lineup_no != null ? idsOf(e.set_id, e.lineup_no) : null));
    download(`bigsurf-edit-entries-week${slate.week}.csv`, csv);
    say(`${rows} ${rows === 1 ? "entry" : "entries"} in the file${wasted ? ` · ${wasted} still repeat a lineup in the same contest` : ""}`, wasted > 0);
  };

  const held = list.filter((e) => e.set_id != null).length;
  const inPlay = list.reduce((s, e) => s + (e.entry_fee ?? 0), 0);
  const picker = <input ref={file} className="input" type="file" accept=".csv,text/csv" aria-label="DraftKings entries file" onChange={(e) => add(e.target.files?.[0])} />;

  // a contest with many entries opens on a tap: twenty dropdowns in a row is a wall, not a list
  const [openContests, setOpenContests] = useState<Set<string>>(new Set());
  const keyOf = (group: DkEntry[]) => group[0].contest_id ?? group[0].contest_name ?? "?";
  const isOpen = (group: DkEntry[]) => group.length <= FOLD_OVER || openContests.has(keyOf(group));
  const flip = (group: DkEntry[]) => setOpenContests((c) => { const n = new Set(c); const k = keyOf(group); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (entries.isLoading) return null;
  if (list.length === 0) {
    return (
      <section className="card card--pad" aria-label="DraftKings entries">
        <h2 className="h2">Add your entries file</h2>
        <p className="small">On DraftKings: Lineups → Edit Entries → Download.</p>
        {slate.upcoming ? picker : <p className="small muted">These games have started, so there is nothing left to edit.</p>}
        <p className="small muted">It tells the app which contests you are in, so a late swap goes back as one file instead of entry by entry.</p>
      </section>
    );
  }
  return (
    <section className="stack stack--tight" aria-label="DraftKings entries">
      <div className="card card--pad">
        <div className="card__head">
          <h2 className="h2">{list.length} {list.length === 1 ? "entry" : "entries"} in {contests.length} {contests.length === 1 ? "contest" : "contests"}</h2>
          <span className="small muted">Read {ago(list[0].imported_at)}</span>
        </div>
        <Facts className="small" items={[`${usd(inPlay)} in play`, `${held} of ${list.length} hold one of your lineups`]} />
        <div className="inline">
          <button className="btn btn--primary" disabled={held === 0} onClick={editFile}>Download the edit file</button>
          <Link className="btn" to="/lineups/swap">Swap out players</Link>
        </div>
        <Why ask="More" lead="Upload the edit file on DraftKings: Lineups → Edit Entries → Upload.">A lineup put on an entry is marked as entered. Entries with no lineup of yours are left out of the file.</Why>
        {slate.upcoming && held < list.length && (
          <div className="inline inline--row">
            <select className="input grow" value={fillFrom} aria-label="Fill the empty entries from" onChange={(e) => setFillFrom(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Fill the {list.length - held} empty from…</option>
              {sets.map((s) => <option key={s.id} value={s.id}>{setName(s)} · {s.n_lineups} {s.n_lineups === 1 ? "lineup" : "lineups"}</option>)}
            </select>
            <button className="btn" disabled={fillFrom === "" || assign.isPending} onClick={fill}>Fill</button>
          </div>
        )}
      </div>
      {wasted > 0 && (
        <div className="card card--pad card--warn" role="alert">
          <p className="strong">{wasted} {wasted === 1 ? "entry repeats" : "entries repeat"} a lineup in the same contest</p>
          {repeats.map((c) => (
            <p key={c.contest} className="small">{c.name ?? "Contest"}: {c.repeats.map((r) => `lineup ${r.lineup_no} ×${r.entries.length}`).join(", ")}</p>
          ))}
          <p className="small muted">A repeat can only tie itself, and the lineup it replaced never plays. Spread them out, then download the edit file and upload it on DraftKings before lock.</p>
          {slate.upcoming && <button className="btn btn--primary" disabled={assign.isPending || many.isLoading} onClick={spread}>Spread them out</button>}
        </div>
      )}
      {contests.map((group) => {
        const mine = group.filter((e) => e.set_id != null).length;
        const open = isOpen(group);
        return (
          <div key={keyOf(group)} className="card card--pad">
            <h3 className="strong">{group[0].contest_name ?? "Contest"}</h3>
            <Facts className="small muted" items={[group[0].entry_fee != null ? `${usd(group[0].entry_fee)} each` : null, `${group.length} ${group.length === 1 ? "entry" : "entries"}`,
              mine === group.length ? "all hold a lineup" : `${group.length - mine} without a lineup`]} />
            {group.length > FOLD_OVER && <button className="btn btn--sm" aria-expanded={open} onClick={() => flip(group)}>{open ? "Hide the entries" : `Show the ${group.length} entries`}</button>}
            {open && group.map((e) => (
              <label className="field" key={e.entry_id}>
                <span>Entry …{e.entry_id.slice(-6)}</span>
                <select className="input" value={e.set_id != null ? `${e.set_id}:${e.lineup_no}` : ""} disabled={assign.isPending || !slate.upcoming} onChange={(ev) => put(e, ev.target.value)}>
                  <option value="">{e.players ? "A lineup that isn't one of yours" : "No lineup yet"}</option>
                  {sets.map((s) => (
                    <optgroup key={s.id} label={setName(s)}>
                      {lineups.filter((l) => l.set_id === s.id).map((l) => <option key={l.lineup_no} value={`${s.id}:${l.lineup_no}`}>{setName(s)} · Lineup {l.lineup_no} · {pts(l.proj)} expected</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
            ))}
          </div>
        );
      })}
      {slate.upcoming && <div className="card card--pad"><label className="field"><span>Add a newer entries file</span>{picker}</label></div>}
    </section>
  );
}
