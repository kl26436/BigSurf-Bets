// Everything the app reads or writes goes through here. Reads hit the app_*
// views, writes go through the bsb_* functions; the database checks who is asking.
import { createClient, type Session } from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as demo from "./demo";
import {
  DEFAULT_SETTINGS, type DkEntry, type FeedHealth, type Game, type Job, type LineQuote, type LineupPlayer, type LineupRow,
  type LineupSet, type PoolPlayer, type PropEdge, type RosterPlayer, type Scorecard, type Settings, type Slate,
  type WaiverRec, type WaiverRun,
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

const TEXT = new Set(["dk_id", "name", "label", "slate_name", "note", "error", "override_note", "contest_name"]);

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
    ["pool", "projections"]);
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
export const useSaveSettings = () =>
  useWrite((s: Settings) => (DEMO ? demo.saveSettings(s) : rpc("bsb_save_settings", { p_settings: s })), ["settings"]);
export const useClaim = () => useWrite((_: void) => rpc<string>("bsb_claim_owner"), ["whoami"]);

// ---- when a request finishes ----------------------------------------------------
// What a finished job changed. The screens that show it would otherwise wait for
// their own timer: a build would read "done" a minute before its lineups appeared.
const CHANGES: Record<string, string[]> = {
  build_lineups: ["sets", "set"],
  import_slate: ["slates", "pool", "sets", "health"],
  project: ["pool", "projections", "sets", "set", "props", "roster", "free-agents", "health"],
  refresh_status: ["pool", "projections", "health"],
  refresh_odds: ["quotes", "props", "games", "health"],
  refresh_stats: ["health"],
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
