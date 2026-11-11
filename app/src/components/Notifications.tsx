import { useEffect, useMemo, useState } from "react";
import { DEMO, useDeletePush, usePushDevices, usePushKey, useSavePush, useSentNotes } from "../lib/api";
import { ago } from "../lib/format";
import { currentSubscription, deviceId, deviceLabel, disablePush, enablePush, pushSupport } from "../lib/push";
import { useStore } from "../lib/store";
import type { Settings } from "../lib/types";
import { useAsk } from "../screens/Week";
import { Facts } from "./ui";

const WHY: Record<string, string> = {
  blocked: "Pop-ups are blocked for this app. Allow notifications for it in the device's settings, then come back.",
  dismissed: "No permission given, so pop-ups stay off.",
  "not-ready": "The app isn't fully installed on this device yet. Close it, open it again, and try once more.",
};
const SENT: Record<string, string> = { sent: "sent", failed: "failed", skipped: "not sent" };

/** Pop-ups on this device and e-mail: what to send, where, and whether it arrived. */
export function NotificationSettings({ draft, save }: { draft: Settings; save: (patch: Partial<Settings>, done: string) => void }) {
  const key = usePushKey();
  const devices = usePushDevices();
  const notes = useSentNotes();
  const savePush = useSavePush();
  const dropPush = useDeletePush();
  const ask = useAsk();
  const { say } = useStore();
  const [here, setHere] = useState<string | null>(null);        // this device's id, when it is signed up
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState(draft.notify_email);
  const support = useMemo(() => (DEMO ? "ok" : pushSupport()), []);
  const blocked = !DEMO && support === "ok" && Notification.permission === "denied";
  useEffect(() => setAddress(draft.notify_email), [draft.notify_email]);
  useEffect(() => {
    if (DEMO || support !== "ok") return;
    let stale = false;
    currentSubscription().then(async (s) => { const id = s ? await deviceId(s.endpoint) : null; if (!stale) setHere(id); }).catch(() => undefined);
    return () => { stale = true; };
  }, [support, devices.data]);

  const list = devices.data ?? [];
  const on = here != null && list.some((d) => d.id === here);
  const others = list.filter((d) => d.id !== here);
  const lastMail = (notes.data ?? []).find((n) => n.channel === "email");

  async function turnOn() {
    if (!DEMO && !key.data) return say("Pop-ups aren't ready yet. Try again in a minute.", true);
    setBusy(true);
    try {
      const sub = DEMO ? { endpoint: "", keys: { p256dh: "", auth: "" }, device: deviceLabel() } : await enablePush(key.data!);
      await savePush.mutateAsync({ sub });
      setHere(DEMO ? "sample" : await deviceId(sub.endpoint));
      say("Pop-ups are on for this device");
    } catch (e) {
      say(WHY[(e as Error).message] ?? `Couldn't turn pop-ups on — ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  }
  async function turnOff() {
    setBusy(true);
    try {
      const endpoint = DEMO ? null : await disablePush();
      await dropPush.mutateAsync(endpoint ? { endpoint } : { id: here ?? undefined });
      setHere(null);
      say("Pop-ups are off for this device");
    } catch (e) {
      say(`Couldn't turn pop-ups off — ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  }
  const saveAddress = () => {
    const next = address.trim();
    if (next === draft.notify_email) return;
    if (next !== "" && !/^\S+@\S+\.\S+$/.test(next)) return say("That doesn't look like an e-mail address", true);
    save({ notify_email: next }, next ? "E-mail address saved" : "E-mail goes to the address you sign in with");
  };

  return (
    <section className="card card--pad stack stack--tight" aria-label="Notifications">
      <h2 className="h2">Notifications</h2>
      <p className="small">Be told when a player in a lineup you entered is ruled out or picks up an injury tag, while there's still time to swap. Everything else that changes is listed on the Week screen.</p>

      <div className="stack stack--tight" role="group" aria-label="Pop-up on this device">
        <div className="spread spread--wrap"><p className="strong">Pop-up on this device</p>{on && <span className="pill pill--ok">On</span>}</div>
        {support === "install" && <p className="small warn" role="status">On an iPhone, pop-ups come from the home-screen app. Open Big Surf Bets from your Home Screen and turn this on there.</p>}
        {support === "unsupported" && <p className="small muted" role="status">This browser can't show pop-ups. On an iPhone it needs iOS 16.4 or later.</p>}
        {blocked && <p className="small warn" role="status">{WHY.blocked}</p>}
        {support === "ok" && !blocked && (on
          ? <div className="inline"><button className="btn btn--sm" disabled={busy} onClick={turnOff}>Turn off on this device</button></div>
          : <div className="inline"><button className="btn btn--primary" disabled={busy} onClick={turnOn}>{busy ? "Turning on…" : "Turn on pop-ups"}</button></div>)}
        {others.map((d) => (
          <div className="rowline" key={d.id}>
            <div className="grow"><p className="strong">{d.device ?? "A device"}</p>
              <Facts items={[`on since ${ago(d.created_at)}`, d.last_ok_at ? `last pop-up ${ago(d.last_ok_at)}` : "no pop-up sent yet", d.failures > 0 ? "the last one didn't arrive" : null]} /></div>
            <button className="btn btn--sm btn--quiet" disabled={dropPush.isPending} onClick={() => dropPush.mutate({ id: d.id }, { onSuccess: () => say("Device removed") })}>Remove</button>
          </div>
        ))}
      </div>

      <div className="stack stack--tight" role="group" aria-label="E-mail">
        <label className="check"><input type="checkbox" checked={draft.notify_email_on}
          onChange={(e) => save({ notify_email_on: e.target.checked }, e.target.checked ? "E-mail alerts are on" : "E-mail alerts are off")} />E-mail me too</label>
        {draft.notify_email_on && (
          <label className="field"><span>Send to</span>
            <input className="input" type="email" inputMode="email" autoCapitalize="off" placeholder="The address you sign in with" value={address}
              onChange={(e) => setAddress(e.target.value)} onBlur={saveAddress} />
          </label>
        )}
        {draft.notify_email_on && lastMail && lastMail.status !== "sent" && (
          <p className="small warn" role="status">The last e-mail was {SENT[lastMail.status]}: {lastMail.error ?? "no reason given"}.</p>
        )}
        {draft.notify_email_on && !lastMail && <p className="small muted">E-mail needs a sending account added once on GitHub (docs/notifications.md). Send a test to see whether it is connected.</p>}
      </div>

      <div className="inline">
        <button className="btn btn--sm" disabled={!on && !draft.notify_email_on} onClick={() => ask("notify_test", {}, "Test on its way — it arrives within a couple of minutes")}>Send a test</button>
      </div>
      {(notes.data ?? []).length > 0 && (
        <div role="group" aria-label="Recently sent">
          <p className="eyebrow">Recently sent</p>
          {notes.data!.slice(0, 5).map((n) => (
            <div className="rowline" key={n.id}>
              <div className="grow"><p className="small strong">{n.title}</p>
                <Facts items={[n.channel === "push" ? `pop-up to ${n.target}` : `e-mail to ${n.target}`, SENT[n.status], ago(n.at)]} className={`small ${n.status === "sent" ? "muted" : "warn"}`} /></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
