"""nflverse ingestion via nflreadpy: teams, players, schedules, weekly player
stats, official injury reports. All free, keyless, updated nightly by the
nflverse GitHub Actions."""

from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import nflreadpy as nfl
import polars as pl
import psycopg

from .db import RunLogger, upsert_df
from .scoring import draftkings_nfl

log = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")

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
        raw = nfl.load_schedules(seasons)
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
        raw = nfl.load_player_stats(seasons, summary_level="week")
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
        raw = nfl.load_injuries(seasons).filter(pl.col("gsis_id").is_not_null())
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
