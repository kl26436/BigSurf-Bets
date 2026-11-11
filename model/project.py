"""Upcoming-week projections: refresh data → rebuild features → retrain on
everything played so far → project the players expected to suit up.

Retraining every run is deliberate. It takes a few minutes, needs no model
registry, and means Tuesday's projections have already learned from Monday
night. The fitted model is pickled next to the output so single props can be
priced afterwards without retraining (`bsb model price`)."""

from __future__ import annotations

import logging
import pickle
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import numpy as np
import polars as pl

from . import data, dst, features, train
from .backtest import PROP_STATS
from .dist import QUANTILES

log = logging.getLogger(__name__)

MODEL_VERSION = "p2.2"  # p2.1: + DST · p2.2: trains from 2019
FIRST_SEASON = 2019   # two more seasons of training data: small but consistent gain (docs/model/experiments.md)
OUT_DIR = Path("data/projections")
# Sleeper injury_status values. Long-term ones hold whenever they were seen; a
# game designation (Out / Doubtful) belongs to one game and goes stale: Sleeper
# keeps showing last week's "Out" until the next report replaces it.
SLEEPER_LONG_TERM = ("IR", "PUP", "Sus", "NA", "COV", "DNR")
SLEEPER_GAME = ("Out", "Doubtful")
SLEEPER_OUT = (*SLEEPER_GAME, *SLEEPER_LONG_TERM)
DESIGNATION_HOURS = 28   # final injury reports land ~44h (Sun), ~28h (Thu) before kickoff
# DraftKings' Status column on a salary export
DK_OUT = ("OUT", "O", "IR", "D")
DK_STATUS_MAX_AGE_HOURS = 96


@dataclass
class Result:
    season: int
    week: int
    projections: pl.DataFrame
    model: train.Model
    n_out: int
    dst_model: dst.DSTModel | None = None


def sleeper_statuses(conn, max_age_hours: int = 48) -> tuple[set[str], set[str]]:
    """→ (out, stale_out) from each player's latest Sleeper status.

    out        long-term statuses (IR, PUP, suspended …), plus Out / Doubtful seen
               within DESIGNATION_HOURS of that team's next kickoff — i.e. this
               week's designation.
    stale_out  Out / Doubtful seen earlier in the week. It may be last week's
               designation, so it only counts when nothing fresher says otherwise
               (see inactive_ids)."""
    rows = conn.execute(
        """with latest as (
               select distinct on (player_id) player_id, injury_status, captured_at,
                      case team when 'LAR' then 'LA' else team end as team
               from bsb.player_status_snapshots
               where player_id is not null and captured_at > now() - make_interval(hours => %s)
               order by player_id, captured_at desc)
           select l.player_id, l.injury_status, l.captured_at,
                  (select min(g.kickoff_at) from bsb.games g
                   where g.sport = 'nfl' and g.kickoff_at > now() - interval '6 hours'
                     and g.kickoff_at < now() + interval '8 days' and l.team in (g.home_team, g.away_team))
           from latest l where l.injury_status is not null""",
        (max_age_hours,),
    ).fetchall()
    out, stale = set(), set()
    for pid, status, seen, kickoff in rows:
        if status in SLEEPER_LONG_TERM:
            out.add(pid)
        elif status in SLEEPER_GAME:
            fresh = kickoff is not None and seen >= kickoff - timedelta(hours=DESIGNATION_HOURS)
            (out if fresh else stale).add(pid)
    return out, stale


def sleeper_out_ids(conn, max_age_hours: int = 48) -> set[str]:
    """Every player Sleeper currently lists as out (fresh or stale)."""
    out, stale = sleeper_statuses(conn, max_age_hours)
    return out | stale


def _dk_status_rows(conn, max_age_hours: int) -> list[tuple[str, str]]:
    return conn.execute(
        """select distinct on (s.player_id) s.player_id, upper(coalesce(s.raw->>'Status', ''))
           from bsb.dfs_salaries s join bsb.dfs_slates sl on sl.id = s.slate_id
           where sl.site = 'draftkings' and sl.starts_at > now()
             and sl.imported_at > now() - make_interval(hours => %s)
             and s.player_id is not null and s.position <> 'DST'
           order by s.player_id, sl.imported_at desc""",
        (max_age_hours,),
    ).fetchall()


