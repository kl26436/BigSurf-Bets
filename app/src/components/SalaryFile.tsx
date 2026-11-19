import { useRef } from "react";
import { useStore } from "../lib/store";
import { useAsk } from "../screens/Week";

/** Add this week's DraftKings salary export. It is weekly work, so it sits where the week starts
 *  (the Week screen and Lineups), not in Settings. */
export function SalaryFile({ again = false }: { again?: boolean }) {
  const ask = useAsk();
  const { say } = useStore();
  const file = useRef<HTMLInputElement>(null);

  async function upload(f: File | undefined) {
    if (!f) return;
    const csv = await f.text();
    if (!csv.startsWith("Position,")) return say("That isn't a DraftKings salary file — export it from a contest's draft page", true);
    ask("import_slate", { csv, name: f.name.replace(/\.csv$/i, "") }, "Salary file sent — expected points follow in a few minutes");
    if (file.current) file.current.value = "";
  }

  return (
    <>
      <input ref={file} className="input" type="file" accept=".csv,text/csv" aria-label="DraftKings salary file" onChange={(e) => upload(e.target.files?.[0])} />
      <p className="small muted">On a contest's draft page on DraftKings choose Export to CSV, then add the file here.{again ? " A fresher export of the same games updates prices and injury tags." : ""}</p>
    </>
  );
}
