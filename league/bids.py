"""Load the guillotine league from Postgres, run `league.guillotine`, store and
print the weekly waiver answer.

Reads: fantasy_leagues, fantasy_roster_snapshots (latest), fantasy_transactions,
player_status_snapshots (Sleeper id → our player, status), projections_latest,
player_week_stats (season form), games (byes).
Writes: bsb.waiver_runs, bsb.waiver_recs (append-only; the app shows the latest run)."""

from __future__ import annotations

import logging
from datetime import timedelta

import psycopg
from psycopg.types.json import Jsonb

from .guillotine import Bid, League, Player, Result, Team, recommend

log = logging.getLogger(__name__)
SKILL = ("QB", "RB", "WR", "TE")


def load_league(conn: psycopg.Connection, league_id: str | None = None) -> League | None:
    row = conn.execute(
        """select r.league_id, r.captured_at from bsb.fantasy_roster_snapshots r
           where (%(l)s::text is null and r.is_me) or r.league_id = %(l)s
           order by r.captured_at desc limit 1""",
        {"l": league_id},
    ).fetchone()
    if not row:
        return None
    league_id, captured_at = row
    lg = conn.execute(
        "select season, roster_positions, settings from bsb.fantasy_leagues where league_id = %s", (league_id,)
    ).fetchone()
    season, slots, settings = lg
    settings = settings or {}
    if int(settings.get("type") or 0) != 3 and not settings.get("last_chopped_leg"):
        log.warning("league %s is not a guillotine league", league_id)
    budget0 = float(settings.get("waiver_budget") or 100)
    cw = conn.execute("select season, week from bsb.current_week()").fetchone()
    week = int(cw[1]) if cw and cw[0] == season else int(settings.get("leg") or 1)

    rosters = conn.execute(
        """select roster_id, owner_name, is_me, players, raw from bsb.fantasy_roster_snapshots
           where league_id = %s and captured_at = %s""",
        (league_id, captured_at),
    ).fetchall()
    alive = [r for r in rosters if r[3] and not ((r[4] or {}).get("settings") or {}).get("eliminated")]
    if not any(r[2] for r in alive):
        return None                                    # I am out (or not in this league)
    taken = {pid for r in alive for pid in r[3]}

    people = _players(conn, season, week)
    teams = [
        Team(
            roster_id=r[0], owner=r[1] or f"Team {r[0]}", is_me=bool(r[2]),
            budget=budget0 - float(((r[4] or {}).get("settings") or {}).get("waiver_budget_used") or 0),
            players=[people[pid] for pid in r[3] if pid in people and people[pid].pos in SKILL],
        )
        for r in alive
    ]
    free = [p for pid, p in people.items() if pid not in taken and p.pos in SKILL and max(p.level, p.proj or 0) >= 6]
    byes = _byes(conn, season, week)
    # weeks: a team is chopped every week until one is left
    last_week = week + len(teams) - 2
    return League(
        week=week, last_week=last_week, slots=list(slots or []), teams=teams, free_agents=free,
        bids=_bids(conn, league_id, budget0), byes=byes,
    )


def _players(conn, season: int, week: int) -> dict[str, Player]:
    rows = conn.execute(
        """with st as (
               select distinct on (s.source_player_id) s.source_player_id as sid, s.player_id, s.team, s.position,
                      s.injury_status, s.raw->>'full_name' as full_name, s.raw->>'status' as roster_status
               from bsb.player_status_snapshots s
               where s.source = 'sleeper' and s.captured_at > now() - interval '8 days'
               order by s.source_player_id, s.captured_at desc),
           form as (
               select w.player_id, count(*) as g, avg(w.fantasy_points_ppr) as avg_ppr,
                      avg(w.fantasy_points_ppr) filter (where w.week >= %(wk)s - 4) as recent
               from bsb.player_week_stats w
               where w.sport = 'nfl' and w.season = %(s)s and w.season_type = 'REG' and w.week < %(wk)s
               group by 1)
           select st.sid, coalesce(pl.display_name, st.full_name, st.sid), st.position, st.team, st.injury_status,
                  st.roster_status, p.ppr_mean, p.ppr_std, f.g, f.avg_ppr, f.recent
           from st
           left join bsb.players pl on pl.sport = 'nfl' and pl.player_id = st.player_id
           left join bsb.projections_latest p on p.player_id = st.player_id and p.season = %(s)s and p.week = %(wk)s
           left join form f on f.player_id = st.player_id
           where st.position in ('QB','RB','WR','TE')""",
        {"s": season, "wk": week},
    ).fetchall()
    fl = lambda v: float(v) if v is not None else None   # noqa: E731
    return {
        r[0]: Player(pid=r[0], name=r[1], pos=r[2], team=r[3], status=r[4], roster_status=r[5],
                     proj=fl(r[6]), proj_sd=fl(r[7]), games=int(r[8] or 0), avg=fl(r[9]), recent=fl(r[10]))
        for r in rows
    }


def _byes(conn, season: int, week: int) -> dict[str, set[int]]:
    rows = conn.execute(
        """select week, home_team, away_team from bsb.games
           where sport = 'nfl' and season = %s and week >= %s and week <= 18""",
        (season, week),
    ).fetchall()
    playing: dict[int, set[str]] = {}
    for w, h, a in rows:
        playing.setdefault(w, set()).update((h, a))
    teams = set().union(*playing.values()) if playing else set()
    return {t: {w for w, s in playing.items() if t not in s} for t in teams}


