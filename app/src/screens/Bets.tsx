import { useMemo, useState } from "react";
import { BetSheet, usd2, vsFair } from "../components/BetSheet";
import { PriceLine } from "../components/PriceLine";
import { PullNow } from "../components/PullNow";
import { Empty, ErrorNote, Facts, Loading, Sheet } from "../components/ui";
import { useBets, useDeleteBet, useGradeBets, usePropEdges, useQuotes, useSettings, useSettleBet } from "../lib/api";
import { useSheet, useTitle } from "../lib/nav";
import { ago, bookName, kickoff, odds, pct, pts, signed, statName, usd } from "../lib/format";
import { betRecord, boardGames, boardPlayers, type BetDraft, type BoardGame, type BoardLine, type BoardSide } from "../lib/prices";
import { arbSplit, decimalToAmerican, suggestedStake } from "../lib/stake";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS, type Bet, type LineQuote, type PropEdge, type Settings } from "../lib/types";

/** "NE to win", "DET −2.5", "Over 51.5" */
export function describe(q: Pick<LineQuote, "market" | "outcome" | "line" | "home_team" | "away_team">): string {
  const team = q.outcome === "home" ? q.home_team : q.away_team;
  if (q.market === "moneyline") return `${team} to win`;
  if (q.market === "spread") return `${team} ${signed(q.line)}`;
  return `${q.outcome === "over" ? "Over" : "Under"} ${pts(q.line)}`;
}
const MARKET: Record<LineQuote["market"], string> = { spread: "Spread", total: "Total points", moneyline: "To win" };

/** Two-sided gaps close within minutes. Past this age a pair is history, not an offer. */
const ARB_FRESH_MINUTES = 15;
/** Below a dollar there is nothing to stake: say so instead of printing "$0". */
const stakeNote = (stake: number) => (stake >= 1 ? `stake ${usd(stake)}` : "stake under $1 at your balance");

function Stale({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  const hours = (Date.now() - Date.parse(at)) / 3600e3;
  return <p className={`small ${hours > 12 ? "warn" : "muted"}`} role="status">Prices seen {ago(at)}.{hours > 12 ? " They've likely moved — check the sportsbook before betting." : ""}</p>;
}

const fromQuote = (q: LineQuote, stake = 0): BetDraft => ({
  kind: "game", description: q.market === "total" ? `${describe(q)} · ${q.away_team} at ${q.home_team}` : describe(q), bookmaker: q.bookmaker,
  price_decimal: q.price_decimal, game_id: q.game_id, market: q.market, number: q.number, outcome: q.outcome, fair_prob: q.fair_prob, stake,
});
const fromLine = (l: { player_id: string; player_name: string | null; game_id: string; stat: string; line: number }, side: "over" | "under", bookmaker: string,
  price: number, fair: number | null, stake = 0): BetDraft => ({
  kind: "player", description: `${l.player_name ?? l.player_id} ${side} ${pts(l.line)} ${statName(l.stat).toLowerCase()}`, bookmaker, price_decimal: price,
  game_id: l.game_id, market: l.stat, number: l.line, outcome: side, player_id: l.player_id, fair_prob: fair, stake,
});

type View = "best" | "prices" | "price" | "mine";
const VIEWS: Record<View, string> = { best: "Best bets", prices: "Prices", price: "Price a line", mine: "My bets" };

export function Bets() {
  const { betsView: { view, kind }, setBetsView } = useStore();
  const quotes = useQuotes();
  const props = usePropEdges();
  const settings = useSettings();
  const bets = useBets();
  const [draft, record, closeRecord] = useSheet<BetDraft>("bet");
  const s = settings.data ?? DEFAULT_SETTINGS;
  useTitle("Bets");

  if (quotes.isLoading || props.isLoading) return <Loading />;
  if (quotes.error) return <ErrorNote error={quotes.error} />;

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Sportsbooks · balance {usd(s.balance_bets)}</p>
        <h1 className="title">Bets</h1>
        <div className="chips chips--wrap" role="group" aria-label="What to show">
          {(Object.keys(VIEWS) as View[]).map((v) => (
            <button key={v} className="chip" aria-pressed={view === v} onClick={() => setBetsView({ view: v })}>{VIEWS[v]}</button>
          ))}
        </div>
        {(view === "best" || view === "prices") && (
          <div className="chips chips--sub" role="group" aria-label="Kind of bet">
            <button className="chip" aria-pressed={kind === "games"} onClick={() => setBetsView({ kind: "games" })}>Games</button>
            <button className="chip" aria-pressed={kind === "players"} onClick={() => setBetsView({ kind: "players" })}>Players</button>
          </div>
        )}
        {(view === "best" || view === "prices") && <PullNow kind="refresh_odds" />}
      </div>

      {view === "best" && (kind === "games"
        ? <BestGames quotes={quotes.data ?? []} s={s} record={record} />
        : <BestPlayers props={props.data ?? []} s={s} record={record} />)}
      {view === "prices" && (kind === "games"
        ? <GameBoard quotes={quotes.data ?? []} s={s} record={record} />
        : <PlayerBoard props={props.data ?? []} s={s} record={record} />)}
      {view === "price" && <PriceLine s={s} record={record} />}
      {view === "mine" && <MyBets bets={bets.data ?? []} loading={bets.isLoading} record={record} />}

      {draft && <BetSheet draft={draft} onClose={closeRecord} />}
    </div>
  );
}

