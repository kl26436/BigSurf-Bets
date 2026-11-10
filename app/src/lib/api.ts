// Everything the app reads or writes goes through here. Reads hit the app_*
// views, writes go through the bsb_* functions; the database checks who is asking.
import { createClient, type Session } from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as demo from "./demo";
import {
  DEFAULT_SETTINGS, type FeedHealth, type Game, type Job, type LineQuote, type LineupPlayer, type LineupRow,
  type LineupSet, type PoolPlayer, type PropEdge, type RosterPlayer, type Scorecard, type Settings, type Slate,
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
      if (typeof v === "string" && k !== "dk_id" && !k.endsWith("_id") && k !== "name" && NUMERIC.test(v)) r[k] = Number(v);
    }
  }
  return rows;
}

async function all<T>(view: string, build: (q: any) => any = (q) => q): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase!.from(view).select("*")).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if (!data || data.length < 1000) return num(out);
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
    queryFn: () => (DEMO ? demo.pool : all<PoolPlayer>("app_pool", (q) => q.eq("slate_id", slateId).order("salary", { ascending: false }))) });
export const useProjections = (enabled = true) =>
  useQuery({ queryKey: ["projections"], enabled, staleTime: MIN,
    queryFn: () => (DEMO ? demo.pool : all<PoolPlayer>("app_projections", (q) => q.order("dk_mean", { ascending: false }))) });
export const useSets = (slateId: number | undefined) =>
  useQuery({ queryKey: ["sets", slateId], enabled: slateId != null, refetchInterval: MIN,
    queryFn: () => (DEMO ? demo.sets : all<LineupSet>("app_lineup_sets", (q) => q.eq("slate_id", slateId).order("created_at", { ascending: false }))) });
export const useSet = (setId: number | undefined) =>
  useQuery({ queryKey: ["set", setId], enabled: setId != null, queryFn: async () => {
    if (DEMO) return demo.setDetail(setId!);
    const [lineups, players] = await Promise.all([
      all<LineupRow>("app_lineups", (q) => q.eq("set_id", setId).order("lineup_no")),
      all<LineupPlayer>("app_lineup_players", (q) => q.eq("set_id", setId).order("lineup_no").order("slot_no")),
    ]);
    return { lineups, players };
  } });
export const useQuotes = () =>
  useQuery({ queryKey: ["quotes"], staleTime: MIN, queryFn: () => (DEMO ? demo.quotes : all<LineQuote>("app_line_quotes")) });
export const usePropEdges = () =>
  useQuery({ queryKey: ["props"], staleTime: MIN, queryFn: () => (DEMO ? demo.props : all<PropEdge>("app_prop_edges")) });
export const useScorecards = () =>
  useQuery({ queryKey: ["scorecards"], queryFn: () => (DEMO ? demo.scorecards : all<Scorecard>("app_scorecards", (q) => q.order("season", { ascending: false }).order("week", { ascending: false }))) });
export const useRoster = () =>
  useQuery({ queryKey: ["roster"], queryFn: () => (DEMO ? demo.roster : all<RosterPlayer>("app_my_roster")) });
export const useFreeAgents = () =>
  useQuery({ queryKey: ["free-agents"], queryFn: () => (DEMO ? demo.freeAgents : all<RosterPlayer>("app_free_agents", (q) => q.order("ppr_mean", { ascending: false }).limit(40))) });
export const useJobs = () =>
  useQuery({ queryKey: ["jobs"], queryFn: () => (DEMO ? demo.jobs() : all<Job>("app_jobs", (q) => q.order("created_at", { ascending: false }).limit(15))),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ["queued", "dispatched", "running"].includes(j.status)) ? 8000 : MIN) });
export const usePlayerLog = (playerId: string | null | undefined) =>
  useQuery({ queryKey: ["log", playerId], enabled: !!playerId && !playerId.startsWith("DST_"), staleTime: 10 * MIN,
    queryFn: () => (DEMO ? demo.log(playerId!) : all<Record<string, number | string | null>>("app_player_log",
      (q) => q.eq("player_id", playerId).order("season", { ascending: false }).order("week", { ascending: false }).limit(8))) });
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
    DEMO ? Promise.resolve(0) : rpc<number>("bsb_save_lineup", { p_slate_id: a.slate_id, p_players: a.players, p_label: a.label ?? null }), ["sets"]);
export const useSetEntered = () =>
  useWrite((a: { set_id: number; entered: boolean }) =>
    DEMO ? demo.setEntered(a.set_id, a.entered) : rpc("bsb_set_entered", { p_set_id: a.set_id, p_entered: a.entered }), ["sets"]);
export const useSaveSettings = () =>
  useWrite((s: Settings) => (DEMO ? demo.saveSettings(s) : rpc("bsb_save_settings", { p_settings: s })), ["settings"]);
export const useClaim = () => useWrite((_: void) => rpc<string>("bsb_claim_owner"), ["whoami"]);
