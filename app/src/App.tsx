import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Mark } from "./components/Mark";
import { Icon, Loading } from "./components/ui";
import { DEMO, supabase, useClaim, useSession, useWhoAmI } from "./lib/api";
import { useStore } from "./lib/store";
import { Bets } from "./screens/Bets";
import { Builder } from "./screens/Builder";
import { Lineups, SetDetail } from "./screens/Lineups";
import { League, More, Results, SettingsScreen } from "./screens/More";
import { Players } from "./screens/Players";
import { SignIn } from "./screens/SignIn";
import { Week } from "./screens/Week";

function Brand() {
  return (
    <>
      <Mark className="header__mark" />
      <span className="wordmark">Big Surf <em>Bets</em></span>
    </>
  );
}

const TABS = [
  { to: "/", label: "Week", icon: "week" },
  { to: "/players", label: "Players", icon: "players" },
  { to: "/lineups", label: "Lineups", icon: "lineups" },
  { to: "/bets", label: "Bets", icon: "bets" },
  { to: "/more", label: "More", icon: "more" },
];

function Shell() {
  const { toast } = useStore();
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><Brand /></div>
        <nav className="nav" aria-label="Main">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.to === "/"}>
              <Icon name={t.icon} />
              {t.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="column">
        <header className="header"><Brand /><span className="header__spacer" /></header>
        {DEMO && <div className="banner" role="status">Sample data — connect the database to see real numbers</div>}
        <main className="main">
          <Routes>
            <Route path="/" element={<Week />} />
            <Route path="/players" element={<Players />} />
            <Route path="/lineups" element={<Lineups />} />
            <Route path="/lineups/build" element={<Builder />} />
            <Route path="/lineups/:id" element={<SetDetail />} />
            <Route path="/bets" element={<Bets />} />
            <Route path="/more" element={<More />} />
            <Route path="/more/results" element={<Results />} />
            <Route path="/more/league" element={<League />} />
            <Route path="/more/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      {toast && <div className={`toast${toast.error ? " toast--error" : ""}`} role="status" aria-live="polite">{toast.text}</div>}
    </div>
  );
}

/** Signed in but not on the list: the first account claims the app, later ones are turned away. */
function Door({ claimOpen }: { claimOpen: boolean }) {
  const claim = useClaim();
  return (
    <main className="main signin stack">
      <img className="signin__lockup" src="/icons/lockup-stacked.png" alt="Big Surf Bets" width="1200" height="1200" />
      {claimOpen ? (
        <>
          <h1 className="title">Make this yours</h1>
          <p>Nobody owns this app yet. The first account to claim it becomes the owner, and after that it's closed to everyone else.</p>
          <button className="btn btn--cta" disabled={claim.isPending} onClick={() => claim.mutate()}>
            {claim.isPending ? "Claiming…" : "Claim this app"}
          </button>
          {claim.isError && <p className="bad small">Couldn't claim it — try again</p>}
        </>
      ) : (
        <>
          <h1 className="title">Not on the list</h1>
          <p>This account can't see anything here. Ask the owner to add you.</p>
        </>
      )}
      <button className="btn" onClick={() => supabase?.auth.signOut()}>Sign out</button>
    </main>
  );
}

export function App() {
  const { session, ready } = useSession();
  const who = useWhoAmI(DEMO || !!session);
  if (!ready) return <Loading />;
  if (!DEMO && !session) return <SignIn />;
  if (who.isLoading) return <Loading />;
  if (!who.data?.member) return <Door claimOpen={!!who.data?.claim_open} />;
  return <Shell />;
}
