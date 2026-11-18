import { describe, expect, it } from "vitest";
import { contestRecord, isEntryHistory, moneyFromHistory, parseEntryHistoryCsv, parseStandingsCsv, person, topShare } from "./contest";

// The layout DraftKings documents for "Export Lineups to CSV": entries on the left, players on the right.
const FILE = [
  "Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,,Player,Roster Position,%Drafted,FPTS",
  '1,4001,sharp (1/3),0,201.52,"DST Eagles FLEX A Runner QB Q Back RB B Runner RB C Runner TE T End WR W One WR W Two WR W Three",,Q Back,QB,34.52%,31.5',
  "2,4002,kevlap (2/2),0,188.1,QB Q Back RB B Runner,,A Runner,RB,12.10%,24.0",
  "3,4003,someone,0,150,QB Other,,\"O'Neil, Jr.\",WR,0.40%,3.2",
  "4,4004,kevlap (1/2),0,121.34,QB Q Back,,,,,",
  "5,4005,sharp (2/3),0,99.9,QB Other,,,,,",
  "",
].join("\n");

describe("contest results file", () => {
  it("keeps your entries, the field's scores and every player's share of lineups", () => {
    const { standings: s, problem } = parseStandingsCsv(FILE, "contest-standings-171234567.csv", { username: "KevLap" });
    expect(problem).toBeUndefined();
    expect(s!.contest_key).toBe("171234567");
    expect(s!.n_entries).toBe(5);
    expect(s!.n_people).toBe(3);
    expect(s!.entries.map((e) => [e.entry_id, e.rank, e.points])).toEqual([["4002", 2, 188.1], ["4004", 4, 121.34]]);
    expect(s!.scores).toMatchObject({ max: 201.52, p50: 150, min: 99.9 });
    expect(s!.ownership).toEqual([
      { name: "Q Back", roster_position: "QB", pct_drafted: 34.52, fpts: 31.5 },
      { name: "A Runner", roster_position: "RB", pct_drafted: 12.1, fpts: 24 },
      { name: "O'Neil, Jr.", roster_position: "WR", pct_drafted: 0.4, fpts: 3.2 },
    ]);
  });
  it("finds your entries by their ids when there is no username", () => {
    const { standings } = parseStandingsCsv(FILE, "results.csv", { entryIds: new Set(["4003"]) });
    expect(standings!.entries.map((e) => e.entry_id)).toEqual(["4003"]);
    expect(standings!.contest_key).toBe("f5-4001");          // no contest id in the file name: told apart by size and first entry
  });
  it("reads a file with no entries of yours without complaint", () => {
    expect(parseStandingsCsv(FILE, "x.csv").standings!.entries).toEqual([]);
  });
  it("says what is wrong with the wrong file", () => {
    expect(parseStandingsCsv("Position,Name + ID,Name,ID\nQB,x,x,1", "DKSalaries.csv").problem).toMatch(/isn't a DraftKings contest results file/);
    expect(parseStandingsCsv("Entry ID,Contest Name,Contest ID,Entry Fee,QB\n1,x,2,$5,3", "DKEntries.csv").problem).toMatch(/entries file/);
    expect(parseStandingsCsv("Rank,EntryId,EntryName,TimeRemaining,Points,Lineup\n", "c.csv").problem).toMatch(/No entries/);
  });
  it("names a place in the field", () => {
    expect(person("kevlap (3/20)")).toBe("kevlap");
    expect(topShare(1, 1000)).toBe("first");
    expect(topShare(8, 1000)).toBe("top 0.8%");
    expect(topShare(120, 1000)).toBe("top 12%");
    expect(topShare(900, 1000)).toBe("bottom 10%");
  });
  it("adds up money only where it is complete", () => {
    const r = contestRecord([{ paid: 10, won: 18, profit: 8, n_mine: 2 }, { paid: 5, won: 0, profit: -5, n_mine: 1 }, { paid: 20, won: 0, profit: null, n_mine: 4 }, { paid: null, won: 0, profit: null, n_mine: 0 }]);
    expect(r).toMatchObject({ n: 2, open: 1, paid: 15, won: 18, profit: 3 });
    expect(r.roi).toBeCloseTo(0.2);
  });
});

describe("DraftKings entry history: the dollars", () => {
  const file = [
    "Sport,Game_Type,Entry_Key,Entry,Contest_Key,Contest_Date_EST,Place,Points,Winnings_Non_Ticket,Winnings_Ticket,Contest_Entries,Entry_Fee,Prize_Pool,Places_Paid",
    'NFL,Classic,5340594556,"NFL $500K Play-Action [20 Entry Max]",197645150,2026-11-15 13:00:00,18398,195.02,$6.00,$0.00,198176,$3.00,"$500,000.00",46000',
    'NFL,Classic,5340594854,"NFL $500K Play-Action [20 Entry Max]",197645150,2026-11-15 13:00:00,53508,172.24,$0.00,$0.00,198176,$3.00,"$500,000.00",46000',
    "NFL,Classic,5340633852,NFL $6K Play-Action [20 Entry Max],197862037,2026-11-15 13:00:00,1292,152.34,$0.00,$3.00,2378,$3.00,\"$6,000.00\",540",
    "NBA,Classic,999,Some other contest,555,2026-11-01 19:00:00,4,300,$50.00,$0.00,10,$5.00,$45.00,3",
    "",
  ].join("\r\n");

  it("tells the history file from a contest's results", () => {
    expect(isEntryHistory(file)).toBe(true);
    expect(isEntryHistory("Rank,EntryId,EntryName,TimeRemaining,Points,Lineup,,Player,Roster Position,%Drafted,FPTS")).toBe(false);
    expect(parseEntryHistoryCsv("Rank,EntryId\n1,2").problem).toMatch(/entry history/);
  });
  it("reads fees and winnings, cash and tickets together", () => {
    const { rows, problem } = parseEntryHistoryCsv(file);
    expect(problem).toBeUndefined();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ entry_id: "5340594556", contest_key: "197645150", entry_fee: 3, won: 6, places_paid: 46000, place: 18398, contest: "NFL $500K Play-Action [20 Entry Max]" });
    expect(rows[2].won).toBe(3);                                              // a ticket counts at its face value
  });
  it("fills in the contests on file and leaves the rest alone", () => {
    const { rows } = parseEntryHistoryCsv(file);
    const contests = [{ id: 2, contest_key: "197645150", name: null, entry_fee: null }, { id: 1, contest_key: "197862037", name: "Mine", entry_fee: 3 },
      { id: 3, contest_key: "000", name: null, entry_fee: null }];
    const entries = [{ contest_id: 2, entry_id: "5340594556" }, { contest_id: 2, entry_id: "5340594854" }, { contest_id: 2, entry_id: "not-in-history" },
      { contest_id: 1, entry_id: "5340633852" }, { contest_id: 3, entry_id: "1" }];
    expect(moneyFromHistory(rows, contests, entries)).toEqual([
      { contest_id: 2, entry_fee: 3, name: "NFL $500K Play-Action [20 Entry Max]", winnings: { "5340594556": 6, "5340594854": 0 } },
      { contest_id: 1, entry_fee: 3, name: "Mine", winnings: { "5340633852": 3 } },
    ]);
  });
});
