import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NotificationSettings } from "../components/Notifications";
import { Empty, ErrorNote, Loading, PosTag, Stepper } from "../components/ui";
import { DEMO, supabase, useDispatches, useJobs, usePlayerResults, usePropResults, useSaveSettings, useScorecards, useSettings } from "../lib/api";
import { ago, bookName, odds, pct, pts, signed, statName, usd } from "../lib/format";
import { decimalToAmerican } from "../lib/stake";
import { useTitle } from "../lib/nav";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS, type PlayerResult, type Settings } from "../lib/types";
import { MODE } from "./Lineups";
import { JOB_NAME, JOB_STATE, useAsk } from "./Week";

export function More() {
  const items = [
    { to: "/more/results", title: "Results", note: "How last week's numbers, lineups and bets actually did" },
    { to: "/more/league", title: "My league", note: "Start and sit, waiver bids, and who is about to come free" },
    { to: "/more/numbers", title: "The numbers", note: "Your own changes to expected points, and when they were last worked out" },
    { to: "/more/settings", title: "Settings", note: "Balances, sportsbooks, salary files, sign out" },
  ];
  useTitle("More");
  return (
    <div className="stack stack--tight">
      <h1 className="title">More</h1>
      <div className="card">
        {items.map((i) => (
          <Link className="rowline" to={i.to} key={i.to}>
            <div className="grow"><p className="strong">{i.title}</p><p className="small muted">{i.note}</p></div>
            <span className="muted" aria-hidden="true">›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

const POSN: Record<string, string> = { QB: "Quarterbacks", RB: "Running backs", WR: "Wide receivers", TE: "Tight ends", DST: "Defenses", ALL: "Everyone" };

export function Results() {
  const cards = useScorecards();
  useTitle("Results");
  if (cards.isLoading) return <Loading />;
  if (cards.error) return <ErrorNote error={cards.error} />;
  return (
    <div className="stack">
      <div><h1 className="title">Results</h1>
        <p className="small muted">Graded every Tuesday against what happened. One week proves little; the running record is what counts.</p></div>
      {(cards.data ?? []).length === 0 && <Empty title="No week has been graded yet" why="A week is graded once all its games are final and it had expected points on file before kickoff." how="The first one lands the Tuesday after this week's games." />}
      {(cards.data ?? []).map((c) => {
        const p = c.metrics.projections, pr = c.metrics.props;
        return (
          <section className="stack stack--tight" key={`${c.season}-${c.week}`} aria-label={`Week ${c.week}`}>
            <div className="spread"><h2 className="h2">Week {c.week}, {c.season}</h2><span className="small muted">Graded {ago(c.created_at)}</span></div>
            {p && (
              <div className="card card--pad scroll-x">
                <p className="strong">Expected points vs what players scored</p>
                <table className="table">
                  <thead><tr><th>Position</th><th>Players</th><th>Average miss</th><th>Lean</th><th>Inside the range</th><th>DraftKings' average missed by</th></tr></thead>
                  <tbody>{Object.entries(p.by_position).map(([pos, m]) => (
                    <tr key={pos}><td>{POSN[pos] ?? pos}</td><td className="num">{m.n}</td><td className="num strong">{pts(m.mae, 2)}</td>
                      <td className="num">{signed(m.bias, 2)}</td><td className="num">{pct(m.cover_p10_p90)}</td>
                      <td className={`num ${m.vs_dk_avg && m.vs_dk_avg.mae_model < m.vs_dk_avg.mae_dk_avg ? "good" : ""}`}>{m.vs_dk_avg ? pts(m.vs_dk_avg.mae_dk_avg, 2) : "–"}</td></tr>
                  ))}</tbody>
                </table>
                <p className="small muted">{p.did_not_play} players with expected points didn't play. "Inside the range" should sit near 80%. Lean above zero means the numbers ran high.</p>
              </div>
            )}
            {(c.metrics.lineups ?? []).map((l) => (
              <div className="card card--pad" key={l.set_id}>
                <div className="spread">
                  <p className="strong">{l.label || MODE[l.mode] || l.mode} · {l.n_complete} {l.n_complete === 1 ? "lineup" : "lineups"}</p>
                  {l.entered && <span className="pill pill--ok">Entered</span>}
                </div>
                <dl className="kv kv--3">
                  <div><dt>Average score</dt><dd className="big num">{pts(l.avg_actual)}</dd></div>
                  <div><dt>Expected</dt><dd className="big num">{pts(l.avg_projected)}</dd></div>
                  <div><dt>Best lineup</dt><dd className="big big--accent num">{pts(l.best_actual)}</dd></div>
                </dl>
                {l.in_p10_p90 != null && <p className="small muted">{pct(l.in_p10_p90)} of lineups landed inside their expected range.</p>}
                <Link className="btn btn--sm btn--quiet" to={`/lineups/${l.set_id}`}>See the lineups</Link>
              </div>
            ))}
            <WeekDetail season={c.season} week={c.week} />
            {pr && pr.n > 0 && (
              <div className="card card--pad">
                <p className="strong">Player bets · {pr.n} settled</p>
                {pr.vs_pinnacle && <p className="small">Model vs the sharp price on {pr.vs_pinnacle.n} bets: error score {pr.vs_pinnacle.logloss_model.toFixed(4)} against {pr.vs_pinnacle.logloss_pinnacle.toFixed(4)} (lower is better){pr.vs_pinnacle.logloss_model < pr.vs_pinnacle.logloss_pinnacle ? " — the model was closer." : " — the market was closer."}</p>}
                {pr.model_edges && <p className="small">Bets the model flagged: {pr.model_edges.wins} of {pr.model_edges.n} won, a return of <span className={pr.model_edges.roi >= 0 ? "good" : "bad"}>{signed(pr.model_edges.roi * 100)}%</span> at $1 each.</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ResultRow({ r }: { r: PlayerResult }) {
  const outside = (r.proj_p10 != null && r.dk < r.proj_p10) || (r.proj_p90 != null && r.dk > r.proj_p90);
  return (
    <div className="prow">
      <PosTag pos={r.pos} />
      <div className="grow"><p className="pname ellipsis">{r.name}</p>
        <p className="pmeta ellipsis">{r.team} · expected {pts(r.proj_dk)}{outside ? " · outside his range" : ""}</p></div>
      <p className="pnum num">{pts(r.dk)}<small className={r.miss >= 0 ? "good" : "bad"}>{signed(r.miss)}</small></p>
    </div>
  );
}

/** One graded week, player by player: who beat his number, who fell short, and the player bets the model liked. */
function WeekDetail({ season, week }: { season: number; week: number }) {
  const [open, setOpen] = useState(false);
  const players = usePlayerResults(open ? season : undefined, week);
  const props = usePropResults(open ? season : undefined, week);
  const rows = (players.data ?? []).filter((r) => r.proj_dk >= 5 || r.pos === "DST");
  const flagged = props.data ?? [];
  const won = flagged.filter((p) => p.model_side === p.came_in).length;
  const settled = flagged.filter((p) => p.came_in !== "push").length;
  return (
    <>
      <button className="btn btn--quiet btn--sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide the players" : "Show the players"}</button>
      {open && (players.isLoading ? <Loading /> : players.error ? <ErrorNote error={players.error} /> : rows.length === 0
        ? <div className="card card--pad"><p className="small muted">Player-by-player results are kept starting with the week graded on November 17. This week was graded before that.</p></div> : (
        <>
          <div className="cols cols--2">
            <section aria-label="Beat expected points"><div className="card__head"><h3 className="h2">Beat their number</h3><span className="small muted">Points over expected</span></div>
              <div className="card">{rows.slice(0, 6).map((r) => <ResultRow key={r.player_id} r={r} />)}</div></section>
            <section aria-label="Fell short of expected points"><div className="card__head"><h3 className="h2">Fell short</h3><span className="small muted">Points under expected</span></div>
              <div className="card">{rows.slice(-6).reverse().map((r) => <ResultRow key={r.player_id} r={r} />)}</div></section>
          </div>
          {flagged.length > 0 && (
            <section aria-label="Player bets the model liked" className="card card--pad">
              <div className="card__head"><h3 className="h2">Player bets the model liked</h3><span className="small muted num">{won} of {settled} won</span></div>
              {flagged.slice(0, 12).map((p) => {
                const price = p.model_side === "over" ? p.over_decimal : p.under_decimal;
                const hit = p.model_side === p.came_in;
                return (
                  <div className="rowline" key={`${p.player_id}${p.stat}${p.line}${p.bookmaker}`}>
                    <div className="grow"><p className="strong">{p.name ?? p.player_id} {p.model_side} {pts(p.line)} {statName(p.stat).toLowerCase()}</p>
                      <p className="small muted">{bookName(p.bookmaker)} {price ? odds(decimalToAmerican(price)) : ""} · finished with {pts(p.actual, 0)}</p></div>
                    <span className={`pill ${p.came_in === "push" ? "" : hit ? "pill--ok" : "pill--bad"}`}>{p.came_in === "push" ? "Tie" : hit ? "Won" : "Lost"}</span>
                  </div>
                );
              })}
              {flagged.length > 12 && <p className="small muted">And {flagged.length - 12} more.</p>}
            </section>
          )}
        </>
      ))}
    </>
  );
}

const BOOKS = ["betmgm", "circa", "draftkings", "fanduel", "caesars"];

export function SettingsScreen() {
  const settings = useSettings();
  const save = useSaveSettings();
  const jobs = useJobs();
  const dispatches = useDispatches(true);
  const ask = useAsk();
  const { say } = useStore();
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const file = useRef<HTMLInputElement>(null);
  useTitle("Settings");
  useEffect(() => { if (settings.data) setDraft(settings.data); }, [settings.data]);
  if (settings.isLoading) return <Loading />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const needsSetup = (jobs.data ?? [])[0]?.status === "needs_setup";
  const lastSent = (dispatches.data ?? []).find((d) => d.sent);

  async function upload(f: File | undefined) {
    if (!f) return;
    const csv = await f.text();
    if (!csv.startsWith("Position,")) return say("That isn't a DraftKings salary file — export it from a contest's draft page", true);
    ask("import_slate", { csv, name: f.name.replace(/\.csv$/i, "") }, "Salary file sent — expected points follow in a few minutes");
    if (file.current) file.current.value = "";
  }

  return (
    <div className="stack">
      <div><h1 className="title">Settings</h1></div>
      <section className="card card--pad stack stack--tight" aria-label="Balances and stakes">
        <h2 className="h2">Balances and stakes</h2>
        <Stepper label="DraftKings balance" value={draft.balance_dfs} onChange={(v) => set("balance_dfs", v)} min={0} max={100000} step={25} format={usd} />
        <Stepper label="Sportsbook balance" value={draft.balance_bets} onChange={(v) => set("balance_bets", v)} min={0} max={100000} step={25} format={usd} />
        <Stepper label="Stake size (share of the full Kelly stake)" value={draft.stake_fraction} onChange={(v) => set("stake_fraction", v)} min={0.05} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} />
        <Stepper label="Most to put on one bet" value={draft.max_stake_pct} onChange={(v) => set("max_stake_pct", v)} min={0.01} max={0.25} step={0.01} format={(v) => `${Math.round(v * 100)}% · ${usd(v * draft.balance_bets)}`} />
        <p className="small muted">Suggested stakes on the Bets tab come from these. A quarter of the Kelly stake is the usual choice: slower growth, far smaller swings.</p>
        <p className="eyebrow">Sportsbooks you can bet at</p>
        <div className="chips chips--wrap" role="group" aria-label="Sportsbooks">
          {BOOKS.map((b) => <button key={b} className="chip" aria-pressed={draft.books.includes(b)} onClick={() => set("books", draft.books.includes(b) ? draft.books.filter((x) => x !== b) : [...draft.books, b])}>{bookName(b)}</button>)}
        </div>
        <button className="btn btn--primary" disabled={save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => say("Settings saved"), onError: () => say("Couldn't save settings — try again", true) })}>{save.isPending ? "Saving…" : "Save changes"}</button>
      </section>

      <NotificationSettings draft={draft} save={(patch, done) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        save.mutate(next, { onSuccess: () => say(done), onError: () => say("Couldn't save that — try again", true) });
      }} />

      <section className="card card--pad stack stack--tight" aria-label="DraftKings salaries">
        <h2 className="h2">DraftKings salaries</h2>
        <p className="small">On a contest's draft page choose Export to CSV, then add the file here. Adding a fresher export of the same games updates prices and injury tags.</p>
        <input ref={file} className="input" type="file" accept=".csv,text/csv" aria-label="DraftKings salary file" onChange={(e) => upload(e.target.files?.[0])} />
      </section>

      <section className="card card--pad stack stack--tight" aria-label="Requests">
        <h2 className="h2">Requests from this app</h2>
        {needsSetup && <p className="small warn" role="alert">Requests are saved but nothing starts them yet. One step is missing: a GitHub token named github_pat in the database's Vault. The steps are in docs/app-setup.md.</p>}
        {!needsSetup && <p className="small muted">{lastSent ? `Last request reached GitHub ${ago(lastSent.at)}${lastSent.status_code ? ` (answer ${lastSent.status_code})` : ""}.` : "Builds, refreshes and uploads run on GitHub and take a few minutes."}</p>}
        {(jobs.data ?? []).slice(0, 6).map((j) => (
          <div className="rowline" key={j.id}><div className="grow"><p className="strong">{JOB_NAME[j.kind] ?? j.kind}</p><p className="small muted">{ago(j.created_at)}{j.error ? ` · ${j.error}` : ""}</p></div>
            <span className={`pill ${JOB_STATE[j.status].tone}`}>{JOB_STATE[j.status].label}</span></div>
        ))}
      </section>
      {!DEMO && <button className="btn btn--danger" onClick={() => supabase?.auth.signOut()}>Sign out</button>}
    </div>
  );
}
