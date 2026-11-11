import { describe, expect, it } from "vitest";
import { goodPriceCount, nextStep, weekSteps, type WeekFacts } from "./week";
import type { LineQuote, PropEdge } from "./types";

const facts = (over: Partial<WeekFacts> = {}): WeekFacts => ({ games: "upcoming", staleFeeds: [], sets: 0, setsOnOldNumbers: 0, enteredLineups: 0, entries: 0,
  scratched: 0, scratchedNames: [], goodPrices: 0, openBets: 0, ...over });
const states = (f: WeekFacts) => Object.fromEntries(weekSteps(f).map((s) => [s.key, s.state]));

describe("what to do this week", () => {
  it("starts with the salary file when no games are loaded", () => {
    const steps = weekSteps(facts({ games: "none" }));
    expect(steps.map((s) => s.key)).toEqual(["salaries", "numbers"]);
    expect(nextStep(steps)).toMatchObject({ key: "salaries", to: "/more/settings" });
  });
  it("walks build → enter → entries file in order", () => {
    expect(nextStep(weekSteps(facts()))?.key).toBe("lineups");
    expect(states(facts())).toMatchObject({ enter: "later", entries: "later", scratches: "later" });
    expect(nextStep(weekSteps(facts({ sets: 2 })))?.key).toBe("enter");
    expect(nextStep(weekSteps(facts({ sets: 2, enteredLineups: 5 })))?.key).toBe("entries");
    expect(nextStep(weekSteps(facts({ sets: 2, enteredLineups: 5, entries: 5 })))).toBeNull();
    expect(states(facts({ sets: 2, enteredLineups: 5, entries: 5 })).scratches).toBe("done");
  });
  it("puts a problem ahead of everything else", () => {
    const steps = weekSteps(facts({ sets: 2, enteredLineups: 5, scratched: 2, scratchedNames: ["A. One", "B. Two"], goodPrices: 3 }));
    expect(nextStep(steps)).toMatchObject({ key: "scratches", to: "/lineups/swap", detail: "A. One, B. Two", title: "2 entered lineups have a player ruled out" });
    expect(nextStep(weekSteps(facts({ staleFeeds: ["player statuses"] })))?.key).toBe("numbers");
  });
  it("asks for nothing once the games have started", () => {
    expect(nextStep(weekSteps(facts({ games: "started", sets: 2 })))).toBeNull();
    expect(states(facts({ games: "started" }))).toMatchObject({ lineups: "later", enter: "later" });
  });
  it("mentions sets built on older numbers until something is entered", () => {
    expect(states(facts({ sets: 2, setsOnOldNumbers: 1 })).lineups).toBe("todo");
    expect(states(facts({ sets: 2, setsOnOldNumbers: 1, enteredLineups: 3 })).lineups).toBe("done");
  });
});

describe("prices worth a look", () => {
  const q = (bookmaker: string, ev: number) => ({ bookmaker, ev }) as LineQuote;
  const e = (bookmaker: string, over: number, under: number) => ({ bookmaker, ev_over_fair: over, ev_under_fair: under, over_decimal: 1.9, under_decimal: 1.9 }) as PropEdge;
  it("counts only the person's books, never the sharp book", () => {
    expect(goodPriceCount([q("betmgm", 0.02), q("betmgm", 0.005), q("circa", 0.05), q("pinnacle", 0.03)],
      [e("betmgm", 0.03, -0.08), e("draftkings", 0.021, 0.02), e("circa", 0.2, 0.2)], ["betmgm", "draftkings", "pinnacle"])).toBe(4);
  });
});
