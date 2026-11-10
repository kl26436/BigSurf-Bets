// How much to put on a bet. Sizing follows the Kelly rule scaled down: a quarter
// of the full Kelly stake by default, never more than a set share of the balance.
// Full Kelly assumes the edge is known exactly; ours is an estimate.

export function americanToDecimal(a: number): number {
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

export function decimalToAmerican(d: number): number {
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Share of the balance the Kelly rule would stake at win chance p and decimal price d (0 when there is no edge). */
export function kelly(p: number, d: number): number {
  if (!(p > 0 && p < 1) || d <= 1) return 0;
  return Math.max(0, (p * d - 1) / (d - 1));
}

export function suggestedStake(balance: number, p: number, d: number, fraction = 0.25, maxShare = 0.05): number {
  const stake = balance * Math.min(kelly(p, d) * fraction, maxShare);
  return stake >= 1 ? Math.floor(stake) : 0;
}

/** Split a total stake across both sides of a two-way market so either result pays the same. */
export function arbSplit(total: number, dA: number, dB: number): { a: number; b: number; profit: number } {
  const wA = 1 / dA, wB = 1 / dB;
  const a = (total * wA) / (wA + wB);
  return { a, b: total - a, profit: a * dA - total };
}