type Record_ = (d: BetDraft) => void;
const kelly = (s: Settings) => (p: number | null, d: number | null) => (p == null || d == null ? 0 : suggestedStake(s.balance_bets, p, d, s.stake_fraction, s.max_stake_pct));

// ---- best bets ---------------------------------------------------------------------
function BestGames({ quotes, s, record }: { quotes: LineQuote[]; s: Settings; record: Record_ }) {
  const mine = (book: string) => s.books.includes(book);
  const stake = kelly(s);
  const arbs = useMemo(() => {
    const by = new Map<string, LineQuote[]>();
    for (const q of quotes) {
      if ((q.arb_pct ?? 0) <= 0 || !q.is_best) continue;
      const k = `${q.game_id}|${q.market}|${q.number}`;
      by.set(k, [...(by.get(k) ?? []), q]);
    }
    return [...by.values()].filter((v) => v.length >= 2).map((v) => [v.find((q) => q.outcome === "home" || q.outcome === "over")!, v.find((q) => q.outcome === "away" || q.outcome === "under")!])
      .filter(([a, b]) => a && b && a.bookmaker !== "pinnacle" && b.bookmaker !== "pinnacle" && mine(a.bookmaker) && mine(b.bookmaker))
      .sort((x, y) => (y[0].arb_pct ?? 0) - (x[0].arb_pct ?? 0));
  }, [quotes, s.books]);
  const value = useMemo(() => quotes.filter((q) => (q.ev ?? 0) >= 0.01 && q.bookmaker !== "pinnacle" && mine(q.bookmaker))
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0)).slice(0, 25), [quotes, s.books]);

  return (
    <>
      <Stale at={quotes[0]?.captured_at} />
      <section className="stack stack--tight" aria-label="Guaranteed profit">
        <div><h2 className="h2">Guaranteed profit</h2><p className="small muted">Two books disagree enough that backing both sides pays whatever happens.</p></div>
        {arbs.length === 0 ? <Empty title="Nothing right now" why="These gaps are rare and close within minutes. Only books you can bet at are shown." /> : arbs.map(([a, b]) => {
          const total = Math.max(2, Math.min(100, Math.floor(s.balance_bets)));
          const split = arbSplit(total, a.price_decimal, b.price_decimal);
          const minutes = (Date.now() - Date.parse(a.captured_at)) / 60e3;
          const gone = !(minutes <= ARB_FRESH_MINUTES);
          return (
            <div className="card card--pad" key={`${a.game_id}${a.market}${a.number}`}>
              <div className="card__head"><p className="strong">{a.away_team} at {a.home_team}</p>
                <span className={`pill ${gone ? "pill--warn" : "pill--ok"}`}>{gone ? `Was +${pct(a.arb_pct, 2)} · ${ago(a.captured_at)}` : `+${pct(a.arb_pct, 2)}`}</span></div>
              {[[a, split.a], [b, split.b]].map(([q, amt]) => {
                const x = q as LineQuote;
                return <div className="rowline" key={x.outcome}><div className="grow"><p className="strong">{describe(x)}</p><p className="small muted">{bookName(x.bookmaker)}</p></div>
                  <p className="pnum num">{odds(x.price_american)}<small>stake {usd(amt as number)}</small></p></div>;
              })}
              {gone
                ? <p className="small warn" role="status">Seen {ago(a.captured_at)} — almost certainly gone. Refresh prices on the Week tab, then check both books before staking anything.</p>
                : <p className="small muted">Stake {usd(total)} in total this way and you're up ${split.profit.toFixed(2)} whichever side wins. Both books must still be showing these prices.</p>}
            </div>
          );
        })}
      </section>
      <section className="stack stack--tight" aria-label="Better than the sharp price">
        <div><h2 className="h2">Better than the sharp price</h2><p className="small muted">Pinnacle's price with its margin removed is the best public estimate of the true chance. These books pay more than that. Tap one after you've placed it to record it.</p></div>
        {value.length === 0 ? <Empty title="Nothing beats the sharp price by 1%" why="That's the normal state of the market." how="Prices refresh Thursday, Saturday, Sunday and Monday. Prices shows every game regardless." /> : (
          <div className="card">{value.map((q) => (
            <button className="rowline rowline--tap" key={`${q.game_id}${q.market}${q.number}${q.outcome}${q.bookmaker}`} onClick={() => record(fromQuote(q, stake(q.fair_prob, q.price_decimal)))}>
              <div className="grow"><p className="strong">{describe(q)}</p>
                <Facts as="span" items={[`${q.away_team} at ${q.home_team}`, kickoff(q.kickoff_at), bookName(q.bookmaker)]} />
                <Facts as="span" className="small muted num" items={[`true chance ${pct(q.fair_prob, 1)}`, stakeNote(stake(q.fair_prob, q.price_decimal))]} /></div>
              <div className="right num"><p className="strong">{odds(q.price_american)}</p><p className="small good">{signed((q.ev ?? 0) * 100)}%</p></div>
            </button>))}
          </div>
        )}
      </section>
    </>
  );
}

