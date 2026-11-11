"""Outcome distributions around a projected mean.

A projection of "62 receiving yards" is not enough to price a prop or build a
lineup — we need P(yards > 54.5) and the ceiling/floor. Two families:

  NegBin     counts (attempts, receptions, TDs …): negative binomial with the
             model mean and one over-dispersion parameter per stat, fitted by
             maximum likelihood on out-of-fold predictions.
  Empirical  yards and fantasy points: no parametric shape assumed. Out-of-fold
             (prediction, actual) pairs are bucketed by prediction; a new
             projection borrows its bucket's actual outcomes, rescaled to the
             projection. Skew, zero-inflation and fat tails come for free.

Both are fitted only on out-of-fold predictions so they describe real forecast
error, not in-sample fit."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import optimize, stats

QUANTILES = (0.1, 0.25, 0.5, 0.75, 0.9)


@dataclass
class NegBin:
    """var = mu + alpha * mu^2 (alpha → 0 is Poisson). alpha is fitted per
    bucket of the projected mean: a starting QB's attempts are far tighter
    around the projection than a backup's, and one global alpha would make the
    model under-confident exactly where the prop markets are."""

    edges: np.ndarray = field(default_factory=lambda: np.array([np.inf]))  # upper mean edge per bucket
    alphas: np.ndarray = field(default_factory=lambda: np.array([0.1]))

    @property
    def alpha(self) -> float:
        return float(np.mean(self.alphas))

    @staticmethod
    def _fit_alpha(mu: np.ndarray, y: np.ndarray) -> float:
        def nll(log_alpha: float) -> float:
            n = 1.0 / np.exp(log_alpha)
            return -stats.nbinom.logpmf(y, n, n / (n + mu)).sum()

        res = optimize.minimize_scalar(nll, bounds=(np.log(1e-4), np.log(5.0)), method="bounded")
        return float(np.exp(res.x))

    @classmethod
    def fit(cls, mu: np.ndarray, y: np.ndarray, n_buckets: int = 5, min_bucket: int = 400) -> NegBin:
        mu = np.clip(np.asarray(mu, float), 1e-4, None)
        y = np.clip(np.round(np.asarray(y, float)), 0, None)
        n_buckets = max(1, min(n_buckets, len(mu) // min_bucket))
        chunks = np.array_split(np.argsort(mu, kind="stable"), n_buckets)
        edges = np.array([mu[c].max() for c in chunks])
        edges[-1] = np.inf
        return cls(edges=edges, alphas=np.array([cls._fit_alpha(mu[c], y[c]) for c in chunks]))

    def _np(self, mu: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mu = np.clip(np.asarray(mu, float), 1e-4, None)
        b = np.clip(np.searchsorted(self.edges, mu, side="left"), 0, len(self.edges) - 1)
        n = 1.0 / self.alphas[b]
        return n, n / (n + mu)

    def prob_over(self, mu: np.ndarray, line: np.ndarray) -> np.ndarray:
        """P(X > line). Lines are normally x.5, so this is P(X >= ceil(line))."""
        n, p = self._np(mu)
        return stats.nbinom.sf(np.floor(np.asarray(line, float)), n, p)

    def quantile(self, mu: np.ndarray, q: float) -> np.ndarray:
        n, p = self._np(mu)
        return stats.nbinom.ppf(q, n, p)

    def to_json(self) -> dict:
        """What the app needs to price a number itself (see app/src/lib/dist.ts)."""
        return {"edges": [None if not np.isfinite(e) else round(float(e), 4) for e in self.edges],
                "alphas": [round(float(x), 5) for x in self.alphas]}


@dataclass
class Empirical:
    edges: np.ndarray = field(default_factory=lambda: np.array([]))  # upper prediction edge per bucket
    pred_mean: np.ndarray = field(default_factory=lambda: np.array([]))
    samples: list[np.ndarray] = field(default_factory=list)          # sorted actual outcomes per bucket

    @classmethod
    def fit(cls, pred: np.ndarray, actual: np.ndarray, n_buckets: int = 15, min_bucket: int = 250) -> Empirical:
        pred, actual = np.asarray(pred, float), np.asarray(actual, float)
        n_buckets = max(1, min(n_buckets, len(pred) // min_bucket))
        order = np.argsort(pred, kind="stable")
        chunks = np.array_split(order, n_buckets)
        return cls(
            edges=np.array([pred[c].max() for c in chunks]),
            pred_mean=np.array([max(pred[c].mean(), 1e-6) for c in chunks]),
            samples=[np.sort(actual[c]) for c in chunks],
        )

    def _bucket(self, mu: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mu = np.asarray(mu, float)
        b = np.clip(np.searchsorted(self.edges, mu, side="left"), 0, len(self.edges) - 1)
        # rescale the bucket's outcomes to this projection (clamped: beyond the
        # range seen in training we don't extrapolate the shape wildly)
        scale = np.clip(np.where(mu > 0, mu, 0.0) / self.pred_mean[b], 0.4, 2.5)
        return b, scale

    def prob_over(self, mu: np.ndarray, line: np.ndarray) -> np.ndarray:
        mu, line = np.broadcast_arrays(np.asarray(mu, float), np.asarray(line, float))
        b, scale = self._bucket(mu)
        out = np.empty(mu.shape, float)
        for k, s in enumerate(self.samples):
            m = b == k
            if m.any():
                out[m] = 1.0 - np.searchsorted(s, line[m] / scale[m], side="right") / len(s)
        return out

    def quantile(self, mu: np.ndarray, q: float) -> np.ndarray:
        mu = np.asarray(mu, float)
        b, scale = self._bucket(mu)
        qs = np.array([np.quantile(s, q) for s in self.samples])
        return qs[b] * scale

    def mean(self, mu: np.ndarray) -> np.ndarray:
        """Calibrated mean: the bucket's realised mean, rescaled."""
        mu = np.asarray(mu, float)
        b, scale = self._bucket(mu)
        return np.array([s.mean() for s in self.samples])[b] * scale

    def std(self, mu: np.ndarray) -> np.ndarray:
        mu = np.asarray(mu, float)
        b, scale = self._bucket(mu)
        return np.array([s.std() for s in self.samples])[b] * scale

    def to_json(self, n_points: int = 201) -> dict:
        """Each bucket's outcomes boiled down to evenly spaced quantiles (0 … 1):
        enough for the app to read P(over) off them to within half a point."""
        qs = np.linspace(0, 1, n_points)
        return {"edges": [round(float(e), 4) for e in self.edges],
                "pred_mean": [round(float(m), 4) for m in self.pred_mean],
                "quantiles": [[round(float(v), 2) for v in np.quantile(s, qs)] for s in self.samples]}


def american_to_prob(odds: float) -> float:
    """Implied probability of American odds (includes the book's vig)."""
    return 100 / (odds + 100) if odds > 0 else -odds / (-odds + 100)


def no_vig(p_over: float, p_under: float) -> tuple[float, float]:
    """Strip the vig from a two-way market (proportional method)."""
    t = p_over + p_under
    return p_over / t, p_under / t
