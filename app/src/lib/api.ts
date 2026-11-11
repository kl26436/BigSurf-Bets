// Everything the app reads or writes goes through here. Reads hit the app_*
// views, writes go through the bsb_* functions; the database checks who is asking.
import { createClient, type Session } from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as demo from "./demo";
import {
  DEFAULT_SETTINGS, type AppEvent, type Bet, type DkEntry, type FeedHealth, type Game, type Job, type LineQuote, type LineupPlayer, type LineupRow,
  type LineupSet, type PoolPlayer, type PropEdge, type RosterPlayer, type Scorecard, type Settings, type Slate,
  type PushDevice, type SentNote, type WaiverRec, type WaiverRun, type ModelDist, type ModelRun, type Override, type PlayerResult, type PropResult,
  type Contest, type ContestEntry, type ContestPlayer,
} from "./types";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
/** No project configured: run on built-in sample data so the screens can be looked at. */
export const DEMO = !url || !key;
export const supabase = DEMO ? null : createClient(url!, key!);

const NUMERIC = /^-?\d+(\.\d+)?$/;
/** Postgres numerics arrive as strings; turn them back into numbers. */
function num<T>(rows: T[]): T[] {
  for (const r of rows as Record<string, unknown>[]) {
    for (const k in r) {
      const v = r[k];
      if (typeof v === "string" && !TEXT.has(k) && !k.endsWith("_id") && NUMERIC.test(v)) r[k] = Number(v);
    }
  }
  return rows;
}

const TEXT = new Set(["dk_id", "name", "label", "slate_name", "note", "error", "override_note", "contest_name", "description", "title", "body", "target", "device",
  "git_sha", "model_version", "entry_name", "entry_id", "contest_key", "lineup", "dk_username"]);

/** Every row of a view (paged past the API's 1,000-row page), or just the first `max`. */
async function all<T>(view: string, build: (q: any) => any = (q) => q, max?: number): Promise<T[]> {
  const out: T[] = [];
  const page = max ?? 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await build(supabase!.from(view).select("*")).range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if (max != null || !data || data.length < page) return num(out);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase!.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// ---- session -----------------------------------------------------------------
export function useSession(): { session: Session | null; ready: boolean } {
  const [state, setState] = useState<{ session: Session | null; ready: boolean }>({ session: null, ready: DEMO });
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, ready: true }));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setState({ session, ready: true }));
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

export interface WhoAmI { signed_in: boolean; member: boolean; role: string | null; claim_open: boolean }
export const useWhoAmI = (enabled: boolean) =>
  useQuery({ queryKey: ["whoami"], enabled, queryFn: () => (DEMO ? demo.whoami : rpc<WhoAmI>("bsb_whoami")) });

// ---- reads -------------------------------------------------------------------
const MIN = 60_000;
export const useHealth = () =>
  useQuery({ queryKey: ["health"], refetchInterval: 2 * MIN, queryFn: () => (DEMO ? demo.health : all<FeedHealth>("app_feed_health", (q) => q.order("sort"))) });
export const useSlates = () =>
  useQuery({ queryKey: ["slates"], queryFn: () => (DEMO ? demo.slates : all<Slate>("app_slates", (q) => q.order("starts_at", { ascending: false }))) });
export const useGames = () =>
  useQuery({ queryKey: ["games"], queryFn: () => (DEMO ? demo.games : all<Game>("app_games", (q) => q.order("kickoff_at"))) });
export const usePool = (slateId: number | undefined) =>
  useQuery({ queryKey: ["pool", slateId], enabled: slateId != null, staleTime: MIN,
    queryFn: () => (DEMO ? demo.poolFor(slateId!) : all<PoolPlayer>("app_pool", (q) => q.eq("slate_id", slateId).order("salary", { ascending: false }))) });
export const useProjections = (enabled = true) =>
  useQuery({ queryKey: ["projections"], enabled, staleTime: MIN,
    queryFn: () => (DEMO ? demo.pool : all<PoolPlayer>("app_projections", (q) => q.order("dk_mean", { ascending: false }))) });
export const useSets = (slateId: number | undefined) =>
  useQuery({ queryKey: ["sets", slateId], enabled: slateId != null, refetchInterval: MIN,
    queryFn: () => (DEMO ? demo.listSets(slateId!) : all<LineupSet>("app_lineup_sets", (q) => q.eq("slate_id", slateId).order("created_at", { ascending: false }))) });
