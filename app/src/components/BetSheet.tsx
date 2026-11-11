import { useState } from "react";
import { useLogBet, useSettings } from "../lib/api";
import { bookName, pct } from "../lib/format";
import { parsePrice, priceText, type BetDraft } from "../lib/prices";
import { useStore } from "../lib/store";
import { DEFAULT_SETTINGS } from "../lib/types";
import { Sheet } from "./ui";

/** Write a placed bet down. Nothing is placed for you: this is the record, after you bet at the sportsbook. */
export function BetSheet({ draft, onClose }: { draft: BetDraft; onClose: () => void }) {
  const settings = useSettings();
  const log = useLogBet();
  const { say } = useStore();
  const books = (settings.data ?? DEFAULT_SETTINGS).books;
  const [what, setWhat] = useState(draft.description);
  const [book, setBook] = useState(draft.bookmaker || books[0] || "");
  const [price, setPrice] = useState(priceText(draft.price_decimal));
  const [stake, setStake] = useState(draft.stake && draft.stake >= 1 ? String(draft.stake) : "");

  const d = parsePrice(price);
  const amount = Number(stake);
  const ok = what.trim() !== "" && book !== "" && d != null && amount > 0;
  // the true chance only describes the price it came with: a different book or number is a different bet
  const fair = draft.fair_prob != null && book === draft.bookmaker ? draft.fair_prob : null;
  const edge = fair != null && d != null ? fair * d - 1 : null;
  const choices = [...new Set([draft.bookmaker, ...books].filter(Boolean))];

  function save() {
    if (!ok) return;
    log.mutate({ bet: { ...draft, description: what.trim(), bookmaker: book, price_decimal: Math.round(d! * 1000) / 1000, stake: amount, fair_prob: fair } }, {
      onSuccess: () => { say("Bet recorded"); onClose(); },
      onError: (e) => say(`Couldn't record the bet — ${e.message}`, true),
    });
  }

  return (
    <Sheet title="Record a bet" onClose={onClose}>
      <form className="stack stack--tight" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <p className="small muted">Place the bet at the sportsbook first, then write down what you got. Nothing is placed from here.</p>
        <label className="field"><span>The bet</span>
          <input className="input" type="text" maxLength={200} placeholder="DET −2.5, or Over 47.5 in NE at BUF" value={what} onChange={(e) => setWhat(e.target.value)} />
        </label>
        <label className="field"><span>Sportsbook</span>
          <select className="input" value={book} onChange={(e) => setBook(e.target.value)}>
            {choices.map((b) => <option key={b} value={b}>{bookName(b)}</option>)}
          </select>
        </label>
        <div className="kv">
          <label className="field"><span>Price you got</span>
            <input className="input" type="text" inputMode="text" autoCapitalize="off" placeholder="+135 or −110" aria-invalid={price !== "" && d == null} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="field"><span>Stake, $</span>
            <input className="input" type="text" inputMode="decimal" placeholder="10" value={stake} onChange={(e) => setStake(e.target.value.replace(/[^\d.]/g, ""))} />
          </label>
        </div>
        {price !== "" && d == null && <p className="small bad" role="alert">Write the price the way the book shows it: +135, −110, or 2.35.</p>}
        <p className="small muted num" role="status">
          {d != null && amount > 0 ? `Wins ${usd2(amount * (d - 1))}, returns ${usd2(amount * d)}.` : "Fill in the price and the stake."}
          {edge != null ? ` True chance ${pct(fair, 1)}: this price is ${vsFair(edge)}.` : ""}
        </p>
        <button className="btn btn--cta" type="submit" disabled={!ok || log.isPending}>{log.isPending ? "Saving…" : "Record it"}</button>
      </form>
    </Sheet>
  );
}

/** Dollars and cents: winnings on a $10 bet are rarely whole dollars. */
export const usd2 = (v: number | null | undefined) =>
  v == null ? "–" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "2.3% better than fair" — a price against the true chance, in words. */
export const vsFair = (ev: number) => `${Math.abs(ev * 100).toFixed(1)}% ${ev >= 0 ? "better" : "worse"} than fair`;
