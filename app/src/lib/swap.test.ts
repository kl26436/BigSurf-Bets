import { describe, expect, it } from "vitest";
import { applySwap, csvLine, isOut, parseEntriesCsv, planSwap, stackOf, toEntriesCsv } from "./swap";
import type { DkEntry, LineupPlayer, PoolPlayer, Pos } from "./types";

const NOW = Date.parse("2026-11-15T19:00:00Z");           // the early games have kicked off
const EARLY = "2026-11-15T18:00:00Z", LATE = "2026-11-15T21:25:00Z";
let n = 100;
function pp(pos: Pos, salary: number, mean: number | null, kickoff = LATE, extra: Partial<PoolPlayer> = {}): PoolPlayer {
  n += 1;
  return { slate_id: 1, dk_id: String(n), player_id: `p${n}`, name: `${pos} ${n}`, pos, team: `T${n}`, opponent: "X", game_id: `g${kickoff}`,
    kickoff_at: kickoff, salary, dk_mean: mean, dk_status: null, ...extra } as PoolPlayer;
}
const SLOT = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "DST"];
function lineup(ps: PoolPlayer[]): LineupPlayer[] {
  return ps.map((p, i) => ({ set_id: 7, lineup_no: 2, slot_no: i, slot: SLOT[i], dk_id: p.dk_id, player_id: p.player_id, name: p.name, pos: p.pos,
    team: p.team, opponent: p.opponent, salary: p.salary, dk_mean: p.dk_mean, status: p.dk_status }));
}
function world() {
  const nine = [pp("QB", 7000, 20), pp("RB", 6000, 15), pp("RB", 5500, 13), pp("WR", 6500, 16), pp("WR", 5000, 12), pp("WR", 4500, 10),
    pp("TE", 4000, 9), pp("RB", 4500, 11), pp("DST", 3000, 7)];                                           // $46,000
  const bench = [pp("WR", 8600, 21), pp("WR", 6400, 15.5), pp("WR", 6000, 14), pp("WR", 3000, 5), pp("RB", 5900, 14.5), pp("TE", 3500, 8),
    pp("WR", 5000, 30, EARLY)];                                                                           // the best one has kicked off
  return { nine, bench, pool: new Map([...nine, ...bench].map((p) => [p.dk_id, p])) };
}

describe("who is ruled out", () => {
  it("is a player gone from the pool, tagged out, or left without expected points", () => {
    expect(isOut(undefined)).toBe(true);
    expect(isOut(pp("WR", 5000, null))).toBe(true);
    expect(isOut(pp("WR", 5000, 12, LATE, { dk_status: "OUT" }))).toBe(true);
    expect(isOut(pp("WR", 5000, 12, LATE, { dk_status: "Q" }))).toBe(false);      // questionable still plays until told otherwise
    expect(isOut(pp("WR", 5000, 12))).toBe(false);
  });
});