export const useSet = (setId: number | undefined) =>
  useQuery({ queryKey: ["set", setId], enabled: setId != null, queryFn: async () => {
    if (DEMO) return demo.setDetail(setId!);
    const [sets, lineups, players] = await Promise.all([
      all<LineupSet>("app_lineup_sets", (q) => q.eq("id", setId)),
      all<LineupRow>("app_lineups", (q) => q.eq("set_id", setId).order("lineup_no")),
      all<LineupPlayer>("app_lineup_players", (q) => q.eq("set_id", setId).order("lineup_no").order("slot_no")),
    ]);
    return { set: sets[0] ?? null, lineups, players };
  } });
/** Every lineup and player of several sets at once: entries and swaps look across sets. */
export const useSetsDetail = (setIds: number[]) =>
  useQuery({ queryKey: ["set", "many", setIds.join(",")], enabled: setIds.length > 0, queryFn: async () => {
    if (DEMO) return demo.manyDetail(setIds);
    const [lineups, players] = await Promise.all([
      all<LineupRow>("app_lineups", (q) => q.in("set_id", setIds).order("set_id").order("lineup_no")),
      all<LineupPlayer>("app_lineup_players", (q) => q.in("set_id", setIds).order("set_id").order("lineup_no").order("slot_no")),
    ]);
    return { lineups, players };
  } });
export const useEntries = (slateId: number | undefined) =>
  useQuery({ queryKey: ["entries", slateId], enabled: slateId != null,
    queryFn: () => (DEMO ? demo.listEntries() : all<DkEntry>("app_dk_entries", (q) => q.eq("slate_id", slateId).order("contest_name").order("entry_id"))) });
export const useQuotes = () =>
  useQuery({ queryKey: ["quotes"], staleTime: MIN, queryFn: () => (DEMO ? demo.quotes : all<LineQuote>("app_line_quotes")) });
export const usePropEdges = () =>
  useQuery({ queryKey: ["props"], staleTime: MIN, queryFn: () => (DEMO ? demo.props : all<PropEdge>("app_prop_edges")) });
export const useBets = () =>
  useQuery({ queryKey: ["bets"], queryFn: () => (DEMO ? demo.listBets() : all<Bet>("app_bets", (q) => q.order("placed_at", { ascending: false }))) });
/** What changed lately, newest first. */
export const useEvents = () =>
  useQuery({ queryKey: ["events"], refetchInterval: 5 * MIN,
    queryFn: () => (DEMO ? demo.events : all<AppEvent>("app_events", (q) => q.order("created_at", { ascending: false }), 40)) });
export const usePushDevices = () =>
  useQuery({ queryKey: ["push-devices"], queryFn: () => (DEMO ? demo.listDevices() : all<PushDevice>("app_push_devices", (q) => q.order("created_at", { ascending: false }))) });
export const useSentNotes = () =>
  useQuery({ queryKey: ["sent-notes"], queryFn: () => (DEMO ? Promise.resolve([] as SentNote[]) : all<SentNote>("app_notifications", (q) => q.order("at", { ascending: false }), 8)) });
/** The public half of the key pop-ups are signed with (null: not made yet). */
export const usePushKey = () =>
  useQuery({ queryKey: ["push-key"], staleTime: Infinity, queryFn: () => (DEMO ? Promise.resolve(null as string | null) : rpc<string | null>("bsb_push_key")) });
export const useScorecards = () =>
  useQuery({ queryKey: ["scorecards"], queryFn: () => (DEMO ? demo.scorecards : all<Scorecard>("app_scorecards", (q) => q.order("season", { ascending: false }).order("week", { ascending: false }))) });
export const useRoster = () =>
  useQuery({ queryKey: ["roster"], queryFn: () => (DEMO ? demo.roster : all<RosterPlayer>("app_my_roster")) });
export const useWaiverRun = () =>
  useQuery({ queryKey: ["waiver-run"], queryFn: async () => (DEMO ? demo.waiverRun : (await all<WaiverRun>("app_waiver_run"))[0] ?? null) });
export const useWaiverRecs = () =>
  useQuery({ queryKey: ["waiver-recs"], queryFn: () => (DEMO ? demo.waiverRecs : all<WaiverRec>("app_waiver_recs", (q) => q.order("rank"))) });
