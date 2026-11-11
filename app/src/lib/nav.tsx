// Navigation that behaves like an installed app, where the only Back is the
// edge swipe: Back closes a sheet before it leaves a screen, a new screen opens
// at the top, Back returns to where you were, and "up" goes to the parent screen
// without piling up history.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

interface SheetState { name: string; value: unknown }
const sheetOf = (state: unknown): SheetState | undefined => (state as { sheet?: SheetState } | null)?.sheet;
/** Position of the current entry in this tab's history (kept by the router). */
const historyIdx = (): number => (window.history.state as { idx?: number } | null)?.idx ?? 0;

/** A sheet whose open state lives in the history entry: opening it adds an
 *  entry, so Back (and the edge swipe) close it instead of leaving the screen.
 *  → [what it is open on, or null · open · close] */
export function useSheet<T = true>(name: string): [T | null, (value?: T) => void, () => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const current = sheetOf(location.state);
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [location.key]);
  const here = { pathname: location.pathname, search: location.search };
  const open = (value: T = true as T) => navigate(here, { state: { sheet: { name, value } }, replace: !!current });
  const close = () => {
    if (current?.name !== name || closing.current) return;      // a second tap must not go back twice
    closing.current = true;
    if (historyIdx() > 0) navigate(-1);
    else navigate(here, { replace: true, state: null });
  };
  return [current?.name === name ? (current.value as T) : null, open, close];
}

// What each history entry showed, and how far it was scrolled.
const paths = new Map<number, string>();
const scrolls = new Map<string, number>();

function scrollTo(y: number, tries = 30) {
  window.scrollTo(0, y);
  // the screen may still be filling in: keep trying for half a second
  if (y > 0 && tries > 0 && Math.abs(window.scrollY - y) > 2) requestAnimationFrame(() => scrollTo(y, tries - 1));
}

/** Call once, in the shell. */
export function useAppNavigation() {
  const location = useLocation();
  const type = useNavigationType();
  const lastPath = useRef<string | null>(null);
  const key = useRef(location.key);

  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const onScroll = () => scrolls.set(key.current, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const idx = historyIdx();
    if (type === "PUSH") for (const k of [...paths.keys()]) if (k > idx) paths.delete(k);
    paths.set(idx, sheetOf(location.state) ? `${location.pathname}#sheet` : location.pathname);
    key.current = location.key;
    // a sheet opening or closing leaves the screen where it is
    if (lastPath.current !== null && lastPath.current !== location.pathname) {
      scrollTo(type === "POP" ? scrolls.get(location.key) ?? 0 : 0);
    }
    lastPath.current = location.pathname;
  }, [location, type]);
}

/** Go to a parent screen: back to it when it is behind us in history, so the
 *  history does not grow a loop; otherwise in place of the current entry. */
export function useGoUp(): (parent: string) => void {
  const navigate = useNavigate();
  return useCallback((parent: string) => {
    const idx = historyIdx();
    for (let j = idx - 1; j >= 0 && paths.has(j); j--) {
      if (paths.get(j) === parent) return void navigate(j - idx);
    }
    navigate(parent, { replace: true });
  }, [navigate]);
}

/** Name the screen for the app switcher, browser tabs and history. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Big Surf Bets` : "Big Surf Bets";
  }, [title]);
}