type Side = { e: PropEdge; side: "Over" | "Under"; price: number; fair: number | null; model: number | null; ev: number };
function BestPlayers({ props, s, record }: { props: PropEdge[]; s: Settings; record: Record_ }) {
  const mine = (book: string) => s.books.includes(book);
  const sides = (which: "fair" | "model"): Side[] => props.flatMap((e): Side[] => [
    { e, side: "Over", price: e.over_decimal ?? 0, fair: e.fair_over, model: e.model_over, ev: (which === "fair" ? e.ev_over_fair : e.ev_over_model) ?? -1 },
    { e, side: "Under", price: e.under_decimal ?? 0, fair: e.fair_over == null ? null : 1 - e.fair_over, model: e.model_over == null ? null : 1 - e.model_over, ev: (which === "fair" ? e.ev_under_fair : e.ev_under_model) ?? -1 },
  ]).filter((x) => x.price > 1 && x.ev >= 0.02 && x.e.bookmaker !== "pinnacle" && mine(x.e.bookmaker)).sort((a, b) => b.ev - a.ev).slice(0, 20);
  const fairSides = useMemo(() => sides("fair"), [props, s.books]);
  const modelSides = useMemo(() => sides("model"), [props, s.books]);
  return (
    <>
      <Stale at={props[0]?.captured_at} />
      <PropList title="Better than the sharp price" note="Same bet, same number, priced above Pinnacle's fair chance." rows={fairSides} chance={(x) => x.fair} stake={kelly(s)} staked record={record}
        empty={{ title: "No player bets beat the sharp price", why: "Books post these close to game day, and most are priced tightly. Prices lists every line that is up." }} />
      <PropList title="Where the model disagrees" note="The model's chance is unproven until the weekly results show it beats the market. Treat these as leads, not bets." rows={modelSides} chance={(x) => x.model} stake={() => 0} record={record}
        empty={{ title: "No disagreements above 2%", why: "Either no player bets are posted yet or the model agrees with the books." }} />
    </>
  );
}

