import { describe, expect, it } from "vitest";
import { SLOTS, addPlayer, arrangeForLateSwap, check, emptyLineup, exposure, toDkCsv, value } from "./lineup";
import { arbSplit, americanToDecimal, decimalToAmerican, kelly, suggestedStake } from "./stake";
import type { PoolPlayer, Pos } from "./types";

let n = 0;
function p(pos: Pos, salary: number, mean: number, game = "g1", kickoff = "2026-11-15T18:00:00Z"): PoolPlayer {
  n += 1;
  return { slate_id: 1, dk_id: String(n), player_id: `p${n}`, name: `${pos}${n}`, pos, team: game + pos, opponent: "X", game_id: game,
    kickoff_at: kickoff, salary, dk_mean: mean } as PoolPlayer;
}

function full(): PoolPlayer[] {
  return [p("QB", 7000, 20), p("RB", 6000, 15), p("RB", 5500, 13), p("WR", 6500, 16), p("WR", 5000, 12), p("WR", 4500, 10),
    p("TE", 4000, 9), p("RB", 4500, 11, "g2", "2026-11-15T21:25:00Z"), p("DST", 3000, 7, "g2")];
}

describe("lineup rules", () => {
  it("fills positions first, then the any-position slot, and refuses a tenth player", () => {
    let l = emptyLineup();
    for (const x of full()) l = addPlayer(l, x).lineup;
    expect(l.map((x) => x?.pos)).toEqual(["QB", "RB", "RB", "WR", "WR", "WR", "TE", "RB", "DST"]);
    const c = check(l);
    expect(c).toMatchObject({ filled: 9, salary: 46000, left: 4000, complete: true, problems: [] });
    expect(c.expected).toBeCloseTo(113);
    expect(addPlayer(l, p("WR", 3000, 5)).error).toMatch(/No open WR spot/);
    expect(addPlayer(l, l[0]!).error).toMatch(/already/);
    expect(addPlayer(emptyLineup(), p("QB", 1, 1)).lineup[0]?.pos).toBe("QB");
  });

  it("flags over-budget and single-game lineups", () => {
    let l = emptyLineup();
    for (const x of full()) l = addPlayer(l, { ...x, salary: x.salary + 1000, game_id: "g1" }).lineup;
    const c = check(l);
    expect(c.complete).toBe(false);
    expect(c.problems).toEqual(["$5,000 over budget", "Players must come from at least two games"]);
    expect(check(emptyLineup()).perOpenSpot).toBe(5555);
  });

  it("moves the latest kickoff into the any-position slot", () => {
    let l = emptyLineup();
    const players = full();
    players[1] = { ...players[1], kickoff_at: "2026-11-16T01:20:00Z" };   // RB1 plays Sunday night
    for (const x of players) l = addPlayer(l, x).lineup;
    const a = arrangeForLateSwap(l);
    expect(a[SLOTS.indexOf("FLEX")]?.dk_id).toBe(players[1].dk_id);
    expect(check(a).complete).toBe(true);
  });

  it("writes the DraftKings upload format and counts exposure", () => {
    expect(toDkCsv([["1", "2", "3", "4", "5", "6", "7", "8", "9"]])).toBe("QB,RB,RB,WR,WR,WR,TE,FLEX,DST\n1,2,3,4,5,6,7,8,9\n");
    const e = exposure([{ dk_id: "a", lineup_no: 1 }, { dk_id: "a", lineup_no: 2 }, { dk_id: "b", lineup_no: 2 }, { dk_id: "c", lineup_no: 3 }]);
    expect(e.get("a")?.share).toBeCloseTo(2 / 3);
    expect(e.get("b")?.count).toBe(1);
    expect(value({ dk_mean: 15, salary: 6000 })).toBeCloseTo(2.5);
  });
});

describe("stakes", () => {
  it("converts prices both ways", () => {
    expect(americanToDecimal(145)).toBeCloseTo(2.45);
    expect(americanToDecimal(-110)).toBeCloseTo(1.9091, 4);
    expect(decimalToAmerican(2.45)).toBe(145);
    expect(decimalToAmerican(1.9091)).toBe(-110);
  });

  it("stakes nothing without an edge and caps the stake with one", () => {
    expect(kelly(0.5, 1.91)).toBe(0);
    expect(kelly(0.55, 2)).toBeCloseTo(0.1);
    expect(suggestedStake(200, 0.5, 1.91)).toBe(0);
    expect(suggestedStake(200, 0.55, 2)).toBe(5);              // quarter Kelly = 2.5% of $200
    expect(suggestedStake(200, 0.9, 2)).toBe(10);              // capped at 5% of the balance
  });

  it("splits an arbitrage so both results pay the same", () => {
    const s = arbSplit(100, 2.1, 2.05);
    expect(s.a * 2.1).toBeCloseTo(s.b * 2.05);
    expect(s.profit).toBeGreaterThan(3.7);
    expect(arbSplit(100, 1.91, 1.91).profit).toBeLessThan(0);
  });
});
