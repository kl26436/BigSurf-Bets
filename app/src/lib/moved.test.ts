import { describe, expect, it } from "vitest";
import { anyMoved, movedLine, numbersMoved } from "./moved";
import type { LineupPlayer, PoolPlayer, Pos } from "./types";

const NOW = Date.parse("2026-11-15T17:00:00Z"), EARLY = "2026-11-15T18:00:00Z";
const pool = (dk_id: string, name: string, pos: Pos, salary: number, mean: number | null, extra: Partial<PoolPlayer> = {}): PoolPlayer =>
  ({ slate_id: 1, dk_id, player_id: `p${dk_id}`, name, pos, team: "T", opponent: "X", game_id: "g", kickoff_at: EARLY, salary, dk_mean: mean, dk_status: null, ...extra }) as PoolPlayer;
const held = (dk_id: string, name: string, pos: Pos, salary: number, mean: number, lineups: number[]): LineupPlayer[] =>
  lineups.map((no) => ({ set_id: 48, lineup_no: no, slot_no: 0, slot: pos, dk_id, player_id: `p${dk_id}`, name, pos, team: "T", opponent: "X", salary, dk_mean: mean, status: null }) as LineupPlayer);

describe("numbers moved since the lineups were entered", () => {
  // week 10 2026, as it would have read at 11:40 with the vacated carries handed on
  const mine = [...held("1", "Kyren Williams", "RB", 7100, 18.0, [1, 2, 3, 4, 5, 6, 7]), ...held("2", "Chuba Hubbard", "RB", 7200, 18.9, [1, 2]),
    ...held("3", "Josh Allen", "QB", 7500, 25.6, [1]), ...held("4", "Drake London", "WR", 6600, 14.0, [1, 2, 3])];
  const now = [pool("1", "Kyren Williams", "RB", 7100, 14.2), pool("2", "Chuba Hubbard", "RB", 7200, 18.86), pool("3", "Josh Allen", "QB", 7500, 25.61),
    pool("4", "Drake London", "WR", 6600, 16.6), pool("5", "Emmett Johnson", "RB", 4700, 15.63), pool("6", "Patrick Mahomes", "QB", 6000, 21.2),
    pool("7", "Cheap Back", "RB", 4000, 9.9), pool("8", "Hurt Back", "RB", 4000, 14, { dk_status: "O" })];

  it("lists held players who moved, biggest effect first, and ignores small changes", () => {
    const m = numbersMoved(mine, now, NOW);
    expect(m.down).toEqual([{ dk_id: "1", name: "Kyren Williams", from: 18.0, to: 14.2, lineups: 7 }]);
    expect(m.up.map((x) => x.name)).toEqual(["Drake London"]);
  });
  it("names the best values you hold none of: playable, not ruled out, clearly better than what you have", () => {
    const m = numbersMoved(mine, now, NOW);
    expect(m.missing.map((x) => x.name)).toEqual(["Emmett Johnson"]);          // 3.3 per $1,000 against 2.6 for the backs held
    expect(m.missing[0]).toMatchObject({ pos: "RB", salary: 4700, mean: 15.63 });
    // Mahomes is a slightly better value than Allen, not by enough to raise; under ten points and ruled out never count
    expect(numbersMoved(mine, [...now, pool("9", "Late Riser", "WR", 4000, 12)], NOW).missing.map((x) => x.name)).toEqual(["Emmett Johnson", "Late Riser"]);
  });
  it("says nothing when the numbers are where they were, or the games have started", () => {
    const same = numbersMoved(mine, now.filter((p) => ["2", "3"].includes(p.dk_id)), NOW);
    expect(anyMoved(same)).toBe(false);
    expect(anyMoved(numbersMoved(mine, now, Date.parse("2026-11-15T19:00:00Z")))).toBe(false);
    expect(anyMoved(null)).toBe(false);
  });
  it("reads as one line", () => {
    expect(movedLine(numbersMoved(mine, now, NOW))).toBe("Kyren Williams 18.0 → 14.2 (7 lineups) · Drake London 14.0 → 16.6 (3 lineups) · not in any: Emmett Johnson 15.6 at $4,700");
  });
});
