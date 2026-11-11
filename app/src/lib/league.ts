// Start and sit for the Sleeper league.
//
// The weekly league run works out the best legal lineup from the whole roster
// (byes, injured reserve, which positions each spot takes). This compares it with
// the lineup actually set in Sleeper and says what to change.
import type { RosterPlayer, WaiverLineupRow } from "./types";

export interface LineupChange {
  start: { sleeper_id: string; name: string; mean: number; spot: string | null };
  sit: { sleeper_id: string; name: string; mean: number } | null;
}

const FLEX = new Set(["RB", "WR", "TE"]);
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
/** A swap worth less than this is noise in the numbers, not advice. */
const WORTH = 0.3;

/** Who to start that isn't starting, each paired with the starter he should replace.
 *  `best` is the run's lineup; when the roster has changed since (a pick-up or a drop),
 *  or there is no run, it falls back to a plain rule: a bench player expected to
 *  outscore a starter he can replace. → null when there is no roster. */
export function lineupChanges(roster: RosterPlayer[], best: WaiverLineupRow[] | null): LineupChange[] | null {
  const mine = roster.filter((p) => p.pos != null && SKILL.has(p.pos));
  if (mine.length === 0) return null;
  const ids = new Set(mine.map((p) => p.sleeper_id));
  const fresh = best != null && best.length > 0 && best.every((b) => ids.has(b.sleeper_id)) && mine.every((p) => best.some((b) => b.sleeper_id === p.sleeper_id));

  const starting = new Set(mine.filter((p) => p.is_starter).map((p) => p.sleeper_id));
  const rows: WaiverLineupRow[] = fresh ? best! : mine.map((p) => ({ sleeper_id: p.sleeper_id, name: p.name, pos: p.pos!, team: p.team,
    status: p.injury_status, mean: p.ppr_mean ?? 0, start: false, spot: null }));
  const want = fresh ? rows.filter((b) => b.start && !starting.has(b.sleeper_id))
    : rows.filter((b) => !starting.has(b.sleeper_id));
  const out = fresh ? rows.filter((b) => !b.start && starting.has(b.sleeper_id)) : rows.filter((b) => starting.has(b.sleeper_id));
  const used = new Set<string>();
  const changes: LineupChange[] = [];
  for (const a of [...want].sort((x, y) => y.mean - x.mean)) {
    const can = out.filter((b) => !used.has(b.sleeper_id) && (b.pos === a.pos || (FLEX.has(a.pos) && FLEX.has(b.pos))))
      .sort((x, y) => Number(y.pos === a.pos) - Number(x.pos === a.pos) || x.mean - y.mean);
    // the plain rule may only replace a starter at the same position: it does not know which spots are any-position
    const sit = (fresh ? can : can.filter((b) => b.pos === a.pos))[0] ?? null;
    if (sit) {
      if (a.mean - sit.mean < WORTH) continue;
      used.add(sit.sleeper_id);
      changes.push({ start: { sleeper_id: a.sleeper_id, name: a.name, mean: a.mean, spot: a.spot }, sit: { sleeper_id: sit.sleeper_id, name: sit.name, mean: sit.mean } });
    } else if (fresh && a.mean >= WORTH) {
      changes.push({ start: { sleeper_id: a.sleeper_id, name: a.name, mean: a.mean, spot: a.spot }, sit: null });
    }
  }
  return changes;
}