function PropList({ title, note, rows, chance, stake, staked = false, empty, record }: {
  title: string; note: string; rows: Side[]; chance: (x: Side) => number | null; stake: (p: number | null, d: number | null) => number; staked?: boolean;
  empty: { title: string; why: string }; record: Record_;
}) {
  return (
    <section className="stack stack--tight" aria-label={title}>
      <div><h2 className="h2">{title}</h2><p className="small muted">{note}</p></div>
      {rows.length === 0 ? <Empty title={empty.title} why={empty.why} /> : (
        <div className="card">{rows.map((x) => {
          const st = stake(chance(x), x.price);
          return (
            <button className="rowline rowline--tap" key={`${x.e.player_id}${x.e.stat}${x.e.line}${x.e.bookmaker}${x.side}`}
              onClick={() => record(fromLine(x.e, x.side === "Over" ? "over" : "under", x.e.bookmaker, x.price, x.fair, st))}>
              <div className="grow"><p className="strong">{x.e.player_name} {x.side.toLowerCase()} {pts(x.e.line)} {statName(x.e.stat).toLowerCase()}</p>
                <Facts as="span" items={[x.e.team, bookName(x.e.bookmaker), `model expects ${pts(x.e.proj_mean)}`]} />
                <Facts as="span" className="small muted num" items={[`chance ${pct(chance(x), 1)}`, staked ? stakeNote(st) : null]} /></div>
              <div className="right num"><p className="strong">{odds(decimalToAmerican(x.price))}</p><p className="small good">{signed(x.ev * 100)}%</p></div>
            </button>);
        })}</div>
      )}
    </section>
  );
}

// ---- all prices --------------------------------------------------------------------
function GameBoard({ quotes, s, record }: { quotes: LineQuote[]; s: Settings; record: Record_ }) {
  const games = useMemo(() => boardGames(quotes, s.books), [quotes, s.books]);
  const [openKey, openSide, closeSide] = useSheet<string>("prices");
  const found = useMemo(() => {
    if (!openKey) return null;
    for (const g of games) for (const m of g.markets) for (const side of m.sides) if (`${g.game_id}|${m.market}|${side.outcome}` === openKey) return { g, side };
    return null;
  }, [openKey, games]);
  if (games.length === 0) return <Empty title="No prices yet" why="Game prices load on Thursday, Saturday, Sunday and Monday." how="Refresh prices from the Week tab to load them now." />;
  return (
    <>
      <Stale at={quotes[0]?.captured_at} />
      <p className="small muted">Every game at the number most books are quoting, with the best price at a book you can bet at. Tap a price to see every book.</p>
      <div className="lgrid lgrid--wide">
        {games.map((g) => <GameCard key={g.game_id} g={g} open={openSide} />)}
      </div>
      {found && (
        <Sheet title={describe(found.side.all[0])} onClose={closeSide}>
          <div className="stack stack--tight">
            <Facts items={[`${found.g.away_team} at ${found.g.home_team}`, kickoff(found.g.kickoff_at), found.side.fair != null ? `true chance ${pct(found.side.fair, 1)}` : null]} />
            <div>
              {found.side.all.map((q) => {
                const yours = s.books.includes(q.bookmaker) && q.bookmaker !== "pinnacle";
                return (
                  <div className="rowline" key={q.bookmaker}>
                    <div className="grow"><p className="strong">{bookName(q.bookmaker)}</p>
                      <p className="small muted">{q.bookmaker === "pinnacle" ? "The sharp price, for reference" : yours ? (q.ev != null ? vsFair(q.ev) : "One of your books") : "Not one of your books"}</p></div>
                    <p className={`pnum num ${yours ? "" : "muted"}`}>{odds(q.price_american ?? decimalToAmerican(q.price_decimal))}</p>
                    {yours && <button className="btn btn--sm" onClick={() => record(fromQuote(q))} aria-label={`Record this bet at ${bookName(q.bookmaker)}`}>Record</button>}
                  </div>
                );
              })}
            </div>
            <p className="small muted">Books you can bet at are set in More → Settings.</p>
          </div>
        </Sheet>
      )}
    </>
  );
}