def _bids(conn, league_id: str, budget0: float) -> list[Bid]:
    rows = conn.execute(
        """select roster_id, player_id, bid, status, status_updated from bsb.fantasy_transactions
           where league_id = %s and type = 'waiver' and player_id is not null and roster_id is not null
           order by status_updated""",
        (league_id,),
    ).fetchall()
    wins = [(r[0], float(r[2] or 0), r[4]) for r in rows if r[3] == "complete"]
    out, runs = [], {}
    for rid, pid, bid, status, ts in rows:
        run = runs.setdefault(ts.date() if ts else None, len(runs))
        spent = sum(a for (r2, a, t2) in wins if r2 == rid and ts and t2 and t2 < ts - timedelta(hours=1))
        out.append(Bid(week=run, roster_id=rid, pid=pid, amount=float(bid or 0), won=status == "complete",
                       budget_before=budget0 - spent))
    return out


# ---------------------------------------------------------------------------
def save(conn: psycopg.Connection, league_id: str, res: Result) -> int:
    lg = res.league
    me_i = next(i for i, t in enumerate(lg.teams) if t.is_me)
    teams = [
        {"roster_id": t.roster_id, "owner": t.owner, "is_me": t.is_me, "budget": round(t.budget),
         "mean": round(float(res.team_mean[i]), 1), "chop": round(float(res.odds.chop_now[i]), 4),
         "win": round(float(res.odds.win[i]), 4)}
        for i, t in enumerate(lg.teams)
    ]
    run_id = conn.execute(
        """insert into bsb.waiver_runs (league_id, week, teams_left, budget, chop, win, dollar_value, teams, drops)
           values (%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
        (league_id, lg.week, len(lg.teams), round(lg.me.budget), float(res.odds.chop_now[me_i]),
         float(res.odds.win[me_i]), res.dollar_value, Jsonb(teams),
         Jsonb([{"name": p.name, "pos": p.pos, "loss": round(loss, 2)} for p, loss in res.drops[:4]])),
    ).fetchone()[0]
    for rank, r in enumerate(res.recs, 1):
        p = r.player
        conn.execute(
            """insert into bsb.waiver_recs (run_id, rank, sleeper_id, name, pos, team, status, proj, level, gain_now,
                   gain_avg, d_chop, d_win, bid_50, bid_80, bid_95, bid, win_at_bid, either_or, drop_name, rivals, can_outbid)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (run_id, rank, p.pid, p.name, p.pos, p.team, p.status, p.proj, r.level, r.gain_now, r.gain_avg,
             r.d_chop, r.d_win, r.bid_50, r.bid_80, r.bid_95, r.bid, r.win_at_bid, r.group, r.drop,
             Jsonb([{"owner": o, "bid": b} for o, b in r.top_rivals]), r.beats_all_but),
        )
    conn.commit()
    return run_id


def report(res: Result) -> str:
    lg = res.league
    lines = [f"Week {lg.week} · {len(lg.teams)} teams left · you have ${lg.me.budget:.0f}", ""]
    lines.append(f"{'team':18s} {'money':>6s} {'points':>7s} {'chopped':>8s} {'title':>6s}")
    order = sorted(range(len(lg.teams)), key=lambda i: res.team_mean[i])
    for i in order:
        t = lg.teams[i]
        lines.append(f"{('> ' if t.is_me else '  ') + t.owner:18s} {t.budget:6.0f} {res.team_mean[i]:7.1f} "
                     f"{res.odds.chop_now[i]:8.1%} {res.odds.win[i]:6.1%}")
    lines += ["", f"{'player':22s} {'pos':3s} {'+now':>5s} {'+avg':>5s} {'chop':>6s} {'title':>6s} "
                  f"{'50/80/95% price':>16s} {'bid':>5s} {'wins':>5s}  note"]
    for r in res.recs[:15]:
        note = ""
        if r.bid:
            note = f"[{r.group}] drop {r.drop}" + (f"; can outbid: {', '.join(r.beats_all_but)}" if r.beats_all_but else "; nobody can outbid")
        lines.append(f"{r.player.name[:22]:22s} {r.player.pos:3s} {r.gain_now:5.1f} {r.gain_avg:5.1f} {r.d_chop:+6.1%} "
                     f"{r.d_win:+6.1%} {f'{r.bid_50}/{r.bid_80}/{r.bid_95}':>16s} {r.bid or '':>5} "
                     f"{f'{r.win_at_bid:.0%}' if r.bid else '':>5s}  {note}")
    lines += ["", "Least valuable on your roster: " + ", ".join(f"{p.name} ({loss:.1f})" for p, loss in res.drops[:4])]
    return "\n".join(lines)


def run(conn: psycopg.Connection, league_id: str | None = None, write: bool = True, n_sim: int = 20000) -> Result | None:
    lg = load_league(conn, league_id)
    if lg is None:
        log.info("no live guillotine roster found")
        return None
    res = recommend(lg, n_sim=n_sim)
    if write:
        lid = league_id or conn.execute(
            "select league_id from bsb.fantasy_roster_snapshots where is_me order by captured_at desc limit 1"
        ).fetchone()[0]
        save(conn, lid, res)
    return res


