import { useMemo, useState } from "react";
import { Empty, ErrorNote, Loading } from "../components/ui";
import { usePropEdges, useQuotes, useSettings } from "../lib/api";
import { ago, bookName, kickoff, odds, pct, pts, signed, statName, usd } from "../lib/format";
import { arbSplit, decimalToAmerican, suggestedStake } from "../lib/stake";
import { DEFAULT_SETTINGS, type LineQuote, type PropEdge } from "../lib/types";

/** "NE to win", "DET −2.5", "Over 51.5" */
export function describe(q: LineQuote): string {
  const team = q.outcome === "home" ? q.home_team : q.away_team;
  if (q.market === "moneyline") return `${team} to win`;
  if (q.market === "spread") return `${team} ${signed(q.line)}`;
  return `${q.outcome === "over" ? "Over" : "Under"} ${pts(q.line)}`;
}

function Stale({ at }: { at: string | null | undefined }) {
  if (!at) return null;
  const hours = (Date.now() - Date.parse(at)) / 3600e3;
  return <p className={`small ${hours > 12 ? "warn" : "muted"}`} role="status">Prices seen {ago(at)}.{hours > 12 ? " They've likely moved — check the sportsbook before betting." : ""}</p>;
}

export function Bets() {
  const [tab, setTab] = useState<"games" | "players">("games");
  const quotes = useQuotes();
  const props = usePropEdges();
  const settings = useSettings();
  const s = settings.data ?? DEFAULT_SETTINGS;
  const mine = (book: string) => s.books.includes(book);
  const stake = (p: number | null, d: number | null) => (p == null || d == null ? 0 : suggestedStake(s.balance_bets, p, d, s.stake_fraction, s.max_stake_pct));

  const arbs = useMemo(() => {
    const by = new Map<string, LineQuote[]>();
    for (const q of quotes.data ?? []) {
      if ((q.arb_pct ?? 0) <= 0 || !q.is_best) continue;
      const k = `${q.game_id}|${q.market}|${q.number}`;
      by.set(k, [...(by.get(k) ?? []), q]);
    }
    return [...by.values()].filter((v) => v.length >= 2).map((v) => [v.find((q) => q.outcome === "home" || q.outcome === "over")!, v.find((q) => q.outcome === "away" || q.outcome === "under")!])
      .filter(([a, b]) => a && b && a.bookmaker !== "pinnacle" && b.bookmaker !== "pinnacle")
      .sort((x, y) => (y[0].arb_pct ?? 0) - (x[0].arb_pct ?? 0));
  }, [quotes.data]);
  const value = useMemo(() => (quotes.data ?? []).filter((q) => (q.ev ?? 0) >= 0.01 && q.bookmaker !== "pinnacle" && mine(q.bookmaker))
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0)).slice(0, 25), [quotes.data, s.books]);

  type Side = { e: PropEdge; side: "Over" | "Under"; price: number; fair: number | null; model: number | null; ev: number };
  const sides = (which: "fair" | "model"): Side[] => (props.data ?? []).flatMap((e): Side[] => [
    { e, side: "Over", price: e.over_decimal ?? 0, fair: e.fair_over, model: e.model_over, ev: (which === "fair" ? e.ev_over_fair : e.ev_over_model) ?? -1 },
    { e, side: "Under", price: e.under_decimal ?? 0, fair: e.fair_over == null ? null : 1 - e.fair_over, model: e.model_over == null ? null : 1 - e.model_over, ev: (which === "fair" ? e.ev_under_fair : e.ev_under_model) ?? -1 },
  ]).filter((x) => x.price > 1 && x.ev >= 0.02 && x.e.bookmaker !== "pinnacle" && mine(x.e.bookmaker)).sort((a, b) => b.ev - a.ev).slice(0, 20);

  if (quotes.isLoading || props.isLoading) return <Loading />;
  if (quotes.error) return <ErrorNote error={quotes.error} />;
  const fairSides = sides("fair"), modelSides = sides("model");

  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Sportsbooks · balance {usd(s.balance_bets)}</p>
        <h1 className="title">Bets</h1>
        <div className="chips" role="group" aria-label="Kind of bet">
          <button className="chip" aria-pressed={tab === "games"} onClick={() => setTab("games")}>Game bets</button>
          <button className="chip" aria-pressed={tab === "players"} onClick={() => setTab("players")}>Player bets</button>
        </div>
      </div>

      {tab === "games" ? (
        <>
          <Stale at={quotes.data?.[0]?.captured_at} />
          <section className="stack stack--tight" aria-label="Guaranteed profit">
            <div><h2 className="h2">Guaranteed profit</h2><p className="small muted">Two books disagree enough that backing both sides pays whatever happens.</p></div>
            {arbs.length === 0 ? <Empty title="Nothing right now" why="These gaps are rare and close within minutes." /> : arbs.map(([a, b]) => {
              const split = arbSplit(100, a.price_decimal, b.price_decimal);
              return (
                <div className="card card--pad" key={`${a.game_id}${a.market}${a.number}`}>
                  <div className="card__head"><p className="strong">{a.away_team} at {a.home_team}</p><span className="pill pill--ok">+{pct(a.arb_pct, 2)}</span></div>
                  {[[a, split.a], [b, split.b]].map(([q, amt]) => {
                    const x = q as LineQuote;
                    return <div className="rowline" key={x.outcome}><div className="grow"><p className="strong">{describe(x)}</p><p className="small muted">{bookName(x.bookmaker)}</p></div>
                      <p className="pnum num">{odds(x.price_american)}<small>stake {usd(amt as number)}</small></p></div>;
                  })}
                  <p className="small muted">Stake $100 in total this way and you're up ${split.profit.toFixed(2)} whichever side wins. Both books must still be showing these prices.</p>
                </div>
              );
            })}
          </section>
          <section className="stack stack--tight" aria-label="Better than the sharp price">
            <div><h2 className="h2">Better than the sharp price</h2><p className="small muted">Pinnacle's price with its margin removed is the best public estimate of the true chance. These books pay more than that.</p></div>
            {value.length === 0 ? <Empty title="Nothing beats the sharp price by 1%" why="That's the normal state of the market." how="Prices refresh Thursday, Saturday, Sunday and Monday." /> : (
              <div className="card">{value.map((q) => (
                <div className="rowline" key={`${q.game_id}${q.market}${q.number}${q.outcome}${q.bookmaker}`}>
                  <div className="grow"><p className="strong">{describe(q)}</p><p className="small muted">{q.away_team} at {q.home_team} · {kickoff(q.kickoff_at)} · {bookName(q.bookmaker)}</p></div>
                  <div className="right num"><p className="strong">{odds(q.price_american)} <span className="good">{signed((q.ev ?? 0) * 100)}%</span></p>
                    <p className="small muted">true chance {pct(q.fair_prob, 1)} · stake {usd(stake(q.fair_prob, q.price_decimal))}</p></div>
                </div>))}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <Stale at={props.data?.[0]?.captured_at} />
          <PropList title="Better than the sharp price" note="Same bet, same number, priced above Pinnacle's fair chance." rows={fairSides} chance={(x) => x.fair} stake={stake}
            empty={{ title: "No player bets beat the sharp price", why: "Books post these close to game day, and most are priced tightly." }} />
          <PropList title="Where the model disagrees" note="The model's chance is unproven until the weekly results show it beats the market. Treat these as leads, not bets." rows={modelSides} chance={(x) => x.model} stake={() => 0}
            empty={{ title: "No disagreements above 2%", why: "Either no player bets are posted yet or the model agrees with the books." }} />
        </>
      )}
    </div>
  );
}

