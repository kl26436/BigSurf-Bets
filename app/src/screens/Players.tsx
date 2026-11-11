import { useMemo, useState } from "react";
import { GamesPicker } from "../components/GamesPicker";
import { Empty, ErrorNote, Fresh, Icon, Loading, PlayerName, PosTag, RangeBar, Sheet, StatusPill } from "../components/ui";
import { usePlayerLog, usePool, useProjections, useSetOverride } from "../lib/api";
import { kickoff, pct, pts, signed, usd } from "../lib/format";
import { POS_LABEL, addPlayer, value, type Lineup } from "../lib/lineup";
import { useSheet, useTitle } from "../lib/nav";
import { useCurrentSlate } from "../lib/slate";
import { useStore, type PlayerSort } from "../lib/store";
import type { PoolPlayer, Pos } from "../lib/types";

const POSITIONS: (Pos | "ALL")[] = ["ALL", "QB", "RB", "WR", "TE", "DST"];
const SORTS: Record<PlayerSort, string> = { points: "Expected points", value: "Points per $1,000", salary: "Price" };
type Sort = PlayerSort;
/** One id for a row whether or not DraftKings games are loaded. */
const rowId = (p: PoolPlayer) => p.dk_id ?? p.player_id ?? p.name;

export function sortPlayers(rows: PoolPlayer[], sort: Sort): PoolPlayer[] {
  const key = (p: PoolPlayer) => (sort === "points" ? p.dk_mean ?? -1 : sort === "value" ? value(p) ?? -1 : p.salary);
  return [...rows].sort((a, b) => key(b) - key(a));
}

