"""Holdout evaluation: train on past seasons, score a later one the model never saw.

Answers three questions, in order of how much money rides on them:
  1. Are the means better than what anyone gets for free (a player's recent
     average)?  → MAE vs naive baselines, per stat and for DK points.
  2. Are the *distributions* honest?  → interval coverage, and reliability of
     over/under probabilities (when the model says 60%, does it hit 60%?).
  3. Does it rank players well?  → Spearman correlation (what DFS cares about).

What this cannot answer: whether the model beats the betting market. The
baselines here are naive; sportsbook lines are not. That needs real prop lines
(accumulating in bsb.odds_snapshots) and is a separate benchmark."""

from __future__ import annotations

import numpy as np
import polars as pl

from . import train
from .features import POSITIONS

# stats we price props on, with the minimum recent average for a player to be
# "listed" (books don't hang a receiving-yards line on a blocking tight end)
PROP_STATS = {
    "passing_yards": 150, "attempts": 20, "completions": 12,
    "rushing_yards": 20, "carries": 6,
    "receiving_yards": 20, "receptions": 2, "targets": 3,
}
RELEVANT_DK = 5.0  # "fantasy-relevant": recent DK average at least this
BINS = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001]


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a - b).mean())


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = a.argsort().argsort(), b.argsort().argsort()
    return float(np.corrcoef(ra, rb)[0, 1])


def stat_accuracy(pred: pl.DataFrame) -> list[dict]:
    rows = []
    for stat, spec in train.SPECS.items():
        d = pred.filter(pl.col("pos").is_in(spec.positions) & pl.col(f"{stat}_l").is_not_null())
        y = d[stat].to_numpy()
        ytd = d.select(pl.coalesce(f"{stat}_ytd", f"{stat}_l"))[:, 0].to_numpy()
        rows.append(dict(
            stat=stat, n=d.height,
            model=_mae(d[f"proj_{stat}"].to_numpy(), y),
            recent_avg=_mae(d[f"{stat}_l"].to_numpy(), y),
            last4=_mae(d[f"{stat}_l4"].to_numpy(), y),
            season_avg=_mae(ytd, y),
        ))
    for r in rows:
        best = min(r["recent_avg"], r["last4"], r["season_avg"])
        r["vs_best_baseline_pct"] = 100 * (r["model"] / best - 1)
    return rows


def points_accuracy(pred: pl.DataFrame, key: str = "dk") -> list[dict]:
    rows = []
    rel = pred.filter(pl.col(f"{key}_l") >= RELEVANT_DK)
    for pos in [*POSITIONS, "ALL"]:
        d = rel if pos == "ALL" else rel.filter(pl.col("pos") == pos)
        y, p = d[key].to_numpy(), d[f"proj_{key}"].to_numpy()
        ytd = d.select(pl.coalesce(f"{key}_ytd", f"{key}_l"))[:, 0].to_numpy()
        base = {"recent_avg": d[f"{key}_l"].to_numpy(), "last4": d[f"{key}_l4"].to_numpy(), "season_avg": ytd}
        best_name = min(base, key=lambda k: _mae(base[k], y))
        rows.append(dict(
            pos=pos, n=d.height, model_mae=_mae(p, y), best_baseline=best_name,
            baseline_mae=_mae(base[best_name], y),
            improvement_pct=100 * (1 - _mae(p, y) / _mae(base[best_name], y)),
            model_rmse=float(np.sqrt(((p - y) ** 2).mean())),
            bias=float((p - y).mean()),
            spearman_model=_spearman(p, y), spearman_baseline=_spearman(base[best_name], y),
            cover_p10_p90=float(((y >= d[f"proj_{key}_p10"].to_numpy()) & (y <= d[f"proj_{key}_p90"].to_numpy())).mean()),
            cover_p25_p75=float(((y >= d[f"proj_{key}_p25"].to_numpy()) & (y <= d[f"proj_{key}_p75"].to_numpy())).mean()),
        ))
    return rows


