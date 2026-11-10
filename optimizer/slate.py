"""The player pool: a DraftKings slate joined to our projections."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import polars as pl

from ingest.draftkings import _parse_game_info, _team

POOL_COLS = [
    "dk_id", "player_id", "name", "pos", "team", "opponent", "game", "kickoff", "salary", "status",
    "dk_mean", "dk_std", "dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90",
]
OUT_STATUSES = ("OUT", "O", "IR", "D")


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", s))


def _finish(df: pl.DataFrame) -> pl.DataFrame:
    """Keep playable rows: projected, not ruled out, one row per player."""
    return (
        df.filter(pl.col("dk_mean").is_not_null() & ~pl.col("status").fill_null("").str.to_uppercase().is_in(OUT_STATUSES))
        .with_columns(
            pl.concat_str([pl.min_horizontal("team", "opponent"), pl.max_horizontal("team", "opponent")], separator="-").alias("game"),
            pl.col("dk_std").fill_null(0.0),
        )
        .unique("dk_id")
        .select(POOL_COLS)
        .sort("salary", "dk_id", descending=[True, False])
    )


def from_files(slate_csv: str | Path, projections: str | Path) -> pl.DataFrame:
    """Local path: a DKSalaries.csv export + a projections parquet from `bsb model project`."""
    dk = pl.read_csv(slate_csv, infer_schema_length=0)
    dk.columns = [c.strip() for c in dk.columns]
    info = [_parse_game_info(g) for g in dk["Game Info"]]
    dk = dk.with_columns(
        pl.col("TeamAbbrev").map_elements(_team, return_dtype=pl.Utf8).alias("team"),
        pl.col("Name").map_elements(norm_name, return_dtype=pl.Utf8).alias("key"),
        pl.Series("kickoff", [i[2] for i in info]),
    )
    pr = pl.read_parquet(projections).with_columns(
        pl.when(pl.col("position") == "DST").then(pl.col("team"))
        .otherwise(pl.col("player_name").map_elements(norm_name, return_dtype=pl.Utf8)).alias("key")
    )
    dk = dk.with_columns(pl.when(pl.col("Position") == "DST").then(pl.col("team")).otherwise(pl.col("key")).alias("key"))
    j = dk.join(
        pr.select("key", "team", "player_id", "opponent", "dk_mean", "dk_std", "dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90"),
        on=["key", "team"], how="left",
    )
    return _finish(j.select(
        pl.col("ID").alias("dk_id"), "player_id", pl.col("Name").alias("name"), pl.col("Position").alias("pos"),
        "team", "opponent", "kickoff", pl.col("Salary").cast(pl.Int32).alias("salary"), pl.col("Status").alias("status"),
        "dk_mean", "dk_std", "dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90",
    ))


def latest_slate_id(conn, slate_type: str = "classic") -> int | None:
    row = conn.execute(
        """select id from bsb.dfs_slates
           where site = 'draftkings' and slate_type = %s and starts_at > now()
           order by imported_at desc limit 1""",
        (slate_type,),
    ).fetchone()
    return row[0] if row else None


def from_db(conn, slate_id: int) -> tuple[pl.DataFrame, dict]:
    """Supabase path: bsb.dfs_salaries ⋈ bsb.projections_latest. → (pool, slate info)"""
    meta = conn.execute(
        "select id, slate_name, slate_type, season, week, salary_cap, starts_at from bsb.dfs_slates where id = %s", (slate_id,)
    ).fetchone()
    if not meta:
        raise ValueError(f"slate {slate_id} not found")
    info = dict(zip(("id", "slate_name", "slate_type", "season", "week", "salary_cap", "starts_at"), meta, strict=True))
    cur = conn.execute(
        """select s.site_player_id, s.player_id, s.player_name, s.position, s.team, s.opponent, g.kickoff_at,
                  s.salary, s.raw->>'Status',
                  p.dk_mean::float8, p.dk_std::float8, p.dk_p10::float8, p.dk_p25::float8, p.dk_p50::float8,
                  p.dk_p75::float8, p.dk_p90::float8, p.run_id
           from bsb.dfs_salaries s
           join bsb.dfs_slates sl on sl.id = s.slate_id
           left join bsb.games g on g.game_id = s.game_id
           left join bsb.projections_latest p
                  on p.player_id = s.player_id and p.season = sl.season and p.week = sl.week
           where s.slate_id = %s""",
        (slate_id,),
    )
    cols = ["dk_id", "player_id", "name", "pos", "team", "opponent", "kickoff", "salary", "status",
            "dk_mean", "dk_std", "dk_p10", "dk_p25", "dk_p50", "dk_p75", "dk_p90", "run_id"]
    df = pl.DataFrame(cur.fetchall(), schema=cols, orient="row", infer_schema_length=None)
    runs = df["run_id"].drop_nulls()
    info["run_id"] = int(runs[0]) if runs.len() else None
    return _finish(df), info
