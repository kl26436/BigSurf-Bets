"""nflverse ingestion via nflreadpy: teams, players, schedules, weekly player
stats, official injury reports. All free, keyless, updated nightly by the
nflverse GitHub Actions."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import datetime
from zoneinfo import ZoneInfo

import nflreadpy as _nflreadpy
import polars as pl
import psycopg
from nflreadpy.config import update_config as _update_config

from .db import RunLogger, upsert_df
from .scoring import draftkings_nfl

log = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")

def _retry[T](
    fn: Callable[[], T], what: str, attempts: int = 10, base_delay: float = 3.0, max_delay: float = 60.0
) -> T:
    """GitHub's release CDN intermittently returns 5xx / times out — sometimes
    for many minutes during an incident. Retry with exponential backoff (3s →
    60s cap, ~7 min total) before giving up. A failed download is cheap to
    retry; a failed weekly job is annoying."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:  # nflreadpy wraps everything in ConnectionError/ValueError
            if i == attempts - 1:
                raise
            delay = min(max_delay, base_delay * (2**i))
            log.warning("%s failed (%s); retry %d/%d in %.0fs", what, e, i + 1, attempts - 1, delay)
            time.sleep(delay)
    raise AssertionError("unreachable")


# Give GitHub longer per request too (default 30s; their gateway 504s at ~10s
# when it's unhealthy, so this mostly matters for big files like pbp).
_update_config(timeout=90)


class _NFL:
    """Proxy over nflreadpy that wraps every load_* call in _retry."""

    def __getattr__(self, name: str):
        target = getattr(_nflreadpy, name)
        if not name.startswith("load_"):
            return target
        return lambda *a, **kw: _retry(lambda: target(*a, **kw), f"nflreadpy.{name}{a}")


nfl = _NFL()


def _load_by_season(loader: Callable[..., pl.DataFrame], seasons: list[int], **kw) -> pl.DataFrame:
    """Fetch one season per call so a CDN failure on one file only retries that
    file, instead of restarting the whole multi-season download."""
    frames = [loader(s, **kw) for s in seasons]
    frames = [f for f in frames if not f.is_empty()]
    return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()

# nflverse uses a few legacy abbreviations; normalise to current ones.
TEAM_FIX = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS", "JAC": "JAX"}


def _fix_team(col: str) -> pl.Expr:
    return pl.col(col).replace(TEAM_FIX)


# ---------------------------------------------------------------------------


def ingest_teams(conn: psycopg.Connection, sport: str = "nfl") -> int:
    with RunLogger(conn, "nflverse.teams") as run:
        raw = nfl.load_teams()
        # the teams file includes historical rows (OAK, SD, STL); keep current 32 only
        raw = raw.filter(~pl.col("team_abbr").is_in(list(TEAM_FIX.keys())))
        df = raw.select(
            pl.lit(sport).alias("sport"),
            pl.col("team_abbr"),
            pl.col("team_name"),
            pl.col("team_nick"),
            pl.col("team_conf").alias("conference"),
            pl.col("team_division").alias("division"),
            pl.col("team_color").alias("color_primary"),
            pl.col("team_color2").alias("color_secondary"),
            pl.col("team_logo_espn").alias("logo_url"),
        )
        run.rows = upsert_df(conn, "teams", df, pk=["sport", "team_abbr"], raw_from=raw)
        conn.commit()
        return run.rows


def ingest_players(conn: psycopg.Connection, sport: str = "nfl") -> int:
    with RunLogger(conn, "nflverse.players") as run:
        raw = nfl.load_players().filter(pl.col("gsis_id").is_not_null())
        df = raw.select(
            pl.lit(sport).alias("sport"),
            pl.col("gsis_id").alias("player_id"),
            pl.col("display_name"),
            pl.col("first_name"),
            pl.col("last_name"),
            pl.col("position"),
            pl.col("position_group"),
            _fix_team("latest_team").alias("latest_team"),
            pl.col("status"),
            pl.col("birth_date").str.to_date("%Y-%m-%d", strict=False),
            pl.col("height").cast(pl.Int32, strict=False).alias("height_in"),
            pl.col("weight").cast(pl.Int32, strict=False).alias("weight_lb"),
            pl.col("rookie_season").cast(pl.Int32, strict=False),
            pl.col("headshot").alias("headshot_url"),
            pl.col("espn_id").cast(pl.Utf8, strict=False),
            pl.col("pfr_id"),
        )
        run.rows = upsert_df(conn, "players", df, pk=["sport", "player_id"], raw_from=raw)
        conn.commit()
        return run.rows