export function Players() {
  const { slate, isLoading } = useCurrentSlate();
  const pool = usePool(slate?.id);
  const all = useProjections(!isLoading && !slate);          // no DraftKings games loaded: show every projected player
  // search, position and sort live in the store: leaving the screen and coming back keeps them
  const { marks, setMark, playersView: { pos, sort, text }, setPlayersView } = useStore();
  const [openId, openPlayer, closePlayer] = useSheet<string>("player");
  useTitle("Players");

  const source = slate ? pool : all;
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const playable = (source.data ?? []).filter((p) => p.dk_mean != null)
      .filter((p) => (pos === "ALL" || p.pos === pos) && (!needle || p.name.toLowerCase().includes(needle) || p.team.toLowerCase() === needle));
    return sortPlayers(playable, slate ? sort : "points");
  }, [source.data, pos, sort, text, slate]);
  const max = useMemo(() => Math.max(30, ...(source.data ?? []).map((p) => p.dk_p90 ?? 0)), [source.data]);
  const open = openId == null ? null : (source.data ?? []).find((p) => rowId(p) === openId) ?? null;

  if (isLoading || source.isLoading) return <Loading />;
  if (source.error) return <ErrorNote error={source.error} />;
  const cycle = (p: PoolPlayer) => setMark(p.dk_id, marks[p.dk_id] === "lock" ? "exclude" : marks[p.dk_id] === "exclude" ? null : "lock");

  return (
    <div className="stack stack--tight">
      <div>
        <p className="eyebrow">{slate ? `DraftKings · ${slate.n_games} games` : "All games this week"}</p>
        <h1 className="title">Players</h1>
        <GamesPicker />
      </div>
      <input className="input" type="search" placeholder="Search a player or team" aria-label="Search players" value={text} onChange={(e) => setPlayersView({ text: e.target.value })} />
      <div className="chips" role="group" aria-label="Position">
        {POSITIONS.map((p) => (
          <button key={p} className="chip" aria-pressed={pos === p} onClick={() => setPlayersView({ pos: p })}>{p === "ALL" ? "All" : POS_LABEL[p]}</button>
        ))}
      </div>
      {slate && (
        <label className="field"><span>Sort by</span>
          <select className="input" value={sort} onChange={(e) => setPlayersView({ sort: e.target.value as Sort })}>
            {Object.entries(SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
      )}
      <div className="spread"><span className="small muted">{rows.length} players</span><Fresh at={source.data?.find((p) => p.projected_at)?.projected_at} /></div>
      {rows.length === 0 ? (
        <Empty title="No players match" why="Players who are out, or haven't played this season, don't get expected points." how="Clear the search or pick another position." />
      ) : (
        <div className="card">
          {rows.map((p) => (
            <div className="prow prow--5" key={rowId(p)}>
              <PosTag pos={p.pos} />
              <button className="grow" onClick={() => openPlayer(rowId(p))} aria-label={`${p.name} details`}>
                <PlayerName name={p.name} status={p.dk_status ?? p.injury_status} />
                <p className="pmeta ellipsis">{p.team} vs {p.opponent}{slate ? ` · ${usd(p.salary)}` : ""}{p.override_dk_mean != null ? " · your number" : ""}</p>
              </button>
              <div className="rangecell"><RangeBar p10={p.dk_p10} p25={p.dk_p25} p50={p.dk_p50} p75={p.dk_p75} p90={p.dk_p90} max={max} /></div>
              <p className="pnum num">{pts(p.dk_mean)}<small>{slate ? `${pts(value(p), 2)} per $1k` : `${pts(p.dk_p10, 0)}–${pts(p.dk_p90, 0)}`}</small></p>
              {slate ? (
                <button className={`iconbtn ${marks[p.dk_id] === "lock" ? "on" : marks[p.dk_id] === "exclude" ? "off" : ""}`} onClick={() => cycle(p)}
                  aria-label={marks[p.dk_id] === "lock" ? `${p.name} is in every lineup — tap to leave him out` : marks[p.dk_id] === "exclude" ? `${p.name} is left out — tap to clear` : `Put ${p.name} in every lineup`}>
                  <Icon name={marks[p.dk_id] === "exclude" ? "ban" : "lock"} />
                </button>
              ) : <span />}
            </div>
          ))}
        </div>
      )}
      {open && <PlayerSheet p={open} week={slate ? { season: slate.season, week: slate.week } : null} max={max} onClose={closePlayer} />}
    </div>
  );
}

const LINE: [string, string][] = [
  ["attempts", "Pass attempts"], ["passing_yards", "Passing yards"], ["passing_tds", "Passing touchdowns"], ["carries", "Carries"],
  ["rushing_yards", "Rushing yards"], ["targets", "Targets"], ["receptions", "Catches"], ["receiving_yards", "Receiving yards"],
  ["dst_sacks", "Sacks"], ["dst_interceptions", "Interceptions"], ["dst_points_allowed", "Points allowed"],
];

function PlayerSheet({ p, week, max, onClose }: { p: PoolPlayer; week: { season: number; week: number } | null; max: number; onClose: () => void }) {
  const log = usePlayerLog(p.player_id);
  const override = useSetOverride();
  const { marks, setMark, say, hand, setHand } = useStore();
  const pool = usePool(week ? p.slate_id : undefined);
  const [custom, setCustom] = useState("");
  const base = p.model_dk_mean ?? p.dk_mean ?? 0;
  const mark = marks[p.dk_id];

  function apply(mean: number | null) {
    if (!week || !p.player_id) return;
    override.mutate({ season: week.season, week: week.week, player_id: p.player_id, dk_mean: mean == null ? null : Math.round(mean * 10) / 10 },
      { onSuccess: () => { say(mean == null ? "Back to the model's number" : "Your number saved"); onClose(); }, onError: () => say("Couldn't save your number — try again", true) });
  }
  function addToLineup() {
    const byId = new Map((pool.data ?? []).map((x) => [x.dk_id, x]));
    const current: Lineup = hand.map((id) => (id ? byId.get(id) ?? null : null));
    const res = addPlayer(current, p);
    if (res.error) return say(res.error, true);
    setHand(res.lineup.map((x) => x?.dk_id ?? null));
    say(`${p.name} added to your lineup`);
    onClose();
  }
  const stats = LINE.filter(([k]) => Number(p[k] ?? 0) >= 0.5);

  return (
    <Sheet title={p.name} onClose={onClose}>
      <div className="stack stack--tight">
        <p className="small muted">{POS_LABEL[p.pos]} · {p.team} vs {p.opponent} · {kickoff(p.kickoff_at)} <StatusPill status={p.dk_status ?? p.injury_status} /></p>
        <dl className="kv kv--3">
          <div><dt>Expected points</dt><dd className="big big--accent num">{pts(p.dk_mean)}</dd></div>
          <div><dt>Likely range</dt><dd className="big num">{pts(p.dk_p10, 0)}–{pts(p.dk_p90, 0)}</dd></div>
          <div><dt>{week ? "Price" : "Team total"}</dt><dd className="big num">{week ? usd(p.salary) : pts(p.implied_total)}</dd></div>
        </dl>
        <RangeBar p10={p.dk_p10} p25={p.dk_p25} p50={p.dk_p50} p75={p.dk_p75} p90={p.dk_p90} max={max} />
        <p className="small muted">
          Team expected to score {pts(p.implied_total)} ({signed(p.team_spread)} spread).
          {p.anytime_td_prob != null && p.pos !== "DST" && p.pos !== "QB" ? ` Scores a touchdown ${pct(p.anytime_td_prob)} of the time.` : ""}
          {p.override_dk_mean != null ? ` You set ${pts(p.override_dk_mean)}; the model says ${pts(p.model_dk_mean)}.` : ""}
        </p>
        {stats.length > 0 && (
          <table className="table"><thead><tr><th>Expected stat line</th><th /></tr></thead>
            <tbody>{stats.map(([k, label]) => <tr key={k}><td>{label}</td><td className="num strong">{pts(Number(p[k]))}</td></tr>)}</tbody>
          </table>
        )}
        {(log.data?.length ?? 0) > 0 && (
          <div className="scroll-x">
            <table className="table"><thead><tr><th>Recent games</th><th>Points</th>{p.pos === "QB" ? <th>Pass yds</th> : <><th>Carries</th><th>Targets</th><th>Catches</th></>}</tr></thead>
              <tbody>{log.data!.map((g) => (
                <tr key={`${g.season}-${g.week}`}><td>Week {g.week} vs {g.opponent}</td><td className="num strong">{pts(Number(g.fantasy_points_dk))}</td>
                  {p.pos === "QB" ? <td className="num">{g.passing_yards}</td> : <><td className="num">{g.carries}</td><td className="num">{g.targets}</td><td className="num">{g.receptions}</td></>}</tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {week && p.player_id && (
          <div className="stack stack--tight">
            <p className="eyebrow">Think the model is wrong? Use your own number</p>
            <div className="inline">
              {[-0.2, -0.1, 0.1, 0.2].map((d) => (
                <button key={d} className="btn btn--sm" disabled={override.isPending} onClick={() => apply(base * (1 + d))}>{d > 0 ? "+" : "−"}{Math.abs(d * 100)}% · {pts(base * (1 + d))}</button>
              ))}
            </div>
            <div className="inline">
              <input className="input grow" inputMode="decimal" placeholder="Exact points" aria-label="Exact expected points" value={custom} onChange={(e) => setCustom(e.target.value)} />
              <button className="btn btn--sm" disabled={!(Number(custom) > 0 && Number(custom) <= 80) || override.isPending} onClick={() => apply(Number(custom))}>Use it</button>
              {p.override_dk_mean != null && <button className="btn btn--sm btn--quiet" onClick={() => apply(null)}>Use the model's</button>}
            </div>
            <p className="eyebrow">In the next lineup build</p>
            <div className="inline">
              <button className={`btn btn--sm ${mark === "lock" ? "btn--primary" : ""}`} onClick={() => setMark(p.dk_id, mark === "lock" ? null : "lock")}>{mark === "lock" ? "In every lineup" : "Put in every lineup"}</button>
              <button className={`btn btn--sm ${mark === "exclude" ? "btn--danger" : ""}`} onClick={() => setMark(p.dk_id, mark === "exclude" ? null : "exclude")}>{mark === "exclude" ? "Left out" : "Leave out"}</button>
              <button className="btn btn--sm" onClick={addToLineup}>Add to my lineup</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
