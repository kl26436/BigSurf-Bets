"""Database-level tests: migrations, the access lock-down, the app's read and
write surface, app jobs, and the queries that decide who is out.

Needs a throwaway Postgres: set TEST_DATABASE_URL to a superuser connection
(CI starts one as a service container). Skipped when it is not set."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

ADMIN_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_DATABASE_URL not set")

ALICE, BOB = str(uuid.uuid4()), str(uuid.uuid4())
TEAMS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]


@pytest.fixture(scope="module")
def db_url():
    name = f"bsb_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'create database "{name}"')
    url = psycopg.conninfo.make_conninfo(ADMIN_URL, dbname=name)
    with psycopg.connect(url, autocommit=True) as c:
        c.execute((Path(__file__).parent / "db" / "supabase_stub.sql").read_text())
    from ingest import db

    assert len(db.migrate(url)) >= 18
    assert db.migrate(url) == []          # second run applies nothing
    _seed(url)
    yield url
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f'drop database if exists "{name}" with (force)')


def _seed(url: str) -> None:
    """A three-game slate with projections for every player on it."""
    kick = datetime.now(UTC) + timedelta(days=3)
    with psycopg.connect(url) as c:
        c.execute("insert into bsb.model_runs (model_version, season, week, trained_seasons) values ('t', 2026, 10, '{2025}')")
        c.execute(
            "insert into bsb.dfs_slates (slate_type, slate_name, site_slate_id, season, week, starts_at) values ('classic', 'test', 't1', 2026, 10, %s)",
            (kick,),
        )
        n = 0
        for g in range(3):
            home, away = TEAMS[2 * g], TEAMS[2 * g + 1]
            gid = f"2026_10_{away}_{home}"
            c.execute(
                "insert into bsb.games (game_id, season, week, game_type, kickoff_at, home_team, away_team, spread_line, total_line) values (%s, 2026, 10, 'REG', %s, %s, %s, 3, 45)",
                (gid, kick + timedelta(hours=3 * g), home, away),
            )
            for team, opp in ((home, away), (away, home)):
                roster = [("QB", 2), ("RB", 4), ("WR", 6), ("TE", 3), ("DST", 1)]
                for pos, count in roster:
                    for k in range(count):
                        n += 1
                        pid = f"DST_{team}" if pos == "DST" else f"00-{n:07d}"
                        name = f"{team} DST" if pos == "DST" else "Pat " + "".join(chr(97 + int(d)) for d in str(n)).title()
                        mean = {"QB": 19, "RB": 14, "WR": 13, "TE": 9, "DST": 7}[pos] - 3.1 * k + (n % 5) * 0.3
                        mean = max(mean, 1.5)
                        salary = int(max(2500, round(mean * 380 + (n % 7) * 90, -2)))
                        if pos != "DST":
                            c.execute(
                                "insert into bsb.players (player_id, display_name, position, latest_team, status) values (%s, %s, %s, %s, 'ACT')",
                                (pid, name, pos, team),
                            )
                        c.execute(
                            """insert into bsb.dfs_salaries (slate_id, site_player_id, player_id, player_name, team, opponent, position, salary, game_id, raw)
                               values (1, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
                            (str(40000 + n), pid, name, team, opp, pos, salary, gid, json.dumps({"Status": ""})),
                        )
                        c.execute(
                            """insert into bsb.projections (run_id, season, week, player_id, game_id, team, opponent, position,
                                   dk_mean, dk_std, dk_p10, dk_p25, dk_p50, dk_p75, dk_p90, ppr_mean)
                               values (1, 2026, 10, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (pid, gid, team, opp, pos, mean, mean * 0.5, mean * 0.35, mean * 0.6, mean * 0.95, mean * 1.3, mean * 1.75, mean),
                        )
        c.commit()


class As:
    """Run statements the way PostgREST would for a given caller."""

    def __init__(self, url: str, role: str, sub: str | None = None):
        self.url, self.role, self.sub = url, role, sub

    def __enter__(self) -> psycopg.Connection:
        self.conn = psycopg.connect(self.url, autocommit=True)
        claims = json.dumps({"sub": self.sub, "email": f"{(self.sub or 'x')[:6]}@example.com"}) if self.sub else ""
        self.conn.execute("select set_config('request.jwt.claims', %s, false)", (claims,))
        self.conn.execute(f"set role {self.role}")
        return self.conn

    def __exit__(self, *a):
        self.conn.close()


VIEWS = ["app_feed_health", "app_model_runs", "app_slates", "app_pool", "app_projections", "app_games", "app_lineup_sets",
         "app_lineups", "app_lineup_players", "app_line_quotes", "app_prop_edges", "app_scorecards", "app_player_log",
         "app_my_roster", "app_free_agents", "app_jobs", "app_overrides", "app_dk_entries", "app_bets",
         "app_events", "app_push_devices", "app_notifications", "app_pull_status"]


def test_every_table_has_row_level_security(db_url):
    with psycopg.connect(db_url) as c:
        open_tables = c.execute(
            """select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'bsb' and c.relkind = 'r' and not c.relrowsecurity"""
        ).fetchall()
    assert open_tables == []


def test_anonymous_callers_get_nothing(db_url):
    with As(db_url, "anon") as c:
        for target in ["bsb.games", "bsb.projections", "bsb.fantasy_roster_snapshots", *[f"public.{v}" for v in VIEWS]]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select 1 from {target} limit 1")
        for call in ["public.bsb_whoami()", "public.bsb_claim_owner()", "public.bsb_request_job('project')", "public.bsb_get_settings()"]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select {call}")


def test_signed_in_stranger_sees_no_rows_and_cannot_write(db_url):
    with psycopg.connect(db_url) as c:   # someone else already owns the app
        c.execute("insert into bsb.app_users (user_id, role) values (%s, 'owner') on conflict do nothing", (ALICE,))
        c.commit()
    with As(db_url, "authenticated", BOB) as c:
        assert c.execute("select public.bsb_whoami()").fetchone()[0]["member"] is False
        assert c.execute("select public.bsb_claim_owner()").fetchone()[0] == "closed"
        for v in VIEWS:
            rows = c.execute(f"select * from public.{v}").fetchall()
            assert all(r[5] is None for r in rows) if v == "app_feed_health" else rows == [], v
        assert c.execute("select count(*) from bsb.dfs_salaries").fetchone()[0] == 0
        for call in ["public.bsb_request_job('project')", "public.bsb_set_entered(1, true)",
                     "public.bsb_set_override(2026, 10, 'x', 12)", "public.bsb_save_settings('{}'::jsonb)",
                     "public.bsb_rename_set(1, 'x')", "public.bsb_archive_set(1)", "public.bsb_delete_set(1)",
                     "public.bsb_delete_lineup(1, 1)", "public.bsb_dismiss_job(1)", "public.bsb_set_lineups_entered(1, '{1}', true)",
                     "public.bsb_replace_lineup(1, 1, '{a}')", "public.bsb_import_dk_entries(1, '[]'::jsonb)",
                     "public.bsb_assign_entries('[]'::jsonb)", "public.bsb_log_bet('{}'::jsonb)", "public.bsb_settle_bet(1, 'won')",
                     "public.bsb_delete_bet(1)", "public.bsb_grade_bets()", "public.bsb_push_key()",
                     "public.bsb_save_push_subscription('{}'::jsonb)", "public.bsb_delete_push_subscription('x')"]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select {call}")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("insert into bsb.app_users (user_id) values (%s)", (BOB,))


def test_first_sign_in_claims_the_app(db_url):
    with psycopg.connect(db_url) as c:
        c.execute("delete from bsb.app_users")
        c.commit()
    with As(db_url, "authenticated", ALICE) as c:
        assert c.execute("select public.bsb_whoami()").fetchone()[0]["claim_open"] is True
        assert c.execute("select public.bsb_claim_owner()").fetchone()[0] == "owner"
        assert c.execute("select public.bsb_claim_owner()").fetchone()[0] == "member"
    with As(db_url, "authenticated", BOB) as c:
        assert c.execute("select public.bsb_claim_owner()").fetchone()[0] == "closed"


def test_member_reads_the_slate_and_writes_through_functions(db_url):
    with As(db_url, "authenticated", ALICE) as c:
        assert c.execute("select count(*) from public.app_pool where slate_id = 1").fetchone()[0] == 96
        assert c.execute("select count(*) from public.app_projections").fetchone()[0] == 96
        assert c.execute("select count(*) from public.app_games").fetchone()[0] == 3
        home = c.execute("select implied_total, team_spread from public.app_pool where team = 'AAA' limit 1").fetchone()
        assert (float(home[0]), float(home[1])) == (24.0, -3.0)      # home favoured by 3, total 45

        # override → the pool shows it, removing it restores the model's number
        pid, base = c.execute("select player_id, dk_mean from public.app_pool where pos = 'WR' order by dk_mean desc limit 1").fetchone()
        c.execute("select public.bsb_set_override(2026, 10, %s, 30, 'gut')", (pid,))
        assert float(c.execute("select dk_mean from public.app_pool where player_id = %s", (pid,)).fetchone()[0]) == 30.0
        c.execute("select public.bsb_set_override(2026, 10, %s, null)", (pid,))
        assert c.execute("select dk_mean from public.app_pool where player_id = %s", (pid,)).fetchone()[0] == base

        # a job is recorded; with no GitHub token configured it says so instead of pretending
        job = c.execute("select public.bsb_request_job('build_lineups', %s::jsonb)", (json.dumps({"n": 3}),)).fetchone()[0]
        status, err = c.execute("select status, error from public.app_jobs where id = %s", (job,)).fetchone()
        assert status == "needs_setup" and "github_pat" in err
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("select public.bsb_request_job('drop_everything')")

        c.execute("select public.bsb_save_settings(%s::jsonb)", (json.dumps({"bankroll_dfs": 300}),))
        assert c.execute("select public.bsb_get_settings()").fetchone()[0] == {"bankroll_dfs": 300}
        # direct writes stay closed even for a member
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("update bsb.dfs_salaries set salary = 1")


def _legal_nine(c) -> list[str]:
    ids = []
    for pos, k in (("QB", 1), ("RB", 2), ("WR", 3), ("TE", 1)):
        ids += [r[0] for r in c.execute(
            "select dk_id from public.app_pool where slate_id = 1 and pos = %s order by salary limit %s", (pos, k)).fetchall()]
    ids.append(c.execute("select dk_id from public.app_pool where slate_id = 1 and pos = 'RB' order by salary offset 2 limit 1").fetchone()[0])
    ids.append(c.execute("select dk_id from public.app_pool where slate_id = 1 and pos = 'DST' order by salary limit 1").fetchone()[0])
    return ids


def test_saving_a_hand_built_lineup_is_checked(db_url):
    with As(db_url, "authenticated", ALICE) as c:
        nine = _legal_nine(c)
        set_id = c.execute("select public.bsb_save_lineup(1, %s, 'mine')", (nine,)).fetchone()[0]
        source, n = c.execute("select source, n_lineups from public.app_lineup_sets where id = %s", (set_id,)).fetchone()
        assert (source, n) == ("manual", 1)
        slots = [r[0] for r in c.execute("select slot from public.app_lineup_players where set_id = %s order by slot_no", (set_id,))]
        assert slots == ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"]
        salary, proj = c.execute("select salary, proj from public.app_lineups where set_id = %s", (set_id,)).fetchone()
        assert salary <= 50000 and proj > 0
        for bad, why in [(nine[:8], "nine"), ([nine[1], *nine[1:]], "nine different"), ([nine[8], *nine[1:8], nine[0]], "slot")]:
            with pytest.raises(psycopg.errors.RaiseException, match=why):
                c.execute("select public.bsb_save_lineup(1, %s)", (bad,))
        dear = [r[0] for r in c.execute("select dk_id from public.app_pool where pos = 'QB' order by salary desc limit 1")]
        c.execute("select public.bsb_set_entered(%s, true)", (set_id,))
        assert c.execute("select entered from public.app_lineup_sets where id = %s", (set_id,)).fetchone()[0] is True
        assert dear


def test_app_job_builds_a_lineup_set(db_url, monkeypatch):
    from typer.testing import CliRunner

    from ingest import cli

    with As(db_url, "authenticated", ALICE) as c:
        lock = c.execute("select dk_id from public.app_pool where pos = 'TE' order by dk_mean limit 1").fetchone()[0]
        ban = c.execute("select dk_id from public.app_pool where pos = 'QB' order by dk_mean desc limit 1").fetchone()[0]
        payload = {"slate_id": 1, "mode": "gpp", "n": 4, "max_exposure": 0.75, "min_unique": 2, "lock": [lock], "exclude": [ban], "label": "test", "min_salary": 0}
        job = c.execute("select public.bsb_request_job('build_lineups', %s::jsonb)", (json.dumps(payload),)).fetchone()[0]
    monkeypatch.setenv("SUPABASE_DB_URL", db_url)
    res = CliRunner().invoke(cli.app, ["app", "run-job", str(job)])
    assert res.exit_code == 0, res.output
    with As(db_url, "authenticated", ALICE) as c:
        status, result = c.execute("select status, result from public.app_jobs where id = %s", (job,)).fetchone()
        assert status == "done" and result["n_lineups"] == 4
        sid = result["set_id"]
        assert c.execute("select source, label, job_id from public.app_lineup_sets where id = %s", (sid,)).fetchone() == ("user", "test", job)
        used = c.execute("select dk_id, count(*) from public.app_lineup_players where set_id = %s group by 1", (sid,)).fetchall()
        counts = dict(used)
        assert counts[lock] == 4 and ban not in counts
        assert max(v for k, v in counts.items() if k != lock) <= 3          # 75% of 4
        # a bad request fails cleanly and says why
        job2 = c.execute("select public.bsb_request_job('build_lineups', %s::jsonb)", (json.dumps({"slate_id": 1, "n": 9999}),)).fetchone()[0]
    assert CliRunner().invoke(cli.app, ["app", "run-job", str(job2)]).exit_code == 1
    with As(db_url, "authenticated", ALICE) as c:
        status, err = c.execute("select status, error from public.app_jobs where id = %s", (job2,)).fetchone()
        assert status == "failed" and "between" in err


def test_a_showdown_salary_file_becomes_captain_lineups(db_url, monkeypatch, tmp_path):
    """A single-game export (every player twice: captain and ordinary) is imported,
    a set is built through an app job, and the lineups come back six to a lineup."""
    from typer.testing import CliRunner

    from ingest import cli
    from ingest.draftkings import import_csv

    with psycopg.connect(db_url) as c:
        kick, gid = c.execute("select kickoff_at, game_id from bsb.games where home_team = 'AAA' and away_team = 'BBB'").fetchone()
        for n, team in enumerate(("AAA", "BBB")):                     # a kicker a side, projected like everyone else
            pid = f"00-K00000{n}"
            c.execute("insert into bsb.players (player_id, display_name, position, latest_team, status) values (%s, %s, 'K', %s, 'ACT') on conflict do nothing",
                      (pid, f"Kick {team.title()}", team))
            c.execute("""insert into bsb.projections (run_id, season, week, player_id, game_id, team, opponent, position, dk_mean, dk_std, dk_p10, dk_p25, dk_p50, dk_p75, dk_p90)
                         select max(id), 2026, 10, %s, %s, %s, %s, 'K', 8.5, 4, 3, 5, 8, 11, 15 from bsb.model_runs on conflict do nothing""",
                      (pid, gid, team, "BBB" if team == "AAA" else "AAA"))
        rows = c.execute(
            """select s.position, s.player_name, s.site_player_id, s.salary, s.team from bsb.dfs_salaries s
               where s.slate_id = 1 and s.team in ('AAA', 'BBB')
               union all select 'K', 'Kick Aaa', '49001', 4000, 'AAA' union all select 'K', 'Kick Bbb', '49002', 4200, 'BBB'""").fetchall()
        from zoneinfo import ZoneInfo
        info = f"BBB@AAA {kick.astimezone(ZoneInfo('America/New_York')):%m/%d/%Y %I:%M%p} ET"
        lines = ["Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame"]
        for pos, name, sid, salary, team in rows:
            lines.append(f"{pos},{name} ({sid}),{name},{sid},FLEX,{salary},{info},{team},9.5")
            lines.append(f"{pos},{name} (9{sid}),{name},9{sid},CPT,{int(salary * 1.5)},{info},{team},9.5")
        f = tmp_path / "showdown.csv"
        f.write_text("\n".join(lines) + "\n")
        assert import_csv(c, f, slate_name="mnf") == len(rows) * 2
        sd, kind, wk = c.execute("select id, slate_type, week from bsb.dfs_slates where slate_name = 'mnf'").fetchone()
        assert kind == "showdown" and wk == 10
        assert c.execute("select count(*) from bsb.dfs_salaries where slate_id = %s and player_id is null", (sd,)).fetchone()[0] == 0

    with As(db_url, "authenticated", ALICE) as c:
        k = c.execute("select dk_id from public.app_pool where slate_id = %s and pos = 'K' and dk_id not like '%%-CPT' limit 1", (sd,)).fetchone()[0]
        qb = c.execute("select dk_id from public.app_pool where slate_id = %s and pos = 'QB' and dk_id not like '%%-CPT' order by dk_mean desc limit 1", (sd,)).fetchone()[0]
        job = c.execute("select public.bsb_request_job('build_lineups', %s::jsonb)",
                        (json.dumps({"slate_id": sd, "mode": "gpp", "n": 5, "lock": [k], "captain": [qb], "label": "Monday night"}),)).fetchone()[0]
    monkeypatch.setenv("SUPABASE_DB_URL", db_url)
    res = CliRunner().invoke(cli.app, ["app", "run-job", str(job)])
    assert res.exit_code == 0, res.output
    with As(db_url, "authenticated", ALICE) as c:
        status, result = c.execute("select status, result from public.app_jobs where id = %s", (job,)).fetchone()
        assert status == "done" and result["n_lineups"] == 5, result
        sid = result["set_id"]
        per = c.execute("""select lineup_no, count(*), sum(salary), count(*) filter (where slot = 'CPT'), count(distinct team),
                                  bool_or(dk_id = %s), min(dk_id) filter (where slot = 'CPT')
                           from public.app_lineup_players where set_id = %s group by 1 order by 1""", (k, sid)).fetchall()
        assert len(per) == 5
        for _, n, salary, caps, teams, has_kicker, cap_id in per:
            # the captain row has its own DraftKings id (here the ordinary id with a 9 in front), as in a real export
            assert (n, caps, teams, has_kicker) == (6, 1, 2, True) and salary <= 50_000 and cap_id == "9" + qb + "-CPT"
        stored = dict(c.execute("select lineup_no, salary from public.app_lineups where set_id = %s", (sid,)).fetchall())
        assert all(stored[no] == salary for no, _, salary, *_ in per)
        rules = c.execute("select settings->'rules' from public.app_lineup_sets where id = %s", (sid,)).fetchone()[0]
        assert rules["qb_stack"] == 0 and rules["lock"] == [k]          # recorded as built: no classic stacking rule
    # the command line builds one for the newest single-game slate, as the Lineups workflow does
    res = CliRunner().invoke(cli.app, ["lineups", "build", "--slate-type", "showdown", "--mode", "gpp", "--n", "3", "--max-exposure", "0.67", "--min-unique", "2"])
    assert res.exit_code == 0 and "CPT" in res.output, res.output
    with psycopg.connect(db_url) as c:
        assert c.execute("select count(*) from bsb.lineup_sets where slate_id = %s and source = 'auto'", (sd,)).fetchone()[0] == 1
        # kickers never show up as fantasy pick-ups
        assert c.execute("select pg_get_viewdef('public.app_free_agents'::regclass)").fetchone()[0].count("'K'") == 0


def test_contest_results_are_kept_small_and_money_is_typed_in(db_url):
    """What the app sends after reading a contest results file: the user's entries, the
    field's scores and every player's share of lineups. The games are worked out from the players."""
    with psycopg.connect(db_url) as c:
        # contests are added after the games: for this test the classic slate started yesterday
        before = c.execute("select starts_at from bsb.dfs_slates where id = 1").fetchone()[0]
        c.execute("update bsb.dfs_slates set starts_at = now() - interval '1 day' where id = 1")
        names = [r[0] for r in c.execute("select player_name from bsb.dfs_salaries where slate_id = 1 and position <> 'DST' order by salary desc limit 8")]
        c.commit()
    file = {"contest_key": "171234567", "n_entries": 47562, "scores": {"max": 251.3, "p99": 205.7, "p90": 181.2, "p75": 164, "p50": 144.5, "min": 38.8},
            "entries": [{"entry_id": "9001", "entry_name": "kevlap (1/2)", "rank": 2214, "points": 186.3, "lineup": "QB a RB b"},
                        {"entry_id": "9002", "entry_name": "kevlap (2/2)", "rank": 30112, "points": 131.02, "lineup": "QB c RB d"}],
            "ownership": [{"name": n, "roster_position": "FLEX", "pct_drafted": 30 - i, "fpts": 20.5 + i} for i, n in enumerate(names)]
                         + [{"name": "Somebody Unknown", "roster_position": "WR", "pct_drafted": 0.4, "fpts": 1.2}]}
    try:
        with As(db_url, "anon") as c:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute("select public.bsb_import_contest(null, %s::jsonb)", (json.dumps(file),))
            for v in ("app_contests", "app_contest_entries", "app_contest_ownership"):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    c.execute(f"select 1 from public.{v} limit 1")
        with As(db_url, "authenticated", BOB) as c:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute("select public.bsb_import_contest(null, %s::jsonb)", (json.dumps(file),))
        with As(db_url, "authenticated", ALICE) as c:
            out = c.execute("select public.bsb_import_contest(null, %s::jsonb)", (json.dumps(file),)).fetchone()[0]
            cid = out["contest_id"]
            assert (out["entries"], out["players"]) == (2, 9)
            row = c.execute("select slate_id, week, n_entries, n_mine, best_rank, best_points, won, n_unsettled, paid, profit, scores->>'p90' from public.app_contests").fetchone()
            assert row[:5] == (1, 10, 47562, 2, 2214) and float(row[5]) == 186.3 and row[6:8] == (0, 2)
            assert row[8] is None and row[9] is None and row[10] == "181.2"
            matched = c.execute("select count(*) filter (where player_id is not null), count(*) from public.app_contest_ownership where contest_id = %s", (cid,)).fetchone()
            assert matched == (8, 9)                                     # players on the slate get our id; a stranger is kept by name
            # the fee alone is not a result: every entry's winnings must be in (0 counts)
            c.execute("select public.bsb_set_contest_money(%s, 3, 'NFL $3 Play-Action', %s::jsonb)", (cid, json.dumps({"9001": 12})))
            assert c.execute("select name, paid, won, n_unsettled, profit from public.app_contests").fetchone() == ("NFL $3 Play-Action", 6, 12, 1, None)
            c.execute("select public.bsb_set_contest_money(%s, null, null, %s::jsonb)", (cid, json.dumps({"9002": 0, "nobody": 50})))
            assert c.execute("select paid, won, n_unsettled, profit from public.app_contests").fetchone() == (6, 12, 0, 6)
            with pytest.raises(psycopg.errors.RaiseException, match="out of range"):
                c.execute("select public.bsb_set_contest_money(%s, -1)", (cid,))
            # the same contest again (a later export): numbers replaced, the dollars already typed in kept, a withdrawn entry dropped
            again = {**file, "n_entries": 47570, "entries": [{**file["entries"][0], "rank": 2200}]}
            out = c.execute("select public.bsb_import_contest(null, %s::jsonb)", (json.dumps(again),)).fetchone()[0]
            assert out["contest_id"] == cid
            assert c.execute("select n_entries, n_mine, name, entry_fee, won from public.app_contests").fetchone() == (47570, 1, "NFL $3 Play-Action", 3, 12)
            assert c.execute("select rank, winnings from public.app_contest_entries").fetchall() == [(2200, 12)]
            for bad in ({**file, "contest_key": ""}, {**file, "entries": "x"}, {**file, "n_entries": 0}, {"contest_key": "k", "n_entries": 5}):
                with pytest.raises(psycopg.errors.RaiseException):
                    c.execute("select public.bsb_import_contest(null, %s::jsonb)", (json.dumps(bad),))
            c.execute("select public.bsb_delete_contest(%s)", (cid,))
            assert c.execute("select count(*) from public.app_contests").fetchone()[0] == 0
            assert c.execute("select count(*) from public.app_contest_ownership").fetchone()[0] == 0
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("update bsb.dfs_slates set starts_at = %s where id = 1", (before,))
            c.commit()


def _stored_set(url: str, source: str, mode: str = "gpp", n: int = 2, entered: bool = False, archived: bool = False,
                label: str | None = None, simulated: bool = True) -> int:
    """A lineup set written the way the pipeline writes one: `n` lineups of the same nine players."""
    with psycopg.connect(url) as c:
        nine = c.execute(
            """(select site_player_id, player_id, player_name, position, team, opponent, salary from bsb.dfs_salaries
                where slate_id = 1 and position = 'QB' order by salary limit 1)
               union all (select site_player_id, player_id, player_name, position, team, opponent, salary from bsb.dfs_salaries
                where slate_id = 1 and position = 'RB' order by salary limit 3)
               union all (select site_player_id, player_id, player_name, position, team, opponent, salary from bsb.dfs_salaries
                where slate_id = 1 and position = 'WR' order by salary limit 3)
               union all (select site_player_id, player_id, player_name, position, team, opponent, salary from bsb.dfs_salaries
                where slate_id = 1 and position = 'TE' order by salary limit 1)
               union all (select site_player_id, player_id, player_name, position, team, opponent, salary from bsb.dfs_salaries
                where slate_id = 1 and position = 'DST' order by salary limit 1)"""
        ).fetchall()
        sid = c.execute(
            """insert into bsb.lineup_sets (slate_id, run_id, mode, n_lineups, settings, summary, source, entered, label, archived_at)
               values (1, 1, %s, %s, '{}'::jsonb, %s::jsonb, %s, %s, %s, case when %s then now() end) returning id""",
            (mode, n, json.dumps({"n": n, "avg_proj": 100, "players_used": 9, "set_best_mean": 140, "set_best_p90": 160}),
             source, entered, label, archived),
        ).fetchone()[0]
        for k in range(1, n + 1):
            c.execute(
                "insert into bsb.lineups (set_id, lineup_no, salary, proj, entered, sim_mean, p10, p50, p90, best_of_set_pct) values (%s, %s, 45000, %s, %s, %s, %s, %s, %s, %s)",
                (sid, k, 100 + k, entered, *((101 + k, 80, 100, 125, 50) if simulated else (None, None, None, None, None))),
            )
            for i, (dk, pid, name, pos, team, opp, sal) in enumerate(nine):
                c.execute(
                    """insert into bsb.lineup_players (set_id, lineup_no, slot_no, slot, site_player_id, player_id, player_name, position, team, opponent, salary, dk_mean)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 10)""",
                    (sid, k, i, pos, dk, pid, name, pos, team, opp, sal),
                )
        c.commit()
    return sid


def test_lineup_sets_can_be_named_trimmed_archived_and_removed(db_url):
    sid = _stored_set(db_url, "user", n=3)
    with As(db_url, "authenticated", ALICE) as c:
        row = lambda: c.execute("select label, archived_at, n_lineups, summary, entered from public.app_lineup_sets where id = %s", (sid,)).fetchone()  # noqa: E731
        c.execute("select public.bsb_rename_set(%s, %s)", (sid, "  Low   risk \n " + "x" * 80))
        assert row()[0] == ("Low risk " + "x" * 80)[:60]
        c.execute("select public.bsb_rename_set(%s, '   ')", (sid,))
        assert row()[0] is None                                   # an empty name clears it
        with pytest.raises(psycopg.errors.RaiseException, match="no such lineup set"):
            c.execute("select public.bsb_rename_set(999999, 'x')")

        c.execute("select public.bsb_archive_set(%s)", (sid,))
        first = row()[1]
        assert first is not None
        c.execute("select public.bsb_archive_set(%s, true)", (sid,))
        assert row()[1] == first                                  # archiving twice keeps the first time
        c.execute("select public.bsb_archive_set(%s, false)", (sid,))
        assert row()[1] is None

        # one lineup out: the count and the numbers that can be recomputed follow, the simulated ones are cleared
        assert c.execute("select public.bsb_delete_lineup(%s, 2)", (sid,)).fetchone()[0] == 2
        _, _, n, summary, _ = row()
        assert n == 2 and summary["n"] == 2 and summary["players_used"] == 9 and float(summary["avg_proj"]) == 102.0
        assert "set_best_mean" not in summary and "set_best_p90" not in summary
        assert [r[0] for r in c.execute("select lineup_no from public.app_lineups where set_id = %s order by 1", (sid,))] == [1, 3]
        assert c.execute("select count(*) from public.app_lineup_players where set_id = %s and lineup_no = 2", (sid,)).fetchone()[0] == 0
        assert c.execute("select count(best_of_set_pct) from public.app_lineups where set_id = %s", (sid,)).fetchone()[0] == 0
        with pytest.raises(psycopg.errors.RaiseException, match="no such lineup"):
            c.execute("select public.bsb_delete_lineup(%s, 2)", (sid,))

        # an entered set is the record of what was played: no delete, no changes
        c.execute("select public.bsb_set_entered(%s, true)", (sid,))
        for call in ("bsb_delete_set(%s)", "bsb_delete_lineup(%s, 1)"):     # every lineup of it is entered
            with pytest.raises(psycopg.errors.RaiseException, match="entered"):
                c.execute(f"select public.{call}", (sid,))
        assert row()[2] == 2
        c.execute("select public.bsb_archive_set(%s)", (sid,))      # archiving it is allowed
        c.execute("select public.bsb_set_entered(%s, false)", (sid,))
        c.execute("select public.bsb_delete_set(%s)", (sid,))
        assert row() is None
        assert c.execute("select count(*) from public.app_lineups where set_id = %s", (sid,)).fetchone()[0] == 0
        assert c.execute("select count(*) from public.app_lineup_players where set_id = %s", (sid,)).fetchone()[0] == 0

        # the last lineup takes its set with it
        one = c.execute("select public.bsb_save_lineup(1, %s, 'solo')", (_legal_nine(c),)).fetchone()[0]
        assert c.execute("select public.bsb_delete_lineup(%s, 1)", (one,)).fetchone()[0] == 0
        assert c.execute("select count(*) from public.app_lineup_sets where id = %s", (one,)).fetchone()[0] == 0

        # a request that failed can be waved away
        job = c.execute("select public.bsb_request_job('build_lineups', '{}'::jsonb)").fetchone()[0]
        assert c.execute("select dismissed_at from public.app_jobs where id = %s", (job,)).fetchone()[0] is None
        c.execute("select public.bsb_dismiss_job(%s)", (job,))
        assert c.execute("select dismissed_at from public.app_jobs where id = %s", (job,)).fetchone()[0] is not None


def test_entered_is_per_lineup_and_a_player_can_be_swapped(db_url):
    sid = _stored_set(db_url, "user", n=3)
    with As(db_url, "authenticated", ALICE) as c:
        flags = lambda: [r[0] for r in c.execute("select entered from public.app_lineups where set_id = %s order by lineup_no", (sid,))]  # noqa: E731
        set_entered = lambda: c.execute("select entered from public.app_lineup_sets where id = %s", (sid,)).fetchone()[0]  # noqa: E731
        assert c.execute("select public.bsb_set_lineups_entered(%s, %s, true)", (sid, [2])).fetchone()[0] == 1
        assert flags() == [False, True, False] and set_entered() is True
        # a lineup that was not played can go; the one that was cannot, and neither can the set
        assert c.execute("select public.bsb_delete_lineup(%s, 1)", (sid,)).fetchone()[0] == 2
        for call in ("bsb_delete_lineup(%s, 2)", "bsb_delete_set(%s)"):
            with pytest.raises(psycopg.errors.RaiseException, match="entered"):
                c.execute(f"select public.{call}", (sid,))
        assert c.execute("select public.bsb_set_lineups_entered(%s, %s, false)", (sid, [2])).fetchone()[0] == 0
        assert set_entered() is False
        c.execute("select public.bsb_set_entered(%s, true)", (sid,))
        assert flags() == [True, True]
        c.execute("select public.bsb_set_entered(%s, false)", (sid,))

        # swap: a legal nine replaces lineup 2; its simulated numbers no longer describe it
        nine = _legal_nine(c)
        c.execute("select public.bsb_replace_lineup(%s, 2, %s)", (sid, nine))
        got = [r[0] for r in c.execute("select dk_id from public.app_lineup_players where set_id = %s and lineup_no = 2 order by slot_no", (sid,))]
        assert got == nine
        salary, proj, p10, best, edited = c.execute(
            "select salary, proj, p10, best_of_set_pct, edited_at from public.app_lineups where set_id = %s and lineup_no = 2", (sid,)).fetchone()
        assert salary <= 50000 and proj > 0 and p10 is None and best is None and edited is not None
        assert "set_best_mean" not in c.execute("select summary from public.app_lineup_sets where id = %s", (sid,)).fetchone()[0]
        with pytest.raises(psycopg.errors.RaiseException, match="nine"):
            c.execute("select public.bsb_replace_lineup(%s, 2, %s)", (sid, nine[:8]))
        with pytest.raises(psycopg.errors.RaiseException, match="no such lineup"):
            c.execute("select public.bsb_replace_lineup(%s, 99, %s)", (sid, nine))
        # a player whose game has started can be neither taken out nor put in
        other_te = c.execute("select dk_id, game_id from public.app_pool where slate_id = 1 and pos = 'TE' and dk_id <> %s order by salary limit 1", (nine[6],)).fetchone()
    swapped = [*nine[:6], other_te[0], *nine[7:]]
    with psycopg.connect(db_url) as c:
        before = c.execute("select kickoff_at from bsb.games where game_id = %s", (other_te[1],)).fetchone()[0]
        c.execute("update bsb.games set kickoff_at = now() - interval '5 minutes' where game_id = %s", (other_te[1],))
        c.commit()
    try:
        with As(db_url, "authenticated", ALICE) as c:
            with pytest.raises(psycopg.errors.RaiseException, match="started"):
                c.execute("select public.bsb_replace_lineup(%s, 2, %s)", (sid, swapped))
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("update bsb.games set kickoff_at = %s where game_id = %s", (before, other_te[1]))
            c.commit()
    with As(db_url, "authenticated", ALICE) as c:
        c.execute("select public.bsb_replace_lineup(%s, 2, %s)", (sid, swapped))        # before kickoff it goes through
        c.execute("select public.bsb_replace_lineup(%s, 2, %s)", (sid, nine))


def test_draftkings_entries_are_linked_to_lineups(db_url):
    sid = _stored_set(db_url, "user", n=3)
    with As(db_url, "authenticated", ALICE) as c:
        nine = _legal_nine(c)
        # a nine no other stored lineup has (an earlier test saved the cheapest one by hand)
        nine[6] = c.execute("select dk_id from public.app_pool where slate_id = 1 and pos = 'TE' and dk_id <> %s order by salary desc limit 1", (nine[6],)).fetchone()[0]
        c.execute("select public.bsb_replace_lineup(%s, 1, %s)", (sid, nine))
        entries = [{"entry_id": "e1", "contest_id": "c9", "contest_name": "NFL $5 Double Up", "entry_fee": "5", "players": list(reversed(nine))},
                   {"entry_id": "e2", "contest_id": "c9", "contest_name": "NFL $5 Double Up", "entry_fee": "5", "players": None}]
        out = c.execute("select public.bsb_import_dk_entries(1, %s::jsonb)", (json.dumps(entries),)).fetchone()[0]
        assert out == {"entries": 2, "linked": 1}
        rows = {r[0]: r[1:] for r in c.execute("select entry_id, set_id, lineup_no, entry_fee from public.app_dk_entries where slate_id = 1")}
        assert rows["e1"] == (sid, 1, 5) and rows["e2"][:2] == (None, None)        # same players in any order is the same lineup
        assert c.execute("select entered from public.app_lineups where set_id = %s and lineup_no = 1", (sid,)).fetchone()[0] is True
        assert c.execute("select entered from public.app_lineup_sets where id = %s", (sid,)).fetchone()[0] is True

        # put a lineup on the empty entry, then take it off again
        assert c.execute("select public.bsb_assign_entries(%s::jsonb)", (json.dumps([{"entry_id": "e2", "set_id": sid, "lineup_no": 3}]),)).fetchone()[0] == 1
        assert c.execute("select set_id, lineup_no from public.app_dk_entries where entry_id = 'e2'").fetchone() == (sid, 3)
        assert c.execute("select entered from public.app_lineups where set_id = %s and lineup_no = 3", (sid,)).fetchone()[0] is True
        with pytest.raises(psycopg.errors.RaiseException, match="same games"):
            c.execute("select public.bsb_assign_entries(%s::jsonb)", (json.dumps([{"entry_id": "e2", "set_id": 999999, "lineup_no": 1}]),))
        c.execute("select public.bsb_assign_entries(%s::jsonb)", (json.dumps([{"entry_id": "e2", "set_id": None}]),))
        assert c.execute("select set_id, lineup_no from public.app_dk_entries where entry_id = 'e2'").fetchone() == (None, None)

        # a fresh file replaces the list: an entry no longer in it was withdrawn; links that still hold are kept
        out = c.execute("select public.bsb_import_dk_entries(1, %s::jsonb)", (json.dumps(entries[:1]),)).fetchone()[0]
        assert out == {"entries": 1, "linked": 1}
        assert [r[0] for r in c.execute("select entry_id from public.app_dk_entries")] == ["e1"]
        for bad in ("[]", '[{"contest_id": "x"}]', '{"entry_id": "e"}'):
            with pytest.raises(psycopg.errors.RaiseException):
                c.execute("select public.bsb_import_dk_entries(1, %s::jsonb)", (bad,))
        # removing the lineup an entry holds leaves the entry, unlinked
        c.execute("select public.bsb_set_entered(%s, false)", (sid,))
        c.execute("select public.bsb_delete_set(%s)", (sid,))
        assert c.execute("select set_id, lineup_no from public.app_dk_entries where entry_id = 'e1'").fetchone() == (None, None)
        c.execute("select public.bsb_import_dk_entries(1, %s::jsonb)", (json.dumps([{"entry_id": "gone", "players": None}]),))
    with psycopg.connect(db_url) as c:
        c.execute("delete from bsb.dk_entries")
        c.commit()


def test_bets_are_recorded_graded_from_the_score_and_compared_with_the_close(db_url):
    with psycopg.connect(db_url) as c:
        gid, home, away, kickoff = c.execute("select game_id, home_team, away_team, kickoff_at from bsb.games where season = 2026 and week = 10 order by game_id limit 1").fetchone()
        c.execute("delete from bsb.bets")
        # the sharp book's fair chance for the home side at -3: 52% a day out, 55% at the last look before kickoff, 60% after it (ignored)
        for at, fair in ((kickoff - timedelta(days=1), 0.52), (kickoff - timedelta(minutes=5), 0.55), (kickoff + timedelta(minutes=5), 0.60)):
            c.execute("insert into bsb.line_quotes (captured_at, game_id, season, week, market, number, outcome, line, bookmaker, price_decimal, fair_prob) "
                      "values (%s, %s, 2026, 10, 'spread', -3, 'home', -3, 'pinnacle', 1.9, %s)", (at, gid, fair))
        c.commit()

    def bet(c, **kw):
        base = {"bookmaker": "DraftKings", "kind": "game", "description": "x", "game_id": gid, "price_decimal": 2.0, "stake": 10}
        return c.execute("select public.bsb_log_bet(%s::jsonb)", (json.dumps({**base, **kw}),)).fetchone()[0]

    with As(db_url, "authenticated", ALICE) as c:
        home_3 = bet(c, description=f"{home} -3", market="spread", number=-3, outcome="home", fair_prob=0.52)
        away_3 = bet(c, description=f"{away} +3", market="spread", number=-3, outcome="away")
        over = bet(c, description="Over 45", market="total", number=45, outcome="over", price_decimal=1.91, stake=20)
        win = bet(c, description=f"{away} to win", market="moneyline", number=0, outcome="away", price_decimal=2.5)
        hand = bet(c, description="Something written by hand", kind="other", game_id=None)
        for bad in ({"stake": 0}, {"price_decimal": 1}, {"description": " "}, {"bookmaker": ""}):
            with pytest.raises(psycopg.errors.RaiseException):
                bet(c, **bad)
        row = lambda i: c.execute("select result, returned, profit, closing_fair, beat_close, graded_by, bookmaker from public.app_bets where id = %s", (i,)).fetchone()  # noqa: E731
        assert row(home_3) == ("open", None, None, None, None, None, "draftkings")       # before kickoff there is no close
        assert c.execute("select public.bsb_grade_bets()").fetchone()[0] == 0             # and nothing to grade

    with psycopg.connect(db_url) as c:          # the game is played: home wins 24-21, a tie against -3 and exactly 45 points
        c.execute("update bsb.games set kickoff_at = now() - interval '4 hours', home_score = 24, away_score = 21 where game_id = %s", (gid,))
        c.execute("update bsb.line_quotes set captured_at = captured_at - (%s - (now() - interval '4 hours')) where game_id = %s and bookmaker = 'pinnacle' and market = 'spread'", (kickoff, gid))
        c.commit()
    try:
        with As(db_url, "authenticated", ALICE) as c:
            assert c.execute("select public.bsb_grade_bets()").fetchone()[0] == 4
            assert row(home_3)[:3] == ("void", 10, 0) and row(away_3)[:3] == ("void", 10, 0)       # tied with the number: stake back
            assert row(over)[:3] == ("void", 20, 0)
            assert row(win)[:3] == ("lost", 0, -10) and row(win)[5] == "score"
            assert row(hand)[0] == "open"                                                        # nothing to grade it from
            # took 2.0 on a side the sharp book made 55% at the close: 10% better than the closing price
            assert float(row(home_3)[3]) == 0.55 and float(row(home_3)[4]) == 0.1
            assert row(away_3)[3] is None                                                        # nobody quoted that side at the end

            c.execute("select public.bsb_settle_bet(%s, 'won')", (hand,))
            assert row(hand)[:3] == ("won", 20, 10) and row(hand)[5] == "hand"
            c.execute("select public.bsb_settle_bet(%s, 'open')", (hand,))
            assert row(hand)[:3] == ("open", None, None)
            with pytest.raises(psycopg.errors.RaiseException):
                c.execute("select public.bsb_settle_bet(%s, 'maybe')", (hand,))
            c.execute("select public.bsb_delete_bet(%s)", (hand,))
            assert row(hand) is None
            assert c.execute("select public.bsb_grade_bets()").fetchone()[0] == 0                 # settled bets are not graded twice
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("update bsb.games set kickoff_at = %s, home_score = null, away_score = null where game_id = %s", (kickoff, gid))
            c.execute("delete from bsb.line_quotes where game_id = %s and bookmaker = 'pinnacle' and market = 'spread'", (gid,))
            c.execute("delete from bsb.bets")
            c.commit()


def test_scorecard_reports_the_sets_on_the_lineups_screen_and_entered_ones(db_url):
    from model import scorecard

    old_auto = _stored_set(db_url, "auto")
    old_auto_entered = _stored_set(db_url, "auto", entered=True)
    new_auto = _stored_set(db_url, "auto")
    cash_auto = _stored_set(db_url, "auto", mode="cash")
    mine = _stored_set(db_url, "user", label="Low risk")
    binned = _stored_set(db_url, "user", archived=True)
    binned_but_played = _stored_set(db_url, "user", archived=True, entered=True)
    by_hand = _stored_set(db_url, "manual", mode="manual", n=1, simulated=False)
    with psycopg.connect(db_url) as c:
        c.execute("update bsb.lineups set actual_points = 110 where set_id = any(%s)",
                  ([old_auto, old_auto_entered, new_auto, cash_auto, mine, binned, binned_but_played, by_hand],))
        c.commit()
        lu = scorecard.graded_lineups(c, 2026, 10)
    graded = set(lu["set_id"].to_list())
    assert {new_auto, cash_auto, mine, binned_but_played, old_auto_entered, by_hand} <= graded
    assert not ({old_auto, binned} & graded)

    by_set = {m["set_id"]: m for m in scorecard.lineup_metrics(lu)}
    assert by_set[mine]["label"] == "Low risk" and by_set[mine]["source"] == "user" and by_set[mine]["entered"] is False
    assert by_set[mine]["in_p10_p90"] == 1.0 and by_set[mine]["avg_projected"] == 102.5
    assert by_set[mine]["n_entered"] == 0 and "entered_avg_actual" not in by_set[mine]
    assert by_set[binned_but_played]["n_entered"] == 2 and by_set[binned_but_played]["entered_avg_actual"] == 110.0
    hand = by_set[by_hand]                      # no simulation behind a hand-built lineup: graded on its projection
    assert hand["avg_actual"] == 110.0 and hand["avg_projected"] == 101.0 and hand["in_p10_p90"] is None
    assert "inside the 80% range" not in scorecard.to_text(
        {"season": 2026, "week": 10, "projections": {"n_played": 0, "did_not_play": 0, "pre_kickoff_share": 1, "by_position": {}},
         "lineups": [hand], "props": {"n": 0}})


def test_the_app_only_calls_views_columns_and_functions_that_exist(db_url):
    """app/src/lib/api.ts names views, columns and functions as strings: nothing checks them
    until a screen fails for a signed-in user. Check every one against the migrated database."""
    import re

    api = (Path(__file__).parent.parent / "app" / "src" / "lib" / "api.ts").read_text()
    reads = re.findall(r'all<[^>]+>\("(\w+)"(?:,\s*\(q\)\s*=>\s*q((?:\.\w+\([^()]*\))+))?', api)
    calls = re.findall(r'\brpc\b[^"\n]*"(bsb_\w+)"(?:,\s*\{([^}]*)\})?', api)
    assert len(reads) >= 15 and len(calls) >= 14, (len(reads), len(calls))
    with psycopg.connect(db_url) as c:
        for view, chain in reads:
            cols = {r[0] for r in c.execute(
                "select column_name from information_schema.columns where table_schema = 'public' and table_name = %s", (view,))}
            assert cols, f"the app reads public.{view}, which does not exist"
            for col in re.findall(r'\.(?:eq|order|is|in|gt|lt|gte|lte)\("(\w+)"', chain):
                assert col in cols, f"the app filters or sorts public.{view} by {col!r}, which it does not have"
        for fn, args in calls:
            rows = c.execute(
                """select p.proargnames, p.pronargs, p.pronargdefaults from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = %s""", (fn,)).fetchall()
            assert len(rows) == 1, f"the app calls public.{fn}: found {len(rows)} functions by that name"
            names, n_args, n_defaults = rows[0]
            params = list(names or [])[:n_args]
            sent = re.findall(r'(\w+):', args)
            assert set(sent) <= set(params), f"{fn}: the app sends {sorted(set(sent) - set(params))}, the function takes {params}"
            required = params[:n_args - n_defaults]
            assert set(required) <= set(sent), f"{fn}: the app leaves out {sorted(set(required) - set(sent))}"


def test_who_is_out_uses_this_weeks_information(db_url):
    """Sleeper's Out/Doubtful is a game designation that lingers into the next
    week; DraftKings' tag is about the coming slate."""
    from model import project

    now = datetime.now(UTC)
    with psycopg.connect(db_url) as c:
        ids = [r[0] for r in c.execute("select player_id from bsb.dfs_salaries where position = 'WR' and team = 'AAA' order by salary").fetchall()]
        stale_cleared, stale_dk_out, long_term, fresh, healthy, far = ids[:6]
        far_team_player = c.execute("select player_id from bsb.dfs_salaries where position = 'WR' and team = 'EEE' limit 1").fetchone()[0]

        def snap(pid, status, team="AAA", hours_ago=1.0):
            c.execute(
                "insert into bsb.player_status_snapshots (captured_at, player_id, source_player_id, team, position, injury_status) values (%s, %s, %s, %s, 'WR', %s)",
                (now - timedelta(hours=hours_ago), pid, "s" + pid, team, status),
            )

        # AAA kicks off in 3 days: an "Out" seen now is older than the 28h designation window → stale
        snap(stale_cleared, "Out")
        snap(stale_dk_out, "Out")
        snap(long_term, "IR")
        snap(healthy, None)
        snap(far, "Doubtful", hours_ago=60)                 # too old to count at all (48h)
        c.execute("update bsb.dfs_salaries set raw = '{\"Status\": \"Q\"}' where player_id = %s", (stale_cleared,))
        c.execute("update bsb.dfs_salaries set raw = '{\"Status\": \"OUT\"}' where player_id = %s", (stale_dk_out,))
        # a team that kicks off within the window: its Out is this week's
        c.execute("update bsb.games set kickoff_at = %s where home_team = 'EEE' or away_team = 'EEE'", (now + timedelta(hours=20),))
        snap(far_team_player, "Out", team="EEE")
        c.commit()
        out, cleared = project.inactive_ids(c)
        assert stale_cleared not in out and stale_cleared in cleared     # DK says Questionable → projected
        assert {stale_dk_out, long_term, far_team_player} <= out
        assert healthy not in out and far not in out and fresh not in out
        assert not (out & cleared)
        h1 = project.inputs_fingerprint(c, out, cleared, "sha")
        assert h1 == project.inputs_fingerprint(c, set(out), set(cleared), "sha")
        assert h1 != project.inputs_fingerprint(c, out | {"someone"}, cleared, "sha")
        c.execute("delete from bsb.player_status_snapshots")
        c.execute("update bsb.dfs_salaries set raw = '{\"Status\": \"\"}'")
        c.commit()


