"""Persist a lineup set: local CSVs (DK upload + readable detail) and Supabase."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
import polars as pl

from .portfolio import Portfolio

OUT_DIR = Path("data/lineups")


def set_summary(pf: Portfolio) -> dict:
    """Set-level numbers: what the lineups achieve together."""
    if not pf.lineups:
        return {}
    best = pf.totals.max(axis=1)
    e = pf.exposure()
    return dict(
        n=len(pf.lineups), players_used=e.height, max_exposure_pct=float(e["exposure_pct"].max()),
        avg_proj=round(float(pf.summary()["proj"].mean()), 2),
        best_lineup_mean=round(float(pf.totals.mean(0).max()), 2),
        set_best_mean=round(float(best.mean()), 2),      # average top score across the set, per simulated slate
        set_best_p90=round(float(np.quantile(best, 0.9)), 1),
    )


def save_local(pf: Portfolio, label: str, out_dir: Path | None = None) -> tuple[Path, Path]:
    out = out_dir or OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    upload, detail = out / f"{label}_dk_upload.csv", out / f"{label}_detail.csv"
    upload.write_text(pf.to_dk_csv(), encoding="utf-8")
    pf.rows().join(pf.summary().select("lineup", "sim_mean", "p10", "p90"), on="lineup").write_csv(detail)
    return upload, detail


def write_db(
    conn, pf: Portfolio, slate_id: int, run_id: int | None, source: str = "auto",
    job_id: int | None = None, label: str | None = None,
) -> int:
    from ingest.db import RunLogger, insert_df

    with RunLogger(conn, "optimizer.lineups") as run:
        s = asdict(pf.settings)
        s["rules"] = {k: (sorted(v) if isinstance(v, set) else v) for k, v in asdict(pf.settings.resolved_rules()).items()}
        set_id = conn.execute(
            """insert into bsb.lineup_sets (slate_id, run_id, mode, n_lineups, settings, summary, source, job_id, label)
               values (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s) returning id""",
            (slate_id, run_id, pf.settings.mode, len(pf.lineups), json.dumps(s),
             json.dumps({**set_summary(pf), "notes": pf.notes}), source, job_id, label),
        ).fetchone()[0]
        lineups = pf.summary().rename({"lineup": "lineup_no"}).with_columns(pl.lit(set_id).alias("set_id"))
        players = pf.rows().rename(
            {"lineup": "lineup_no", "dk_id": "site_player_id", "name": "player_name", "pos": "position"}
        ).with_columns(pl.lit(set_id).alias("set_id"))
        n = insert_df(conn, "lineups", lineups)
        insert_df(conn, "lineup_players", players)
        run.rows = n
        run.detail.update(set_id=set_id, slate_id=slate_id, mode=pf.settings.mode)
        conn.commit()
        return set_id