def dk_out_ids(conn, max_age_hours: int = DK_STATUS_MAX_AGE_HOURS) -> set[str]:
    """Players DraftKings tags Out / IR / Doubtful on a recently imported salary
    file for a slate that hasn't started. DK often flags a player days before
    the official injury report does; the age limit keeps a stale export from
    holding someone out after their status changes."""
    return {pid for pid, status in _dk_status_rows(conn, max_age_hours) if status in DK_OUT}


def dk_cleared_ids(conn, max_age_hours: int = DK_STATUS_MAX_AGE_HOURS) -> set[str]:
    """Players on a fresh upcoming DK slate that DK does *not* tag as out
    (healthy or Questionable). DK's tag is about the coming game."""
    return {pid for pid, status in _dk_status_rows(conn, max_age_hours) if status not in DK_OUT}


def inactive_ids(conn) -> tuple[set[str], set[str]]:
    """→ (out_ids, cleared_ids) for the upcoming week.

    Out = Sleeper long-term + this week's Sleeper designations + DK out tags,
    plus Sleeper's possibly-stale Out/Doubtful unless DraftKings lists the player
    as available for the coming slate. (Seen on 2026 week 10: four starters were
    Out in week 9, Questionable on DK for week 10, and still "Out" on Sleeper on
    Tuesday — dropping them was wrong.) Cleared = DK-available players, who are
    projected even after a long layoff."""
    out, stale = sleeper_statuses(conn)
    dk_out, cleared = dk_out_ids(conn), dk_cleared_ids(conn)
    return out | dk_out | (stale - cleared), cleared - out - dk_out


def _tidy_dst(pred: pl.DataFrame) -> pl.DataFrame:
    return pred.select(
        "season", "week", (pl.lit("DST_") + pl.col("team")).alias("player_id"),
        (pl.col("team") + pl.lit(" DST")).alias("player_name"), pl.lit("DST").alias("position"),
        "team", "opponent", "game_id", "is_home", pl.col("own_implied_total").alias("implied_total"), "spread_team",
        pl.col("proj_dk").round(2).alias("dk_mean"), pl.col("proj_dk_std").round(2).alias("dk_std"),
        *[pl.col(f"proj_dk_p{int(q * 100)}").round(2).alias(f"dk_p{int(q * 100)}") for q in QUANTILES],
        pl.col("proj_sacks").round(3).alias("dst_sacks"), pl.col("proj_interceptions").round(3).alias("dst_interceptions"),
        pl.col("proj_fumble_recoveries").round(3).alias("dst_fumble_recoveries"), pl.col("proj_tds").round(3).alias("dst_tds"),
        pl.col("proj_points_allowed").round(2).alias("dst_points_allowed"),
    )


def _tidy(model: train.Model, pred: pl.DataFrame) -> pl.DataFrame:
    p_td0 = (1 - train.prob_over(model, "rushing_tds", pred["proj_rushing_tds"].to_numpy(), 0.5)) * (
        1 - train.prob_over(model, "receiving_tds", pred["proj_receiving_tds"].to_numpy(), 0.5)
    )
    pos = pred["pos"].to_numpy()
    # per-stat quantiles so the app can show a range and Phase 3 can sanity-check lines
    qcols = []
    for stat in PROP_STATS:
        ok = np.isin(pos, train.SPECS[stat].positions)
        mu = pred[f"proj_{stat}"].to_numpy()
        qcols.append(
            pl.struct(
                [
                    pl.Series(f"p{int(q * 100)}", np.where(ok, np.round(model.dists[stat].quantile(mu, q), 1), np.nan)).fill_nan(None)
                    for q in QUANTILES
                ]
            ).alias(stat)
        )
    pts = []
    for k in ("dk", "ppr"):
        pts += [
            pl.col(f"proj_{k}").round(2).alias(f"{k}_mean"), pl.col(f"proj_{k}_std").round(2).alias(f"{k}_std"),
            *[pl.col(f"proj_{k}_p{int(q * 100)}").round(2).alias(f"{k}_p{int(q * 100)}") for q in QUANTILES],
        ]
    return pred.select(
        "season", "week", "player_id", "player_name", pl.col("pos").alias("position"), "team", "opponent",
        "game_id", "is_home", "implied_total", "spread_team",
        pl.when(pl.col("inj_doubtful") == 1).then(pl.lit("Doubtful"))
        .when(pl.col("inj_questionable") == 1).then(pl.lit("Questionable")).alias("injury_status"),
        *[pl.col(f"proj_{s}").round(3).alias(s) for s in train.SPECS],
        *pts,
        pl.Series("anytime_td_prob", np.round(1 - p_td0, 4)),
        pl.struct(qcols).alias("stat_quantiles"),
    ).sort("dk_mean", descending=True)


