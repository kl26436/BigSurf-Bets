"""Weekly scorecard: grade last week against what actually happened.

Three questions, kept in bsb.scorecards so the answers accumulate week by week:

  projections  Were the numbers we believed *at kickoff* accurate, and better than
               DraftKings' own average-points figure for the same players?
  lineups      What did each saved lineup score, and where did that land in the
               range the simulation gave it?
  props        Was the model's over/under probability closer to the truth than
               Pinnacle's no-vig price, and did the edges it flagged pay?

One week proves nothing — a single slate is a few hundred correlated outcomes.
The point is the running record."""

from __future__ import annotations

import json
import logging

import numpy as np
import polars as pl

from . import data, dst
from .features import POSITIONS, _played_rows, _player_ref

log = logging.getLogger(__name__)
PROP_STATS = ["attempts", "completions", "passing_yards", "passing_tds", "interceptions",
              "carries", "rushing_yards", "receptions", "receiving_yards"]


def completed_week(schedules: pl.DataFrame, season: int) -> int | None:
    """Latest week of `season` in which every game has a final score."""
    w = (
        schedules.filter(pl.col("season") == season).group_by("week")
        .agg(pl.col("home_score").is_null().sum().alias("open")).filter(pl.col("open") == 0)
    )
    return int(w["week"].max()) if w.height else None


def actuals(d: data.NFLData, season: int, week: int) -> pl.DataFrame:
    """What every skill player and DST actually scored. Players who dressed but
    recorded nothing are real zeros; players who did not play are absent."""
    wk = (pl.col("season") == season) & (pl.col("week") == week)
    skill = _played_rows(d, _player_ref(d.players)).filter(wk).select(
        "player_id", pl.col("pos").alias("position"), "team", "dk", "ppr", *PROP_STATS,
        (pl.col("rushing_tds") + pl.col("receiving_tds")).alias("anytime_td"),
    )
    d_ = dst.build(d).filter(wk & ~pl.col("is_future")).select(
        (pl.lit("DST_") + pl.col("team")).alias("player_id"), pl.lit("DST").alias("position"), "team", "dk",
    )
    return pl.concat([skill, d_], how="diagonal_relaxed")


def kickoff_projections(conn, season: int, week: int) -> pl.DataFrame:
    """Per player, the newest projection made before his game kicked off (or,
    if none was, the earliest one — flagged pre_kickoff = false)."""
    cur = conn.execute(
        """select distinct on (p.player_id)
                  p.player_id, p.position, p.dk_mean::float8, p.dk_p10::float8, p.dk_p90::float8,
                  p.ppr_mean::float8, p.run_id, coalesce(r.created_at <= g.kickoff_at, false) as pre_kickoff
           from bsb.projections p
           join bsb.model_runs r on r.id = p.run_id
           left join bsb.games g on g.sport = 'nfl' and g.game_id = p.game_id
           where p.sport = 'nfl' and p.season = %s and p.week = %s
           order by p.player_id, coalesce(r.created_at <= g.kickoff_at, false) desc,
                    case when r.created_at <= g.kickoff_at then r.created_at end desc, r.created_at asc""",
        (season, week),
    )
    cols = ["player_id", "position", "dk_mean", "dk_p10", "dk_p90", "ppr_mean", "run_id", "pre_kickoff"]
    return pl.DataFrame(cur.fetchall(), schema=cols, orient="row", infer_schema_length=None)


