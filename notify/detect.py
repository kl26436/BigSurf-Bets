"""Find what changed. Read-only: returns events, run.py records them."""

from __future__ import annotations

from dataclasses import dataclass, field

import psycopg

# statuses that mean "will not play" — the same lists the projections use (model/project.py)
SLEEPER_OUT = ("Out", "IR", "PUP", "Sus", "Doubtful", "NA", "COV", "DNR")
DK_OUT = ("OUT", "O", "IR", "D")
STATUS_WORDS = {
    "Out": "out", "O": "out", "OUT": "out", "IR": "on injured reserve", "PUP": "on the PUP list", "Sus": "suspended",
    "Doubtful": "doubtful", "D": "doubtful", "Questionable": "questionable", "Q": "questionable",
    "NA": "not with the team", "COV": "on the COVID list", "DNR": "not returning",
}
# a status change or a points move is only worth a line for players who matter on the slate
MIN_POINTS_FOR_FEED = 8.0
POINTS_MOVE = 3.0
# the "no expected points" rule only means "ruled out" when the week has projections at all
MIN_POOL_COVERAGE = 0.4


@dataclass
class Event:
    kind: str                    # scratch / status / points / test
    dedupe_key: str
    title: str
    body: str = ""
    url: str = "/"
    severity: str = "info"       # alert: worth a pop-up
    slate_id: int | None = None
    player_id: str | None = None
    notify: bool = False         # send it, not only list it
    data: dict = field(default_factory=dict)


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def scratches(conn: psycopg.Connection) -> list[Event]:
    """Players in entered lineups, for games still to come, who are now ruled out."""
    rows = conn.execute(
        """
        with live as (
            select sl.id as slate_id,
                   (select count(*) filter (where p.dk_mean is not null)::float8 / greatest(count(*), 1)
                      from public.app_pool p where p.slate_id = sl.id) as coverage
            from bsb.dfs_slates sl
            where sl.starts_at > now() - interval '36 hours'
        ),
        mine as (
            select ls.slate_id, lp.set_id, lp.lineup_no, lp.site_player_id as dk_id, lp.player_id, lp.player_name, lp.team
            from bsb.lineup_players lp
            join bsb.lineups l on l.set_id = lp.set_id and l.lineup_no = lp.lineup_no and l.entered
            join bsb.lineup_sets ls on ls.id = lp.set_id and ls.archived_at is null
            join live on live.slate_id = ls.slate_id
        )
        select m.slate_id, m.dk_id, m.player_id, m.player_name, m.team,
               count(distinct (m.set_id, m.lineup_no)) as n_lineups,
               bool_or(p.dk_id is null) as gone, bool_or(p.dk_mean is null) as no_points, max(p.dk_status) as dk_status,
               max(live.coverage) as coverage, max(st.injury_status) as sleeper_status
        from mine m
        join live on live.slate_id = m.slate_id
        left join public.app_pool p on p.slate_id = m.slate_id and p.dk_id = m.dk_id
        left join lateral (
            select s.injury_status from bsb.player_status_snapshots s
            where s.sport = 'nfl' and s.player_id = m.player_id and s.captured_at > now() - interval '36 hours'
            order by s.captured_at desc limit 1
        ) st on true
        where coalesce(p.kickoff_at, now() + interval '1 hour') > now()        -- a started game can't be swapped
        group by m.slate_id, m.dk_id, m.player_id, m.player_name, m.team
        """
    ).fetchall()
    out = []
    for slate_id, dk_id, player_id, name, team, n_lineups, gone, no_points, dk_status, coverage, sleeper in rows:
        dk = (dk_status or "").upper()
        if sleeper in SLEEPER_OUT:
            word, level = STATUS_WORDS.get(sleeper, "ruled out"), ("doubtful" if sleeper == "Doubtful" else "out")
        elif dk in DK_OUT:
            word, level = STATUS_WORDS.get(dk, "ruled out"), ("doubtful" if dk == "D" else "out")
        elif gone or (no_points and (coverage or 0) >= MIN_POOL_COVERAGE):
            word, level = "no longer expected to play", "out"
        else:
            continue
        out.append(Event(
            kind="scratch", dedupe_key=f"scratch:{slate_id}:{dk_id}:{level}", severity="alert", notify=True,
            title=f"{name} is {word}", slate_id=slate_id, player_id=player_id, url="/lineups/swap",
            body=f"{name}{f' ({team})' if team else ''} is in {_plural(n_lineups, 'entered lineup')}.",
            data={"dk_id": dk_id, "lineups": n_lineups, "level": level},
        ))
    return out


