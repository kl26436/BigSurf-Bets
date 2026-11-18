// Entered lineups against the numbers as they stand now.
//
// A set is built from one projections run. News after that (a starter ruled out,
// a backup taking his work) changes the numbers, and lineups already entered do
// not change with them. Week 10 2026: the entered set was built at 10:46, the
// last run before lock was at 11:40, and nothing on the Week screen said that
// mattered. This says who moved, and who you are missing.
import { usePool, useSetsDetail } from "./api";
import { isOut } from "./swap";
import type { LineupPlayer, LineupSet, PoolPlayer, Slate } from "./types";

export interface Mover { dk_id: string; name: string; from: number; to: number; lineups: number }
export interface Missing { dk_id: string; name: string; pos: string; salary: number; mean: number; value: number }
export interface Moved {
  /** held players whose expected points fell or rose by MOVE or more since the set was built */
  down: Mover[];
  up: Mover[];
  /** the best values at a position right now that are in none of the entered lineups */
  missing: Missing[];
}

export const MOVE = 2.5;            // points
const MIN_POINTS = 10;              // a "best value" has to be playable
const TOP_VALUES = 2;               // per position
const VALUE_EDGE = 1.1;             // … and clearly better than what you hold there

const perK = (mean: number, salary: number) => (salary > 0 ? (mean / salary) * 1000 : 0);

/** `held`: the rows of entered lineups (built-time numbers); `pool`: the slate now. Games that have kicked off are left out. */
export function numbersMoved(held: LineupPlayer[], pool: PoolPlayer[], now = Date.now()): Moved {
  const open = pool.filter((p) => !p.kickoff_at || Date.parse(p.kickoff_at) > now);
  const byId = new Map(open.map((p) => [p.dk_id, p]));
  const mine = new Map<string, { row: LineupPlayer; lineups: Set<string> }>();
  for (const h of held) {
    const m = mine.get(h.dk_id) ?? { row: h, lineups: new Set<string>() };
    m.lineups.add(`${h.set_id}:${h.lineup_no}`);
    mine.set(h.dk_id, m);
  }
  const movers: Mover[] = [];
  for (const [id, m] of mine) {
    const p = byId.get(id);
    if (!p || p.dk_mean == null || m.row.dk_mean == null || isOut(p)) continue;      // ruled out is the scratches step's job
    if (Math.abs(p.dk_mean - m.row.dk_mean) >= MOVE) movers.push({ dk_id: id, name: m.row.name, from: m.row.dk_mean, to: p.dk_mean, lineups: m.lineups.size });
  }
  const bySize = (a: Mover, b: Mover) => Math.abs(b.to - b.from) * b.lineups - Math.abs(a.to - a.from) * a.lineups;
  const missing: Missing[] = [];
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const here = open.filter((p) => p.pos === pos && p.dk_mean != null && p.dk_mean >= MIN_POINTS && !isOut(p))
      .map((p) => ({ dk_id: p.dk_id, name: p.name, pos, salary: p.salary, mean: p.dk_mean!, value: perK(p.dk_mean!, p.salary) }))
      .sort((a, b) => b.value - a.value);
    // what you hold at the position, valued at today's numbers
    const heldBest = Math.max(0, ...here.filter((p) => mine.has(p.dk_id)).map((p) => p.value));
    for (const p of here.slice(0, TOP_VALUES)) if (!mine.has(p.dk_id) && p.value >= heldBest * VALUE_EDGE) missing.push(p);
  }
  return { down: movers.filter((m) => m.to < m.from).sort(bySize), up: movers.filter((m) => m.to > m.from).sort(bySize), missing: missing.sort((a, b) => b.value - a.value) };
}

export const anyMoved = (m: Moved | null | undefined) => !!m && m.down.length + m.up.length + m.missing.length > 0;

/** One line for a list: "Kyren Williams 18.0 → 14.2 (7 lineups) · not held: Emmett Johnson 15.6 at $4,700". */
export function movedLine(m: Moved, max = 3): string {
  const f = (x: number) => x.toFixed(1);
  const parts = [...m.down, ...m.up].slice(0, max).map((x) => `${x.name} ${f(x.from)} → ${f(x.to)} (${x.lineups} ${x.lineups === 1 ? "lineup" : "lineups"})`);
  if (m.missing.length) parts.push(`not in any: ${m.missing.slice(0, 2).map((x) => `${x.name} ${f(x.mean)} at $${x.salary.toLocaleString()}`).join(", ")}`);
  return parts.join(" · ");
}

/** null while loading, when nothing is entered, or when every entered set already uses the latest numbers. */
export function useMoved(slate: Slate | null | undefined, sets: LineupSet[]): Moved | null {
  const stale = sets.filter((s) => s.entered && !s.archived_at && !s.on_latest_projections && s.source !== "manual");
  const many = useSetsDetail(stale.map((s) => s.id));
  const pool = usePool(slate?.id);
  if (!slate?.upcoming || stale.length === 0 || !many.data || !pool.data?.length) return null;
  const played = new Set(many.data.lineups.filter((l) => l.entered).map((l) => `${l.set_id}:${l.lineup_no}`));
  return numbersMoved(many.data.players.filter((p) => played.has(`${p.set_id}:${p.lineup_no}`)), pool.data);
}