function GameCard({ g, open }: { g: BoardGame; open: (key: string) => void }) {
  return (
    <section className="card card--pad" aria-label={`${g.away_team} at ${g.home_team}`}>
      <div className="card__head"><h2 className="h2">{g.away_team} at {g.home_team}</h2><span className="small muted">{kickoff(g.kickoff_at)}</span></div>
      {g.markets.map((m) => (
        <div key={m.market} className="board">
          <p className="eyebrow">{MARKET[m.market]}</p>
          <div className="board__sides">
            {m.sides.map((side) => <SideButton key={side.outcome} g={g} side={side} onClick={() => open(`${g.game_id}|${m.market}|${side.outcome}`)} />)}
          </div>
        </div>
      ))}
    </section>
  );
}

function SideButton({ g, side, onClick }: { g: BoardGame; side: BoardSide; onClick: () => void }) {
  const q = side.best;
  const any = side.all[0];
  const label = describe({ market: any.market, outcome: side.outcome, line: side.line, home_team: g.home_team, away_team: g.away_team });
  return (
    <button className="board__side" onClick={onClick} aria-label={`${label}: every book's price`}>
      <span className="strong ellipsis">{any.market === "moneyline" ? (side.outcome === "home" ? g.home_team : g.away_team) : label}</span>
      <span className="num board__price">{q ? odds(q.price_american ?? decimalToAmerican(q.price_decimal)) : "–"}</span>
      <span className="small muted ellipsis">{q ? bookName(q.bookmaker) : "None of your books"}</span>
    </button>
  );
}

const PAGE = 40;
function PlayerBoard({ props, s, record }: { props: PropEdge[]; s: Settings; record: Record_ }) {
  const [text, setText] = useState("");
  const [stat, setStat] = useState("");
  const [shown, setShown] = useState(PAGE);
  const stats = useMemo(() => [...new Set(props.map((e) => e.stat))].sort((a, b) => statName(a).localeCompare(statName(b))), [props]);
  const rows = useMemo(() => boardPlayers(props, s.books, { text, stat: stat || undefined }), [props, s.books, text, stat]);
  if (props.length === 0) return <Empty title="No player lines yet" why="Books post these close to game day." how="Refresh prices from the Week tab to check again." />;
  return (
    <>
      <Stale at={props[0]?.captured_at} />
      <div className="kv">
        <input className="input" type="search" placeholder="Search a player or team" aria-label="Search player lines" value={text} onChange={(e) => { setText(e.target.value); setShown(PAGE); }} />
        <select className="input" aria-label="Which stat" value={stat} onChange={(e) => { setStat(e.target.value); setShown(PAGE); }}>
          <option value="">Every stat</option>
          {stats.map((k) => <option key={k} value={k}>{statName(k)}</option>)}
        </select>
      </div>
      <p className="small muted">{rows.length} {rows.length === 1 ? "line" : "lines"} at your books, best price for each side. Tap a price after you've placed it to record it.</p>
      {rows.length === 0 ? <Empty title="No lines match" why="None of your books has a line for that search." how="Clear the search or pick another stat." /> : (
        <div className="card">
          {rows.slice(0, shown).map((l) => <LineRow key={l.key} l={l} record={record} />)}
        </div>
      )}
      {rows.length > shown && <button className="btn" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length}</button>}
    </>
  );
}

