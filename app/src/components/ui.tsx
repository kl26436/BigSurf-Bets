import { useEffect, type ReactNode } from "react";
import { ago, statusLabel } from "../lib/format";
import { POS_LABEL } from "../lib/lineup";
import type { Pos } from "../lib/types";

export function Loading({ what = "Loading…" }: { what?: string }) {
  return <p className="loading" role="status">{what}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div className="card card--pad" role="alert">
      <p className="strong bad">Couldn't load this</p>
      <p className="small muted">{error instanceof Error ? error.message : "Check your connection and try again."}</p>
    </div>
  );
}

/** Three-part empty state: what this is, why it's empty, how to start. */
export function Empty({ title, why, how }: { title: string; why?: string; how?: ReactNode }) {
  return (
    <div className="card empty">
      <p className="strong">{title}</p>
      {why && <p className="muted small">{why}</p>}
      {how && <p className="small">{how}</p>}
    </div>
  );
}

export function PosTag({ pos }: { pos: Pos | string | null }) {
  return <span className="tag">{pos ? POS_LABEL[pos as Pos] ?? pos : "–"}</span>;
}

const SHORT_STATUS: Record<string, string> = { Questionable: "Q", Doubtful: "D", Out: "OUT", "Injured reserve": "IR" };

/** `short` is the one- to three-letter tag used on player rows, where the full word does not fit. */
export function StatusPill({ status, short = false }: { status: string | null | undefined; short?: boolean }) {
  const label = statusLabel(status);
  if (!label) return null;
  const tone = label === "Questionable" ? "pill--warn" : "pill--bad";
  if (!short) return <span className={`pill ${tone}`}>{label}</span>;
  return <span className={`pill ${tone}`} role="img" aria-label={label} title={label}>{SHORT_STATUS[label] ?? label.slice(0, 3).toUpperCase()}</span>;
}

/** A player's name on a row. The name gives way when space runs out; the injury tag never does. */
export function PlayerName({ name, status, children }: { name: string; status?: string | null; children?: ReactNode }) {
  return (
    <p className="pname">
      <span className="pname__text">{name}</span>
      <StatusPill status={status} short />
      {children}
    </p>
  );
}

/** Floor-to-ceiling bar: 10th–90th percentile band, middle half, median tick. */
export function RangeBar({ p10, p25, p50, p75, p90, max }: { p10: number | null; p25?: number | null; p50?: number | null; p75?: number | null; p90: number | null; max: number }) {
  if (p10 == null || p90 == null || max <= 0) return null;
  const x = (v: number) => Math.max(0, Math.min(100, (v / max) * 100));
  return (
    <svg className="range" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={`Likely range ${p10.toFixed(0)} to ${p90.toFixed(0)} points`}>
      <rect className="range__track" x="0" y="6" width="100" height="2" rx="1" />
      <rect className="range__band" x={x(p10)} y="4" width={Math.max(1, x(p90) - x(p10))} height="6" rx="3" />
      {p25 != null && p75 != null && <rect className="range__core" x={x(p25)} y="4" width={Math.max(1, x(p75) - x(p25))} height="6" rx="3" />}
      {p50 != null && <rect className="range__mid" x={x(p50) - 0.75} y="2" width="1.5" height="10" />}
    </svg>
  );
}

export function Fresh({ at, label }: { at: string | null | undefined; label?: string }) {
  return <span className="small muted">{label ?? "Updated"} {ago(at)}</span>;
}

/** The one bottom-sheet in the app. Escape and the backdrop close it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grab" />
        <div className="spread">
          <h2 className="h2">{title}</h2>
          <button className="btn btn--quiet btn--sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stepper({ label, value, onChange, min, max, step = 1, format = String }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string;
}) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
  return (
    <label className="field">
      <span>{label}</span>
      <div className="stepper">
        <button type="button" aria-label={`Less: ${label}`} onClick={() => onChange(clamp(value - step))}>−</button>
        <output>{format(value)}</output>
        <button type="button" aria-label={`More: ${label}`} onClick={() => onChange(clamp(value + step))}>+</button>
      </div>
    </label>
  );
}

const ICONS: Record<string, ReactNode> = {
  week: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  players: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.900 1.900 6.500 5.500M16 5.200a3.500 3.500 0 010 6.600M18.500 14.800c1.700.800 2.700 2.500 3 5.200" /></>,
  lineups: <><path d="M4 6h16M4 12h16M4 18h10" /></>,
  bets: <><path d="M4 19V9M10 19V5M16 19v-7M21 19H3" /></>,
  more: <><circle cx="5" cy="12" r="1.200" /><circle cx="12" cy="12" r="1.200" /><circle cx="19" cy="12" r="1.200" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  ban: <><circle cx="12" cy="12" r="8.500" /><path d="M6 6l12 12" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
};
export function Icon({ name }: { name: keyof typeof ICONS | string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>;
}