export const useFreeAgents = () =>
  useQuery({ queryKey: ["free-agents"], queryFn: () => (DEMO ? demo.freeAgents : all<RosterPlayer>("app_free_agents", (q) => q.order("ppr_mean", { ascending: false }), 40)) });
/** The model's outcome shapes, by stat: what Price a line reads a chance from. */
export const useModelDists = () =>
  useQuery({ queryKey: ["dists"], staleTime: 30 * MIN, queryFn: async () => {
    const rows = DEMO ? demo.dists : await all<ModelDist>("app_model_dists");
    return new Map(rows.map((d) => [d.stat, d]));
  } });
export const usePlayerResults = (season: number | undefined, week: number | undefined) =>
  useQuery({ queryKey: ["player-results", season, week], enabled: season != null && week != null, staleTime: 30 * MIN,
    queryFn: () => (DEMO ? demo.playerResults : all<PlayerResult>("app_player_results", (q) => q.eq("season", season).eq("week", week).order("miss", { ascending: false }))) });
export const usePropResults = (season: number | undefined, week: number | undefined) =>
  useQuery({ queryKey: ["prop-results", season, week], enabled: season != null && week != null, staleTime: 30 * MIN,
    queryFn: () => (DEMO ? demo.propResults : all<PropResult>("app_prop_results", (q) => q.eq("season", season).eq("week", week).not("model_side", "is", null))) });
export const useOverrides = () =>
  useQuery({ queryKey: ["overrides"], queryFn: () => (DEMO ? demo.listOverrides() : all<Override>("app_overrides", (q) => q.order("updated_at", { ascending: false }), 100)) });
export const useModelRuns = () =>
  useQuery({ queryKey: ["model-runs"], queryFn: () => (DEMO ? demo.modelRuns : all<ModelRun>("app_model_runs", (q) => q.order("created_at", { ascending: false }), 12)) });
export const useContests = () =>
  useQuery({ queryKey: ["contests"], queryFn: () => (DEMO ? demo.listContests() : all<Contest>("app_contests", (q) => q.order("imported_at", { ascending: false }))) });
export const useContestEntries = (enabled: boolean) =>
  useQuery({ queryKey: ["contest-entries"], enabled, queryFn: () => (DEMO ? demo.listContestEntries() : all<ContestEntry>("app_contest_entries", (q) => q.order("rank"))) });
export const useContestPlayers = (contestId: number | null) =>
  useQuery({ queryKey: ["contest-players", contestId], enabled: contestId != null, staleTime: 30 * MIN,
    queryFn: () => (DEMO ? demo.contestPlayers(contestId!) : all<ContestPlayer>("app_contest_ownership", (q) => q.eq("contest_id", contestId).order("pct_drafted", { ascending: false }), 60)) });
/** Every entry id the entries files have told us about: how your rows are found in a results file. */
export const useKnownEntryIds = () =>
  useQuery({ queryKey: ["entries", "ids"], staleTime: 5 * MIN, queryFn: async () =>
    new Set((DEMO ? await demo.listEntries() : await all<DkEntry>("app_dk_entries")).map((e) => e.entry_id)) });
export const useJobs = () =>
  useQuery({ queryKey: ["jobs"], queryFn: () => (DEMO ? demo.jobs() : all<Job>("app_jobs", (q) => q.order("created_at", { ascending: false }), 15)),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ["queued", "dispatched", "running"].includes(j.status)) ? 8000 : MIN) });
export const usePlayerLog = (playerId: string | null | undefined) =>
  useQuery({ queryKey: ["log", playerId], enabled: !!playerId && !playerId.startsWith("DST_"), staleTime: 10 * MIN,
    queryFn: () => (DEMO ? demo.log(playerId!) : all<Record<string, number | string | null>>("app_player_log",
      (q) => q.eq("player_id", playerId).order("season", { ascending: false }).order("week", { ascending: false }), 8)) });
export const useSettings = () =>
  useQuery({ queryKey: ["settings"], staleTime: Infinity,
    queryFn: async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(DEMO ? demo.loadSettings() : await rpc<Partial<Settings>>("bsb_get_settings")) }) });
export const useDispatches = (enabled: boolean) =>
  useQuery({ queryKey: ["dispatches"], enabled: enabled && !DEMO,
    queryFn: () => rpc<{ at: string; workflow: string; source: string | null; sent: boolean; status_code: number | null }[]>("bsb_recent_dispatches") });

// ---- writes ------------------------------------------------------------------
function useWrite<A>(fn: (a: A) => Promise<unknown>, invalidate: string[]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] })) });
}

