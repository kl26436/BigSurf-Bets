import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useContestEntries, useContestPlayers, useContests, useDeleteContest, useImportContest, useKnownEntryIds, useSaveSettings, useSetContestMoney, useSettings } from "../lib/api";
import { contestRecord, parseStandingsCsv, topShare, type Standings } from "../lib/contest";
import { ago, pts, signed } from "../lib/format";
import { useSheet } from "../lib/nav";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS, type Contest, type ContestEntry } from "../lib/types";
import { usd2 } from "./BetSheet";
import { ErrorNote, Facts, Loading, Sheet } from "./ui";

const title = (c: Contest) => c.name || `Contest ${c.contest_key}`;
const money = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** What a contest cost and paid: the results file has neither, so they are typed in once. */
function MoneySheet({ c, entries, onClose }: { c: Contest; entries: ContestEntry[]; onClose: () => void }) {
  const save = useSetContestMoney();
  const remove = useDeleteContest();
  const { say } = useStore();
  const [name, setName] = useState(c.name ?? "");
  const [fee, setFee] = useState(c.entry_fee != null ? String(c.entry_fee) : "");
  const [won, setWon] = useState<Record<string, string>>(() => Object.fromEntries(entries.map((e) => [e.entry_id, e.winnings != null ? String(e.winnings) : ""])));
  const [sure, setSure] = useState(false);
  const clean = (v: string) => v.replace(/[^\d.]/g, "");
  function submit() {
    save.mutate({ contest_id: c.id, entry_fee: money(fee), name: name.trim() || null, winnings: Object.fromEntries(entries.map((e) => [e.entry_id, money(won[e.entry_id] ?? "")])) }, {
      onSuccess: () => { say("Saved"); onClose(); },
      onError: (e) => say(`Couldn't save that — ${e.message}`, true),
    });
  }
  return (
    <Sheet title="What it cost and paid" onClose={onClose}>
      <form className="stack stack--tight" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <p className="small muted">DraftKings' results file has places and points but no dollars. Fill these in from the contest page; enter 0 for an entry that won nothing.</p>
        <label className="field"><span>Contest name</span>
          <input className="input" type="text" maxLength={120} placeholder="NFL $5 Double Up" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field"><span>Entry fee, $ (each entry)</span>
          <input className="input" type="text" inputMode="decimal" placeholder="5" value={fee} onChange={(e) => setFee(clean(e.target.value))} />
        </label>
        {entries.map((e) => (
          <label className="field" key={e.entry_id}><span>Won, $: place {e.rank?.toLocaleString() ?? "–"}, {pts(e.points, 2)} points</span>
            <input className="input" type="text" inputMode="decimal" placeholder="0" value={won[e.entry_id] ?? ""} onChange={(ev) => setWon({ ...won, [e.entry_id]: clean(ev.target.value) })} />
          </label>
        ))}
        <button className="btn btn--cta" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
        {sure ? (
          <div className="inline">
            <button type="button" className="btn btn--danger" disabled={remove.isPending} onClick={() => remove.mutate({ contest_id: c.id }, { onSuccess: () => { say("Contest removed"); onClose(); }, onError: (e) => say(`Couldn't remove it — ${e.message}`, true) })}>Remove it for good</button>
            <button type="button" className="btn btn--quiet" onClick={() => setSure(false)}>Keep it</button>
          </div>
        ) : <button type="button" className="btn btn--quiet btn--sm bad" onClick={() => setSure(true)}>Remove this contest</button>}
      </form>
    </Sheet>
  );
}

/** The players the field used most, with what they scored. */
function Field({ contestId }: { contestId: number }) {
  const players = useContestPlayers(contestId);
  if (players.isLoading) return <Loading />;
  const rows = (players.data ?? []).slice(0, 12);
  if (rows.length === 0) return <p className="small muted">The file had no player list.</p>;
  return (
    <table className="table">
      <thead><tr><th scope="col">Player</th><th scope="col">In lineups</th><th scope="col">Scored</th></tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={`${p.name}${p.roster_position}`}><td>{p.name} <span className="muted">{p.roster_position}</span></td><td className="num strong">{p.pct_drafted != null ? `${pts(p.pct_drafted)}%` : "–"}</td><td className="num">{pts(p.fpts)}</td></tr>
      ))}</tbody>
    </table>
  );
}

