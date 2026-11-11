import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorNote, Loading, PlayerName, PosTag, Stepper } from "../components/ui";
import { DEMO, supabase, useDispatches, useFreeAgents, useJobs, useRoster, useSaveSettings, useScorecards, useSettings, useWaiverRecs, useWaiverRun } from "../lib/api";
import { ago, bookName, kickoff, pct, pts, signed, usd } from "../lib/format";
import { useTitle } from "../lib/nav";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS, type RosterPlayer, type Settings } from "../lib/types";
import { MODE } from "./Lineups";
import { JOB_NAME, JOB_STATE, useAsk } from "./Week";

export function More() {
  const items = [
    { to: "/more/results", title: "Results", note: "How last week's numbers, lineups and bets actually did" },
    { to: "/more/league", title: "My league", note: "Who to start and who to pick up, by expected points" },
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

/** Guillotine league: who is in danger this week and what to bid at the weekly blind auction. */
function WaiverBids() {
  const run = useWaiverRun();
  const recs = useWaiverRecs();
  const r = run.data;
  if (!r) return null;
  const all = recs.data ?? [];
  const bids = all.filter((c) => c.bid > 0);
  const others = all.filter((c) => c.bid === 0).slice(0, 8);
  const teams = [...r.teams].sort((a, b) => b.chop - a.chop);
  const eitherOr = bids.filter((c) => c.either_or === bids[0]?.either_or).length > 1;
  return (
    <section aria-label="Waiver bids" className="stack stack--tight">
      <div className="card__head"><h2 className="h2">Waiver bids</h2><span className="small muted">Week {r.week} · {r.teams_left} teams left · worked out {ago(r.created_at)}</span></div>
      <div className="card card--pad">
        <dl className="kv kv--3">
          <div><dt>Money left</dt><dd className="big num">{usd(r.budget)}</dd></div>
          <div><dt>Chopped this week</dt><dd className={`big num ${r.chop >= 0.15 ? "bad" : ""}`}>{pct(r.chop)}</dd></div>
          <div><dt>Win the league</dt><dd className="big big--accent num">{pct(r.win)}</dd></div>
        </dl>
        <p className="small muted">Chances as your roster stands, before any pick-up.</p>
      </div>
      {bids.length === 0 ? <div className="card card--pad"><p className="strong">No bid worth making</p><p className="small">Nobody available improves your lineup enough to spend on this week.</p></div> : (
        <div className="card">
          {bids.map((c) => (
            <div className="prow" key={c.sleeper_id}>
              <PosTag pos={c.pos} />
              <div className="grow">
                <p className="pname">{c.name}</p>
                <p className="pmeta">Wins about {pct(c.win_at_bid)} of the time · drop {c.drop_name ?? "your weakest player"}</p>
                <p className="pmeta">{signed(c.gain_avg)} points a week · chop risk {signed(c.d_chop * 100)} points · {(c.can_outbid ?? []).length === 0 ? "nobody has the money to outbid this" : `${(c.can_outbid ?? []).length} ${(c.can_outbid ?? []).length === 1 ? "team has" : "teams have"} the money to outbid this`}</p>
                <p className="pmeta">Safer: {usd(c.bid_80)} wins 8 in 10, {usd(c.bid_95)} wins 19 in 20</p>
              </div>
              <p className="pnum num">{usd(c.bid)}<small>bid</small></p>
            </div>
          ))}
          {eitherOr && <p className="small muted card--pad">The bids that share a drop are either/or: enter the same player to drop on each, and put the one you want most first.</p>}
        </div>
      )}
      <div className="cols cols--2">
        <div className="card card--pad">
          <p className="strong">Who is in danger</p>
          <table className="table">
            <thead><tr><th scope="col">Team</th><th scope="col">Money</th><th scope="col">Expected</th><th scope="col">Chopped</th></tr></thead>
            <tbody>{teams.map((t) => (
              <tr key={t.roster_id}><td className={t.is_me ? "strong" : undefined}>{t.is_me ? "You" : t.owner}</td><td className="num">{usd(t.budget)}</td><td className="num">{pts(t.mean)}</td><td className="num">{pct(t.chop)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {others.length > 0 && (
          <div className="card card--pad">
            <p className="strong">Others available</p>
            <table className="table">
              <thead><tr><th scope="col">Player</th><th scope="col">Points a week</th><th scope="col">Price to win 8 in 10</th></tr></thead>
              <tbody>{others.map((c) => (
                <tr key={c.sleeper_id}><td>{c.name} <span className="muted">{c.pos}</span></td><td className="num">{signed(c.gain_avg)}</td><td className="num">{usd(c.bid_80)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted">Bids are estimates: what rivals will pay is read from their past bids and the money they have left. Chances ignore players that later chops will free up.</p>
    </section>
  );
}

function RosterRow({ p }: { p: RosterPlayer }) {
  return (
    <div className="prow">
      <PosTag pos={p.pos} />
      <div className="grow"><PlayerName name={p.name} status={p.injury_status} />
        <p className="pmeta ellipsis">{p.opponent ? `${p.team} vs ${p.opponent} · ${kickoff(p.kickoff_at)}` : p.team ? `${p.team} · no game or no number this week` : "No number this week"}</p></div>
      <p className="pnum num">{pts(p.ppr_mean)}<small>{p.ppr_p10 != null ? `${pts(p.ppr_p10, 0)}–${pts(p.ppr_p90, 0)}` : ""}</small></p>
    </div>
  );
}

export function League() {
  const roster = useRoster();
  const free = useFreeAgents();
  useTitle("My league");
  if (roster.isLoading || free.isLoading) return <Loading />;
  if (roster.error) return <ErrorNote error={roster.error} />;
  const mine = [...(roster.data ?? [])].sort((a, b) => (b.ppr_mean ?? -1) - (a.ppr_mean ?? -1));
  const starters = mine.filter((p) => p.is_starter), bench = mine.filter((p) => !p.is_starter);
  const worstStart = Math.min(...starters.filter((p) => p.pos !== "QB" && p.pos !== "DST" && p.pos !== "K").map((p) => p.ppr_mean ?? 0));
  const swaps = bench.filter((p) => (p.ppr_mean ?? 0) > worstStart + 0.5 && p.pos !== "QB");
  return (
    <div className="stack">
      <div><p className="eyebrow">Sleeper</p><h1 className="title">My league</h1>
        <p className="small muted">Expected points use standard full-point-per-catch scoring. Kickers aren't modelled yet.</p></div>
      {mine.length === 0 ? <Empty title="No roster found" why="Your Sleeper roster is read on Tuesdays and Saturdays." how="It appears after the next league refresh." /> : (
        <>
          <WaiverBids />
          {swaps.length > 0 && <div className="card card--pad" role="status"><p className="strong warn">Check your lineup</p>
            <p className="small">{swaps.map((p) => p.name).join(", ")} on your bench {swaps.length === 1 ? "is" : "are"} expected to outscore a current starter.</p></div>}
          <div className="cols cols--2">
            <section aria-label="Starters"><div className="card__head"><h2 className="h2">Starting</h2><span className="small muted num">{pts(starters.reduce((a, p) => a + (p.ppr_mean ?? 0), 0))} expected</span></div>
              <div className="card">{starters.map((p) => <RosterRow key={p.sleeper_id} p={p} />)}</div></section>
            <section aria-label="Bench"><div className="card__head"><h2 className="h2">Bench</h2></div>
              <div className="card">{bench.length ? bench.map((p) => <RosterRow key={p.sleeper_id} p={p} />) : <p className="muted small">Nobody on the bench.</p>}</div></section>
          </div>
          <section aria-label="Best available players"><div className="card__head"><h2 className="h2">Best available</h2><span className="small muted">Not on any roster</span></div>
            <div className="card">{(free.data ?? []).slice(0, 20).map((p) => <RosterRow key={p.player_id ?? p.name} p={p} />)}{(free.data ?? []).length === 0 && <p className="muted small">Nobody with expected points is available.</p>}</div></section>
        </>
      )}
    </div>
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
        <div className="chips" role="group" aria-label="Sportsbooks">
          {BOOKS.map((b) => <button key={b} className="chip" aria-pressed={draft.books.includes(b)} onClick={() => set("books", draft.books.includes(b) ? draft.books.filter((x) => x !== b) : [...draft.books, b])}>{bookName(b)}</button>)}
        </div>
        <button className="btn btn--primary" disabled={save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => say("Settings saved"), onError: () => say("Couldn't save settings — try again", true) })}>{save.isPending ? "Saving…" : "Save changes"}</button>
      </section>

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
