// The Week screen as a list of things to do, in the order a week goes:
// salaries → fresh numbers → lineups → entered → entries file → players ruled out → bets.
import { SHARP } from "./prices";
import type { LineQuote, PropEdge } from "./types";

export type StepState = "done" | "todo" | "alert" | "later";
export interface Step {
  key: "salaries" | "numbers" | "lineups" | "enter" | "entries" | "scratches" | "bets";
  title: string;
  detail: string;
  state: StepState;
  /** where the step is done */
  to?: string;
  action?: string;
  /** requests that put it right from here, without leaving the screen */
  jobs?: string[];
}

/** What each feed is called on screen, whatever the database calls it. */
export const FEED_NAME: Record<string, string> = {
  "nflverse.player_stats": "Game stats", "nflverse.injuries": "Injury reports", "sleeper.status": "Player statuses", "sleeper.league": "Sleeper league",
  "odds.oddslink": "Game prices", "odds.oddspapi": "Player bets and sharp prices", "model.project": "Expected points", "optimizer.lineups": "Lineups",
};
export const feedName = (f: { job: string; label: string }): string => FEED_NAME[f.job] ?? f.label;
/** The request that brings a feed up to date, and what its button says. */
export const FEED_FIX: Record<string, { kind: string; action: string }> = {
  "nflverse.player_stats": { kind: "refresh_stats", action: "Refresh stats" }, "nflverse.injuries": { kind: "refresh_stats", action: "Refresh stats" },
  "sleeper.status": { kind: "refresh_status", action: "Check statuses" }, "sleeper.league": { kind: "refresh_league", action: "Refresh league" },
  "odds.oddslink": { kind: "refresh_odds", action: "Refresh prices" }, "odds.oddspapi": { kind: "refresh_odds", action: "Refresh prices" },
  "model.project": { kind: "project", action: "Re-run expected points" },
};
/** The requests that refresh a list of feeds, each once. */
export const fixesFor = (jobs: string[]): string[] => [...new Set(jobs.map((j) => FEED_FIX[j]?.kind).filter((k): k is string => !!k))];

