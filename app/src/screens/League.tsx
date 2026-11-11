import { Empty, ErrorNote, Facts, Loading, PlayerName, PosTag } from "../components/ui";
import { useFreeAgents, useRoster, useWaiverRecs, useWaiverRun } from "../lib/api";
import { ago, kickoff, pct, pts, signed, usd } from "../lib/format";
import { lineupChanges } from "../lib/league";
import { useTitle } from "../lib/nav";
import type { RosterPlayer, WaiverAdvice, WaiverComing, WaiverGrade, WaiverRec, WaiverRun } from "../lib/types";

const VERDICT: Record<WaiverAdvice["verdict"], string> = {
  now: "Bid this week",
  wait: "Hold your money this week",
  either: "A close call",
  hold: "Nothing worth buying yet",
};

/** Spend now or keep the money for players about to come free: the read, and the two numbers behind it. */
function NowOrWait({ a }: { a: WaiverAdvice }) {
  const why = a.verdict === "now"
    ? (a.my_chop >= 0.15 && a.now && a.now.d_chop <= -0.02
      ? `You have a ${pct(a.my_chop)} chance of being chopped this week, and ${a.now.name} brings that down to ${pct(Math.max(0, a.my_chop + a.now.d_chop))}.`
      : `The best player on offer now adds more than anyone likely to come free after this week's chop.`)
    : a.verdict === "wait" ? "Players likely to come free after this week's chop would add more to your lineup than anyone on offer now, and you are not in much danger this week."
    : a.verdict === "either" ? "What is on offer now and what is likely to come free next week are worth about the same to you. A modest bid now keeps money for later."
    : "Nobody on offer, and nobody likely to come free next week, improves your lineup by a point a week.";
  return (
    <section className="card card--pad" aria-label="Bid now or wait">
      <div className="card__head"><h2 className="h2">Bid now or wait</h2><span className={`pill ${a.verdict === "now" ? "pill--accent" : a.verdict === "wait" ? "pill--warn" : ""}`}>{VERDICT[a.verdict]}</span></div>
      <p className="small">{why}</p>
      <dl className="kv">
        <div><dt>Best on offer now</dt><dd className="big num">{a.now ? signed(a.now.gain) : "–"}</dd></div>
        <div><dt>Expected best next week</dt><dd className="big num">{signed(a.later_gain)}</dd></div>
      </dl>
      <Facts items={[a.now ? `${a.now.name}: ${usd(a.now.price_80)} wins 8 in 10` : null,
        a.likeliest?.name ? `${a.likeliest.owner} is the likeliest to go (${pct(a.likeliest.chop)}); ${a.likeliest.name} would add ${signed(a.likeliest.gain)}` : null]} />
      <p className="small muted">Both numbers are points a week added to your starting lineup. This is a rule of thumb: it leaves out that every other team bids on next week's players too.</p>
    </section>
  );
}

function Bids({ r, bids }: { r: WaiverRun; bids: WaiverRec[] }) {
  const eitherOr = bids.filter((c) => c.either_or === bids[0]?.either_or).length > 1;
  if (bids.length === 0) return <div className="card card--pad"><p className="strong">No bid worth making</p><p className="small">Nobody available improves your lineup enough to spend on this week.</p></div>;
  return (
    <div className="card">
      {bids.map((c) => (
        <div className="prow prow--top" key={c.sleeper_id}>
          <PosTag pos={c.pos} />
          <div className="grow">
            <p className="pname">{c.name}</p>
            <p className="small">Drop {c.drop_name ?? "your weakest player"}</p>
          </div>
          <p className="pnum num"><small>Bid</small>{usd(c.bid)}</p>
          <div className="prow__wide">
            <dl className="mini">
              <div><dt>Wins the bid</dt><dd className="num">{pct(c.win_at_bid)}</dd></div>
              <div><dt>Points a week</dt><dd className="num">{signed(c.gain_avg)}</dd></div>
              <div><dt>Chance of the chop</dt><dd className="num">{pct(r.chop)} → {pct(Math.max(0, r.chop + c.d_chop))}</dd></div>
            </dl>
            <Facts items={[`Safer: ${usd(c.bid_80)} wins 8 in 10`, `${usd(c.bid_95)} wins 19 in 20`]} />
            <p className="small muted">{(c.can_outbid ?? []).length === 0 ? "Nobody has the money to outbid this." : `${(c.can_outbid ?? []).length} ${(c.can_outbid ?? []).length === 1 ? "team has" : "teams have"} the money to outbid this.`}</p>
          </div>
        </div>
      ))}
      {eitherOr && <p className="small muted card--pad">The bids that share a drop are either/or: enter the same player to drop on each, and put the one you want most first.</p>}
    </div>
  );
}

