// Price a number from the model's own outcome shapes.
//
// The projection run stores, per stat, the shape it fitted around a projected
// mean (model/dist.py → bsb.model_dists). Two kinds, mirrored here exactly:
//   nb   counts: negative binomial, spread set per bucket of the projected mean
//   emp  yards: real outcomes for similar projections, rescaled to this one
// With a player's projected mean this gives the chance of going over any number.
import type { ModelDist } from "./types";

/** First bucket whose upper edge is at or above the mean (the last bucket has no edge). */
function bucket(edges: (number | null)[], mu: number): number {
  for (let i = 0; i < edges.length; i++) if (edges[i] == null || mu <= (edges[i] as number)) return i;
  return edges.length - 1;
}

function nbOver(p: { edges: (number | null)[]; alphas: number[] }, mean: number, line: number): number {
  const mu = Math.max(mean, 1e-4);
  const n = 1 / p.alphas[bucket(p.edges, mu)];
  const q = n / (n + mu);
  const top = Math.floor(line);
  if (top < 0) return 1;
  let pmf = Math.pow(q, n), cdf = pmf;
  for (let k = 0; k < top; k++) {
    pmf *= ((k + n) / (k + 1)) * (1 - q);
    cdf += pmf;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

function empOver(p: { edges: number[]; pred_mean: number[]; quantiles: number[][] }, mean: number, line: number): number {
  const b = bucket(p.edges, mean);
  const scale = Math.min(2.5, Math.max(0.4, (mean > 0 ? mean : 0) / p.pred_mean[b]));
  const x = line / scale;
  const q = p.quantiles[b], last = q.length - 1;
  if (x < q[0]) return 1;
  if (x >= q[last]) return 0;
  // share of outcomes at or below x: the last grid point not above it, then straight-line to the next
  let lo = 0, hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (q[mid] <= x) lo = mid; else hi = mid - 1;
  }
  const step = q[lo + 1] - q[lo];
  const below = (lo + (step > 0 ? (x - q[lo]) / step : 0)) / last;
  return Math.min(1, Math.max(0, 1 - below));
}

/** Chance the stat finishes above `line` for a player projected at `mean`. */
export function probOver(d: ModelDist, mean: number, line: number): number {
  return d.kind === "nb" ? nbOver(d.params as never, mean, line) : empOver(d.params as never, mean, line);
}

/** Break-even American price for a chance (null at 0 or 1). */
export function fairAmerican(p: number): number | null {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

/** Stats that can be priced for a position, in the order a sportsbook lists them. */
export const PRICED: Record<string, string[]> = {
  QB: ["passing_yards", "attempts", "completions", "passing_tds", "interceptions", "rushing_yards", "anytime_td"],
  RB: ["rushing_yards", "carries", "receptions", "receiving_yards", "anytime_td"],
  WR: ["receptions", "receiving_yards", "rushing_yards", "anytime_td"],
  TE: ["receptions", "receiving_yards", "anytime_td"],
};

/** A sensible first number: the nearest half to the projection, as books quote them. */
export const startLine = (mean: number) => Math.max(0.5, Math.floor(mean) - 0.5 + (mean - Math.floor(mean) >= 0.5 ? 1 : 0));