export const useRequestJob = () =>
  useWrite((a: { kind: string; payload?: Record<string, unknown> }) =>
    DEMO ? demo.addJob(a.kind, a.payload ?? {}) : rpc<number>("bsb_request_job", { p_kind: a.kind, p_payload: a.payload ?? {} }), ["jobs"]);
export const useSetOverride = () =>
  useWrite((a: { season: number; week: number; player_id: string; dk_mean: number | null; note?: string }) =>
    DEMO ? demo.setOverride(a.player_id, a.dk_mean) : rpc("bsb_set_override", { p_season: a.season, p_week: a.week, p_player_id: a.player_id, p_dk_mean: a.dk_mean, p_note: a.note ?? null }),
    ["pool", "projections", "overrides"]);
export const useSaveLineup = () =>
  useWrite((a: { slate_id: number; players: string[]; label?: string }) =>
    DEMO ? demo.saveLineup(a.players, a.label) : rpc<number>("bsb_save_lineup", { p_slate_id: a.slate_id, p_players: a.players, p_label: a.label ?? null }), ["sets"]);
export const useSetEntered = () =>
  useWrite((a: { set_id: number; entered: boolean }) =>
    DEMO ? demo.setEntered(a.set_id, a.entered) : rpc("bsb_set_entered", { p_set_id: a.set_id, p_entered: a.entered }), ["sets", "set"]);
/** → how many of the set's lineups are now entered */
export const useSetLineupsEntered = () =>
  useWrite((a: { set_id: number; lineup_nos: number[]; entered: boolean }) =>
    DEMO ? demo.setLineupsEntered(a.set_id, a.lineup_nos, a.entered)
      : rpc<number>("bsb_set_lineups_entered", { p_set_id: a.set_id, p_lineup_nos: a.lineup_nos, p_entered: a.entered }), ["sets", "set"]);
/** Nine DraftKings ids in slot order take the place of a stored lineup's players (a late swap). */
export const useReplaceLineup = () =>
  useWrite((a: { set_id: number; lineup_no: number; players: string[] }) =>
    DEMO ? demo.replaceLineup(a.set_id, a.lineup_no, a.players)
      : rpc("bsb_replace_lineup", { p_set_id: a.set_id, p_lineup_no: a.lineup_no, p_players: a.players }), ["sets", "set"]);
export const useImportEntries = () =>
  useWrite((a: { slate_id: number; entries: unknown[] }) =>
    DEMO ? demo.importEntries(a.entries) : rpc<{ entries: number; linked: number }>("bsb_import_dk_entries", { p_slate_id: a.slate_id, p_entries: a.entries }),
    ["entries", "sets", "set"]);
export const useAssignEntries = () =>
  useWrite((a: { assignments: { entry_id: string; set_id: number | null; lineup_no?: number | null }[] }) =>
    DEMO ? demo.assignEntries(a.assignments) : rpc<number>("bsb_assign_entries", { p_assignments: a.assignments }), ["entries", "sets", "set"]);
/** Write a placed bet down → its id */
export const useLogBet = () =>
  useWrite((a: { bet: Record<string, unknown> }) => (DEMO ? demo.logBet(a.bet) : rpc<number>("bsb_log_bet", { p: a.bet })), ["bets"]);
export const useSettleBet = () =>
  useWrite((a: { id: number; result: Bet["result"] }) => (DEMO ? demo.settleBet(a.id, a.result) : rpc("bsb_settle_bet", { p_id: a.id, p_result: a.result })), ["bets"]);
export const useDeleteBet = () =>
  useWrite((a: { id: number }) => (DEMO ? demo.deleteBet(a.id) : rpc("bsb_delete_bet", { p_id: a.id })), ["bets"]);
/** Settle open bets from final scores → how many were settled */
export const useGradeBets = () =>
  useWrite((_: void) => (DEMO ? demo.gradeBets() : rpc<number>("bsb_grade_bets")), ["bets"]);
/** Sign a device up for pop-ups (the browser's subscription, plus a label for the list). */
export const useSavePush = () =>
  useWrite((a: { sub: { endpoint: string; keys: { p256dh: string; auth: string }; device: string } }) =>
    DEMO ? demo.saveDevice(a.sub.device) : rpc("bsb_save_push_subscription", { p: a.sub }), ["push-devices"]);
