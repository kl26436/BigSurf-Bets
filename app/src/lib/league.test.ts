import { describe, expect, it } from "vitest";
import { lineupChanges } from "./league";
import type { RosterPlayer, WaiverLineupRow } from "./types";

const p = (id: string, pos: string, mean: number, starter: boolean): RosterPlayer => ({ sleeper_id: id, player_id: id, name: id, pos, team: "AAA", is_starter: starter,
  opponent: "BBB", kickoff_at: null, ppr_mean: mean, ppr_p10: null, ppr_p90: null, injury_status: null });
const b = (id: string, pos: string, mean: number, start: boolean, spot: string | null = null): WaiverLineupRow => ({ sleeper_id: id, name: id, pos, team: "AAA", status: null, mean, start, spot });

const roster = [p("qb", "QB", 18, true), p("rb1", "RB", 14, true), p("rb2", "RB", 6, true), p("wr1", "WR", 15, true), p("te", "TE", 7, true), p("wr2", "WR", 11, false), p("rb3", "RB", 9, false)];

describe("start and sit", () => {
  it("says nothing when Sleeper already has the best lineup", () => {
    const best = roster.map((r) => b(r.sleeper_id, r.pos!, r.ppr_mean!, r.is_starter));
    expect(lineupChanges(roster, best)).toEqual([]);
  });
  it("pairs each player to start with the starter he replaces, same position first", () => {
    const best = [b("qb", "QB", 18, true, "QB"), b("rb1", "RB", 14, true, "RB1"), b("rb3", "RB", 9, true, "RB2"), b("wr1", "WR", 15, true, "WR1"), b("te", "TE", 7, true, "TE"),
      b("wr2", "WR", 11, false), b("rb2", "RB", 6, false)];
    const c = lineupChanges(roster, best)!;
    expect(c).toHaveLength(1);
    expect(c[0].start.sleeper_id).toBe("rb3");
    expect(c[0].sit?.sleeper_id).toBe("rb2");
    expect(c[0].start.spot).toBe("RB2");
  });
  it("lets a receiver take a running back's any-position spot", () => {
    const best = [b("qb", "QB", 18, true), b("rb1", "RB", 14, true), b("wr2", "WR", 11, true, "FLEX1"), b("wr1", "WR", 15, true), b("te", "TE", 7, true), b("rb3", "RB", 9, false), b("rb2", "RB", 6, false)];
    const c = lineupChanges(roster, best)!;
    expect(c.map((x) => [x.start.sleeper_id, x.sit?.sleeper_id])).toEqual([["wr2", "rb2"]]);
  });
  it("falls back to a plain same-position rule when the roster changed since the run", () => {
    const stale = [b("qb", "QB", 18, true), b("gone", "RB", 20, true)];
    const c = lineupChanges(roster, stale)!;
    expect(c.map((x) => [x.start.sleeper_id, x.sit?.sleeper_id])).toEqual([["rb3", "rb2"]]);
  });
  it("ignores a swap worth a fraction of a point", () => {
    const close = roster.map((r) => (r.sleeper_id === "rb3" ? p("rb3", "RB", 6.2, false) : r));
    expect(lineupChanges(close, null)).toEqual([]);
  });
  it("has nothing to say without a roster", () => {
    expect(lineupChanges([], null)).toBeNull();
  });
});