function ContestCard({ c, entries, edit }: { c: Contest; entries: ContestEntry[]; edit: (id: number) => void }) {
  const [field, setField] = useState(false);
  const settled = c.profit != null;
  return (
    <div className="card card--pad">
      <div className="card__head"><h3 className="h2">{title(c)}</h3>
        {c.n_mine > 0 && (settled ? <span className={`pill ${c.profit! > 0 ? "pill--ok" : c.profit! < 0 ? "pill--bad" : ""}`}>{c.profit! >= 0 ? "+" : ""}{usd2(c.profit)}</span> : <span className="pill pill--warn">Dollars missing</span>)}</div>
      <Facts items={[c.week ? `Week ${c.week}` : null, `${c.n_entries.toLocaleString()} entries`, c.entry_fee != null ? `${usd2(c.entry_fee)} to enter` : null, `added ${ago(c.imported_at)}`]} />
      {entries.length === 0 ? <p className="small muted">None of your entries were found in this file. Its field and scores are still kept.</p> : entries.map((e) => (
        <div className="rowline" key={e.entry_id}>
          <div className="grow"><p className="strong">Place {e.rank?.toLocaleString() ?? "–"} <span className="muted">{topShare(e.rank, c.n_entries)}</span></p>
            <p className="small muted">{e.winnings != null ? `won ${usd2(e.winnings)}` : "winnings not filled in"}{e.set_id != null ? " · " : ""}{e.set_id != null && <Link className="accent" to={`/lineups/${e.set_id}`}>see the lineup</Link>}</p></div>
          <p className="pnum num">{pts(e.points, 2)}<small>points</small></p>
        </div>
      ))}
      {c.scores && <Facts className="small muted num" items={[`Winner ${pts(c.scores.max)}`, `top 1% ${pts(c.scores.p99)}`, `top 10% ${pts(c.scores.p90)}`, `middle ${pts(c.scores.p50)}`]} />}
      <div className="inline">
        <button className="btn btn--sm" onClick={() => edit(c.id)}>{settled ? "Change the dollars" : "Fill in the dollars"}</button>
        <button className="btn btn--sm btn--quiet" aria-expanded={field} onClick={() => setField(!field)}>{field ? "Hide the field" : "Who the field played"}</button>
      </div>
      {field && <Field contestId={c.id} />}
    </div>
  );
}