def prop_calibration(model: train.Model, pred: pl.DataFrame) -> tuple[list[dict], list[dict], list[dict]]:
    """Over/under probabilities against synthetic lines set at 75% / 100% / 125%
    of each listed player's recent average (so the centre *and* the tails of
    the distribution get tested). → (per-stat summary, reliability table, picks)."""
    per_stat, all_p, all_hit, picks = [], [], [], []
    for stat, floor_ in PROP_STATS.items():
        spec = train.SPECS[stat]
        d = pred.filter(pl.col("pos").is_in(spec.positions) & (pl.col(f"{stat}_l") >= floor_))
        mu, y, base = d[f"proj_{stat}"].to_numpy(), d[stat].to_numpy(), d[f"{stat}_l"].to_numpy()
        ps, hits = [], []
        for mult in (0.75, 1.0, 1.25):
            line = np.floor(base * mult) + 0.5
            p = train.prob_over(model, stat, mu, line)
            hit = (y > line).astype(float)
            ps.append(p)
            hits.append(hit)
            if mult == 1.0:  # the "main" line: where would the model have bet?
                for side, conf, won in (("over", p, hit), ("under", 1 - p, 1 - hit)):
                    m = conf >= 0.58
                    picks.append(dict(stat=stat, side=side, n=int(m.sum()), wins=float(won[m].sum())))
        p, hit = np.concatenate(ps), np.concatenate(hits)
        base_rate = hit.mean()
        per_stat.append(dict(
            stat=stat, n=len(p), brier=float(((p - hit) ** 2).mean()),
            brier_base_rate=float(((base_rate - hit) ** 2).mean()),
            mean_pred=float(p.mean()), actual=float(base_rate),
        ))
        all_p.append(p)
        all_hit.append(hit)
    p, hit = np.concatenate(all_p), np.concatenate(all_hit)
    rel = []
    for lo, hi in zip(BINS[:-1], BINS[1:], strict=True):
        m = (p >= lo) & (p < hi)
        if m.any():
            rel.append(dict(bucket=f"{lo:.0%}–{min(hi, 1):.0%}", n=int(m.sum()), predicted=float(p[m].mean()), actual=float(hit[m].mean())))
    return per_stat, rel, picks


def td_calibration(model: train.Model, pred: pl.DataFrame) -> list[dict]:
    """Anytime-TD probability (rush or receiving) for relevant non-QBs."""
    d = pred.filter((pl.col("dk_l") >= RELEVANT_DK) & (pl.col("pos") != "QB"))
    p0 = (1 - train.prob_over(model, "rushing_tds", d["proj_rushing_tds"].to_numpy(), 0.5)) * (
        1 - train.prob_over(model, "receiving_tds", d["proj_receiving_tds"].to_numpy(), 0.5)
    )
    p, hit = 1 - p0, ((d["rushing_tds"] + d["receiving_tds"]) > 0).to_numpy().astype(float)
    rows = []
    for lo, hi in ((0, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.4), (0.4, 0.5), (0.5, 1.01)):
        m = (p >= lo) & (p < hi)
        if m.any():
            rows.append(dict(bucket=f"{lo:.0%}–{min(hi, 1):.0%}", n=int(m.sum()), predicted=float(p[m].mean()), actual=float(hit[m].mean())))
    return rows


def run(df: pl.DataFrame, train_seasons: list[int], test_season: int, weeks: tuple[int, int] | None = None) -> dict:
    """Fit on `train_seasons`, evaluate on `test_season` (optionally a week range)."""
    model, _ = train.fit(df, train_seasons)
    test = df.filter((pl.col("season") == test_season) & ~pl.col("is_future"))
    if weeks:
        test = test.filter(pl.col("week").is_between(weeks[0], weeks[1]))
    pred = train.predict(model, test)
    per_stat, reliability, picks = prop_calibration(model, pred)
    return dict(
        train_seasons=train_seasons, test_season=test_season,
        weeks=[int(test["week"].min()), int(test["week"].max())],
        n_train=model.n_rows, n_test=test.height, n_features=len(model.features),
        stats=stat_accuracy(pred), dk=points_accuracy(pred, "dk"), ppr=points_accuracy(pred, "ppr"),
        props=per_stat, reliability=reliability, picks=picks, anytime_td=td_calibration(model, pred),
        dispersion={k: [round(float(a), 4) for a in v.alphas] for k, v in model.dists.items() if hasattr(v, "alphas")},
        _model=model, _pred=pred,
    )


