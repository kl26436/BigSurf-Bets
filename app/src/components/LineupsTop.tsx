import { GamesPicker } from "./GamesPicker";
import { ViewLinks } from "./ui";

/** The top of every Lineups view: the same title, the three views, and which games they are about. */
export function LineupsTop({ eyebrow }: { eyebrow: string }) {
  return (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="title">Lineups</h1>
      <ViewLinks label="Lineups views" links={[["/lineups", "Sets"], ["/lineups/players", "Players"], ["/lineups/entries", "Entries"]]} />
      <GamesPicker />
    </>
  );
}