/** Contest results: add DraftKings' file after a contest, see where your entries placed, and keep the money record. */
export function Contests() {
  const contests = useContests();
  const entries = useContestEntries(true);
  const known = useKnownEntryIds();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const add = useImportContest();
  const { say } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [editing, openMoney, closeMoney] = useSheet<number>("contest");
  // a file whose entries could not be told apart from everyone else's: waits for the username
  const [pending, setPending] = useState<{ text: string; name: string; standings: Standings } | null>(null);
  const [who, setWho] = useState("");
  const s = settings.data ?? DEFAULT_SETTINGS;
  const list = contests.data ?? [];
  const byContest = useMemo(() => {
    const m = new Map<number, ContestEntry[]>();
    for (const e of entries.data ?? []) m.set(e.contest_id, [...(m.get(e.contest_id) ?? []), e]);
    return m;
  }, [entries.data]);
  const record = contestRecord(list);

  function send(standings: Standings) {
    add.mutate({ contest: { ...standings } }, {
      onSuccess: (r) => {
        const n = (r as { entries: number }).entries;
        say(n > 0 ? `Added: ${n} of your ${n === 1 ? "entry" : "entries"} among ${standings.n_entries.toLocaleString()}` : `Added, with none of your entries among ${standings.n_entries.toLocaleString()}`);
      },
      onError: (e) => say(`Couldn't add that file — ${e.message}`, true),
    });
  }
  async function read(f: File | undefined) {
    if (!f) return;
    const text = await f.text();
    if (input.current) input.current.value = "";
    const { standings, problem } = parseStandingsCsv(text, f.name, { username: s.dk_username, entryIds: known.data });
    if (!standings) return say(problem ?? "That file couldn't be read", true);
    if (standings.entries.length === 0) return setPending({ text, name: f.name, standings });
    send(standings);
  }
  function retry() {
    if (!pending) return;
    const name = who.trim();
    const again = parseStandingsCsv(pending.text, pending.name, { username: name, entryIds: known.data }).standings ?? pending.standings;
    if (again.entries.length === 0) return say(`No entry in that file is named ${name}`, true);
    saveSettings.mutate({ ...s, dk_username: name });
    setPending(null);
    send(again);
  }

  if (contests.isLoading) return <Loading />;
  if (contests.error) return <ErrorNote error={contests.error} />;
  const open = editing == null ? null : list.find((c) => c.id === editing) ?? null;
  return (
    <section className="stack stack--tight" aria-label="Contests">
      <div className="card__head"><h2 className="h2">Contests</h2><span className="small muted">What your entries placed and paid</span></div>
      {record.n + record.open > 0 && (
        <div className="card card--pad">
          <dl className="kv kv--3">
            <div><dt>Entry fees</dt><dd className="big num">{usd2(record.paid)}</dd></div>
            <div><dt>Won</dt><dd className="big num">{usd2(record.won)}</dd></div>
            <div><dt>Result</dt><dd className={`big num ${record.profit > 0 ? "good" : record.profit < 0 ? "bad" : ""}`}>{record.profit >= 0 ? "+" : ""}{usd2(record.profit)}</dd></div>
          </dl>
          <Facts items={[`${record.n} ${record.n === 1 ? "contest" : "contests"} counted`, record.roi != null ? `${signed(record.roi * 100)}% on fees` : null,
            record.open > 0 ? `${record.open} more ${record.open === 1 ? "needs" : "need"} dollars filled in` : null]} />
        </div>
      )}
      <div className="card card--pad stack stack--tight">
        <p className="strong">Add a contest's results</p>
        <p className="small">On the DraftKings desktop site, open a contest that has finished and choose Export Lineups to CSV, then add the file here. It is read on this device: your entries, the scores it took to place, and each player's share of lineups are what is kept.</p>
        <input ref={input} className="input" type="file" accept=".csv,text/csv" aria-label="Contest results file" disabled={add.isPending} onChange={(e) => read(e.target.files?.[0])} />
        {add.isPending && <p className="small muted" role="status">Adding…</p>}
        {pending && (
          <div className="stack stack--tight" role="alert">
            <p className="small warn">That file has {pending.standings.n_entries.toLocaleString()} entries from {pending.standings.n_people.toLocaleString()} people, and none could be matched to you. What is your DraftKings username?</p>
            <label className="field"><span>DraftKings username</span>
              <input className="input" type="text" autoCapitalize="off" autoCorrect="off" value={who} onChange={(e) => setWho(e.target.value)} />
            </label>
            <div className="inline">
              <button className="btn btn--primary" disabled={who.trim() === ""} onClick={retry}>Find my entries</button>
              <button className="btn btn--quiet" onClick={() => { const p = pending; setPending(null); send(p.standings); }}>Add it without mine</button>
            </div>
          </div>
        )}
      </div>
      {list.map((c) => <ContestCard key={c.id} c={c} entries={byContest.get(c.id) ?? []} edit={openMoney} />)}
      {list.length > 0 && <p className="small muted">A week or two of contests says little about whether the lineups win: results swing far more than that. The record worth reading is a season long.</p>}
      {open && <MoneySheet c={open} entries={byContest.get(open.id) ?? []} onClose={closeMoney} />}
    </section>
  );
}