describe("swapping out a scratched player", () => {
  it("does nothing when everyone is playing", () => {
    const w = world();
    expect(planSwap(lineup(w.nine), w.pool, { now: NOW })).toBeNull();
  });
  it("puts in the best player who fits the slot and the money, and whose game has not started", () => {
    const w = world();
    w.pool.set(w.nine[3].dk_id, { ...w.nine[3], dk_mean: null });           // the $6,500 receiver is out
    const plan = planSwap(lineup(w.nine), w.pool, { now: NOW })!;
    // $10,500 to spend on the slot: the $8,600 receiver fits; the 30-point one kicked off at noon
    expect(plan.swaps).toHaveLength(1);
    expect(plan.swaps[0].pick?.dk_id).toBe(w.bench[0].dk_id);
    expect(plan.swaps[0].options.map((p) => p.pos)).toEqual(["WR", "WR", "WR", "WR"]);      // a receiver slot takes receivers only
    expect(plan.complete).toBe(true);
    expect(plan.salary).toBe(46000 - 6500 + 8600);
    expect(plan.before).toBeCloseTo(113 - 16);
    expect(plan.after).toBeCloseTo(113 - 16 + 21);
    const ids = applySwap(lineup(w.nine), plan);
    expect(ids[3]).toBe(w.bench[0].dk_id);
    expect(ids.filter((_, i) => i !== 3)).toEqual(w.nine.filter((_, i) => i !== 3).map((p) => p.dk_id));   // the other eight stay put
  });
  it("lets any running back, receiver or tight end into the any-position slot", () => {
    const w = world();
    w.pool.set(w.nine[7].dk_id, { ...w.nine[7], dk_status: "OUT" });
    const plan = planSwap(lineup(w.nine), w.pool, { now: NOW })!;
    expect(plan.swaps[0].slot).toBe("FLEX");
    expect(new Set(plan.swaps[0].options.map((p) => p.pos))).toEqual(new Set(["WR", "RB", "TE"]));
    expect(plan.swaps[0].pick?.dk_id).toBe(w.bench[1].dk_id);                 // $8,500 to spend: the $8,600 one is out of reach
  });
  it("keeps two swaps inside the budget together", () => {
    const w = world();
    w.pool.set(w.nine[4].dk_id, { ...w.nine[4], dk_mean: null });           // $5,000 receiver
    w.pool.set(w.nine[5].dk_id, { ...w.nine[5], dk_mean: null });           // $4,500 receiver  → $13,500 for two
    const plan = planSwap(lineup(w.nine), w.pool, { now: NOW })!;
    const picks = plan.swaps.map((s) => s.pick!);
    expect(picks[0].dk_id).not.toBe(picks[1].dk_id);
    expect(picks.reduce((s, p) => s + p.salary, 0)).toBeLessThanOrEqual(13500);
    expect(picks.reduce((s, p) => s + (p.dk_mean ?? 0), 0)).toBeCloseTo(15.5 + 14);          // 8,600 + 6,400 would be $1,500 over
    expect(plan.salary).toBeLessThanOrEqual(50000);
  });
  it("honours the person's own choice", () => {
    const w = world();
    w.pool.set(w.nine[3].dk_id, { ...w.nine[3], dk_mean: null });
    const plan = planSwap(lineup(w.nine), w.pool, { now: NOW, chosen: { 3: w.bench[3].dk_id } })!;
    expect(plan.swaps[0].pick?.dk_id).toBe(w.bench[3].dk_id);
  });
  it("says so when the scratched player's game has started, and when nobody fits", () => {
    const w = world();
    const early = { ...w.nine[1], dk_mean: null, kickoff_at: EARLY };
    w.pool.set(early.dk_id, early);
    const plan = planSwap(lineup(w.nine), w.pool, { now: NOW })!;
    expect(plan.swaps).toEqual([]);
    expect(plan.locked.map((p) => p.dk_id)).toEqual([early.dk_id]);
    expect(plan.complete).toBe(false);
    const w2 = world();
    w2.pool.set(w2.nine[8].dk_id, { ...w2.nine[8], dk_mean: null });         // the defence is out and there is no other
    const none = planSwap(lineup(w2.nine), w2.pool, { now: NOW })!;
    expect(none.swaps[0].pick).toBeNull();
    expect(none.complete).toBe(false);
  });
});

