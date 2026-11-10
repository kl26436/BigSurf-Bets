"""Load the nflverse frames the model needs.

The model reads nflverse directly (same source the Phase 1 ingest lands in
Supabase) so training needs no database and runs anywhere: laptop, CI, Actions.
Frames are cached as parquet under data/cache (git-ignored)."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import polars as pl

log = logging.getLogger(__name__)

CACHE_DIR = Path("data/cache")
# 2019–2020 are loaded only to warm up rolling features for the 2021 rows.
WARMUP_SEASONS = 2
TEAM_FIX = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS", "JAC": "JAX"}


@dataclass
class NFLData:
    stats: pl.DataFrame      # weekly player stats (nflverse load_player_stats)
    schedules: pl.DataFrame  # games incl. closing/current spread + total, starting QBs
    injuries: pl.DataFrame   # official weekly injury reports
    snaps: pl.DataFrame      # PFR snap counts
    players: pl.DataFrame    # player reference (ids, birth date, draft, latest team)
    team_stats: pl.DataFrame | None = None  # weekly team stats incl. defense/special teams (DST model)


def _fix_teams(df: pl.DataFrame, cols: list[str]) -> pl.DataFrame:
    return df.with_columns([pl.col(c).replace(TEAM_FIX) for c in cols if c in df.columns])


def _is_final(path: Path, season: int) -> bool:
    """A cached season file is trusted only if it was written after that
    season ended (March of the following year) — a file cached mid-season must
    not be served as the finished season once the calendar rolls over."""
    if not path.exists():
        return False
    written = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    return written >= datetime(season + 1, 3, 1, tzinfo=UTC)


def _load_seasons(name: str, seasons: list[int], refresh_from: int, cache: Path, **kw) -> pl.DataFrame:
    """One file per season. Completed seasons never change, so they are served
    from cache; seasons >= refresh_from are always re-downloaded (unless
    refresh_from is past the last season, i.e. offline mode)."""
    from ingest.nflverse import nfl  # retrying proxy over nflreadpy

    loader = getattr(nfl, f"load_{name}")
    frames = []
    for s in seasons:
        path = cache / f"{name}_{s}.parquet"
        if s < refresh_from and (_is_final(path, s) or (path.exists() and refresh_from > seasons[-1])):
            frames.append(pl.read_parquet(path))
            continue
        t0 = time.time()
        df = loader(s, **kw)
        df.write_parquet(path)
        log.info("nflverse %s %s: %d rows (%.1fs)", name, s, df.height, time.time() - t0)
        frames.append(df)
    frames = [f for f in frames if not f.is_empty()]
    # column dtypes drift between seasons' files; pin the join keys
    return pl.concat(frames, how="diagonal_relaxed").with_columns(
        pl.col("season").cast(pl.Int32), pl.col("week").cast(pl.Int32)
    )


def load(
    first_season: int, last_season: int, cache_dir: Path | None = None, offline: bool = False
) -> NFLData:
    """Frames for first_season-WARMUP_SEASONS … last_season. The last season is
    always refreshed; earlier ones come from cache when present. `offline=True`
    serves everything from cache (fast iteration, reproducible backtests)."""
    from ingest.nflverse import nfl

    cache = cache_dir or CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    seasons = list(range(first_season - WARMUP_SEASONS, last_season + 1))
    fresh = last_season + 1 if offline else last_season
    stats = _load_seasons("player_stats", seasons, fresh, cache, summary_level="week")
    schedules = _load_seasons("schedules", seasons, fresh, cache)
    injuries = _load_seasons("injuries", seasons, fresh, cache)
    snaps = _load_seasons("snap_counts", seasons, fresh, cache)
    team_stats = _load_seasons("team_stats", seasons, fresh, cache, summary_level="week")
    if offline and (cache / "players.parquet").exists():
        players = pl.read_parquet(cache / "players.parquet")
    else:
        players = nfl.load_players()
        players.write_parquet(cache / "players.parquet")
    return NFLData(
        stats=_fix_teams(stats, ["team", "opponent_team"]),
        schedules=_fix_teams(schedules, ["home_team", "away_team"]),
        injuries=_fix_teams(injuries, ["team"]),
        snaps=_fix_teams(snaps, ["team", "opponent"]),
        players=_fix_teams(players, ["latest_team"]),
        team_stats=_fix_teams(team_stats, ["team", "opponent_team"]),
    )


def latest_completed_week(schedules: pl.DataFrame, season: int) -> int:
    """Last week of `season` in which at least one game has a final score."""
    done = schedules.filter((pl.col("season") == season) & pl.col("home_score").is_not_null())
    return int(done["week"].max()) if done.height else 0


def _open_games(schedules: pl.DataFrame, season: int, today: date | None = None) -> pl.DataFrame:
    """Games of `season` still to be played: no final score, and not dated before
    today (US Eastern). The date test keeps a game whose score nflverse has not
    posted yet (Tuesday morning after Monday night) from holding the week open."""
    today = today or datetime.now(ZoneInfo("America/New_York")).date()
    return schedules.filter(pl.col("season") == season).with_columns(
        pl.col("gameday").cast(pl.Utf8).str.to_date("%Y-%m-%d", strict=False).alias("_day")
    ).filter(pl.col("home_score").is_null() & (pl.col("_day") >= today))


def next_week(schedules: pl.DataFrame, season: int, today: date | None = None) -> int | None:
    """The week to project: the earliest week of `season` that still has a game
    to play. It stays on the current week from Thursday night through Monday
    night — the Sunday-morning run must re-project *this* week with the final
    injury news, not jump to the next one because Thursday's game is over."""
    g = _open_games(schedules, season, today)
    return int(g["week"].min()) if g.height else None


def open_teams(schedules: pl.DataFrame, season: int, week: int, today: date | None = None) -> set[str]:
    """Teams whose game in (season, week) has not been played yet."""
    g = _open_games(schedules, season, today).filter(pl.col("week") == week)
    return set(g["home_team"].to_list()) | set(g["away_team"].to_list())