function LineRow({ l, record }: { l: BoardLine; record: Record_ }) {
  const side = (which: "over" | "under") => {
    const best = l[which][0];
    const fair = l.fair_over == null ? null : which === "over" ? l.fair_over : 1 - l.fair_over;
    return (
      <button className="board__side" disabled={!best} onClick={() => best && record(fromLine(l, which, best.bookmaker, best.price, fair))}
        aria-label={`${l.player_name} ${which} ${pts(l.line)} ${statName(l.stat).toLowerCase()}`}>
        <span className="strong">{which === "over" ? "Over" : "Under"}</span>
        <span className="num board__price">{best ? odds(decimalToAmerican(best.price)) : "–"}</span>
        <span className="small muted ellipsis">{best ? bookName(best.bookmaker) : "No price"}</span>
      </button>
    );
  };
  return (
    <div className="board board--line">
      <div><p className="strong">{l.player_name} · {statName(l.stat).toLowerCase()} {pts(l.line)}</p>
        <Facts items={[l.team, l.proj_mean != null ? `model expects ${pts(l.proj_mean)}` : null, l.fair_over != null ? `true chance of the over ${pct(l.fair_over, 0)}` : null]} /></div>
      <div className="board__sides">{side("over")}{side("under")}</div>
    </div>
  );
}

// ---- my bets -----------------------------------------------------------------------
const RESULT: Record<Bet["result"], string> = { open: "Open", won: "Won", lost: "Lost", void: "Stake back" };

