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
edges_app = typer.Typer(no_args_is_help=True, help="Market edges: props and game lines")
lineups_app = typer.Typer(no_args_is_help=True, help="DraftKings lineup optimizer (needs the [model] extra)")
app.add_typer(db_app, name="db")
app.add_typer(nfl_app, name="nfl")
app.add_typer(sleeper_app, name="sleeper")
app.add_typer(odds_app, name="odds")
app.add_typer(dk_app, name="dk")
app.add_typer(model_app, name="model")
app.add_typer(lineups_app, name="lineups")
app.add_typer(edges_app, name="edges")

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
    from model import backtest, data, dst, features

    tr = _seasons(train_seasons)
    d = data.load(min(tr), test, offline=offline)
    wk = tuple(int(x) for x in weeks.split("-")) if weeks else None
    report = backtest.to_markdown(backtest.run(features.build(d), tr, test, wk))
    report += "\n" + dst.to_markdown(dst.evaluate(dst.build(d), tr, test, wk))
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

    import polars as pl

    from model import project

    out_ids: set[str] = set()
    if write:
        with _db.connect(settings().db_url) as conn:
            out_ids = project.sleeper_out_ids(conn) | project.dk_out_ids(conn)
    res = project.run(season, week, out_ids=out_ids, offline=offline)
    path = project.save_local(res)
    if write:
        with _db.connect(settings().db_url) as conn:
            run_id = project.write_db(conn, res, git_sha=os.getenv("GITHUB_SHA"))
            typer.echo(f"run {run_id}: {res.projections.height} players → bsb.projections")
            # price the market with the model that was just fitted; never let a
            # market hiccup cost us the projections that are already saved
            try:
                from markets import lines, props

                n_props = props.build(conn, res.model, res.projections, run_id, res.season, res.week)
                n_lines = lines.build(conn)
                typer.echo(f"markets: {n_props} prop prices → bsb.prop_prices, {n_lines} line quotes → bsb.line_quotes")
            except Exception as e:  # noqa: BLE001
                conn.rollback()
                log.warning("market pricing failed (projections are saved): %s", e)
    typer.echo(f"{res.season} week {res.week} — saved {path}")
    cols = ["player_name", "position", "team", "opponent", "dk_mean", "dk_p10", "dk_p90", "ppr_mean", "anytime_td_prob"]
    fmt = "{:24s} {:3s} {:3s} v {:3s}  DK {:5.1f} ({:4.1f}–{:4.1f})  PPR {:5.1f}  TD {:4.0%}"
    for r in res.projections.head(top).select(cols).iter_rows():
        typer.echo(fmt.format(*[0.0 if v is None else v for v in r]))
    typer.echo("— DST —")
    for r in res.projections.filter(pl.col("position") == "DST").head(8).select(cols).iter_rows():
        typer.echo(fmt.format(*[0.0 if v is None else v for v in r]))


@model_app.command("scorecard")
def model_scorecard(
    season: int = typer.Option(None, help="default: current season"),
    week: int = typer.Option(None, help="default: latest fully played week"),
    offline: bool = typer.Option(False, help="use cached nflverse files only"),
):
    """Grade a finished week: projections, saved lineups and prop prices vs what happened."""
    from model import scorecard

    with _db.connect(settings().db_url) as conn:
        r = scorecard.run(conn, season, week, offline=offline)
    typer.echo(scorecard.to_text(r) if r else "nothing to grade yet")


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


# --- edges ------------------------------------------------------------------

@edges_app.command("lines")
def edges_lines():
    """Analyse the newest game-line snapshot (best price, Pinnacle fair value, arbitrage)."""
    from markets import lines

    with _db.connect(settings().db_url) as conn:
        typer.echo(f"{lines.build(conn)} quotes → bsb.line_quotes")


