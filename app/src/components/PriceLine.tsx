import { useMemo, useState } from "react";
import { useModelDists, useProjections } from "../lib/api";
import { PRICED, fairAmerican, probOver, startLine } from "../lib/dist";
import { ago, kickoff, odds, pct, pts, statName } from "../lib/format";
import { parsePrice, type BetDraft } from "../lib/prices";
import { suggestedStake } from "../lib/stake";
import type { PoolPlayer, Settings } from "../lib/types";
import { vsFair } from "./BetSheet";
import { Empty, ErrorNote, Facts, Loading, PlayerName, PosTag, Stepper } from "./ui";

type Side = "over" | "under";

/** What the model expects of a player for one stat (a touchdown is a chance, not a count). */
function expected(p: PoolPlayer, stat: string): number | null {
  const v = stat === "anytime_td" ? p.anytime_td_prob : (p[stat] as number | null | undefined);
  return v == null ? null : Number(v);
}

/** Any player, any stat, any number: the model's chance, the fair price, and whether an offered price is worth taking. */
export function PriceLine({ s, record }: { s: Settings; record: (d: BetDraft) => void }) {
  const players = useProjections();
  const dists = useModelDists();
  const [text, setText] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [stat, setStat] = useState<string | null>(null);
  const [line, setLine] = useState(0.5);
  const [side, setSide] = useState<Side>("over");
  const [offered, setOffered] = useState("");

  const priced = useMemo(() => (players.data ?? []).filter((p) => p.pos in PRICED && p.player_id), [players.data]);
  const matches = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (t ? priced.filter((p) => p.name.toLowerCase().includes(t) || p.team.toLowerCase() === t) : priced).slice(0, 8);
  }, [priced, text]);
  const player = priced.find((p) => p.player_id === playerId) ?? null;

  if (players.isLoading || dists.isLoading) return <Loading />;
  if (players.error) return <ErrorNote error={players.error} />;
  if (priced.length === 0) return <Empty title="No expected points yet this week" why="A price needs this week's numbers for the player." how="They arrive with the next refresh." />;
  if ((dists.data?.size ?? 0) === 0) {
    return <Empty title="Not ready yet" why="Pricing uses figures the next refresh of the numbers saves for the first time." how="It will work after that refresh, with nothing to do here." />;
  }

  function choose(p: PoolPlayer) {
    const first = PRICED[p.pos].find((k) => (expected(p, k) ?? 0) > 0) ?? PRICED[p.pos][0];
    setPlayerId(p.player_id);
    pick(p, first);
    setText("");
  }
  function pick(p: PoolPlayer, k: string) {
    setStat(k);
    setLine(startLine(expected(p, k) ?? 0));
    setOffered("");
  }

  if (!player || !stat) {
    return (
      <section className="stack stack--tight" aria-label="Price a line">
        <div><h2 className="h2">Price a line</h2><p className="small muted">Pick a player, a stat and a number. You get the model's chance of going over, the price that would be fair, and whether the price you're offered is worth taking.</p></div>
        <input className="input" type="search" placeholder="Search a player or team" aria-label="Search players" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="card">
          {matches.map((p) => (
            <button className="prow" key={p.player_id} onClick={() => choose(p)}>
              <PosTag pos={p.pos} />
              <div className="grow"><PlayerName name={p.name} status={p.injury_status} /><p className="pmeta ellipsis">{p.team} vs {p.opponent} · {kickoff(p.kickoff_at)}</p></div>
              <p className="pnum num">{pts(p.dk_mean)}<small>expected</small></p>
            </button>
          ))}
          {matches.length === 0 && <p className="muted small card--pad">Nobody matches. Only players with a game still to play this week can be priced.</p>}
        </div>
      </section>
    );
  }

  const mean = expected(player, stat);
  const td = stat === "anytime_td";
  const dist = dists.data?.get(stat);
  const over = mean == null ? null : td ? mean : dist ? probOver(dist, mean, line) : null;
  const chance = over == null ? null : side === "over" ? over : 1 - over;
  const price = parsePrice(offered);
  const edge = chance != null && price != null ? chance * price - 1 : null;
  const stake = chance != null && price != null ? suggestedStake(s.balance_bets, chance, price, s.stake_fraction, s.max_stake_pct) : 0;
  const what = td ? `${player.name} ${side === "over" ? "to score a touchdown" : "not to score a touchdown"}`
    : `${player.name} ${side} ${pts(line)} ${statName(stat).toLowerCase()}`;
  const sideName = (x: Side) => (td ? (x === "over" ? "Scores" : "Doesn't score") : `${x === "over" ? "Over" : "Under"} ${pts(line)}`);

  return (
    <section className="stack stack--tight" aria-label="Price a line">
      <div className="card card--pad">
        <div className="prow">
          <PosTag pos={player.pos} />
          <div className="grow"><PlayerName name={player.name} status={player.injury_status} /><p className="pmeta ellipsis">{player.team} vs {player.opponent} · {kickoff(player.kickoff_at)}</p></div>
          <button className="btn btn--sm btn--quiet" onClick={() => { setPlayerId(null); setStat(null); }}>Change</button>
        </div>
        <div className="chips chips--wrap" role="group" aria-label="Stat">
          {PRICED[player.pos].filter((k) => expected(player, k) != null).map((k) => (
            <button key={k} className="chip" aria-pressed={stat === k} onClick={() => pick(player, k)}>{statName(k)}</button>
          ))}
        </div>
      </div>

      {over == null ? <Empty title="No number for this stat" why="The model has nothing for this player and stat this week." /> : (
        <>
          <div className="card card--pad stack stack--tight">
            {!td && <Stepper label={`${statName(stat)} — the number`} value={line} onChange={setLine} min={0.5} max={600} step={stat.endsWith("yards") ? 5 : 1} format={(v) => pts(v)} />}
            <p className="small muted num">{td ? `The model gives him a ${pct(mean, 0)} chance of a rushing or receiving touchdown.` : `Expected: ${pts(mean)} ${statName(stat).toLowerCase()}.`}</p>
            <div>
              {(["over", "under"] as Side[]).map((x) => {
                const p = x === "over" ? over : 1 - over;
                return (
                  <div className="rowline" key={x}>
                    <div className="grow"><p className="strong">{sideName(x)}</p><p className="small muted">Fair price {odds(fairAmerican(p))}</p></div>
                    <p className="pnum num">{pct(p, 1)}<small>chance</small></p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card card--pad stack stack--tight">
            <p className="strong">Offered a price?</p>
            <div className="chips" role="group" aria-label="Side">
              {(["over", "under"] as Side[]).map((x) => <button key={x} className="chip" aria-pressed={side === x} onClick={() => setSide(x)}>{sideName(x)}</button>)}
            </div>
            <label className="field"><span>Price at the sportsbook</span>
              <input className="input" type="text" inputMode="text" autoCapitalize="off" placeholder="+135 or −110" aria-invalid={offered !== "" && price == null} value={offered} onChange={(e) => setOffered(e.target.value)} />
            </label>
            {offered !== "" && price == null && <p className="small bad" role="alert">Write the price the way the book shows it: +135, −110, or 2.35.</p>}
            {edge != null && (
              <p className={`small num ${edge >= 0.02 ? "good" : edge < 0 ? "bad" : ""}`} role="status">
                By the model this price is {vsFair(edge)}.{edge >= 0.02 ? (stake >= 1 ? ` A stake of $${stake} fits your settings.` : " The stake that fits your settings is under $1.") : " Not a bet at this price."}
              </p>
            )}
            <button className="btn" disabled={price == null} onClick={() => record({ kind: "player", description: what, bookmaker: "", price_decimal: price, game_id: player.game_id,
              market: stat, number: td ? 0.5 : line, outcome: side, player_id: player.player_id, fair_prob: null, stake: edge != null && edge >= 0.02 ? stake : 0 })}>
              Record this bet
            </button>
          </div>
          <Facts items={["The chance is the model's, not the market's", `numbers from ${ago(player.projected_at)}`]} />
          <p className="small muted">How the model's chances have done against the sharp price is on Results. Until that record is a few weeks long, treat a gap between the model and a book as a question, not an edge.</p>
        </>
      )}
    </section>
  );
}
