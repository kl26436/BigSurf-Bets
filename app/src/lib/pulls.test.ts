import { describe, expect, it } from "vitest";
import { allowanceNote, pullState } from "./pulls";
import type { Job, PullStatus } from "./types";

const now = Date.parse("2026-11-12T20:00:00Z");
const job = (o: Partial<Job>): Job => ({ id: 1, created_at: new Date(now - 60e3).toISOString(), kind: "refresh_league", payload: {}, status: "done",
  started_at: null, finished_at: null, result: null, error: null, dismissed_at: null, ...o });
const papi = (o: Partial<PullStatus>): PullStatus => ({ job: "odds.oddspapi", label: "Props", checked_at: null, changed_at: null, monthly: 250, used: 84, reserved: 70, pulls_left: 13, ...o });

describe("pullState", () => {
  it("is idle with no job of that kind", () => {
    expect(pullState("refresh_league", [job({ kind: "refresh_odds", status: "running" })], now)).toEqual({ busy: false, problem: null });
  });
  it("is busy while the newest job is on its way", () => {
    for (const status of ["queued", "dispatched", "running"] as const) expect(pullState("refresh_league", [job({ status })], now).busy).toBe(true);
  });
  it("goes by the newest job, not an older failure", () => {
    const jobs = [job({ id: 1, status: "failed", created_at: new Date(now - 600e3).toISOString() }), job({ id: 2, status: "done" })];
    expect(pullState("refresh_league", jobs, now)).toEqual({ busy: false, problem: null });
  });
  it("says why a recent pull didn't happen, and forgets it later", () => {
    expect(pullState("refresh_league", [job({ status: "needs_setup" })], now).problem).toMatch(/GitHub/);
    expect(pullState("refresh_league", [job({ status: "failed" })], now).problem).toMatch(/failed/);
    expect(pullState("refresh_league", [job({ status: "failed", created_at: new Date(now - 3600e3).toISOString() })], now).problem).toBeNull();
  });
});

describe("allowanceNote", () => {
  it("counts the spare pulls", () => {
    expect(allowanceNote(papi({}))).toBe("13 spare pulls of player bets and sharp lines this month.");
    expect(allowanceNote(papi({ pulls_left: 1 }))).toMatch(/^1 spare pull of/);
  });
  it("says game lines still refresh when none is spare", () => {
    expect(allowanceNote(papi({ pulls_left: 0, used: 190 }))).toMatch(/190 of 250 requests used.*still refreshes game lines/);
  });
  it("says nothing for a feed without an allowance", () => {
    expect(allowanceNote(undefined)).toBeNull();
    expect(allowanceNote(papi({ monthly: null, used: null, pulls_left: null }))).toBeNull();
  });
});
