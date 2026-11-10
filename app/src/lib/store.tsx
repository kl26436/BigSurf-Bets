// Small client-side state that outlives a screen: which players are locked or
// left out of the next build, the lineup being built by hand, and toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Mark = "lock" | "exclude";
interface Toast { text: string; error?: boolean }
interface Store {
  marks: Record<string, Mark>;
  setMark: (dkId: string, mark: Mark | null) => void;
  clearMarks: () => void;
  hand: (string | null)[];
  setHand: (ids: (string | null)[]) => void;
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
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => save("bsb-marks", marks), [marks]);
  useEffect(() => save("bsb-hand", hand), [hand]);

  const setMark = useCallback((dkId: string, mark: Mark | null) => setMarks((m) => {
    const next = { ...m };
    if (mark) next[dkId] = mark; else delete next[dkId];
    return next;
  }), []);
  const say = useCallback((text: string, error = false) => {
    clearTimeout(timer.current);
    setToast({ text, error });
    timer.current = setTimeout(() => setToast(null), error ? 4000 : 1800);
  }, []);
  const value = useMemo<Store>(() => ({
    marks, setMark, clearMarks: () => setMarks({}), hand: hand.length === 9 ? hand : EMPTY, setHand: setHandState, toast, say,
  }), [marks, setMark, hand, toast, say]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
}
