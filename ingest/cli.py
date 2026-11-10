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
model_app = typer.Typer(no_args_is_help=True, help="Projection model (needs the [model] extra)")
app.add_typer(db_app, name="db")
app.add_typer(nfl_app, name="nfl")
app.add_typer(sleeper_app, name="sleeper")
app.add_typer(odds_app, name="odds")
app.add_typer(dk_app, name="dk")
app.add_typer(model_app, name="model")

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

def _run_steps(conn, steps: list[tuple[str, callable]]) -> None:
    """Run every step even if one fails (each step is its own transaction and
    logs to bsb.ingest_runs), then exit non-zero if anything failed. A GitHub
    CDN hiccup on one file shouldn't cost us the other four."""
    failed = []
    for name, fn in steps:
        try:
            fn()
        except Exception as e:  # already logged by RunLogger
            failed.append((name, e))
            conn.rollback()
    if failed:
        typer.echo("\nFAILED steps:", err=True)
        for name, e in failed:
            typer.echo(f"  {name}: {str(e)[:200]}", err=True)
        typer.echo("Re-run the same command to retry just these (all steps are idempotent).", err=True)
        raise typer.Exit(1)


@nfl_app.command()
def backfill(
    seasons: str = typer.Option("2021-2026", help="e.g. 2021-2026 or 2024,2025"),
    only: str = typer.Option(
        None, help="comma-separated subset of: teams,players,schedules,player_stats,injuries"
    ),
):
    """Teams, players, schedules, weekly stats, injuries for the given seasons."""
    from . import nflverse as nv

    s = _seasons(seasons)
    with _db.connect(settings().db_url) as conn:
        steps = [
            ("teams", lambda: nv.ingest_teams(conn)),
            ("players", lambda: nv.ingest_players(conn)),
            ("schedules", lambda: nv.ingest_schedules(conn, s)),
            ("player_stats", lambda: nv.ingest_player_week_stats(conn, s)),
            ("injuries", lambda: nv.ingest_injury_reports(conn, s)),
        ]
        if only:
            want = {w.strip() for w in only.split(",")}
            unknown = want - {n for n, _ in steps}
            if unknown:
                raise typer.BadParameter(f"unknown step(s): {sorted(unknown)}")
            steps = [st for st in steps if st[0] in want]
        _run_steps(conn, steps)


@nfl_app.command()
def weekly():
    """In-season refresh: current season schedules, stats, injuries + players."""
    from . import nflverse as nv

    s = [nv.current_season()]
    with _db.connect(settings().db_url) as conn:
        _run_steps(
            conn,
            [
                ("players", lambda: nv.ingest_players(conn)),
                ("schedules", lambda: nv.ingest_schedules(conn, s)),
                ("player_stats", lambda: nv.ingest_player_week_stats(conn, s)),
                ("injuries", lambda: nv.ingest_injury_reports(conn, s)),
            ],
        )


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


# --- model ------------------------------------------------------------------

@model_app.command("backtest")
def model_backtest(
    train_seasons: str = typer.Option("2021-2025", "--train", help="seasons to fit on"),
    test: int = typer.Option(2026, help="held-out season to score"),
    weeks: str = typer.Option(None, help="week range within the test season, e.g. 1-9"),
    out: str = typer.Option(None, help="write the markdown report here"),
    offline: bool = typer.Option(False, help="use cached nflverse files only"),
):
    """Train on past seasons, score a later one, print accuracy + calibration."""
    from model import backtest, data, features

    tr = _seasons(train_seasons)
    d = data.load(min(tr), test, offline=offline)
    wk = tuple(int(x) for x in weeks.split("-")) if weeks else None
    report = backtest.to_markdown(backtest.run(features.build(d), tr, test, wk))
    typer.echo(report)
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(report, encoding="utf-8")


@model_app.command("project")
def model_project(
    season: int = typer.Option(None, help="default: current season"),
    week: int = typer.Option(None, help="default: next unplayed week"),
    write: bool = typer.Option(True, help="write to Supabase (bsb.projections); --no-write for a local dry run"),
    offline: bool = typer.Option(False, help="use cached nflverse files only"),
    top: int = typer.Option(25, help="rows to print"),
):
    """Refresh data, retrain, project the upcoming week. With --write, players
    Sleeper lists as out are excluded and their usage is redistributed."""
    import os

    from model import project

    out_ids: set[str] = set()
    if write:
        with _db.connect(settings().db_url) as conn:
            out_ids = project.sleeper_out_ids(conn)
    res = project.run(season, week, out_ids=out_ids, offline=offline)
    path = project.save_local(res)
    if write:
        with _db.connect(settings().db_url) as conn:
            run_id = project.write_db(conn, res, git_sha=os.getenv("GITHUB_SHA"))
        typer.echo(f"run {run_id}: {res.projections.height} players → bsb.projections")
    typer.echo(f"{res.season} week {res.week} — saved {path}")
    cols = ["player_name", "position", "team", "opponent", "dk_mean", "dk_p10", "dk_p90", "ppr_mean", "anytime_td_prob"]
    for r in res.projections.head(top).select(cols).iter_rows():
        typer.echo("{:24s} {:2s} {:3s} v {:3s}  DK {:5.1f} ({:4.1f}–{:4.1f})  PPR {:5.1f}  TD {:4.0%}".format(*r))


@model_app.command("price")
def model_price(player: str, stat: str, line: float):
    """Fair price for a prop from the last local run, e.g.
    `bsb model price "ceedee lamb" receiving_yards 84.5`."""
    from model import project

    rows = project.price(player, stat, line)
    if not rows:
        typer.echo("no matching player with that stat in the latest projections", err=True)
        raise typer.Exit(1)
    for r in rows:
        typer.echo(
            f"{r['player']} ({r['team']} v {r['opponent']}, wk {r['week']}) {stat}: proj {r['projection']:.1f}\n"
            f"  over  {line}: {r['p_over']:.1%}  fair {r['fair_over']:+d}\n"
            f"  under {line}: {r['p_under']:.1%}  fair {r['fair_under']:+d}"
        )


if __name__ == "__main__":
    app()