def test_sleeper_players_are_matched_without_a_gsis_id(db_url):
    from ingest.sleeper import IdResolver

    with psycopg.connect(db_url) as c:
        pid, name = c.execute("select player_id, display_name from bsb.players where latest_team = 'BBB' and position = 'RB' limit 1").fetchone()
        r = IdResolver(c)
        assert r.resolve("9001", {"gsis_id": f" {pid} "}) == (pid, "gsis")
        assert r.resolve("9002", {"full_name": name + " Jr.", "team": "BBB", "position": "RB"}) == (pid, "name_team")
        assert r.resolve("9003", {"full_name": name, "team": "ZZZ", "position": "RB"}) == (pid, "name_pos")   # traded
        assert r.resolve("9004", {"full_name": "Nobody Atall", "team": "BBB", "position": "RB"}) == (None, "none")


def test_feed_health_flags_a_quiet_feed(db_url):
    with psycopg.connect(db_url) as c:
        c.execute("insert into bsb.ingest_runs (job, started_at, finished_at, ok, rows_written) values ('sleeper.status', now() - interval '5 days', now() - interval '5 days', true, 900)")
        c.execute("insert into bsb.ingest_runs (job, started_at, finished_at, ok, rows_written) values ('odds.oddslink', now() - interval '1 hour', now() - interval '1 hour', true, 500)")
        c.execute("insert into bsb.ingest_runs (job, started_at, finished_at, ok, rows_written, detail) values ('odds.oddslink', now(), now(), false, 0, '{\"error\": \"boom\"}')")
        c.commit()
        state = dict(c.execute("select job, state from public.app_feed_health").fetchall())
    assert state["sleeper.status"] == "stale" and state["odds.oddslink"] == "failing" and state["nflverse.player_stats"] == "never"