def ingest_schedules(conn: psycopg.Connection, seasons: list[int], sport: str = "nfl") -> int:
    with RunLogger(conn, "nflverse.schedules") as run:
        raw = _load_by_season(nfl.load_schedules, seasons)
        # gameday 'YYYY-MM-DD' + gametime 'HH:MM' (ET) → UTC timestamptz
        kickoff = (
            pl.concat_str([pl.col("gameday"), pl.lit(" "), pl.col("gametime").fill_null("13:00")])
            .str.strptime(pl.Datetime, "%Y-%m-%d %H:%M", strict=False)
            .dt.replace_time_zone("America/New_York", ambiguous="earliest")
            .dt.convert_time_zone("UTC")
        )
        df = raw.select(
            pl.lit(sport).alias("sport"),
            pl.col("game_id"),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("game_type"),
            kickoff.alias("kickoff_at"),
            _fix_team("home_team").alias("home_team"),
            _fix_team("away_team").alias("away_team"),
            pl.col("home_score").cast(pl.Int32, strict=False),
            pl.col("away_score").cast(pl.Int32, strict=False),
            pl.col("roof"),
            pl.col("surface"),
            pl.col("temp").cast(pl.Int32, strict=False).alias("temp_f"),
            pl.col("wind").cast(pl.Int32, strict=False).alias("wind_mph"),
            pl.col("spread_line").cast(pl.Float64, strict=False),
            pl.col("total_line").cast(pl.Float64, strict=False),
            pl.col("home_moneyline").cast(pl.Int32, strict=False),
            pl.col("away_moneyline").cast(pl.Int32, strict=False),
            pl.col("espn").cast(pl.Utf8, strict=False).alias("espn_id"),
        )
        run.rows = upsert_df(conn, "games", df, pk=["sport", "game_id"], raw_from=raw)
        run.detail["seasons"] = seasons
        conn.commit()
        return run.rows


def ingest_player_week_stats(
    conn: psycopg.Connection, seasons: list[int], sport: str = "nfl"
) -> int:
    with RunLogger(conn, "nflverse.player_stats") as run:
        raw = _load_by_season(nfl.load_player_stats, seasons, summary_level="week")
        raw = raw.filter(pl.col("player_id").is_not_null())
        raw = raw.with_columns(draftkings_nfl())
        df = raw.select(
            pl.lit(sport).alias("sport"),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("season_type"),
            pl.col("player_id"),
            pl.col("game_id"),
            _fix_team("team").alias("team"),
            _fix_team("opponent_team").alias("opponent"),
            pl.col("position"),
            pl.col("completions").cast(pl.Int32, strict=False),
            pl.col("attempts").cast(pl.Int32, strict=False),
            pl.col("passing_yards").cast(pl.Int32, strict=False),
            pl.col("passing_tds").cast(pl.Int32, strict=False),
            pl.col("passing_interceptions").cast(pl.Int32, strict=False).alias("interceptions"),
            pl.col("carries").cast(pl.Int32, strict=False),
            pl.col("rushing_yards").cast(pl.Int32, strict=False),
            pl.col("rushing_tds").cast(pl.Int32, strict=False),
            pl.col("targets").cast(pl.Int32, strict=False),
            pl.col("receptions").cast(pl.Int32, strict=False),
            pl.col("receiving_yards").cast(pl.Int32, strict=False),
            pl.col("receiving_tds").cast(pl.Int32, strict=False),
            (
                pl.col("sack_fumbles_lost").fill_null(0)
                + pl.col("rushing_fumbles_lost").fill_null(0)
                + pl.col("receiving_fumbles_lost").fill_null(0)
            )
            .cast(pl.Int32)
            .alias("fumbles_lost"),
            pl.col("target_share").cast(pl.Float64, strict=False),
            pl.col("air_yards_share").cast(pl.Float64, strict=False),
            pl.col("wopr").cast(pl.Float64, strict=False),
            pl.col("passing_epa").cast(pl.Float64, strict=False),
            pl.col("rushing_epa").cast(pl.Float64, strict=False),
            pl.col("receiving_epa").cast(pl.Float64, strict=False),
            pl.col("fantasy_points_ppr").cast(pl.Float64, strict=False),
            pl.col("fantasy_points_dk").cast(pl.Float64, strict=False),
        )
        run.rows = upsert_df(
            conn,
            "player_week_stats",
            df,
            pk=["sport", "season", "week", "season_type", "player_id"],
            raw_from=raw,
        )
        run.detail["seasons"] = seasons
        conn.commit()
        return run.rows


def ingest_injury_reports(
    conn: psycopg.Connection, seasons: list[int], sport: str = "nfl"
) -> int:
    with RunLogger(conn, "nflverse.injuries") as run:
        raw = _load_by_season(nfl.load_injuries, seasons).filter(pl.col("gsis_id").is_not_null())
        # one row per player-week: keep the latest-looking report (last row wins)
        raw = raw.unique(subset=["season", "week", "gsis_id"], keep="last")
        df = raw.select(
            pl.lit(sport).alias("sport"),
            pl.col("season").cast(pl.Int32),
            pl.col("week").cast(pl.Int32),
            pl.col("gsis_id").alias("player_id"),
            _fix_team("team").alias("team"),
            pl.col("position"),
            pl.col("report_status"),
            pl.col("report_primary_injury").alias("report_injury"),
            pl.col("practice_status"),
            pl.col("practice_primary_injury").alias("practice_injury"),
        )
        run.rows = upsert_df(
            conn, "injury_reports", df, pk=["sport", "season", "week", "player_id"], raw_from=raw
        )
        run.detail["seasons"] = seasons
        conn.commit()
        return run.rows


def current_season(now: datetime | None = None) -> int:
    """NFL season label = year the season started (Sept). Jan–Feb belong to prior year."""
    now = now or datetime.now(ET)
    return now.year if now.month >= 3 else now.year - 1
