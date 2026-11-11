import { describe, expect, it } from "vitest";
import { buildCards, describeSettings, handKey, pickerChoices, rebuildPayload, visibleSets } from "./lineup";
import type { Job, LineupSet, PoolPlayer, Pos } from "./types";

let id = 0;
function set(over: Partial<LineupSet>): LineupSet {
  id += 1;
  return { id, created_at: new Date(2026, 10, 10, 12, 0, 60 - id).toISOString(), slate_id: 1, run_id: 7, mode: "gpp", source: "auto", entered: false,
    label: null, job_id: null, n_lineups: 20, settings: null, summary: null, on_latest_projections: true, archived_at: null, ...over };
}
const job = (over: Partial<Job>): Job => ({ id: ++id, created_at: new Date().toISOString(), kind: "build_lineups", payload: {}, status: "done",
  started_at: null, finished_at: new Date().toISOString(), result: null, error: null, dismissed_at: null, ...over });

describe("which sets the Lineups screen shows", () => {
  it("keeps the newest automatic set of each kind, everything of the user's, and anything entered", () => {
    // newest first, as the list arrives
    const newTournament = set({}), newCash = set({ mode: "cash" }), mine = set({ source: "user" }), byHand = set({ source: "manual", mode: "manual" });
    const oldTournament = set({}), oldEntered = set({ entered: true }), binned = set({ source: "user", archived_at: "2026-11-10T00:00:00Z" });
    const v = visibleSets([newTournament, newCash, mine, byHand, oldTournament, oldEntered, binned]);
    expect(v.auto).toEqual([newTournament, newCash]);
    expect(v.mine).toEqual([mine, byHand, oldEntered]);          // an entered automatic set stays when a newer one replaces it
    expect(v.archived).toEqual([binned]);
    expect([...v.auto, ...v.mine]).not.toContain(oldTournament);
  });
  it("does not let an archived automatic set stand in for the current one", () => {
    const archivedNewest = set({ archived_at: "2026-11-10T00:00:00Z" }), older = set({});
    expect(visibleSets([archivedNewest, older]).auto).toEqual([older]);
  });
});

describe("what tells two sets apart", () => {
  it("names the settings in the Build sheet's words", () => {
    const s = set({ source: "user", settings: { n: 20, max_exposure: 0.25, min_unique: 3, rules: { qb_stack: 1, bring_back: 0, lock: ["1", "2"], exclude: ["3"] } } });
    expect(describeSettings(s)).toEqual(["A player in at most 25%", "3 players differ", "QB with a receiver", "2 locked in", "1 left out"]);
    expect(describeSettings(set({ settings: { max_exposure: 0.5, min_unique: 1, rules: { qb_stack: 2, bring_back: 1 } } })))
      .toEqual(["A player in at most 50%", "1 player differs", "QB with 2 receivers", "plus an opponent"]);
  });
  it("says nothing for a hand-built lineup or a set with no record of its settings, and skips shares for a single lineup", () => {
    expect(describeSettings(set({ source: "manual", settings: { user_id: "x" } }))).toEqual([]);
    expect(describeSettings(set({ settings: null }))).toEqual([]);
    expect(describeSettings(set({ n_lineups: 1, settings: { max_exposure: 1, min_unique: 3, rules: { qb_stack: 1 } } }))).toEqual(["QB with a receiver"]);
  });
  it("rebuilds with exactly what the set was built with", () => {
    const s = set({ slate_id: 4, mode: "cash", source: "user", label: "Safe", n_lineups: 2,
      settings: { n: 3, mode: "cash", seed: 7, max_exposure: 0.67, min_unique: 2, rules: { qb_stack: 0, bring_back: 0, lock: ["9"], exclude: [], max_per_team: 5, min_salary: 49000, salary_cap: 50000 } } });
    expect(rebuildPayload(s)).toEqual({ slate_id: 4, mode: "cash", n: 3, lock: ["9"], exclude: [], max_exposure: 0.67, min_unique: 2,
      qb_stack: 0, bring_back: 0, max_per_team: 5, min_salary: 49000, label: "Safe" });
    // nothing recorded: the size of the set and its kind are still enough to ask for one
    expect(rebuildPayload(set({ settings: null, n_lineups: 5 }))).toEqual({ slate_id: 1, mode: "gpp", n: 5, lock: [], exclude: [] });
  });
});