@edges_app.command("show")
def edges_show(min_ev: float = typer.Option(0.02, help="minimum expected value to list"), top: int = typer.Option(15)):
    """Current edges: arbitrage and +EV on game lines, and props priced off Pinnacle and off the model."""
    with _db.connect(settings().db_url) as conn:
        arbs = conn.execute(
            """select game_id, market, number, outcome, bookmaker, price_american, round(arb_pct * 100, 2)
               from bsb.line_quotes_latest where arb_pct > 0 and is_best order by arb_pct desc, game_id, market, outcome limit %s""",
            (top * 2,),
        ).fetchall()
        ev = conn.execute(
            """select game_id, market, line, outcome, bookmaker, price_american, round(fair_prob * 100, 1), round(ev * 100, 2)
               from bsb.line_quotes_latest where ev >= %s and bookmaker <> 'pinnacle' order by ev desc limit %s""",
            (min_ev, top),
        ).fetchall()
        sides = """select player_name, team, stat, line, bookmaker, side, price, round(fair * 100, 1), round(model * 100, 1), round(ev * 100, 2)
                   from (select player_name, team, stat, line, bookmaker, 'over' as side, over_decimal as price, fair_over as fair,
                                model_over as model, {over} as ev from bsb.prop_edges
                         union all
                         select player_name, team, stat, line, bookmaker, 'under', under_decimal, 1 - fair_over,
                                1 - model_over, {under} from bsb.prop_edges) x
                   where ev >= %s and bookmaker <> 'pinnacle' order by ev desc limit %s"""
        fair = conn.execute(sides.format(over="ev_over_fair", under="ev_under_fair"), (min_ev, top)).fetchall()
        model = conn.execute(sides.format(over="ev_over_model", under="ev_under_model"), (min_ev, top)).fetchall()
    typer.echo(f"ARBITRAGE on game lines ({len(arbs)} legs)")
    for r in arbs:
        typer.echo(f"  {r[0]:18s} {r[1]:9s} {r[2]:>5} {r[3]:5s} {r[4]:10s} {r[5]:+5d}   locks {r[6]}%")
    typer.echo(f"\nGAME LINES beating Pinnacle fair value by ≥ {min_ev:.0%}")
    for r in ev:
        typer.echo(f"  {r[0]:18s} {r[1]:9s} {r[2] if r[2] is not None else '':>5} {r[3]:5s} {r[4]:10s} {r[5]:+5d}   fair {r[6]}%  EV {r[7]:+}%")
    for title, rows in (("PROPS beating Pinnacle fair value (same line)", fair), ("PROPS the model likes (unproven until the scorecard says otherwise)", model)):
        typer.echo(f"\n{title}")
        for r in rows:
            f = f"{r[7]}%" if r[7] is not None else "  –  "
            typer.echo(f"  {(r[0] or '?'):22s} {r[1] or '':3s} {r[2]:16s} {r[4]:10s} {r[5]:5s} {r[3]:>5} @ {float(r[6]):.2f}   fair {f}  model {r[8]}%  EV {r[9]:+}%")


# --- lineups ----------------------------------------------------------------

