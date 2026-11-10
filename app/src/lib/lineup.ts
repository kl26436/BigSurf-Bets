// DraftKings classic rules, shared by the hand builder and every lineup view.
import type { PoolPlayer, Pos } from "./types";

export const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"] as const;
export type Slot = (typeof SLOTS)[number];
export type Lineup = (PoolPlayer | null)[];

export const SLOT_LABEL: Record<Slot, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "Any", DST: "DEF" };
export const POS_LABEL: Record<Pos, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", DST: "DEF" };

export function emptyLineup(): Lineup {
  return SLOTS.map(() => null);
}

export function canFill(slot: Slot, pos: Pos): boolean {
  return slot === pos || (slot === "FLEX" && (pos === "RB" || pos === "WR" || pos === "TE"));
}

/** Put a player in the first open slot he fits: his own position first, then the any-position slot. */
export function addPlayer(lineup: Lineup, p: PoolPlayer): { lineup: Lineup; error?: string } {
  if (lineup.some((x) => x?.dk_id === p.dk_id)) return { lineup, error: `${p.name} is already in this lineup` };
  const open = (s: Slot) => SLOTS.findIndex((slot, i) => slot === s && lineup[i] === null);
  let i = p.pos === "DST" ? open("DST") : open(p.pos as Slot);
  if (i < 0 && p.pos !== "QB" && p.pos !== "DST") i = open("FLEX");
  if (i < 0) return { lineup, error: `No open ${POS_LABEL[p.pos]} spot — remove a player first` };
  const next = lineup.slice();
  next[i] = p;
  return { lineup: next };
}

export function removeAt(lineup: Lineup, i: number): Lineup {
  const next = lineup.slice();
  next[i] = null;
  return next;
}

export interface Check {
  filled: number;
  salary: number;
  left: number;
  expected: number;
  perOpenSpot: number | null;
  complete: boolean;
  problems: string[];
}

export function check(lineup: Lineup, budget = 50_000): Check {
  const players = lineup.filter((p): p is PoolPlayer => p !== null);
  const salary = players.reduce((s, p) => s + p.salary, 0);
  const expected = players.reduce((s, p) => s + (p.dk_mean ?? 0), 0);
  const open = SLOTS.length - players.length;
  const problems: string[] = [];
  if (salary > budget) problems.push(`$${(salary - budget).toLocaleString()} over budget`);
  if (open === 0 && new Set(players.map((p) => p.game_id ?? p.team)).size < 2) {
    problems.push("Players must come from at least two games");
  }
  lineup.forEach((p, i) => {
    if (p && !canFill(SLOTS[i], p.pos)) problems.push(`${p.name} can't play ${SLOT_LABEL[SLOTS[i]]}`);
  });
  return {
    filled: players.length,
    salary,
    left: budget - salary,
    expected,
    perOpenSpot: open > 0 ? Math.floor((budget - salary) / open) : null,
    complete: open === 0 && problems.length === 0,
    problems,
  };
}

/** DraftKings lets you swap a player until his game starts. Keeping the latest
 *  kickoff in the any-position slot leaves the most swaps open on Sunday. */
export function arrangeForLateSwap(lineup: Lineup): Lineup {
  const flexAt = SLOTS.indexOf("FLEX");
  const flex = lineup[flexAt];
  if (!flex) return lineup;
  const time = (p: PoolPlayer | null) => (p?.kickoff_at ? Date.parse(p.kickoff_at) : 0);
  let latest = flexAt;
  SLOTS.forEach((slot, i) => {
    const p = lineup[i];
    if (p && slot === flex.pos && time(p) > time(lineup[latest])) latest = i;
  });
  if (latest === flexAt) return lineup;
  const next = lineup.slice();
  [next[flexAt], next[latest]] = [next[latest], next[flexAt]];
  return next;
}

/** DraftKings bulk-upload file: one lineup per row, player ids in slot order. */
export function toDkCsv(lineups: string[][]): string {
  return [SLOTS.join(","), ...lineups.map((ids) => ids.join(","))].join("\n") + "\n";
}

export function exposure<T extends { dk_id: string; lineup_no: number }>(rows: T[]): Map<string, { row: T; count: number; share: number }> {
  const total = new Set(rows.map((r) => r.lineup_no)).size || 1;
  const out = new Map<string, { row: T; count: number; share: number }>();
  for (const r of rows) {
    const e = out.get(r.dk_id) ?? { row: r, count: 0, share: 0 };
    e.count += 1;
    e.share = e.count / total;
    out.set(r.dk_id, e);
  }
  return out;
}

/** Expected points per $1,000 of budget — the usual way to compare prices. */
export function value(p: Pick<PoolPlayer, "dk_mean" | "salary">): number | null {
  return p.dk_mean != null && p.salary > 0 ? (p.dk_mean / p.salary) * 1000 : null;
}