describe("build requests on the Lineups screen", () => {
  const now = Date.parse("2026-11-15T16:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const built = set({ source: "user" });
  it("offers a finished build for a while, then lets it go", () => {
    const fresh = job({ finished_at: at(2), result: { set_id: built.id } });
    expect(buildCards([fresh], [built], now)).toEqual([{ job: fresh, state: "ready", setId: built.id }]);
    expect(buildCards([job({ finished_at: at(40), result: { set_id: built.id } })], [built], now)).toEqual([]);
    expect(buildCards([fresh], [], now)).toEqual([]);                                   // its set was deleted
    expect(buildCards([fresh], [{ ...built, archived_at: at(1) }], now)).toEqual([]);   // or archived
  });
  it("shows a failed request with its reason until it is dismissed", () => {
    const failed = job({ status: "failed", error: "no legal lineup under these rules", finished_at: at(300), created_at: at(301) });
    expect(buildCards([failed], [], now)[0]).toMatchObject({ state: "failed", why: "no legal lineup under these rules" });
    expect(buildCards([job({ status: "needs_setup", error: "No GitHub token" })], [], now)[0].state).toBe("failed");
    expect(buildCards([{ ...failed, dismissed_at: at(1) }], [], now)).toEqual([]);
  });
  it("calls a build that never reported back what it is", () => {
    expect(buildCards([job({ status: "running", created_at: at(3), finished_at: null })], [], now)[0].state).toBe("working");
    const lost = buildCards([job({ status: "dispatched", created_at: at(45), finished_at: null })], [], now)[0];
    expect(lost.state).toBe("failed");
    expect(lost.why).toMatch(/never reported back/);
  });
  it("ignores other kinds of request and shows three at most", () => {
    expect(buildCards([job({ kind: "refresh_odds", status: "failed" })], [], now)).toEqual([]);
    expect(buildCards(Array.from({ length: 5 }, () => job({ status: "running", created_at: at(1), finished_at: null })), [], now)).toHaveLength(3);
  });
});

describe("the hand builder's picker", () => {
  let n = 0;
  const p = (pos: Pos, salary: number, mean: number | null, name = `${pos}${n + 1}`, team = "KC"): PoolPlayer =>
    ({ slate_id: 1, dk_id: String(++n), player_id: `p${n}`, name, pos, team, opponent: "X", game_id: "g", kickoff_at: null, salary, dk_mean: mean } as PoolPlayer);
  const pool = [p("WR", 8000, 20, "Alpha"), p("WR", 3000, 6, "Bravo"), p("RB", 5000, 15, "Charlie", "DAL"), p("TE", 2500, 4, "Delta"),
    p("QB", 7000, 22, "Echo"), p("WR", 4000, null, "Out Guy"), ...Array.from({ length: 120 }, (_, i) => p("WR", 3000 + i * 10, 5 + i * 0.01))];
  const names = (rows: PoolPlayer[]) => rows.slice(0, 4).map((x) => x.name);

  it("lists everyone who can fill the slot, however many", () => {
    expect(pickerChoices(pool, "WR", new Set())).toHaveLength(122);            // not a top 80
    expect(pickerChoices(pool, "FLEX", new Set())).toHaveLength(124);          // + the RB and the TE; never the QB
    expect(pickerChoices(pool, "WR", new Set(["1"])).map((x) => x.name)).not.toContain("Alpha");
    expect(pickerChoices(pool, "WR", new Set()).map((x) => x.name)).not.toContain("Out Guy");   // no expected points: not playable
  });
  it("sorts by points, value or price", () => {
    const few = pool.slice(0, 5);
    expect(names(pickerChoices(few, "FLEX", new Set(), { sort: "points" }))).toEqual(["Alpha", "Charlie", "Bravo", "Delta"]);
    expect(names(pickerChoices(few, "FLEX", new Set(), { sort: "value" }))).toEqual(["Charlie", "Alpha", "Bravo", "Delta"]);
    expect(names(pickerChoices(few, "FLEX", new Set(), { sort: "cheapest" }))).toEqual(["Delta", "Bravo", "Charlie", "Alpha"]);
  });
  it("keeps to the budget left when asked, and finds players by name or team", () => {
    const few = pool.slice(0, 5);
    expect(names(pickerChoices(few, "FLEX", new Set(), { fitsOnly: true, left: 4000 }))).toEqual(["Bravo", "Delta"]);
    expect(names(pickerChoices(few, "FLEX", new Set(), { fitsOnly: false, left: 4000 }))).toHaveLength(4);
    expect(names(pickerChoices(few, "FLEX", new Set(), { text: "char" }))).toEqual(["Charlie"]);
    expect(names(pickerChoices(few, "FLEX", new Set(), { text: "dal" }))).toEqual(["Charlie"]);
  });
  it("knows the same nine players in any order", () => {
    expect(handKey(["3", "1", null, "2"])).toBe(handKey(["1", "2", "3"]));
    expect(handKey(["1", "2"])).not.toBe(handKey(["1", "3"]));
  });
});