@lineups_app.command("build")
def lineups_build(
    n: int = typer.Option(20, help="number of lineups"),
    mode: str = typer.Option("gpp", help="gpp (tournaments) or cash (50/50s, head-to-heads)"),
    max_exposure: float = typer.Option(0.5, help="max share of lineups any one player may appear in"),
    min_unique: int = typer.Option(3, help="players by which any two lineups must differ"),
    lock: str = typer.Option(None, help="comma-separated names (or DK ids) that must be in every lineup"),
    exclude: str = typer.Option(None, help="comma-separated names (or DK ids) to leave out"),
    slate_id: int = typer.Option(None, help="bsb.dfs_slates id (default: newest upcoming classic slate)"),
    csv: str = typer.Option(None, help="local mode: a DKSalaries.csv export instead of Supabase"),
    projections: str = typer.Option(None, help="local mode: projections parquet from `bsb model project`"),
    write: bool = typer.Option(True, help="save the set to Supabase (ignored in local mode)"),
    seed: int = typer.Option(7),
):
    """Build a set of DK classic lineups from the latest projections."""
    import polars as pl

    from optimizer import portfolio, slate, store
    from optimizer.classic import Rules

    if mode not in ("gpp", "cash"):
        raise typer.BadParameter("mode must be gpp or cash")
    info: dict = {}
    if csv:
        if not projections:
            raise typer.BadParameter("--csv needs --projections")
        pool, label = slate.from_files(csv, projections), Path(csv).stem
    else:
        with _db.connect(settings().db_url) as conn:
            slate_id = slate_id or slate.latest_slate_id(conn)
            if slate_id is None:
                typer.echo("no upcoming DraftKings classic slate in bsb.dfs_slates — upload a salary export to slates/")
                raise typer.Exit(0)
            pool, info = slate.from_db(conn, slate_id)
        label = f"slate{slate_id}"
    if pool.is_empty():
        typer.echo("no projected players on this slate yet — has `bsb model project` run for its week?")
        raise typer.Exit(0)

    def ids(spec: str | None) -> set[str]:
        out: set[str] = set()
        for tok in (t.strip() for t in (spec or "").split(",") if t.strip()):
            hit = pool.filter((pl.col("dk_id") == tok) | pl.col("name").str.to_lowercase().str.contains(tok.lower(), literal=True))
            if hit.is_empty():
                raise typer.BadParameter(f"no player on the slate matches {tok!r}")
            out |= set(hit["dk_id"].to_list())
        return out

    st = portfolio.Settings(n=n, mode=mode, max_exposure=max_exposure, min_unique=min_unique, seed=seed)
    base = st.resolved_rules()
    st.rules = Rules(**{**base.__dict__, "lock": ids(lock), "exclude": ids(exclude)})
    pf = portfolio.build(pool, st)
    if not pf.lineups:
        typer.echo("no legal lineup could be built: " + "; ".join(pf.notes))
        raise typer.Exit(1)
    upload, detail = store.save_local(pf, f"{label}_{mode}")
    if not csv and write:
        with _db.connect(settings().db_url) as conn:
            set_id = store.write_db(conn, pf, info["id"], info.get("run_id"))
        typer.echo(f"lineup set {set_id} → bsb.lineup_sets / lineups / lineup_players")

    sm = store.set_summary(pf)
    typer.echo(f"{len(pf.lineups)} {mode} lineups from {pool.height} players · {sm['players_used']} players used · "
               f"max exposure {sm['max_exposure_pct']:.0f}% · avg projection {sm['avg_proj']}")
    typer.echo(f"set's best lineup per simulated slate: mean {sm['set_best_mean']}, top-10% {sm['set_best_p90']} "
               f"(single best lineup averages {sm['best_lineup_mean']})")
    for note in pf.notes:
        typer.echo(f"note: {note}")
    rows, summ = pf.rows(), {r["lineup"]: r for r in pf.summary().iter_rows(named=True)}
    for k in range(1, min(len(pf.lineups), 3) + 1):
        x = summ[k]
        typer.echo(f"\n#{k}  ${x['salary']:,}  proj {x['proj']}  range {x['p10']}–{x['p90']}")
        for r in rows.filter(pl.col("lineup") == k).iter_rows(named=True):
            flag = f" [{r['status']}]" if r["status"] else ""
            typer.echo(f"  {r['slot']:4s} {r['name']:24s} {r['team']:3s} v {r['opponent']:3s} ${r['salary']:>5,} {r['dk_mean']:5.1f}{flag}")
    typer.echo("\nexposure:")
    for r in pf.exposure().head(12).iter_rows(named=True):
        typer.echo(f"  {r['exposure_pct']:3.0f}%  {r['name']:24s} {r['pos']:3s} {r['team']:3s} ${r['salary']:>5,}")
    typer.echo(f"\nDK upload file: {upload}\ndetail: {detail}")


@lineups_app.command("fit-corr")
def lineups_fit_corr(train_seasons: str = typer.Option("2021-2025", "--train"), offline: bool = typer.Option(False)):
    """Re-estimate the role correlation matrix (optimizer/role_corr.json)."""
    from model import data, dst, features
    from optimizer import corr

    tr = _seasons(train_seasons)
    d = data.load(min(tr), max(tr), offline=offline)
    c = corr.fit(features.build(d), dst.build(d), tr)
    corr.save(c)
    typer.echo(f"fitted on {c['n_team_games']} team-games → {corr.PATH}")


if __name__ == "__main__":
    app()
