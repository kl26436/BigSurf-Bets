"""`bsb` command line. Every GitHub Actions job is one of these commands, so
anything the workflows do can be reproduced locally."""

from __future__ import annotations

import logging
from pathlib import Path

import typer

from . import db as _db
from .config import settings

app = typer.Typer(no_args_is_help=True, help="Big Surf Bets ingestion CLI")
db_app = typer.Typer(no_args_is_help=True, help="Database")
nfl_app = typer.Typer(no_args_is_help=True, help="nflverse data")
sleeper_app = typer.Typer(no_args_is_help=True, help="Sleeper (injury status + leagues)")
odds_app = typer.Typer(no_args_is_help=True, help="Sportsbook odds")
dk_app = typer.Typer(no_args_is_help=True, help="DraftKings salaries")
app.add_typer(db_app, name="db")
app.add_typer(nfl_app, name="nfl")
app.add_typer(sleeper_app, name="sleeper")
app.add_typer(odds_app, name="odds")
app.add_typer(dk_app, name="dk")

log = logging.getLogger("bsb")


def _seasons(seasons: str | None) -> list[int]:
    from .nflverse import current_season

    if not seasons:
        return [current_season()]
    if "-" in seasons:
        a, b = seasons.split("-")
        return list(range(int(a), int(b) + 1))
    return [int(s) for s in seasons.split(",")]


# --- db ---------------------------------------------------------------------

@db_app.command()
def migrate():
    """Apply supabase/migrations/*.sql (idempotent)."""
    _db.migrate(settings().db_url)


@db_app.command()
def ping():
    """Check the connection and print table row counts."""
    with _db.connect(settings().db_url) as conn:
        rows = conn.execute(
            """select relname, n_live_tup from pg_stat_user_tables
               where schemaname='bsb' order by relname"""
        ).fetchall()
        for name, n in rows:
            typer.echo(f"{name:32s} {n:>10,}")


# --- nflverse ---------------------------------------------------------------

@nfl_app.command()
def backfill(seasons: str = typer.Option("2021-2026", help="e.g. 2021-2026 or 2024,2025")):
    """Teams, players, schedules, weekly stats, injuries for the given seasons."""
    from . import nflverse as nv

    s = _seasons(seasons)
    with _db.connect(settings().db_url) as conn:
        nv.ingest_teams(conn)
        nv.ingest_players(conn)
        nv.ingest_schedules(conn, s)
        nv.ingest_player_week_stats(conn, s)
        nv.ingest_injury_reports(conn, s)


@nfl_app.command()
def weekly():
    """In-season refresh: current season schedules, stats, injuries + players."""
    from . import nflverse as nv

    s = [nv.current_season()]
    with _db.connect(settings().db_url) as conn:
        nv.ingest_players(conn)
        nv.ingest_schedules(conn, s)
        nv.ingest_player_week_stats(conn, s)
        nv.ingest_injury_reports(conn, s)


# --- sleeper ----------------------------------------------------------------

@sleeper_app.command()
def status():
    """Snapshot current injury/depth status for all active skill players."""
    from .sleeper import snapshot_status

    with _db.connect(settings().db_url) as conn:
        snapshot_status(conn)


@sleeper_app.command()
def leagues(username: str):
    """List this user's leagues for the current season (to find a league_id)."""
    from .sleeper_league import leagues_for_user

    for lg in leagues_for_user(username):
        typer.echo(f"{lg['league_id']}  {lg['name']}  ({lg.get('total_rosters')} teams)")


@sleeper_app.command()
def league(league_id: str, username: str = typer.Option(None, help="your Sleeper username, to flag your roster")):
    """Snapshot rosters + settings for a league."""
    from .sleeper_league import snapshot_league

    with _db.connect(settings().db_url) as conn:
        snapshot_league(conn, league_id, username)


# --- odds -------------------------------------------------------------------

@odds_app.command()
def oddspapi(days: int = 7):
    """Snapshot upcoming NFL boards from OddsPapi (uses ODDSPAPI_BOOKMAKERS)."""
    from .odds_oddspapi import snapshot_upcoming

    cfg = settings()
    if not cfg.oddspapi_key:
        raise typer.BadParameter("ODDSPAPI_API_KEY not set")
    with _db.connect(cfg.db_url) as conn:
        snapshot_upcoming(conn, cfg.oddspapi_key, list(cfg.oddspapi_bookmakers), days)


@odds_app.command()
def oddslink():
    """Snapshot upcoming NFL game lines from OddsLink."""
    from .odds_oddslink import snapshot_upcoming

    cfg = settings()
    if not cfg.oddslink_key:
        raise typer.BadParameter("ODDSLINK_API_KEY not set")
    with _db.connect(cfg.db_url) as conn:
        snapshot_upcoming(conn, cfg.oddslink_key)


# --- draftkings -------------------------------------------------------------

@dk_app.command("import-csv")
def dk_import_csv(path: Path, slate_name: str = typer.Option(None), slate_id: str = typer.Option(None)):
    """Import a DKSalaries.csv export."""
    from .draftkings import import_csv

    with _db.connect(settings().db_url) as conn:
        import_csv(conn, path, slate_name, slate_id)


@dk_app.command("fetch")
def dk_fetch(draft_group_id: int, out: Path = Path("data/dk")):
    """Fetch a draft group via the unofficial endpoint and import it."""
    from .draftkings import draftgroup_to_csv, fetch_draftgroup, import_csv

    out.mkdir(parents=True, exist_ok=True)
    csv = draftgroup_to_csv(fetch_draftgroup(draft_group_id), out / f"dk_{draft_group_id}.csv")
    with _db.connect(settings().db_url) as conn:
        import_csv(conn, csv, slate_name=f"DK draftgroup {draft_group_id}", site_slate_id=str(draft_group_id))


if __name__ == "__main__":
    app()