def run(
    season: int | None = None, week: int | None = None, out_ids: set[str] | None = None,
    offline: bool = False, first_season: int = FIRST_SEASON, force_ids: set[str] | None = None,
) -> Result:
    from ingest.nflverse import current_season

    season = season or current_season()
    d = data.load(first_season, season, offline=offline)
    week = week or data.next_week(d.schedules, season)
    if week is None:
        raise RuntimeError(f"No unplayed week left in {season}")
    df = features.build(d, upcoming=(season, week), out_ids=out_ids, force_ids=force_ids)
    fut = df.filter(pl.col("is_future"))
    if fut.is_empty():
        raise RuntimeError(f"No games/players found for {season} week {week}")
    seasons = list(range(first_season, season + 1))
    model, _ = train.fit(df, seasons)
    proj = _tidy(model, train.predict(model, fut))
    dst_df = dst.build(d, upcoming=(season, week))
    dst_model = dst.fit(dst_df, seasons)
    dst_proj = _tidy_dst(dst.predict(dst_model, dst_df.filter(pl.col("is_future"))))
    log.info("projected %d players + %d DSTs for %s week %s", proj.height, dst_proj.height, season, week)
    proj = pl.concat([proj, dst_proj], how="diagonal_relaxed").sort("dk_mean", descending=True)
    # mid-week (after Thursday night): only teams that still have their game to play
    still = data.open_teams(d.schedules, season, week)
    if still and proj.filter(pl.col("team").is_in(list(still))).height:
        dropped = proj.filter(~pl.col("team").is_in(list(still)))["team"].n_unique()
        if dropped:
            log.info("%d teams have already played week %s — not re-projected", dropped, week)
        proj = proj.filter(pl.col("team").is_in(list(still)))
    return Result(season, week, proj, model, len(out_ids or ()), dst_model)


def save_local(res: Result, out_dir: Path | None = None) -> Path:
    out = out_dir or OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    stem = out / f"projections_{res.season}_w{res.week:02d}"
    res.projections.write_parquet(stem.with_suffix(".parquet"))
    res.projections.drop("stat_quantiles").write_csv(stem.with_suffix(".csv"))
    with open(out / "model_latest.pkl", "wb") as f:
        pickle.dump({"model": res.model, "season": res.season, "week": res.week}, f)
    return stem.with_suffix(".csv")


def write_db(conn, res: Result, git_sha: str | None = None, inputs_hash: str | None = None) -> int:
    """Append a model run + its projections to Supabase (bsb.model_runs,
    bsb.projections). Runs are append-only; bsb.projections_latest serves the
    newest one per week."""
    from ingest.db import RunLogger, insert_df

    with RunLogger(conn, "model.project") as log_run:
        m = res.model
        run_id = conn.execute(
            """insert into bsb.model_runs
                   (sport, model_version, season, week, trained_seasons, n_train_rows, n_features,
                    n_players, n_ruled_out, metrics, git_sha, inputs_hash)
               values ('nfl', %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s) returning id""",
            (
                MODEL_VERSION, res.season, res.week, m.seasons, m.n_rows, len(m.features),
                res.projections.height, res.n_out,
                _json({**m.oof_metrics, **({"oof_mae_dst_dk": res.dst_model.oof_mae} if res.dst_model else {})}), git_sha,
                inputs_hash,
            ),
        ).fetchone()[0]
        df = res.projections.drop("player_name", "is_home", "implied_total", "spread_team").with_columns(
            pl.lit(run_id).alias("run_id"), pl.lit("nfl").alias("sport"),
        )
        log_run.rows = insert_df(conn, "projections", df)
        save_dists(conn, m, run_id)
        log_run.detail.update(run_id=run_id, season=res.season, week=res.week, ruled_out=res.n_out)
        conn.commit()
        return run_id