/** Rivals most likely to be chopped, and which of their players would help you: next week's auction, a week early. */
function Coming({ rows }: { rows: WaiverComing[] }) {
  const shown = rows.filter((c) => c.chop_3 >= 0.05).slice(0, 5);
  return (
    <section aria-label="What is coming" className="stack stack--tight">
      <div className="card__head"><h2 className="h2">What is coming</h2><span className="small muted">Players that go to auction when their team is chopped</span></div>
      {shown.length === 0 ? <div className="card card--pad"><p className="small muted">No rival has a real chance of being chopped in the next three weeks.</p></div> : (
        shown.map((c) => {
          const useful = c.players.filter((p) => p.gain > 0);
          return (
            <div className="card card--pad" key={c.owner}>
              <div className="card__head"><p className="strong">{c.owner}</p><span className={`pill ${c.chop_1 >= 0.25 ? "pill--warn" : ""}`}>{pct(c.chop_1)} this week</span></div>
              <Facts items={[`${pct(c.chop_3)} within three weeks`, `${usd(c.budget)} left to spend`]} />
              {useful.length === 0 ? <p className="small muted">None of their players would start for you.</p> : useful.map((p) => (
                <div className="rowline" key={p.name}>
                  <div className="grow"><p className="strong">{p.name} <span className="muted">{p.pos}</span></p><p className="small muted">{pts(p.level)} points a week when he plays</p></div>
                  <p className="pnum num">{signed(p.gain)}<small>for you</small></p>
                </div>
              ))}
            </div>
          );
        })
      )}
      <p className="small muted">A team chopped after this week's games has its players in next Wednesday's auction.</p>
    </section>
  );
}