def _rank_corr(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 3:
        return None
    return float(np.corrcoef(a.argsort().argsort(), b.argsort().argsort())[0, 1])


def projection_metrics(proj: pl.DataFrame, act: pl.DataFrame, dk_avg: pl.DataFrame | None = None, min_proj: float = 5.0) -> dict:
    """Accuracy by position for players projected ≥ min_proj DK points (all DSTs).
    A projected player with no result did not play: he is counted separately,
    not scored as a zero — sitting a player out is an availability miss, not a
    projection miss."""
    j = proj.join(act.select("player_id", pl.col("dk").alias("actual")), on="player_id", how="left")
    rel = j.filter((pl.col("dk_mean") >= min_proj) | (pl.col("position") == "DST"))
    played = rel.filter(pl.col("actual").is_not_null())
    if dk_avg is not None and dk_avg.height:
        played = played.join(dk_avg, on="player_id", how="left")
    out: dict = {
        "n_projected": rel.height, "n_played": played.height, "did_not_play": rel.height - played.height,
        "pre_kickoff_share": round(float(proj["pre_kickoff"].mean()), 3) if proj.height else None, "by_position": {},
    }
    for pos in [*POSITIONS, "DST", "ALL"]:
        d = played if pos == "ALL" else played.filter(pl.col("position") == pos)
        if d.is_empty():
            continue
        y, p = d["actual"].to_numpy().astype(float), d["dk_mean"].to_numpy().astype(float)
        m = dict(
            n=d.height, mae=round(float(np.abs(p - y).mean()), 3), bias=round(float((p - y).mean()), 3),
            rank_corr=_rank_corr(p, y),
            cover_p10_p90=round(float(((y >= d["dk_p10"].to_numpy()) & (y <= d["dk_p90"].to_numpy())).mean()), 3),
        )
        if "dk_avg" in d.columns:  # head-to-head on players DK also has a number for
            both = d.filter(pl.col("dk_avg").is_not_null() & (pl.col("dk_avg") > 0))
            if both.height >= 5:
                yb = both["actual"].to_numpy().astype(float)
                m["vs_dk_avg"] = dict(
                    n=both.height, mae_model=round(float(np.abs(both["dk_mean"].to_numpy() - yb).mean()), 3),
                    mae_dk_avg=round(float(np.abs(both["dk_avg"].to_numpy().astype(float) - yb).mean()), 3),
                    rank_corr_model=_rank_corr(both["dk_mean"].to_numpy().astype(float), yb),
                    rank_corr_dk_avg=_rank_corr(both["dk_avg"].to_numpy().astype(float), yb),
                )
        out["by_position"][pos] = m
    return out


def lineup_metrics(lineups: pl.DataFrame) -> list[dict]:
    """lineups: set_id, mode, lineup_no, actual, p10, p50, p90, sim_mean, complete (all 9 players have a result);
    optionally proj, label, source, entered. A lineup built by hand has no simulated
    range: its expected score falls back to the plain projection and the range share is left out."""
    out = []
    has = set(lineups.columns)
    for (set_id, mode), g in lineups.group_by("set_id", "mode", maintain_order=True):
        done = g.filter(pl.col("complete"))
        if done.is_empty():
            continue
        a = done["actual"].to_numpy().astype(float)
        expected = pl.coalesce("sim_mean", "proj") if "proj" in has else pl.col("sim_mean")
        avg_expected = done.select(expected.mean()).item()
        ranged = done.filter(pl.col("p10").is_not_null() & pl.col("p90").is_not_null())
        m = dict(
            set_id=int(set_id), mode=mode, n=g.height, n_complete=done.height,
            avg_actual=round(float(a.mean()), 2), best_actual=round(float(a.max()), 2), worst_actual=round(float(a.min()), 2),
            avg_projected=None if avg_expected is None else round(float(avg_expected), 2),
            in_p10_p90=None, above_p90=None, below_p10=None,
        )
        if ranged.height:
            r = ranged["actual"].to_numpy().astype(float)
            lo, hi = ranged["p10"].to_numpy().astype(float), ranged["p90"].to_numpy().astype(float)
            m.update(in_p10_p90=round(float(((r >= lo) & (r <= hi)).mean()), 3),
                     above_p90=int((r > hi).sum()), below_p10=int((r < lo).sum()))
        for k in ("label", "source", "entered"):       # what the Results screen titles the set with
            if k in has:
                m[k] = g[k][0]
        if "lineup_entered" in has:                    # the lineups that were actually played, apart from the rest
            played = done.filter(pl.col("lineup_entered"))
            m["n_entered"] = int(g["lineup_entered"].sum())
            if played.height:
                e = played["actual"].to_numpy().astype(float)
                m.update(entered_avg_actual=round(float(e.mean()), 2), entered_best_actual=round(float(e.max()), 2))
        out.append(m)
    return out


# Which lineup sets a week's scorecard reports on: what was on the Lineups screen
# at the end of the week (the newest automatic set of each kind, and every set the
# user asked for or built that was not archived), plus anything marked as entered.
# Superseded automatic sets are rebuilt several times a day and would bury the rest.
GRADED_LINEUPS_SQL = """
select l.set_id, ls.mode, l.lineup_no, l.actual_points::float8, l.p10::float8, l.p50::float8,
       l.p90::float8, l.sim_mean::float8, l.actual_points is not null, l.proj::float8,
       ls.label, ls.source, ls.entered, l.entered
from bsb.lineups l join bsb.lineup_sets ls on ls.id = l.set_id
join bsb.dfs_slates sl on sl.id = ls.slate_id
where sl.season = %s and sl.week = %s
  and (ls.entered
       or (ls.archived_at is null
           and (ls.source <> 'auto'
                or ls.id = (select x.id from bsb.lineup_sets x
                            where x.slate_id = ls.slate_id and x.mode = ls.mode and x.source = 'auto'
                              and x.archived_at is null
                            order by x.created_at desc, x.id desc limit 1))))
order by l.set_id, l.lineup_no"""

GRADED_LINEUPS_COLUMNS = ["set_id", "mode", "lineup_no", "actual", "p10", "p50", "p90", "sim_mean", "complete", "proj",
                          "label", "source", "entered", "lineup_entered"]


def graded_lineups(conn, season: int, week: int) -> pl.DataFrame:
    rows = conn.execute(GRADED_LINEUPS_SQL, (season, week)).fetchall()
    return pl.DataFrame(rows, orient="row", infer_schema_length=None, schema=GRADED_LINEUPS_COLUMNS)


def run(conn, season: int | None = None, week: int | None = None, offline: bool = False) -> dict | None:
    from ingest.db import RunLogger, insert_df
    from ingest.nflverse import current_season
    from markets import props as props_mod

    season = season or current_season()
    d = data.load(season, season, offline=offline)
    week = week or completed_week(d.schedules, season)
    if not week:
        log.info("scorecard: no completed week in %s yet", season)
        return None
    proj = kickoff_projections(conn, season, week)
    if proj.is_empty():
        log.info("scorecard: no projections stored for %s week %s — nothing to grade", season, week)
        return None
    with RunLogger(conn, "model.scorecard") as run_log:
        act = actuals(d, season, week)
        conn.execute("delete from bsb.player_results where sport = 'nfl' and season = %s and week = %s", (season, week))
        insert_df(conn, "player_results", act.select("player_id", "position", "team", "dk", "ppr").with_columns(
            pl.lit("nfl").alias("sport"), pl.lit(season).alias("season"), pl.lit(week).alias("week")))

        cur = conn.execute(
            """select distinct on (s.player_id) s.player_id, s.avg_points::float8
               from bsb.dfs_salaries s join bsb.dfs_slates sl on sl.id = s.slate_id
               where sl.season = %s and sl.week = %s and s.player_id is not null and s.avg_points is not null
               order by s.player_id, sl.imported_at desc""",
            (season, week),
        )
        dk_avg = pl.DataFrame(cur.fetchall(), schema=["player_id", "dk_avg"], orient="row")
        metrics: dict = {"projections": projection_metrics(proj, act, dk_avg)}

        # lineups: a lineup's actual score counts only if all nine players have a result
        conn.execute(
            """update bsb.lineups l set actual_points = x.pts
               from (select lp.set_id, lp.lineup_no, sum(r.dk) as pts, count(r.dk) as n
                     from bsb.lineup_players lp
                     join bsb.lineup_sets ls on ls.id = lp.set_id
                     join bsb.dfs_slates sl on sl.id = ls.slate_id
                     left join bsb.player_results r on r.sport = 'nfl' and r.season = sl.season
                          and r.week = sl.week and r.player_id = lp.player_id
                     where sl.season = %s and sl.week = %s
                     group by 1, 2) x
               where l.set_id = x.set_id and l.lineup_no = x.lineup_no and x.n = 9""",
            (season, week),
        )
        lu = graded_lineups(conn, season, week)
        metrics["lineups"] = lineup_metrics(lu) if lu.height else []

        # props: write the settled stat onto every price for the week, then grade the last pre-game pricing
        long = act.filter(pl.col("position") != "DST").unpivot(
            [*PROP_STATS, "anytime_td"], index="player_id", variable_name="stat", value_name="actual"
        ).filter(pl.col("actual").is_not_null())
        conn.execute("create temp table _actual (player_id text, stat text, actual numeric) on commit drop")
        with conn.cursor() as c:
            c.executemany("insert into _actual values (%s, %s, %s)", long.rows())
        conn.execute(
            """update bsb.prop_prices p set actual = a.actual from _actual a
               where p.season = %s and p.week = %s and p.player_id = a.player_id and p.stat = a.stat""",
            (season, week),
        )
        cur = conn.execute(
            """select distinct on (p.player_id, p.stat, p.line, p.bookmaker)
                      p.player_id, p.stat, p.line::float8, p.bookmaker, p.over_decimal::float8, p.under_decimal::float8,
                      p.novig_over::float8, p.model_over::float8, p.actual::float8
               from bsb.prop_prices p left join bsb.games g on g.sport = 'nfl' and g.game_id = p.game_id
               where p.season = %s and p.week = %s and (g.kickoff_at is null or p.captured_at <= g.kickoff_at)
               order by p.player_id, p.stat, p.line, p.bookmaker, p.run_id desc""",
            (season, week),
        )
        pp = pl.DataFrame(cur.fetchall(), orient="row", infer_schema_length=None, schema=[
            "player_id", "stat", "line", "bookmaker", "over_decimal", "under_decimal", "novig_over", "model_over", "actual"])
        metrics["props"] = props_mod.grade(pp) if pp.height else {"n": 0}

        conn.execute(
            """insert into bsb.scorecards (sport, season, week, metrics) values ('nfl', %s, %s, %s::jsonb)
               on conflict (sport, season, week) do update set metrics = excluded.metrics, created_at = now()""",
            (season, week, json.dumps(metrics)),
        )
        run_log.rows = act.height
        run_log.detail.update(season=season, week=week)
        conn.commit()
    return {"season": season, "week": week, **metrics}


def to_text(r: dict) -> str:
    L = [f"Scorecard — {r['season']} week {r['week']}"]
    p = r["projections"]
    L.append(f"projections: {p['n_played']} graded, {p['did_not_play']} projected players did not play, "
             f"{(p['pre_kickoff_share'] or 0):.0%} from pre-kickoff runs")
    for pos, m in p["by_position"].items():
        s = f"  {pos:3s} n={m['n']:3d}  MAE {m['mae']:.2f}  bias {m['bias']:+.2f}  rank {m['rank_corr'] or 0:.2f}  80% band {m['cover_p10_p90']:.0%}"
        if "vs_dk_avg" in m:
            v = m["vs_dk_avg"]
            s += f"   | vs DK avg (n={v['n']}): MAE {v['mae_model']:.2f} vs {v['mae_dk_avg']:.2f}, rank {v['rank_corr_model'] or 0:.2f} vs {v['rank_corr_dk_avg'] or 0:.2f}"
        L.append(s)
    for s in r["lineups"]:
        L.append(f"lineups set {s['set_id']} ({s['mode']}): {s['n_complete']}/{s['n']} complete · avg {s['avg_actual']} "
                 f"(projected {s['avg_projected']}) · best {s['best_actual']}"
                 + (f" · {s['in_p10_p90']:.0%} inside the 80% range" if s.get("in_p10_p90") is not None else ""))
    pr = r["props"]
    if pr.get("n"):
        L.append(f"props: {pr['n']} settled")
        if "vs_pinnacle" in pr:
            v = pr["vs_pinnacle"]
            L.append(f"  vs Pinnacle (n={v['n']}): log loss model {v['logloss_model']:.4f} vs Pinnacle {v['logloss_pinnacle']:.4f} (lower is better)")
        if "model_edges" in pr:
            v = pr["model_edges"]
            L.append(f"  model-flagged edges: {v['n']} bets, {v['wins']} won, {v['units']:+.2f} units (ROI {v['roi']:+.1%}; model claimed {v['avg_ev_claimed']:+.1%})")
    else:
        L.append("props: none priced for this week")
    return "\n".join(L)