export interface WeekFacts {
  /** this week's DraftKings games: none loaded, still to come, or already started */
  games: "none" | "upcoming" | "started";
  staleFeeds: string[];
  /** the requests that refresh them (see fixesFor) */
  staleFixes?: string[];
  sets: number;
  /** sets of yours built before the numbers last changed */
  setsOnOldNumbers: number;
  /** what changed for lineups already entered on older numbers, in a line ("" when nothing material) */
  movedSinceEntered?: string;
  enteredLineups: number;
  entries: number;
  /** entered lineups with a player ruled out, and who */
  scratched: number;
  scratchedNames: string[];
  /** prices at your books that beat the sharp price */
  goodPrices: number;
  openBets: number;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function weekSteps(f: WeekFacts): Step[] {
  const live = f.games === "upcoming";
  const steps: Step[] = [
    f.games === "none"
      ? { key: "salaries", title: "Load this week's salaries", detail: "Lineups need the salary file from DraftKings.", state: "todo", to: "/lineups", action: "Add the file" }
      : { key: "salaries", title: "Salaries loaded", detail: live ? "This week's DraftKings games are in." : "These games have started. Next week's salaries come out on Tuesday.", state: "done" },
    f.staleFeeds.length > 0
      ? { key: "numbers", title: "Numbers are out of date", detail: `Out of date: ${f.staleFeeds.join(", ")}.`, state: "alert", jobs: f.staleFixes?.length ? f.staleFixes : undefined, action: "Refresh" }
      : { key: "numbers", title: "Numbers are fresh", detail: "Stats, statuses, prices and expected points are up to date.", state: "done" },
  ];
  if (f.games === "none") return steps;

  steps.push(f.sets === 0
    ? { key: "lineups", title: "Build lineups", detail: "No lineup sets yet for these games.", state: live ? "todo" : "later", to: "/lineups", action: "Build" }
    : f.movedSinceEntered && live && f.enteredLineups > 0
      ? { key: "lineups", title: "Expected points moved after you entered", detail: f.movedSinceEntered, state: "alert", to: "/lineups", action: "Open" }
    : f.setsOnOldNumbers > 0 && live && f.enteredLineups === 0
      ? { key: "lineups", title: "Rebuild on the latest expected points", detail: `${n(f.setsOnOldNumbers, "set")} of yours ${f.setsOnOldNumbers === 1 ? "was" : "were"} built before expected points changed.`, state: "todo", to: "/lineups", action: "Open" }
      : { key: "lineups", title: "Lineups built", detail: `${n(f.sets, "set")} ready.${f.setsOnOldNumbers > 0 && live ? ` ${f.setsOnOldNumbers === 1 ? "One was" : `${f.setsOnOldNumbers} were`} built before expected points changed.` : ""}`, state: "done", to: "/lineups", action: "Open" });

  steps.push(f.enteredLineups > 0
    ? { key: "enter", title: "Lineups entered", detail: `${n(f.enteredLineups, "lineup")} marked as entered.`, state: "done", to: "/lineups", action: "Open" }
    : { key: "enter", title: "Enter lineups on DraftKings", detail: "Download a set, upload it on DraftKings, then mark what you entered.", state: live && f.sets > 0 ? "todo" : "later", to: "/lineups", action: "Open" });

  steps.push(f.entries > 0
    ? { key: "entries", title: "Entries file added", detail: `${n(f.entries, "entry", "entries")} matched to your lineups, ready for a late swap.`, state: "done", to: "/lineups/entries", action: "Open" }
    : { key: "entries", title: "Add your entries file", detail: "After entering, add the file from DraftKings so a late swap goes back as one upload.", state: live && f.enteredLineups > 0 ? "todo" : "later", to: "/lineups/entries", action: "Add" });

  steps.push(f.scratched > 0
    ? { key: "scratches", title: `${n(f.scratched, "entered lineup")} ${f.scratched === 1 ? "has" : "have"} a player ruled out`, detail: f.scratchedNames.join(", "), state: "alert", to: "/lineups/swap", action: "Swap" }
    : f.enteredLineups > 0 && live
      ? { key: "scratches", title: "Nobody ruled out", detail: "Nobody in an entered lineup is ruled out. Inactives are announced 90 minutes before each kickoff.", state: "done" }
      : { key: "scratches", title: "Watch for players ruled out", detail: "Once lineups are entered, a player who is ruled out shows up here.", state: "later" });

  steps.push(f.goodPrices > 0
    ? { key: "bets", title: `${n(f.goodPrices, "price")} better than the sharp price`, detail: `At your sportsbooks right now.${f.openBets ? ` ${n(f.openBets, "open bet")} on your record.` : ""}`, state: "todo", to: "/bets", action: "See them" }
    : { key: "bets", title: "No standout prices", detail: `Nothing at your books beats the sharp price right now.${f.openBets ? ` ${n(f.openBets, "open bet")} on your record.` : ""}`, state: "done", to: "/bets", action: "Prices" });
  return steps;
}

/** The step to do now: a problem first, then the first thing not yet done. */
export const nextStep = (steps: Step[]): Step | null => steps.find((s) => s.state === "alert") ?? steps.find((s) => s.state === "todo") ?? null;

/** Prices at the person's books that beat the sharp price: the same lists the Bets screen opens with. */
export function goodPriceCount(quotes: LineQuote[], props: PropEdge[], books: string[]): number {
  const mine = (b: string) => b !== SHARP && books.includes(b);
  const games = quotes.filter((q) => (q.ev ?? 0) >= 0.01 && mine(q.bookmaker)).length;
  const players = props.filter((e) => mine(e.bookmaker)).reduce((s, e) =>
    s + Number((e.ev_over_fair ?? -1) >= 0.02 && (e.over_decimal ?? 0) > 1) + Number((e.ev_under_fair ?? -1) >= 0.02 && (e.under_decimal ?? 0) > 1), 0);
  return games + players;
}
