import { useState, type FormEvent } from "react";
import { supabase } from "../lib/api";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  async function run(kind: "in" | "up" | "link", e?: FormEvent) {
    e?.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setNote(null);
    const redirect = { emailRedirectTo: window.location.origin };
    const res = kind === "in" ? await supabase.auth.signInWithPassword({ email, password })
      : kind === "up" ? await supabase.auth.signUp({ email, password, options: redirect })
      : await supabase.auth.signInWithOtp({ email, options: redirect });
    setBusy(false);
    if (res.error) setNote({ text: res.error.message, bad: true });
    else if (kind === "up" && !res.data.session) setNote({ text: "Account created. Open the confirmation email, then sign in here." });
    else if (kind === "link") setNote({ text: "Link sent — open it on this device." });
  }

  return (
    <main className="main signin">
      <img className="signin__mark" src="/icons/mark.svg" alt="" />
      <h1 className="title">Sign in</h1>
      <form className="stack stack--tight" onSubmit={(e) => run("in", e)}>
        <label className="field"><span>Email</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>Password</span>
          <input className="input" type="password" autoComplete="current-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn--cta" disabled={busy || !email || password.length < 8}>{busy ? "Signing in…" : "Sign in"}</button>
        <button type="button" className="btn" disabled={busy || !email || password.length < 8} onClick={() => run("up")}>Create account</button>
        <button type="button" className="btn btn--quiet" disabled={busy || !email} onClick={() => run("link")}>Email me a sign-in link instead</button>
        {note && <p className={note.bad ? "bad small" : "small"} role="status">{note.text}</p>}
      </form>
    </main>
  );
}