function MyBets({ bets, loading, record }: { bets: Bet[]; loading: boolean; record: Record_ }) {
  const grade = useGradeBets();
  const settle = useSettleBet();
  const remove = useDeleteBet();
  const { say } = useStore();
  const [openId, openBet, closeBet] = useSheet<number>("mybet");
  const r = useMemo(() => betRecord(bets), [bets]);
  const open = bets.filter((b) => b.result === "open");
  const settled = bets.filter((b) => b.result !== "open");
  const picked = openId == null ? null : bets.find((b) => b.id === openId) ?? null;
  if (loading) return <Loading />;

  const check = () => grade.mutate(undefined, {
    onSuccess: (n) => say(Number(n) > 0 ? `${n} ${Number(n) === 1 ? "bet" : "bets"} settled from final scores` : "Nothing new to settle — games not final, or bets written by hand"),
    onError: (e) => say(`Couldn't check results — ${e.message}`, true),
  });
  const set = (b: Bet, result: Bet["result"]) => settle.mutate({ id: b.id, result }, {
    onSuccess: () => { say(result === "open" ? "Back to open" : `Marked: ${RESULT[result].toLowerCase()}`); closeBet(); },
    onError: (e) => say(`Couldn't save that — ${e.message}`, true),
  });
  const blank: BetDraft = { kind: "other", description: "", bookmaker: "", price_decimal: null };

  return (
    <>
      <section className="card card--pad" aria-label="Your record">
        <dl className="kv kv--3">
          <div><dt>Profit</dt><dd className={`big num ${r.profit > 0 ? "good" : r.profit < 0 ? "bad" : ""}`}>{r.settled ? usd2(r.profit) : "–"}</dd></div>
          <div><dt>Staked</dt><dd className="big num">{r.staked ? usd(r.staked) : "–"}</dd></div>
          <div><dt>Beat the close</dt><dd className="big num">{r.closeN ? `${r.closeBeat} of ${r.closeN}` : "–"}</dd></div>
        </dl>
        <p className="small">
          {r.settled === 0 ? "No settled bets yet." : `${r.won} won, ${r.lost} lost${r.returned ? `, ${r.returned} stake back` : ""}.${r.roi != null ? ` ${signed(r.roi * 100)}% on the money staked.` : ""}`}
          {r.closeAvg != null ? ` On average your prices were ${Math.abs(r.closeAvg * 100).toFixed(1)}% ${r.closeAvg >= 0 ? "better" : "worse"} than the closing price.` : ""}
        </p>
        <p className="small muted">Beating the closing price is the early sign of an edge; a few dozen results say little. The close is the sharp book's price at the last check before kickoff, for game bets only.</p>
        <div className="inline">
          <button className="btn btn--primary" onClick={() => record(blank)}>Record a bet</button>
          <button className="btn" disabled={grade.isPending || open.length === 0} onClick={check}>{grade.isPending ? "Checking…" : "Check results"}</button>
        </div>
      </section>

      <section className="stack stack--tight" aria-label="Open bets">
        <h2 className="h2">Open{open.length ? ` · ${usd(r.openStake)} at stake` : ""}</h2>
        {open.length === 0 ? <Empty title="No open bets" why="Bets you record appear here until the game is final." how="Tap a price on Best bets or Prices after placing it, or use Record a bet." /> : (
          <div className="card">{open.map((b) => <BetRow key={b.id} b={b} onClick={() => openBet(b.id)} />)}</div>
        )}
      </section>
      {settled.length > 0 && (
        <section className="stack stack--tight" aria-label="Settled bets">
          <h2 className="h2">Settled</h2>
          <div className="card">{settled.map((b) => <BetRow key={b.id} b={b} onClick={() => openBet(b.id)} />)}</div>
        </section>
      )}

      {picked && (
        <Sheet title={picked.description} onClose={closeBet}>
          <div className="stack stack--tight">
            <Facts className="small muted num" items={[bookName(picked.bookmaker), odds(decimalToAmerican(picked.price_decimal)), `stake ${usd2(picked.stake)}`, `placed ${ago(picked.placed_at)}`]} />
            {picked.away_team && <p className="small muted">{picked.away_team} at {picked.home_team} · {kickoff(picked.kickoff_at)}</p>}
            {picked.fair_prob != null && <p className="small muted num">True chance when placed {pct(picked.fair_prob, 1)}{picked.closing_fair != null ? ` · at the last price check before kickoff ${pct(picked.closing_fair, 1)}` : ""}.</p>}
            {picked.result !== "open" && <p className="small">{RESULT[picked.result]}{picked.graded_by === "score" ? ", settled from the final score" : ", marked by hand"}.</p>}
            <p className="eyebrow">{picked.result === "open" ? "How did it end?" : "Change the result"}</p>
            <div className="inline">
              {(["won", "lost", "void"] as const).filter((x) => x !== picked.result).map((x) => (
                <button key={x} className="btn btn--sm" disabled={settle.isPending} onClick={() => set(picked, x)}>{RESULT[x]}</button>
              ))}
              {picked.result !== "open" && <button className="btn btn--sm btn--quiet" disabled={settle.isPending} onClick={() => set(picked, "open")}>Back to open</button>}
            </div>
            <button className="btn btn--sm btn--quiet bad" disabled={remove.isPending}
              onClick={() => remove.mutate({ id: picked.id }, { onSuccess: () => { say("Bet removed from your record"); closeBet(); }, onError: (e) => say(`Couldn't remove it — ${e.message}`, true) })}>
              Remove from my record
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function BetRow({ b, onClick }: { b: Bet; onClick: () => void }) {
  const price = odds(decimalToAmerican(b.price_decimal));
  return (
    <button className="rowline rowline--tap" onClick={onClick}>
      <div className="grow"><p className="strong">{b.description}</p>
        <Facts as="span" className="small muted num" items={[bookName(b.bookmaker), price, `stake ${usd2(b.stake)}`]} />
        {b.result === "open"
          ? <Facts as="span" items={[b.kickoff_at ? kickoff(b.kickoff_at) : null, `placed ${ago(b.placed_at)}`]} />
          : <span className="small muted">{b.beat_close == null ? "No closing price to compare" : b.beat_close > 0 ? `Beat the close by ${pct(b.beat_close, 1)}` : `The close was ${pct(-b.beat_close, 1)} better`}</span>}
      </div>
      <div className="right num">
        {b.result === "open"
          ? <><p className="small muted">to win</p><p className="strong">{usd2(b.stake * (b.price_decimal - 1))}</p></>
          : <p className={`strong ${b.result === "won" ? "good" : b.result === "lost" ? "bad" : ""}`}>{b.result === "void" ? "Stake back" : `${(b.profit ?? 0) > 0 ? "+" : ""}${usd2(b.profit)}`}</p>}
      </div>
    </button>
  );
}