/** Forget a device: this one by its address, or any of yours by the id in the list. */
export const useDeletePush = () =>
  useWrite((a: { endpoint?: string; id?: string }) =>
    DEMO ? demo.deleteDevice() : rpc<number>("bsb_delete_push_subscription", { p_endpoint: a.endpoint ?? null, p_id: a.id ?? null }), ["push-devices"]);
export const useRenameSet = () =>
  useWrite((a: { set_id: number; label: string | null }) =>
    DEMO ? demo.renameSet(a.set_id, a.label) : rpc("bsb_rename_set", { p_set_id: a.set_id, p_label: a.label }), ["sets", "set"]);
export const useArchiveSet = () =>
  useWrite((a: { set_id: number; archived: boolean }) =>
    DEMO ? demo.archiveSet(a.set_id, a.archived) : rpc("bsb_archive_set", { p_set_id: a.set_id, p_archived: a.archived }), ["sets", "set"]);
export const useDeleteSet = () =>
  useWrite((a: { set_id: number }) => (DEMO ? demo.deleteSet(a.set_id) : rpc("bsb_delete_set", { p_set_id: a.set_id })), ["sets"]);
/** → lineups left in the set (0: the set went with its last lineup) */
export const useDeleteLineup = () =>
  useWrite((a: { set_id: number; lineup_no: number }) =>
    DEMO ? demo.deleteLineup(a.set_id, a.lineup_no) : rpc<number>("bsb_delete_lineup", { p_set_id: a.set_id, p_lineup_no: a.lineup_no }), ["sets", "set"]);
export const useDismissJob = () =>
  useWrite((a: { job_id: number }) => (DEMO ? demo.dismissJob(a.job_id) : rpc("bsb_dismiss_job", { p_job_id: a.job_id })), ["jobs"]);
/** Store what a results file held → {contest_id, entries, players} */
export const useImportContest = () =>
  useWrite((a: { contest: Record<string, unknown> }) =>
    DEMO ? demo.importContest(a.contest) : rpc<{ contest_id: number; entries: number; players: number }>("bsb_import_contest", { p_slate_id: null, p: a.contest }),
    ["contests", "contest-entries", "contest-players"]);
export const useSetContestMoney = () =>
  useWrite((a: { contest_id: number; entry_fee: number | null; name: string | null; winnings: Record<string, number | null> }) =>
    DEMO ? demo.setContestMoney(a.contest_id, a.entry_fee, a.name, a.winnings)
      : rpc("bsb_set_contest_money", { p_contest_id: a.contest_id, p_entry_fee: a.entry_fee, p_name: a.name, p_winnings: a.winnings }), ["contests", "contest-entries"]);
export const useDeleteContest = () =>
  useWrite((a: { contest_id: number }) => (DEMO ? demo.deleteContest(a.contest_id) : rpc("bsb_delete_contest", { p_contest_id: a.contest_id })), ["contests", "contest-entries"]);
export const useSaveSettings = () =>
  useWrite((s: Settings) => (DEMO ? demo.saveSettings(s) : rpc("bsb_save_settings", { p_settings: s })), ["settings"]);
export const useClaim = () => useWrite((_: void) => rpc<string>("bsb_claim_owner"), ["whoami"]);

// ---- when a request finishes ----------------------------------------------------
// What a finished job changed. The screens that show it would otherwise wait for
// their own timer: a build would read "done" a minute before its lineups appeared.
const CHANGES: Record<string, string[]> = {
  build_lineups: ["sets", "set"],
  import_slate: ["slates", "pool", "sets", "health"],
  project: ["pool", "projections", "sets", "set", "props", "roster", "free-agents", "health", "dists", "model-runs", "waiver-run", "waiver-recs"],
  refresh_status: ["pool", "projections", "health", "events"],
  refresh_odds: ["quotes", "props", "games", "health"],
  refresh_stats: ["health"],
  notify_test: ["sent-notes", "push-devices", "push-key"],
};
/** Call once, in the shell. */
export function useJobEffects() {
  const jobs = useJobs();
  const qc = useQueryClient();
  const seen = useRef(new Map<number, string>());
  useEffect(() => {
    for (const j of jobs.data ?? []) {
      const before = seen.current.get(j.id);
      if (before && before !== "done" && j.status === "done") (CHANGES[j.kind] ?? []).forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      seen.current.set(j.id, j.status);
    }
  }, [jobs.data, qc]);
}