function PropList({ title, note, rows, chance, stake, empty }: {
  title: string; note: string; rows: { e: PropEdge; side: string; price: number; ev: number; fair: number | null; model: number | null }[];
  chance: (x: { fair: number | null; model: number | null }) => number | null; stake: (p: number | null, d: number | null) => number; empty: { title: string; why: string };
}) {
  return (
    <section className="stack stack--tight" aria-label={title}>
      <div><h2 className="h2">{title}</h2><p className="small muted">{note}</p></div>
      {rows.length === 0 ? <Empty title={empty.title} why={empty.why} /> : (
        <div className="card">{rows.map((x) => {
          const st = stake(chance(x), x.price);
          return (
            <div className="rowline" key={`${x.e.player_id}${x.e.stat}${x.e.line}${x.e.bookmaker}${x.side}`}>
              <div className="grow"><p className="strong">{x.e.player_name} {x.side.toLowerCase()} {pts(x.e.line)} {statName(x.e.stat).toLowerCase()}</p>
                <p className="small muted">{x.e.team} · {bookName(x.e.bookmaker)} · model expects {pts(x.e.proj_mean)}</p></div>
              <div className="right num"><p className="strong">{odds(decimalToAmerican(x.price))} <span className="good">{signed(x.ev * 100)}%</span></p>
                <p className="small muted">chance {pct(chance(x), 1)}{st > 0 ? ` · stake ${usd(st)}` : ""}</p></div>
            </div>);
        })}</div>
      )}
    </section>
  );
}