def test_waiver_bids_run_end_to_end_and_only_members_read_them(db_url):
    """Seed a three-team guillotine league on the test slate, ingest its bid
    history the way the Sleeper feed delivers it, run the advice and read it
    back through the app's views."""
    from ingest.sleeper_league import transaction_rows
    from league import bids

    lid = "L1"
    with psycopg.connect(db_url) as c:
        players = c.execute(
            "select player_id, position, latest_team from bsb.players where position in ('QB','RB','WR','TE') order by player_id"
        ).fetchall()
        sid = {pid: str(5000 + i) for i, (pid, _, _) in enumerate(players)}
        for pid, pos, team in players:
            c.execute(
                """insert into bsb.player_status_snapshots (source, player_id, source_player_id, team, position, raw)
                   values ('sleeper', %s, %s, %s, %s, %s::jsonb)""",
                (pid, sid[pid], team, pos, json.dumps({"full_name": "x", "status": "Active"})),
            )
        c.execute(
            """insert into bsb.fantasy_leagues (league_id, name, season, total_rosters, roster_positions, settings)
               values (%s, 'Chop', 2026, 4, %s, %s::jsonb)""",
            (lid, ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"], json.dumps({"type": 3, "waiver_budget": 1000})),
        )
        by_team: dict[str, list[str]] = {}
        for pid, _pos, team in players:
            by_team.setdefault(team, []).append(sid[pid])
        rosters = [(1, "me", True, by_team["AAA"], 300), (2, "rival", False, by_team["BBB"], 100),
                   (3, "other", False, by_team["CCC"], 650), (4, "gone", False, [], 0)]
        for rid, owner, me, ids, used in rosters:
            raw = {"settings": {"waiver_budget_used": used, **({"eliminated": 9} if not ids else {})}}
            c.execute(
                """insert into bsb.fantasy_roster_snapshots (league_id, week, roster_id, owner_name, is_me, players, starters, raw)
                   values (%s, 10, %s, %s, %s, %s, %s, %s::jsonb)""",
                (lid, rid, owner, me, ids, ids[:7], json.dumps(raw)),
            )
        feed = [
            {"transaction_id": 1, "type": "waiver", "status": "complete", "leg": 8, "adds": {"7001": 2}, "drops": {"7002": 2},
             "settings": {"waiver_bid": 100}, "created": 1_790_000_000_000, "status_updated": 1_790_000_100_000,
             "metadata": {"notes": "ok"}, "roster_ids": [2]},
            {"transaction_id": 2, "type": "waiver", "status": "failed", "leg": 8, "adds": {"7001": 3}, "drops": None,
             "settings": {"waiver_bid": 60}, "created": 1_790_000_000_000, "status_updated": 1_790_000_100_000, "roster_ids": [3]},
            {"transaction_id": 3, "type": "chopped", "status": "complete", "leg": 9, "adds": None, "drops": {"7003": 4},
             "settings": None, "created": 1_790_600_000_000, "status_updated": 1_790_600_000_000, "roster_ids": [4]},
        ]
        rows = transaction_rows(lid, feed)
        assert rows[0][5:9] == (2, "7001", "7002", 100) and rows[2][5:7] == (4, None)
        c.cursor().executemany(
            """insert into bsb.fantasy_transactions (transaction_id, league_id, leg, type, status, roster_id, player_id,
                   drop_player_id, bid, adds, drops, created, status_updated, note) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            rows,
        )
        c.commit()

        lg = bids.load_league(c)
        assert [t.owner for t in lg.teams] == ["me", "rival", "other"] and lg.me.budget == 700
        assert lg.week == 10 and len(lg.weeks) == 2                      # three teams → two more chops
        assert len(lg.bids) == 2 and {b.budget_before for b in lg.bids} == {1000}
        taken = {p.pid for t in lg.teams for p in t.players}
        assert lg.free_agents and not ({p.pid for p in lg.free_agents} & taken)
        res = bids.run(c, n_sim=2000)
        assert "teams left" in bids.report(res)
        run_id, n = c.execute("select max(run_id), count(*) from bsb.waiver_recs").fetchone()
        assert n == len(res.recs) > 0
        assert c.execute("select bid from bsb.waiver_recs where run_id = %s and rank = 1", (run_id,)).fetchone()[0] <= 700

    with As(db_url, "anon") as c:
        for v in ("public.app_waiver_run", "public.app_waiver_recs", "bsb.fantasy_transactions"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select 1 from {v} limit 1")
    with As(db_url, "authenticated", BOB) as c:
        assert c.execute("select * from public.app_waiver_recs").fetchall() == []
    with As(db_url, "authenticated", ALICE) as c:
        run = c.execute("select week, teams_left, budget, jsonb_array_length(teams) from public.app_waiver_run").fetchone()
        assert run == (10, 3, 700, 3)
        assert c.execute("select count(*) from public.app_waiver_recs").fetchone()[0] == n
        lineup, coming, advice, grade = c.execute("select lineup, coming, advice, grade from public.app_waiver_run").fetchone()
        assert sum(1 for d in lineup if d["start"]) == 7 and {d["spot"] for d in lineup if d["start"]} >= {"QB", "RB1", "FLEX"}
        assert {x["owner"] for x in coming} == {"rival", "other"} and all(0 <= x["chop_1"] <= x["chop_3"] <= 1 for x in coming)
        assert advice["verdict"] in ("now", "wait", "either", "hold") and advice["needs"]
        assert grade is None                                             # no auction has been settled since a run priced it

    # the auction settles: a rival wins the top-ranked player, I lose a lower bid on him, and I win the second
    with psycopg.connect(db_url) as c:
        (r1, s1, b50, b80, b95), (r2, s2, *_) = c.execute(
            "select rank, sleeper_id, bid_50, bid_80, bid_95 from bsb.waiver_recs where run_id = %s and rank <= 2 order by rank", (run_id,)).fetchall()
        when = datetime.now(UTC) + timedelta(minutes=30)
        tx = [("t-a", 2, s1, b80, "complete"), ("t-b", 1, s1, 5, "failed"), ("t-c", 1, s2, 9, "complete")]
        for tid, rid, sleeper, amount, status in tx:
            c.execute(
                """insert into bsb.fantasy_transactions (transaction_id, league_id, leg, type, status, roster_id, player_id, bid, status_updated)
                   values (%s, %s, 10, 'waiver', %s, %s, %s, %s, %s)""", (tid, lid, status, rid, sleeper, amount, when))
        c.commit()
        g = bids.grade_prices(c, lid)
        assert g["run_id"] == run_id and g["n"] == 2
        top, second = g["rows"]
        assert top["top_rival"] == b80 and top["won_by"] == "rival" and top["i_won"] is False and top["my_bid"] == 5
        assert second["top_rival"] == 0 and second["i_won"] is True and second["paid"] == 9
        assert g["beat_50"] == 1 + (b50 > b80) and g["beat_80"] == 1 and g["beat_95"] == 1 + (b95 > b80)
        bids.run(c, n_sim=500)                                           # the next run carries the grade with it
    with As(db_url, "authenticated", ALICE) as c:
        assert c.execute("select grade->>'n' from public.app_waiver_run").fetchone()[0] == "2"


def test_price_a_line_shapes_and_player_results_reach_the_app(db_url):
    """The projection run saves the model's outcome shapes once per stat; the
    scorecard keeps what was expected beside what happened. Members read both."""
    from types import SimpleNamespace

    import numpy as np

    from model import project
    from model.dist import Empirical, NegBin

    rng = np.random.default_rng(1)
    mu = rng.gamma(2, 3, 3000)
    model = SimpleNamespace(dists={
        "receptions": NegBin.fit(mu, rng.poisson(mu)),
        "receiving_yards": Empirical.fit(mu * 10, mu * 10 * rng.lognormal(0, 0.4, 3000)),
    })
    with psycopg.connect(db_url) as c:
        assert project.save_dists(c, model, None) == 2 and project.save_dists(c, model, None) == 2    # replaced, not appended
        pid = c.execute("select player_id from bsb.players where position = 'WR' order by player_id limit 1").fetchone()[0]
        c.execute("""insert into bsb.player_results (sport, season, week, player_id, position, team, dk, ppr, proj_dk, proj_p10, proj_p90)
                     values ('nfl', 2026, 9, %s, 'WR', 'AAA', 21.5, 20, 12.0, 4, 22), ('nfl', 2026, 9, 'nobody-expected', 'WR', 'AAA', 3, 3, null, null, null)""", (pid,))
        c.commit()
    with As(db_url, "anon") as c:
        for v in ("app_model_dists", "app_player_results", "app_prop_results", "app_overrides", "app_model_runs"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select 1 from public.{v} limit 1")
    with As(db_url, "authenticated", BOB) as c:
        assert c.execute("select count(*) from public.app_model_dists").fetchone()[0] == 0
    with As(db_url, "authenticated", ALICE) as c:
        rows = dict((r[0], (r[1], r[2])) for r in c.execute("select stat, kind, params from public.app_model_dists"))
        assert rows["receptions"][0] == "nb" and rows["receptions"][1]["edges"][-1] is None
        emp = rows["receiving_yards"][1]
        assert rows["receiving_yards"][0] == "emp" and len(emp["quantiles"]) == len(emp["edges"]) and len(emp["quantiles"][0]) == 201
        got = c.execute("select player_id, dk, proj_dk, miss from public.app_player_results where season = 2026 and week = 9").fetchall()
        assert [(r[0], float(r[1]), float(r[2]), float(r[3])) for r in got] == [(pid, 21.5, 12.0, 9.5)]
        c.execute("select public.bsb_set_override(2026, 10, %s, 17.5, 'hunch')", (pid,))
        o = c.execute("select player_id, dk_mean, this_week, name is not null from public.app_overrides").fetchall()
        assert (pid, 17.5, True, True) in [(r[0], float(r[1]), r[2], r[3]) for r in o]
        c.execute("select public.bsb_set_override(2026, 10, %s, null)", (pid,))
        assert c.execute("select count(*) from public.app_overrides where player_id = %s", (pid,)).fetchone()[0] == 0
        assert c.execute("select count(*) from public.app_model_runs").fetchone()[0] >= 1


# ---- what changed, and telling people -----------------------------------------------------
SUB = {"endpoint": "https://push.example.com/send/abc123", "keys": {"p256dh": "BPublicKeyOfTheDevice", "auth": "c2VjcmV0"}, "device": "iPhone"}


def _member(url: str, settings: dict | None = None) -> None:
    """ALICE has access, signs in with an address, and has chosen her notification settings."""
    with psycopg.connect(url) as c:
        c.execute("insert into bsb.app_users (user_id, email, role) values (%s, 'alice@example.com', 'owner') "
                  "on conflict (user_id) do update set email = excluded.email", (ALICE,))
        c.execute("insert into bsb.user_settings (user_id, settings) values (%s, %s::jsonb) "
                  "on conflict (user_id) do update set settings = excluded.settings", (ALICE, json.dumps(settings or {})))
        c.commit()


def _clear_notify(url: str) -> None:
    with psycopg.connect(url) as c:
        c.execute("delete from bsb.events")
        c.execute("delete from bsb.push_subscriptions")
        c.execute("delete from bsb.player_status_snapshots")
        c.execute("update bsb.dfs_salaries set raw = jsonb_set(raw, '{Status}', '\"\"')")
        c.commit()


class Outbox:
    """Stands in for the push service and the mail server."""

    def __init__(self, gone: bool = False, mail_ok: bool = True):
        self.pushes, self.mails, self.gone, self.mail_ok = [], [], gone, mail_ok

    def push(self, sub, payload, private_key):
        from notify.send import Sent
        self.pushes.append((sub["endpoint"], payload))
        return Sent(False, "push service answered 410", gone=True) if self.gone else Sent(True)

    def email(self, to, subject, body, url="/"):
        from notify.send import Sent
        self.mails.append((to, subject, body, url))
        return Sent(True) if self.mail_ok else Sent(False, "SMTPAuthenticationError: bad password")


def test_a_device_signs_up_for_pop_ups_and_only_its_owner_sees_it(db_url):
    from notify import send

    _clear_notify(db_url)
    _member(db_url)
    with psycopg.connect(db_url) as c:
        c.execute("delete from bsb.app_config where key like 'vapid%'")
        c.commit()
        with As(db_url, "authenticated", ALICE) as a:
            assert a.execute("select public.bsb_push_key()").fetchone()[0] is None        # the pipeline has not made the keys yet
        private, public = send.ensure_keys(c)
        assert send.ensure_keys(c) == (private, public)                                    # made once
        assert len(public) == 87 and len(private) == 43                                    # an uncompressed P-256 point and a 32-byte scalar
    with As(db_url, "authenticated", ALICE) as a:
        assert a.execute("select public.bsb_push_key()").fetchone()[0] == public
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            a.execute("select value from bsb.app_config")                                 # the private half stays out of reach
        for bad in ({}, {"endpoint": "http://plain.example.com/x", "keys": SUB["keys"]}, {"endpoint": SUB["endpoint"], "keys": {"auth": "x"}}):
            with pytest.raises(psycopg.errors.RaiseException, match="not a push subscription"):
                a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps(bad),))
        a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps(SUB),))
        a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps({**SUB, "device": "iPhone 16"}),))   # the same device again
        rows = a.execute("select id, device, last_ok_at from public.app_push_devices").fetchall()
        assert len(rows) == 1 and rows[0][1] == "iPhone 16"
        assert rows[0][0] == "e6f1e563ad6145546e8846b0788d243bf8bb43d19dcd717437303d8370963c17"          # SHA-256 of the address: app/src/lib/push.test.ts computes the same
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            a.execute("select p256dh, auth from bsb.push_subscriptions")                   # the keys are never handed back
        assert a.execute("select public.bsb_delete_push_subscription(null, 'nope')").fetchone()[0] == 0
        assert a.execute("select public.bsb_delete_push_subscription(null, %s)", (rows[0][0],)).fetchone()[0] == 1
        assert a.execute("select count(*) from public.app_push_devices").fetchone()[0] == 0
        a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps(SUB),))
    with psycopg.connect(db_url) as c:                                                     # someone else with access sees none of it
        c.execute("insert into bsb.app_users (user_id, email) values (%s, 'bob@example.com')", (BOB,))
        c.commit()
    try:
        with As(db_url, "authenticated", BOB) as b:
            assert b.execute("select count(*) from public.app_push_devices").fetchone()[0] == 0
            assert b.execute("select public.bsb_delete_push_subscription(%s)", (SUB["endpoint"],)).fetchone()[0] == 0
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("delete from bsb.app_users where user_id = %s", (BOB,))
            c.commit()
    _clear_notify(db_url)


def test_a_player_ruled_out_of_an_entered_lineup_is_recorded_once_and_sent(db_url):
    from notify import run as notify_run

    _clear_notify(db_url)
    _member(db_url, {"notify_email_on": True})
    with psycopg.connect(db_url) as c:
        c.execute("update bsb.lineups set entered = false")
        c.execute("update bsb.lineup_sets set entered = false")
        c.commit()
    sid = _stored_set(db_url, "user", n=2, entered=True, label="Sunday main")
    _stored_set(db_url, "user", n=1)                                                       # the same nine, not entered: must not count
    with As(db_url, "authenticated", ALICE) as a:
        a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps(SUB),))
    with psycopg.connect(db_url) as c:
        nine = c.execute("select site_player_id, player_id, player_name, position, team from bsb.lineup_players where set_id = %s and lineup_no = 1 order by slot_no", (sid,)).fetchall()
        rb, wr, te, dst = nine[1], nine[4], nine[7], nine[8]
        snap = "insert into bsb.player_status_snapshots (player_id, source_player_id, injury_status, captured_at) values (%s, 's', %s, now() - %s::interval)"

        box = Outbox()
        assert notify_run.run(c, box.push, box.email)["events"] == 0 and box.pushes == []      # everybody is playing

        c.execute(snap, (rb[1], "Out", "1 minute"))
        c.commit()
        out = notify_run.run(c, box.push, box.email)
        assert out == {"events": 1, "to_send": 1, "push_sent": 1, "push_failed": 0, "email_sent": 1, "email_failed": 0}
        endpoint, payload = box.pushes[0]
        assert endpoint == SUB["endpoint"] and payload["title"] == f"{rb[2]} is out" and payload["url"] == "/lineups/swap"
        assert "2 entered lineups" in payload["body"] and rb[4] in payload["body"] and payload["body"].endswith("Open the app to swap him out.")
        assert box.mails == [("alice@example.com", f"{rb[2]} is out", payload["body"], "/lineups/swap")]   # the sign-in address, by default
        assert notify_run.run(c, box.push, box.email)["events"] == 0 and len(box.pushes) == 1    # the same scratch is not sent twice

        with As(db_url, "authenticated", ALICE) as a:
            assert a.execute("select kind, severity, title, url from public.app_events").fetchall() == [("scratch", "alert", f"{rb[2]} is out", "/lineups/swap")]
            assert a.execute("select body from public.app_events").fetchone()[0].endswith("2 entered lineups.")       # in the app's list there is no "open the app"
            sent = a.execute("select channel, target, status from public.app_notifications order by channel").fetchall()
            assert sent == [("email", "a…e@example.com", "sent"), ("push", "iPhone", "sent")]
            assert a.execute("select last_ok_at is not null from public.app_push_devices").fetchone()[0] is True

        # three more at once (an inactives list): DraftKings' own tag, a doubtful, and a defense gone from the salary file → one message
        c.execute("update bsb.dfs_salaries set raw = jsonb_set(raw, '{Status}', '\"O\"') where slate_id = 1 and site_player_id = %s", (wr[0],))
        c.execute(snap, (te[1], "Doubtful", "1 minute"))
        saved = c.execute("delete from bsb.dfs_salaries where slate_id = 1 and site_player_id = %s returning *", (dst[0],)).fetchone()
        cols = [d.name for d in c.execute("select * from bsb.dfs_salaries limit 0").description]
        c.commit()
        out = notify_run.run(c, box.push, box.email)
        assert (out["events"], out["to_send"], out["push_sent"], out["email_sent"]) == (3, 3, 1, 1)
        assert box.pushes[-1][1]["title"] == "3 changes to your lineups" and box.pushes[-1][1]["url"] == "/lineups/swap"
        for name in (wr[2], te[2], dst[2]):
            assert name in box.pushes[-1][1]["body"]
        assert f"{te[2]} is doubtful" in box.pushes[-1][1]["body"]
        c.execute(f"insert into bsb.dfs_salaries ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})",
                  [json.dumps(v) if isinstance(v, dict) else v for v in saved])
        c.execute(snap, (te[1], "Out", "0 minutes"))                                       # doubtful → out is news again
        c.commit()
        assert notify_run.run(c, box.push, box.email)["to_send"] == 1 and box.pushes[-1][1]["title"] == f"{te[2]} is out"

        # a device that no longer accepts pop-ups is forgotten; a mail failure is logged with its reason
        c.execute("delete from bsb.events where dedupe_key like %s", (f"scratch:1:{rb[0]}:%",))
        c.commit()
        gone = Outbox(gone=True, mail_ok=False)
        out = notify_run.run(c, gone.push, gone.email)
        assert (out["push_failed"], out["email_failed"]) == (1, 1)
        assert c.execute("select count(*) from bsb.push_subscriptions").fetchone()[0] == 0
        assert c.execute("select status, error from bsb.notifications where channel = 'email' order by id desc limit 1").fetchone() == ("failed", "SMTPAuthenticationError: bad password")

        # once his game has started nothing can be swapped, so nothing is sent
        c.execute("delete from bsb.events")
        c.execute("update bsb.games set kickoff_at = now() - interval '5 minutes' where game_id = (select game_id from bsb.dfs_salaries where slate_id = 1 and site_player_id = %s)", (rb[0],))
        c.commit()
        quiet = Outbox()
        titles = [e.title for e in __import__("notify.detect", fromlist=["x"]).scratches(c)]
        assert f"{rb[2]} is out" not in titles
        c.rollback()
    with psycopg.connect(db_url) as c:
        kick = c.execute("select max(kickoff_at) from bsb.games where season = 2026 and week = 10").fetchone()[0]
        c.execute("update bsb.games set kickoff_at = %s where kickoff_at < now() and season = 2026 and week = 10", (kick,))
        c.execute("update bsb.lineups set entered = false where set_id = %s", (sid,))
        c.execute("update bsb.lineup_sets set entered = false where id = %s", (sid,))
        c.commit()
    assert quiet.pushes == []
    _clear_notify(db_url)


def test_missing_projections_for_the_whole_week_are_not_mistaken_for_scratches(db_url):
    from notify import detect

    _clear_notify(db_url)
    sid = _stored_set(db_url, "user", n=1, entered=True)
    try:
        with psycopg.connect(db_url) as c:
            c.execute("create temp table keep as select * from bsb.projections")
            c.execute("delete from bsb.projections where position <> 'DST'")              # a failed run: almost nobody has expected points
            assert detect.scratches(c) == []
            c.execute("delete from bsb.projections")
            c.execute("insert into bsb.projections select * from keep")
            c.execute("delete from bsb.projections where player_id = (select player_id from bsb.lineup_players where set_id = %s and slot_no = 1)", (sid,))
            assert [e.title.split(" is ")[1] for e in detect.scratches(c)] == ["no longer expected to play"]   # one player dropped by a healthy run
            c.rollback()
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("update bsb.lineups set entered = false where set_id = %s", (sid,))
            c.execute("update bsb.lineup_sets set entered = false where id = %s", (sid,))
            c.commit()


def test_status_changes_and_points_moves_fill_the_what_changed_list(db_url):
    from notify import detect
    from notify import run as notify_run

    _clear_notify(db_url)
    _member(db_url)
    sid = _stored_set(db_url, "user", n=1, entered=True)
    with As(db_url, "authenticated", ALICE) as a:
        a.execute("select public.bsb_save_push_subscription(%s::jsonb)", (json.dumps(SUB),))
    snap = "insert into bsb.player_status_snapshots (player_id, source_player_id, injury_status, captured_at) values (%s, 's', %s, now() - %s::interval)"
    try:
        with psycopg.connect(db_url) as c:
            mine = c.execute("select player_id, player_name from bsb.lineup_players where set_id = %s and slot_no = 0", (sid,)).fetchone()
            star, bench = (c.execute(
                f"select player_id, name from public.app_pool where dk_mean {op} 8 and pos = 'WR' and player_id not in (select player_id from bsb.lineup_players where set_id = %s) order by dk_mean {order} limit 1",
                (sid,)).fetchone() for op, order in ((">=", "desc"), ("<", "asc")))
            for pid in (mine[0], star[0], bench[0]):
                c.execute(snap, (pid, None, "2 hours"))
                c.execute(snap, (pid, "Questionable", "1 minute"))
            c.execute(snap, (star[0], None, "3 hours"))                                    # older history changes nothing
            # a second projections run: the same numbers, one player four points higher
            run2 = c.execute("insert into bsb.model_runs (model_version, season, week, trained_seasons) values ('t', 2026, 10, '{2025}') returning id").fetchone()[0]
            cols = [d.name for d in c.execute("select * from bsb.projections limit 0").description if d.name != "run_id"]
            c.execute(f"insert into bsb.projections (run_id, {', '.join(cols)}) select %s, {', '.join(cols)} from bsb.projections where run_id = 1", (run2,))
            c.execute("update bsb.projections set dk_mean = dk_mean + 4 where run_id = %s and player_id = %s", (run2, star[0]))
            c.commit()

            events = {e.dedupe_key.split(":")[0] + ":" + (e.player_id or ""): e for e in detect.find_events(c)}
            assert set(events) == {f"status:{mine[0]}", f"status:{star[0]}", f"points:{star[0]}"}      # the bench player is not worth a line
            assert events[f"status:{mine[0]}"].title == f"{mine[1]} is questionable" and events[f"status:{mine[0]}"].notify is True
            assert "lineup you entered" in events[f"status:{mine[0]}"].body
            assert events[f"status:{star[0]}"].notify is False                                          # listed, not sent: he is not in a lineup
            assert "→" in events[f"points:{star[0]}"].title and events[f"points:{star[0]}"].body.endswith("Up 4.0 since the last run.")

            box = Outbox()
            out = notify_run.run(c, box.push, box.email)
            assert (out["events"], out["to_send"], out["push_sent"], out["email_sent"]) == (3, 1, 1, 0)   # e-mail is off until switched on
            assert box.pushes[0][1]["title"] == f"{mine[1]} is questionable" and box.mails == []
            with As(db_url, "authenticated", ALICE) as a:
                assert a.execute("select count(*), count(*) filter (where kind = 'points') from public.app_events").fetchone() == (3, 1)

            # cleared again → a line saying so
            c.execute(snap, (star[0], None, "0 minutes"))
            c.commit()
            cleared = [e for e in detect.status_changes(c) if e.player_id == star[0]]
            assert cleared[0].title == f"{star[1]} is off the injury report" and cleared[0].body.endswith("He was questionable.")

            # "send me a test": to that person only, and never in the list
            out = notify_run.test(c, ALICE, box.push, box.email)
            assert out["push_sent"] == 1 and out["devices"] == 1 and out["email_on"] is False
            assert box.pushes[-1][1]["title"] == "Big Surf Bets: test"
            with As(db_url, "authenticated", ALICE) as a:
                assert a.execute("select count(*) from public.app_events where kind = 'test'").fetchone()[0] == 0
                assert a.execute("select count(*) from public.app_notifications where kind = 'test'").fetchone()[0] == 1
    finally:
        with psycopg.connect(db_url) as c:
            c.execute("delete from bsb.model_runs where id > 1")
            c.execute("update bsb.lineups set entered = false where set_id = %s", (sid,))
            c.execute("update bsb.lineup_sets set entered = false where id = %s", (sid,))
            c.commit()
        _clear_notify(db_url)


def test_the_app_can_ask_for_a_test_notification(db_url):
    _member(db_url)
    with As(db_url, "authenticated", ALICE) as a:
        job = a.execute("select public.bsb_request_job('notify_test')").fetchone()[0]
    with psycopg.connect(db_url) as c:
        kind, status, error = c.execute("select kind, status, error from bsb.app_jobs where id = %s", (job,)).fetchone()
        assert kind == "notify_test" and status == "needs_setup" and "github_pat" in error      # no token in the test database: saved, not started


def test_league_pull_keeps_a_snapshot_only_when_something_changed(db_url, monkeypatch):
    """Read hourly, the league must not add a full set of rosters every hour: a
    snapshot is stored when a roster, a lineup or a transaction moved, and the
    run still counts as a check for the app's "checked" time."""
    from ingest import db as _db
    from ingest import sleeper_league as sl

    lid = "PULL1"
    feed = {
        "rosters": [{"roster_id": 1, "owner_id": "u1", "starters": ["a", "b"], "players": ["a", "b", "c"], "reserve": None,
                     "settings": {"wins": 3, "losses": 7, "fpts": 900, "fpts_decimal": 12}},
                    {"roster_id": 2, "owner_id": "u2", "starters": ["d"], "players": ["d", "e"], "reserve": [],
                     "settings": {"wins": 5, "losses": 5, "fpts": 950, "fpts_decimal": 0}}],
        "txs": [],
    }
    monkeypatch.setattr(sl, "league", lambda _id: {"name": "Pull test", "season": "2026", "total_rosters": 2,
                                                   "scoring_settings": {}, "roster_positions": ["QB"], "settings": {}})
    monkeypatch.setattr(sl, "fetch_state", lambda: {"season": "2026", "week": 11})
    monkeypatch.setattr(sl, "users", lambda _id: [{"user_id": "u1", "display_name": "Me"}, {"user_id": "u2", "display_name": "Them"}])
    monkeypatch.setattr(sl, "rosters", lambda _id: json.loads(json.dumps(feed["rosters"])))
    monkeypatch.setattr(sl, "transactions", lambda _id, week: feed["txs"] if week == 11 else [])

    def snapshots(c) -> int:
        return c.execute("select count(distinct captured_at) from bsb.fantasy_roster_snapshots where league_id = %s", (lid,)).fetchone()[0]

    with psycopg.connect(db_url) as c:
        assert sl.snapshot_league(c, lid) is True and snapshots(c) == 1
        assert sl.snapshot_league(c, lid) is False and snapshots(c) == 1          # nothing moved: nothing stored
        assert _db.recent_ok(c, "sleeper.league", 5, need_rows=False)            # ...but it counts as a look
        assert not _db.recent_ok(c, "sleeper.league", 0, need_rows=False)

        feed["rosters"][0]["starters"] = ["a", "c"]                               # a lineup change in Sleeper
        assert sl.snapshot_league(c, lid) is True and snapshots(c) == 2

        feed["txs"] = [{"transaction_id": 9101, "type": "waiver", "status": "pending", "leg": 11, "adds": {"z": 2},
                        "drops": None, "settings": {"waiver_bid": 40}, "created": 1_790_000_000_000,
                        "status_updated": 1_790_000_000_000, "roster_ids": [2]}]
        assert sl.snapshot_league(c, lid) is True and snapshots(c) == 2           # a new bid, rosters the same
        assert sl.snapshot_league(c, lid) is False                                # the same bid seen again
        feed["txs"][0]["status"] = "complete"
        assert sl.snapshot_league(c, lid) is True                                 # the bid went through

        runs = c.execute("select ok, rows_written, detail->>'changed' from bsb.ingest_runs where job = 'sleeper.league' order by id").fetchall()
    assert [r[2] for r in runs[-6:]] == ["true", "false", "true", "true", "false", "true"]
    assert all(r[0] for r in runs[-6:])


def test_a_refresh_tapped_twice_starts_one_pull_and_the_league_has_its_own_workflow(db_url):
    with psycopg.connect(db_url) as c:
        c.execute("insert into bsb.app_users (user_id, role) values (%s, 'owner') on conflict do nothing", (ALICE,))
        c.commit()
    with As(db_url, "authenticated", ALICE) as c:
        first = c.execute("select public.bsb_request_job('refresh_league')").fetchone()[0]
    with psycopg.connect(db_url) as c:
        wf, inputs = c.execute("select workflow, inputs from bsb.dispatches order by id desc limit 1").fetchone()
        assert wf == "league.yml" and inputs == {"app_job_id": str(first)}
        c.execute("update bsb.app_jobs set status = 'dispatched' where id = %s", (first,))   # GitHub accepted it
        c.commit()
    with As(db_url, "authenticated", ALICE) as c:
        assert c.execute("select public.bsb_request_job('refresh_league')").fetchone()[0] == first
        other = c.execute("select public.bsb_request_job('refresh_odds')").fetchone()[0]
    assert other != first
    with psycopg.connect(db_url) as c:
        c.execute("update bsb.app_jobs set status = 'done' where id = %s", (first,))
        c.commit()
    with As(db_url, "authenticated", ALICE) as c:   # once it has landed, a tap starts a new one
        assert c.execute("select public.bsb_request_job('refresh_league')").fetchone()[0] != first


def test_on_demand_odds_pulls_only_spend_what_the_timetable_does_not_need(db_url):
    """OddsPapi allows 250 requests a month. What the scheduled pulls still need
    this month is set aside; only the rest is offered to the "pull now" button."""
    import calendar

    today = datetime.now(UTC).date()
    last = calendar.monthrange(today.year, today.month)[1]
    weights = {6: 2, 0: 1, 3: 1}                     # Python weekday: Sun 2 (Sat night + Sun morning UTC), Mon 1, Thu 1
    scheduled = sum(weights.get(today.replace(day=d).weekday(), 0) for d in range(today.day, last + 1))

    with psycopg.connect(db_url) as c:
        c.execute("delete from bsb.ingest_runs where job = 'odds.oddspapi'")
        c.execute("""insert into bsb.ingest_runs (job, started_at, finished_at, ok, rows_written, detail) values
                     ('odds.oddspapi', now() - interval '40 days', now() - interval '40 days', true, 10, '{"api_calls": 90}'),
                     ('odds.oddspapi', date_trunc('month', now()) + interval '1 minute', now(), true, 900, '{"api_calls": 7}'),
                     ('odds.oddspapi', now() - interval '2 minutes', now() - interval '1 minute', false, 0, '{"api_calls": 4, "error": "x"}'),
                     ('odds.oddspapi', now() - interval '1 minute', now(), true, 800, '{"api_calls": 7}')""")
        c.commit()
        monthly, used, per_pull, reserved, left = c.execute("select * from bsb.oddspapi_budget()").fetchone()
        assert (monthly, used, per_pull) == (250, 18, 7)                          # last month's 90 don't count; the failed pull's 4 do
        assert reserved == scheduled * 7
        assert left == max((250 - 18 - scheduled * 7) // 7, 0)

        c.execute("insert into bsb.app_config (key, value) values ('oddspapi_monthly', '20') on conflict (key) do update set value = excluded.value")
        c.commit()
        assert c.execute("select pulls_left from bsb.oddspapi_budget()").fetchone()[0] == 0
        c.execute("delete from bsb.app_config where key = 'oddspapi_monthly'")
        c.commit()

    with As(db_url, "authenticated", ALICE) as c:                                 # the app reads it through the view
        rows = {r[0]: r for r in c.execute("select job, checked_at, changed_at, pulls_left from public.app_pull_status")}
    assert set(rows) == {"sleeper.league", "odds.oddslink", "odds.oddspapi"}
    assert rows["odds.oddspapi"][3] == left and rows["odds.oddslink"][3] is None
    with As(db_url, "authenticated", BOB) as c:                                   # a stranger sees nothing
        assert c.execute("select * from public.app_pull_status").fetchall() == []