/** Last auction: the three prices beside the highest bid a rival really made. */
function PriceCheck({ g }: { g: WaiverGrade }) {
  return (
    <section aria-label="How last week's prices did" className="card card--pad">
      <div className="card__head"><h2 className="h2">How last week's prices did</h2><span className="small muted">Week {g.week} auction</span></div>
      <dl className="kv kv--3">
        <div><dt>50% price won</dt><dd className="big num">{g.beat_50} of {g.n}</dd></div>
        <div><dt>80% price won</dt><dd className="big num">{g.beat_80} of {g.n}</dd></div>
        <div><dt>95% price won</dt><dd className="big num">{g.beat_95} of {g.n}</dd></div>
      </dl>
      <div className="scroll-x">
        <table className="table">
          <thead><tr><th scope="col">Player</th><th scope="col">Top rival bid</th><th scope="col">Our 50 / 80 / 95% prices</th><th scope="col">Went to</th></tr></thead>
          <tbody>{g.rows.map((r) => (
            <tr key={r.name}><td>{r.name} <span className="muted">{r.pos}</span></td><td className="num strong">{usd(r.top_rival)}</td>
              <td className="num">{usd(r.bid_50)} / {usd(r.bid_80)} / {usd(r.bid_95)}</td>
              <td className={r.i_won ? "strong" : undefined}>{r.i_won ? `You, for ${usd(r.paid)}` : r.won_by ? `${r.won_by}, ${usd(r.paid)}` : "Nobody"}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <p className="small muted">Each price is meant to beat every rival that share of the time. A handful of players a week proves little; the count over several weeks is the test.</p>
    </section>
  );
}

function RosterRow({ p, spot }: { p: RosterPlayer; spot?: string | null }) {
  return (
    <div className="prow">
      <PosTag pos={p.pos} />
      <div className="grow"><PlayerName name={p.name} status={p.injury_status} />
        <p className="pmeta ellipsis">{spot ? `${spot} · ` : ""}{p.opponent ? `${p.team} vs ${p.opponent} · ${kickoff(p.kickoff_at)}` : p.team ? `${p.team} · no game or no number this week` : "No number this week"}</p></div>
      <p className="pnum num">{pts(p.ppr_mean)}<small>{p.ppr_p10 != null ? `${pts(p.ppr_p10, 0)}–${pts(p.ppr_p90, 0)}` : ""}</small></p>
    </div>
  );
}

export function League() {
  const roster = useRoster();
  const free = useFreeAgents();
  const run = useWaiverRun();
  const recs = useWaiverRecs();
  useTitle("My league");
  if (roster.isLoading || free.isLoading || run.isLoading) return <Loading />;
  if (roster.error) return <ErrorNote error={roster.error} />;
  const mine = [...(roster.data ?? [])].sort((a, b) => (b.ppr_mean ?? -1) - (a.ppr_mean ?? -1));
  const starters = mine.filter((p) => p.is_starter), bench = mine.filter((p) => !p.is_starter);
  const r = run.data ?? null;
  const all = recs.data ?? [];
  const bids = all.filter((c) => c.bid > 0);
  const others = all.filter((c) => c.bid === 0).slice(0, 8);
  const teams = r ? [...r.teams].sort((a, b) => b.chop - a.chop) : [];
  const changes = lineupChanges(mine, r?.lineup ?? null);
  const thin = (r?.advice?.needs ?? []).filter((n) => n.gap < -0.5).slice(0, 3);

  if (mine.length === 0) {
    return (
      <div className="stack">
        <div><p className="eyebrow">Sleeper</p><h1 className="title">My league</h1></div>
        <Empty title="No roster found" why="Your Sleeper roster is read on Tuesdays and Saturdays." how="It appears after the next league refresh." />
      </div>
    );
  }
  return (
    <div className="stack">
      <div><p className="eyebrow">Sleeper</p><h1 className="title">My league</h1>
        <p className="small muted">Expected points use standard full-point-per-catch scoring. Kickers aren't modelled yet.</p></div>

      {r && (
        <section aria-label="Where you stand" className="stack stack--tight">
          <div className="card__head"><h2 className="h2">Where you stand</h2><Facts as="span" items={[`Week ${r.week}`, `${r.teams_left} teams left`, `worked out ${ago(r.created_at)}`]} /></div>
          <div className="card card--pad">
            <dl className="kv kv--3">
              <div><dt>Money left</dt><dd className="big num">{usd(r.budget)}</dd></div>
              <div><dt>Chopped</dt><dd className={`big num ${r.chop >= 0.15 ? "bad" : ""}`}>{pct(r.chop)}</dd></div>
              <div><dt>Win it all</dt><dd className="big big--accent num">{pct(r.win)}</dd></div>
            </dl>
            <p className="small muted">Your chance of being chopped this week and of winning the league, as your roster stands before any pick-up.</p>
          </div>
        </section>
      )}

      <section aria-label="Start and sit" className="stack stack--tight">
        <div className="card__head"><h2 className="h2">Start and sit</h2><span className="small muted num">{pts(starters.reduce((a, p) => a + (p.ppr_mean ?? 0), 0))} expected as set in Sleeper</span></div>
        {changes == null ? null : changes.length === 0 ? (
          <div className="card card--pad" role="status"><p className="strong good">Your lineup in Sleeper is the best one</p>
            <p className="small muted">No change to who starts would raise your expected points this week.</p></div>
        ) : (
          <div className="card card--pad" role="status">
            <p className="strong warn">Change your lineup in Sleeper</p>
            {changes.map((c) => (
              <div className="rowline" key={c.start.sleeper_id}>
                <div className="grow"><p className="strong">Start {c.start.name}</p><p className="small muted">{c.sit ? `Sit ${c.sit.name} (${pts(c.sit.mean)})` : "In an empty spot"}{c.start.spot ? ` · ${c.start.spot}` : ""}</p></div>
                <p className="pnum num">{pts(c.start.mean)}<small className="good">{c.sit ? signed(c.start.mean - c.sit.mean) : ""}</small></p>
              </div>
            ))}
          </div>
        )}
        <div className="cols cols--2">
          <section aria-label="Starters"><p className="eyebrow">Starting in Sleeper</p>
            <div className="card">{starters.map((p) => <RosterRow key={p.sleeper_id} p={p} />)}</div></section>
          <section aria-label="Bench"><p className="eyebrow">Bench</p>
            <div className="card">{bench.length ? bench.map((p) => <RosterRow key={p.sleeper_id} p={p} />) : <p className="muted small card--pad">Nobody on the bench.</p>}</div></section>
        </div>
        {thin.length > 0 && (
          <div className="card card--pad">
            <p className="strong">Where your lineup is thin</p>
            <table className="table">
              <thead><tr><th scope="col">Spot</th><th scope="col">Yours</th><th scope="col">Typical rival</th><th scope="col">Gap</th></tr></thead>
              <tbody>{thin.map((n) => (
                <tr key={n.spot}><td>{n.spot} <span className="muted">{n.name}</span></td><td className="num">{pts(n.mine)}</td><td className="num">{pts(n.league)}</td><td className="num bad">{signed(n.gap)}</td></tr>
              ))}</tbody>
            </table>
            <p className="small muted">Expected points this week against the middle team still alive at the same spot. These are the spots a pick-up helps most.</p>
          </div>
        )}
      </section>

      {r?.advice && <NowOrWait a={r.advice} />}

      {r && (
        <section aria-label="Waiver bids" className="stack stack--tight">
          <div className="card__head"><h2 className="h2">Waiver bids</h2><span className="small muted">Blind auction, Wednesday morning</span></div>
          <Bids r={r} bids={bids} />
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
      )}

      {r?.coming && <Coming rows={r.coming} />}
      {r?.grade && <PriceCheck g={r.grade} />}

      <section aria-label="Best available players"><div className="card__head"><h2 className="h2">Best available</h2><span className="small muted">Not on any roster</span></div>
        <div className="card">{(free.data ?? []).slice(0, 20).map((p) => <RosterRow key={p.player_id ?? p.name} p={p} />)}{(free.data ?? []).length === 0 && <p className="muted small card--pad">Nobody with expected points is available.</p>}</div></section>
    </div>
  );
}
