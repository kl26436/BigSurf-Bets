import { describe, expect, it } from "vitest";
import { betRecord, boardGames, boardPlayers, parsePrice, priceText } from "./prices";
import type { Bet, LineQuote, PropEdge } from "./types";

const quote = (market: LineQuote["market"], number: number, outcome: LineQuote["outcome"], bookmaker: string, price: number, extra: Partial<LineQuote> = {}): LineQuote => ({
  captured_at: "2026-11-12T12:00:00Z", game_id: "g1", home_team: "DET", away_team: "NE", kickoff_at: "2026-11-15T18:00:00Z", market, number, outcome,
  line: market === "moneyline" ? null : market === "spread" && outcome === "away" ? -number : number, bookmaker, price_american: null, price_decimal: price,
  fair_prob: 0.5, ev: 0.5 * price - 1, is_best: false, arb_pct: null, ...extra });
const BOOKS = ["betmgm", "draftkings"];

describe("the price board for games", () => {
  const quotes = [
    // -2.5 is quoted by three books, -3 by one: -2.5 is the number shown
    quote("spread", -2.5, "home", "pinnacle", 1.95), quote("spread", -2.5, "home", "betmgm", 1.91), quote("spread", -2.5, "home", "draftkings", 1.93),
    quote("spread", -2.5, "away", "pinnacle", 1.95), quote("spread", -2.5, "away", "betmgm", 1.92), quote("spread", -2.5, "away", "circa", 1.99),
    quote("spread", -3, "home", "fanduel", 2.05), quote("spread", -3, "away", "fanduel", 1.8),
    quote("total", 47.5, "under", "betmgm", 1.9), quote("total", 47.5, "over", "betmgm", 1.92),
    quote("moneyline", 0, "home", "draftkings", 1.7, { game_id: "g0", kickoff_at: "2026-11-13T01:15:00Z", home_team: "KC", away_team: "LV" }),
  ];
  const board = boardGames(quotes, BOOKS);
  it("orders games by kickoff and markets as spread, total, to win", () => {
    expect(board.map((g) => g.game_id)).toEqual(["g0", "g1"]);
    expect(board[1].markets.map((m) => m.market)).toEqual(["spread", "total"]);
  });
  it("shows the number most books quote, the away side and the over first", () => {
    const spread = board[1].markets[0];
    expect(spread.number).toBe(-2.5);
    expect(spread.sides.map((s) => [s.outcome, s.line])).toEqual([["away", 2.5], ["home", -2.5]]);
    expect(board[1].markets[1].sides.map((s) => s.outcome)).toEqual(["over", "under"]);
  });
  it("picks the best price at a book the person can use, never the sharp book's or a stranger's", () => {
    const [away, home] = board[1].markets[0].sides;
    expect(home.best?.bookmaker).toBe("draftkings");
    expect(away.best?.bookmaker).toBe("betmgm");                       // circa pays more but is not one of theirs
    expect(away.all.map((q) => q.bookmaker)).toEqual(["circa", "pinnacle", "betmgm"]);
    expect(boardGames(quotes, ["caesars"])[1].markets[0].sides[0].best).toBeNull();
  });
});

describe("the price board for players", () => {
  const edge = (player: string, stat: string, line: number, bookmaker: string, over: number | null, under: number | null, mean = 60): PropEdge => ({
    game_id: "g1", player_id: player, player_name: `Name ${player}`, team: "DET", stat, line, bookmaker, over_decimal: over, under_decimal: under, proj_mean: mean,
    model_over: 0.5, fair_over: bookmaker === "pinnacle" ? 0.52 : null, ev_over_fair: null, ev_under_fair: null, ev_over_model: null, ev_under_model: null, captured_at: null });
  const props = [
    edge("a", "receiving_yards", 61.5, "betmgm", 1.87, 1.87), edge("a", "receiving_yards", 61.5, "draftkings", 1.91, 1.83), edge("a", "receiving_yards", 61.5, "pinnacle", 1.9, 1.9),
    edge("a", "receptions", 4.5, "circa", 2.1, 1.7, 5), edge("b", "rushing_yards", 80.5, "draftkings", 1.8, null, 90),
  ];
  it("groups by player, stat and number with the best over and under at the person's books", () => {
    const rows = boardPlayers(props, BOOKS);
    expect(rows.map((r) => r.key)).toEqual(["b|rushing_yards|80.5", "a|receiving_yards|61.5"]);      // the catches line is only at a book they can't use
    const a = rows[1];
    expect(a.over[0]).toEqual({ bookmaker: "draftkings", price: 1.91 });
    expect(a.under[0]).toEqual({ bookmaker: "betmgm", price: 1.87 });
    expect(a.fair_over).toBe(0.52);
    expect(a.books).toBe(3);
    expect(rows[0].under).toEqual([]);
  });
  it("filters by name, team and stat", () => {
    expect(boardPlayers(props, BOOKS, { text: "name b" })).toHaveLength(1);
    expect(boardPlayers(props, BOOKS, { text: "det" })).toHaveLength(2);
    expect(boardPlayers(props, BOOKS, { stat: "receiving_yards" }).map((r) => r.player_id)).toEqual(["a"]);
  });
});

describe("prices as people write them", () => {
  it("reads American and decimal prices", () => {
    expect(parsePrice("+135")).toBeCloseTo(2.35);
    expect(parsePrice("-110")).toBeCloseTo(1.909, 3);
    expect(parsePrice("−110")).toBeCloseTo(1.909, 3);                // the typographic minus the app prints
    expect(parsePrice("150")).toBeCloseTo(2.5);
    expect(parsePrice("2.35")).toBe(2.35);
    for (const bad of ["", "abc", "+50", "-99", "1", "0.5", "1e3"]) expect(parsePrice(bad)).toBeNull();
  });
  it("prints a decimal price the American way", () => {
    expect(priceText(2.35)).toBe("+135");
    expect(priceText(1.909)).toBe("-110");
    expect(priceText(null)).toBe("");
  });
});

describe("the bet record", () => {
  const bet = (result: Bet["result"], stake: number, price: number, beat: number | null = null): Bet => ({
    id: 1, created_at: "", placed_at: "", bookmaker: "betmgm", kind: "game", description: "x", game_id: null, market: null, number: null, outcome: null, player_id: null,
    price_decimal: price, stake, fair_prob: null, result, settled_at: null, graded_by: null, note: null, home_team: null, away_team: null, kickoff_at: null,
    returned: null, profit: result === "won" ? stake * (price - 1) : result === "lost" ? -stake : result === "void" ? 0 : null, closing_fair: null, beat_close: beat });
  it("adds up money and counts bets that beat the closing price", () => {
    const r = betRecord([bet("won", 10, 2, 0.04), bet("lost", 10, 1.9, -0.02), bet("void", 20, 1.9, 0.01), bet("open", 5, 2)]);
    expect(r).toMatchObject({ open: 1, openStake: 5, settled: 3, won: 1, lost: 1, returned: 1, staked: 20, profit: 0, roi: 0, closeN: 3, closeBeat: 2 });
    expect(r.closeAvg).toBeCloseTo(0.01);
  });
  it("has nothing to say before anything is settled", () => {
    expect(betRecord([bet("open", 5, 2)])).toMatchObject({ settled: 0, staked: 0, roi: null, closeN: 0, closeAvg: null });
  });
});
