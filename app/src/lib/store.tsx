// Small client-side state that outlives a screen: which players are locked or
// left out of the next build, the lineup being built by hand, how the Players
// list was last filtered, and toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Pos } from "./types";

export type Mark = "lock" | "exclude";
export type PlayerSort = "points" | "value" | "salary";
export interface PlayersView { pos: Pos | "ALL"; sort: PlayerSort; text: string }
export interface BetsView { view: "best" | "prices" | "price" | "mine"; kind: "games" | "players" }
/** The hand-built lineup as it was last saved: the same nine again is not saved twice. */
export interface SavedHand { key: string; setId: number; label: string | null }
interface Toast { text: string; error?: boolean }
interface Store {
  marks: Record<string, Mark>;
  setMark: (dkId: string, mark: Mark | null) => void;
  clearMarks: () => void;
  hand: (string | null)[];
  setHand: (ids: (string | null)[]) => void;
  savedHand: SavedHand | null;
  setSavedHand: (s: SavedHand | null) => void;
  /** games picked for this visit (null: the current ones) */
  slateId: number | null;
  setSlateId: (id: number | null) => void;
  playersView: PlayersView;
  setPlayersView: (patch: Partial<PlayersView>) => void;
  betsView: BetsView;
  setBetsView: (patch: Partial<BetsView>) => void;
  toast: Toast | null;
  say: (text: string, error?: boolean) => void;
}

const Ctx = createContext<Store | null>(null);
const EMPTY: (string | null)[] = Array(9).fill(null);

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: state lives for the session only */ }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [marks, setMarks] = useState<Record<string, Mark>>(() => load("bsb-marks", {}));
  const [hand, setHandState] = useState<(string | null)[]>(() => load("bsb-hand", EMPTY));
  const [savedHand, setSavedHand] = useState<SavedHand | null>(() => load("bsb-saved-hand", null));
  // kept for the session, not across launches: a filter left on from last week hides players
  const [playersView, setView] = useState<PlayersView>({ pos: "ALL", sort: "points", text: "" });
  const [betsView, setBets] = useState<BetsView>({ view: "best", kind: "games" });
  const [slateId, setSlateId] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => save("bsb-marks", marks), [marks]);
  useEffect(() => save("bsb-hand", hand), [hand]);
  useEffect(() => save("bsb-saved-hand", savedHand), [savedHand]);

  const setMark = useCallback((dkId: string, mark: Mark | null) => setMarks((m) => {
    const next = { ...m };
    if (mark) next[dkId] = mark; else delete next[dkId];
    return next;
  }), []);
  const setPlayersView = useCallback((patch: Partial<PlayersView>) => setView((v) => ({ ...v, ...patch })), []);
  const setBetsView = useCallback((patch: Partial<BetsView>) => setBets((v) => ({ ...v, ...patch })), []);
  const say = useCallback((text: string, error = false) => {
    clearTimeout(timer.current);
    setToast({ text, error });
    timer.current = setTimeout(() => setToast(null), error ? 4000 : 1800);
  }, []);
  const value = useMemo<Store>(() => ({
    marks, setMark, clearMarks: () => setMarks({}), hand: hand.length === 9 ? hand : EMPTY, setHand: setHandState,
    savedHand, setSavedHand, slateId, setSlateId, playersView, setPlayersView, betsView, setBetsView, toast, say,
  }), [marks, setMark, hand, savedHand, slateId, playersView, setPlayersView, betsView, setBetsView, toast, say]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
}