def save_dists(conn, model: train.Model, run_id: int | None) -> int:
    """Keep the fitted outcome shapes where the app can read them: one row per
    stat, replaced on every run (bsb.model_dists). With these and a player's
    projected mean the app prices any number without a round trip."""
    import json

    from .dist import NegBin

    n = 0
    for stat, d in model.dists.items():
        kind = "nb" if isinstance(d, NegBin) else "emp"
        conn.execute(
            """insert into bsb.model_dists (stat, kind, params, run_id) values (%s, %s, %s::jsonb, %s)
               on conflict (stat) do update set kind = excluded.kind, params = excluded.params,
                   run_id = excluded.run_id, updated_at = now()""",
            (stat, kind, json.dumps(d.to_json()), run_id),
        )
        n += 1
    return n


def inputs_fingerprint(conn, out_ids: set[str], cleared: set[str], git_sha: str | None = None) -> str:
    """Everything a projection run depends on, boiled down to one short hash:
    who is out, the newest stats / odds / slate, the week in play and the code.
    Two runs with the same fingerprint would produce the same numbers."""
    import hashlib
    import json

    row = conn.execute(
        """select
             (select max(finished_at) from bsb.ingest_runs where ok and job like 'nflverse.%%'),
             (select max(captured_at) from bsb.odds_snapshots),
             (select max(imported_at) from bsb.dfs_slates where starts_at > now()),
             (select season::text || '-' || week::text from bsb.games
               where sport = 'nfl' and home_score is null and kickoff_at > now() - interval '12 hours'
               order by kickoff_at limit 1)"""
    ).fetchone()
    blob = json.dumps([MODEL_VERSION, git_sha, sorted(out_ids), sorted(cleared), [str(x) for x in row]])
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def latest_fingerprint(conn) -> str | None:
    row = conn.execute("select inputs_hash from bsb.model_runs order by created_at desc limit 1").fetchone()
    return row[0] if row else None


def _json(d: dict) -> str:
    import json

    return json.dumps({k: round(float(v), 4) for k, v in d.items()})


def price(player: str, stat: str, line: float, out_dir: Path | None = None) -> list[dict]:
    """P(over/under) and fair odds for a prop, from the latest saved run."""
    out = out_dir or OUT_DIR
    with open(out / "model_latest.pkl", "rb") as f:
        saved = pickle.load(f)  # noqa: S301 — our own artifact
    model: train.Model = saved["model"]
    if stat not in model.dists:
        raise ValueError(f"unknown stat {stat!r}; choose from {sorted(model.dists)}")
    proj = pl.read_parquet(out / f"projections_{saved['season']}_w{saved['week']:02d}.parquet")
    hits = proj.filter(pl.col("player_name").str.to_lowercase().str.contains(player.lower(), literal=True))
    rows = []
    for r in hits.iter_rows(named=True):
        if r["position"] not in train.SPECS[stat].positions:
            continue
        p = float(train.prob_over(model, stat, np.array([r[stat]]), np.array([line]))[0])
        rows.append(dict(
            player=r["player_name"], team=r["team"], opponent=r["opponent"], week=r["week"], stat=stat,
            projection=r[stat], line=line, p_over=p, p_under=1 - p,
            fair_over=fair_american(p), fair_under=fair_american(1 - p),
        ))
    return rows


def fair_american(p: float) -> int | None:
    """Break-even American odds for probability p (bet only at a better price)."""
    if not 0 < p < 1:
        return None
    return round(-100 * p / (1 - p)) if p >= 0.5 else round(100 * (1 - p) / p)