def to_markdown(r: dict) -> str:
    L: list[str] = []
    a = L.append
    a(f"# Backtest — {r['test_season']} weeks {r['weeks'][0]}–{r['weeks'][1]}")
    a("")
    a(f"Trained on {r['train_seasons'][0]}–{r['train_seasons'][-1]} ({r['n_train']:,} player-games, "
      f"{r['n_features']} features); scored on {r['n_test']:,} player-games the model never saw.")
    a("")
    a("## DraftKings points (fantasy-relevant players)")
    a("")
    a("| Pos | n | Model MAE | Best naive MAE | Improvement | Bias | Rank corr (model / naive) | 80% band covers | 50% band covers |")
    a("|---|---|---|---|---|---|---|---|---|")
    for x in r["dk"]:
        a(f"| {x['pos']} | {x['n']:,} | {x['model_mae']:.2f} | {x['baseline_mae']:.2f} ({x['best_baseline'].replace('_', ' ')}) | "
          f"{x['improvement_pct']:+.1f}% | {x['bias']:+.2f} | {x['spearman_model']:.3f} / {x['spearman_baseline']:.3f} | "
          f"{x['cover_p10_p90']:.0%} | {x['cover_p25_p75']:.0%} |")
    a("")
    a("## PPR points (fantasy-relevant players)")
    a("")
    a("| Pos | n | Model MAE | Best naive MAE | Improvement | Rank corr (model / naive) |")
    a("|---|---|---|---|---|---|")
    for x in r["ppr"]:
        a(f"| {x['pos']} | {x['n']:,} | {x['model_mae']:.2f} | {x['baseline_mae']:.2f} | {x['improvement_pct']:+.1f}% | "
          f"{x['spearman_model']:.3f} / {x['spearman_baseline']:.3f} |")
    a("")
    a("## Stat projections — mean absolute error")
    a("")
    a("| Stat | n | Model | Recent avg (EWMA) | Last 4 | Season avg | Model vs best naive |")
    a("|---|---|---|---|---|---|---|")
    for x in r["stats"]:
        a(f"| {x['stat']} | {x['n']:,} | {x['model']:.3f} | {x['recent_avg']:.3f} | {x['last4']:.3f} | {x['season_avg']:.3f} | {x['vs_best_baseline_pct']:+.1f}% |")
    a("")
    a("## Over/under probabilities — reliability")
    a("")
    a("Synthetic lines at 75% / 100% / 125% of each listed player's recent average. "
      "A calibrated model's *actual* column matches *predicted*.")
    a("")
    a("| Model said P(over) | n | Predicted | Actual |")
    a("|---|---|---|---|")
    for x in r["reliability"]:
        a(f"| {x['bucket']} | {x['n']:,} | {x['predicted']:.1%} | {x['actual']:.1%} |")
    a("")
    a("| Stat | n | Brier (model) | Brier (base rate) | Mean predicted | Actual over rate |")
    a("|---|---|---|---|---|---|")
    for x in r["props"]:
        a(f"| {x['stat']} | {x['n']:,} | {x['brier']:.4f} | {x['brier_base_rate']:.4f} | {x['mean_pred']:.1%} | {x['actual']:.1%} |")
    a("")
    n = sum(p["n"] for p in r["picks"])
    w = sum(p["wins"] for p in r["picks"])
    if n:
        a(f"Sides the model liked at ≥58% against a line at the player's recent average: **{w:.0f}–{n - w:.0f} "
          f"({w / n:.1%})** over {n:,} picks. That is a test against a *naive* line, not a sportsbook's — "
          "it shows the probabilities carry signal, not that the market is beatable.")
        a("")
    a("## Anytime touchdown (non-QB)")
    a("")
    a("| Model said | n | Predicted | Actual |")
    a("|---|---|---|---|")
    for x in r["anytime_td"]:
        a(f"| {x['bucket']} | {x['n']:,} | {x['predicted']:.1%} | {x['actual']:.1%} |")
    a("")
    return "\n".join(L)