describe("the DraftKings entries file", () => {
  const FILE = [
    "Entry ID,Contest Name,Contest ID,Entry Fee,QB,RB,RB,WR,WR,WR,TE,FLEX,DST,,Instructions",
    '4412345678,"NFL $20K Slant, [20 Entry Max]",184555001,$3,Pat Qb (101),A Rb (102),B Rb (103),A Wr (104),B Wr (105),C Wr (106),A Te (107),C Rb (108),KC  (109),,1. Column A lists all of your contest entries',
    "4412345679,NFL $5 Double Up,184555002,$5,,,,,,,,,,,2. Your current lineup is listed next to each entry",
    ",,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,Position,Name + ID,Name,ID,Roster Position,Salary",
    ",,,,,,,,,,,,,,QB,Pat Qb (101),Pat Qb,101,QB,7000",
  ].join("\r\n");
  it("reads entries and their lineups, and nothing else in the file", () => {
    const { entries, problem } = parseEntriesCsv("﻿" + FILE);
    expect(problem).toBeUndefined();
    expect(entries).toEqual([
      { entry_id: "4412345678", contest_id: "184555001", contest_name: "NFL $20K Slant, [20 Entry Max]", entry_fee: "3",
        players: ["101", "102", "103", "104", "105", "106", "107", "108", "109"] },
      { entry_id: "4412345679", contest_id: "184555002", contest_name: "NFL $5 Double Up", entry_fee: "5", players: null },
    ]);
  });
  it("reads a player whose game has started (DraftKings adds LOCKED after the id)", () => {
    const row = "1,x,2,$1,A One (101) (LOCKED),B (102),C (103),D (104),E (105),F (106),G (107),H (108),Team (109)";
    expect(parseEntriesCsv("Entry ID,Contest Name,Contest ID,Entry Fee,QB,RB,RB,WR,WR,WR,TE,FLEX,DST\n" + row).entries[0].players)
      .toEqual(["101", "102", "103", "104", "105", "106", "107", "108", "109"]);
  });
  it("explains a file that is something else", () => {
    expect(parseEntriesCsv("Position,Name + ID,Name,ID,Roster Position,Salary\nQB,x,x,1,QB,7000").problem).toMatch(/Entry ID/);
    expect(parseEntriesCsv("Entry ID,Contest Name,Contest ID,Entry Fee,CPT,FLEX,FLEX,FLEX,FLEX,FLEX\n1,x,2,$1,,,,,,").problem).toMatch(/nine-player/);
    expect(parseEntriesCsv("Entry ID,Contest Name,Contest ID,Entry Fee,QB,RB,RB,WR,WR,WR,TE,FLEX,DST\n").problem).toMatch(/No entries/);
  });
  it("splits quoted cells", () => {
    expect(csvLine('1,"a, b","say ""hi""",')).toEqual(["1", "a, b", 'say "hi"', ""]);
  });
  it("writes the file to hand back: entries that hold a lineup, players by id", () => {
    const e = (id: string, name: string, lineup: number | null): DkEntry => ({ entry_id: id, slate_id: 1, contest_id: "9", contest_name: name, entry_fee: 3,
      players: null, set_id: lineup ? 7 : null, lineup_no: lineup, imported_at: "" });
    const out = toEntriesCsv([e("11", "A, B", 1), e("12", "C", null)], (x) => (x.lineup_no ? ["1", "2", "3", "4", "5", "6", "7", "8", "9"] : null));
    expect(out.rows).toBe(1);
    expect(out.csv).toBe('Entry ID,Contest Name,Contest ID,Entry Fee,QB,RB,RB,WR,WR,WR,TE,FLEX,DST\n11,"A, B",9,$3,1,2,3,4,5,6,7,8,9\n');
    expect(parseEntriesCsv(out.csv).entries[0].players).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);    // and it reads back
  });
});

describe("how a lineup is paired", () => {
  const p = (name: string, pos: string, team: string, opponent: string) => ({ name, pos, team, opponent });
  it("names the quarterback, his pass catchers and who comes back", () => {
    expect(stackOf([p("Patrick Mahomes", "QB", "KC", "BUF"), p("Travis Kelce", "TE", "KC", "BUF"), p("Rashee Rice", "WR", "KC", "BUF"),
      p("Khalil Shakir", "WR", "BUF", "KC"), p("Bijan Robinson", "RB", "ATL", "NO"), p("KC", "DST", "KC", "BUF")])).toBe("Mahomes + Kelce, Rice · vs Shakir");
    expect(stackOf([p("Jalen Hurts", "QB", "PHI", "DAL"), p("Bijan Robinson", "RB", "ATL", "NO")])).toBe("Hurts, on his own");
    expect(stackOf([p("Bijan Robinson", "RB", "ATL", "NO")])).toBe("");
    expect(stackOf([p("Michael Penix Jr.", "QB", "ATL", "NO"), p("Drake London", "WR", "ATL", "NO")])).toBe("Penix + London");
  });
});
