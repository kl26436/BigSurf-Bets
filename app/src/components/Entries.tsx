import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAssignEntries, useEntries, useImportEntries, useSetsDetail } from "../lib/api";
import { ago, pts, usd } from "../lib/format";
import { useStore } from "../lib/store";
import { parseEntriesCsv, toEntriesCsv } from "../lib/swap";
import type { DkEntry, LineupSet, Slate } from "../lib/types";
import { download } from "../screens/Builder";
import { setName } from "../screens/Lineups";

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
  function fill() {
    const empty = list.filter((e) => e.set_id == null);
    const taken = new Set(list.filter((e) => e.set_id === fillFrom).map((e) => e.lineup_no));
    const free = lineups.filter((l) => l.set_id === fillFrom && !taken.has(l.lineup_no)).sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));
    const pairs = empty.slice(0, free.length).map((e, i) => ({ entry_id: e.entry_id, set_id: free[i].set_id, lineup_no: free[i].lineup_no }));
    if (pairs.length === 0) return say("That set has no lineup left to give", true);
    assign.mutate({ assignments: pairs }, {
      onSuccess: () => say(`${pairs.length} ${pairs.length === 1 ? "entry" : "entries"} filled${pairs.length < empty.length ? ` · ${empty.length - pairs.length} still empty` : ""}`),
      onError: (err) => say(`Couldn't fill them — ${err.message}`, true),
    });
  }
  const editFile = () => {
    const { csv, rows } = toEntriesCsv(list, (e) => (e.set_id != null && e.lineup_no != null ? idsOf(e.set_id, e.lineup_no) : null));
    download(`bigsurf-edit-entries-week${slate.week}.csv`, csv);
    say(`${rows} ${rows === 1 ? "entry" : "entries"} in the file`);
  };

  const held = list.filter((e) => e.set_id != null).length;
  const inPlay = list.reduce((s, e) => s + (e.entry_fee ?? 0), 0);
  const picker = <input ref={file} className="input" type="file" accept=".csv,text/csv" aria-label="DraftKings entries file" onChange={(e) => add(e.target.files?.[0])} />;

  if (entries.isLoading) return null;
  return (
    <section className="stack stack--tight" aria-label="DraftKings entries">
      <p className="eyebrow">Your DraftKings entries</p>
      {list.length === 0 ? (
        <div className="card card--pad">
          <p className="strong">Add your entries file</p>
          <p className="small muted">On DraftKings: Lineups → Edit Entries → Download. It tells the app which contests you are in, so a late swap goes back as one file instead of entry by entry.</p>
          {slate.upcoming && picker}
        </div>
      ) : (
        <div className="card card--pad">
          <div className="card__head">
            <p className="strong">{list.length} {list.length === 1 ? "entry" : "entries"} in {contests.length} {contests.length === 1 ? "contest" : "contests"} · {usd(inPlay)} in play</p>
            <span className="small muted">Read {ago(list[0].imported_at)}</span>
          </div>
          <p className="small">{held} of {list.length} hold one of your lineups.{held < list.length ? " The rest are left out of the edit file." : ""}</p>
          {contests.map((group) => (
            <div key={group[0].contest_id ?? group[0].contest_name} className="stack stack--tight">
              <p className="small strong">{group[0].contest_name ?? "Contest"}{group[0].entry_fee != null ? ` · ${usd(group[0].entry_fee)}` : ""}</p>
              {group.map((e) => (
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
          ))}
          {slate.upcoming && held < list.length && (
            <div className="inline">
              <select className="input grow" value={fillFrom} aria-label="Fill the empty entries from" onChange={(e) => setFillFrom(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Fill the empty entries from…</option>
                {sets.map((s) => <option key={s.id} value={s.id}>{setName(s)} · {s.n_lineups} {s.n_lineups === 1 ? "lineup" : "lineups"}</option>)}
              </select>
              <button className="btn" disabled={fillFrom === "" || assign.isPending} onClick={fill}>Fill</button>
            </div>
          )}
          <div className="inline">
            <button className="btn btn--primary" disabled={held === 0} onClick={editFile}>Download the edit file</button>
            <Link className="btn" to="/lineups/swap">Check for scratches</Link>
          </div>
          <p className="small muted">Upload the edit file on DraftKings: Lineups → Edit Entries → Upload. A lineup put on an entry is marked as entered.</p>
          {slate.upcoming && <label className="field"><span>Add a newer entries file</span>{picker}</label>}
        </div>
      )}
    </section>
  );
}