def status_changes(conn: psycopg.Connection) -> list[Event]:
    """Slate players whose status changed between the last two snapshots."""
    rows = conn.execute(
        """
        with pool as (
            select distinct on (p.player_id) p.player_id, p.name, p.team, p.slate_id, p.dk_id, p.dk_mean
            from public.app_pool p join bsb.dfs_slates sl on sl.id = p.slate_id and sl.starts_at > now()
            where p.player_id is not null and p.kickoff_at > now()
            order by p.player_id, p.slate_id desc
        ),
        snaps as (
            select s.player_id, s.injury_status, s.captured_at,
                   lag(s.injury_status) over w as prev, lag(s.captured_at) over w as prev_at,
                   row_number() over (partition by s.player_id order by s.captured_at desc) as rn
            from bsb.player_status_snapshots s
            where s.sport = 'nfl' and s.captured_at > now() - interval '48 hours' and s.player_id in (select player_id from pool)
            window w as (partition by s.player_id order by s.captured_at)
        )
        select p.player_id, p.name, p.team, p.slate_id, p.dk_id, p.dk_mean, s.injury_status, s.prev, s.captured_at,
               exists (select 1 from bsb.lineup_players lp
                         join bsb.lineups l on l.set_id = lp.set_id and l.lineup_no = lp.lineup_no and l.entered
                         join bsb.lineup_sets ls on ls.id = lp.set_id and ls.archived_at is null and ls.slate_id = p.slate_id
                        where lp.site_player_id = p.dk_id) as mine
        from snaps s join pool p on p.player_id = s.player_id
        where s.rn = 1 and s.prev_at is not null and s.injury_status is distinct from s.prev
        """
    ).fetchall()
    out = []
    for player_id, name, team, slate_id, dk_id, dk_mean, now_status, prev, at, mine in rows:
        ruled_out = now_status in SLEEPER_OUT
        if ruled_out and mine:
            continue                                   # scratches() says it, louder
        if not mine and (dk_mean is None or float(dk_mean) < MIN_POINTS_FOR_FEED) and not ruled_out:
            continue
        if now_status is None:
            title = f"{name} is off the injury report"
            body = f"He was {STATUS_WORDS.get(prev, prev)}."
        else:
            title = f"{name} is {STATUS_WORDS.get(now_status, now_status.lower())}"
            body = f"He was {STATUS_WORDS.get(prev, prev)} before." if prev else "He had no tag before."
        if mine:
            body += " He is in a lineup you entered."
        out.append(Event(
            kind="status", dedupe_key=f"status:{player_id}:{at:%Y%m%d%H%M}:{now_status or 'clear'}", title=title,
            body=f"{team}. {body}" if team else body, slate_id=slate_id, player_id=player_id,
            url="/lineups" if mine else "/players", severity="alert" if ruled_out else "info",
            notify=bool(mine and now_status is not None), data={"dk_id": dk_id, "from": prev, "to": now_status, "mine": mine},
        ))
    return out


def points_moves(conn: psycopg.Connection) -> list[Event]:
    """Slate players whose expected points moved by three or more between the last two runs."""
    rows = conn.execute(
        """
        with runs as (
            select r.id, r.season, r.week, row_number() over (partition by r.season, r.week order by r.id desc) as rn
            from bsb.model_runs r
            join (select distinct season, week from bsb.dfs_slates where starts_at > now()) w on w.season = r.season and w.week = r.week
            where r.sport = 'nfl'
        )
        select a.run_id, p.player_id, p.name, p.team, p.slate_id, b.dk_mean::float8 as before, a.dk_mean::float8 as after
        from runs ra join runs rb on rb.season = ra.season and rb.week = ra.week and ra.rn = 1 and rb.rn = 2
        join bsb.projections a on a.run_id = ra.id
        join bsb.projections b on b.run_id = rb.id and b.player_id = a.player_id
        join lateral (
            select p.player_id, p.name, p.team, p.slate_id from public.app_pool p
            join bsb.dfs_slates sl on sl.id = p.slate_id and sl.starts_at > now() and sl.season = ra.season and sl.week = ra.week
            where p.player_id = a.player_id order by p.slate_id desc limit 1
        ) p on true
        where abs(a.dk_mean - b.dk_mean) >= %s and greatest(a.dk_mean, b.dk_mean) >= %s
        """,
        (POINTS_MOVE, MIN_POINTS_FOR_FEED),
    ).fetchall()
    return [
        Event(kind="points", dedupe_key=f"points:{run_id}:{player_id}", slate_id=slate_id, player_id=player_id, url="/players",
              title=f"{name}: {before:.1f} → {after:.1f} expected",
              body=f"{team + '. ' if team else ''}{'Up' if after > before else 'Down'} {abs(after - before):.1f} since the last run.",
              data={"before": before, "after": after})
        for run_id, player_id, name, team, slate_id, before, after in rows
    ]


def find_events(conn: psycopg.Connection) -> list[Event]:
    return scratches(conn) + status_changes(conn) + points_moves(conn)
