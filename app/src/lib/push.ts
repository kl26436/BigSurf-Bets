// Pop-ups on this device (Web Push). The pipeline sends them; this file signs the device up.
//
// iPhone: pop-ups exist only for the app opened from the Home Screen (iOS 16.4+), never
// in a Safari tab, and the permission prompt must come straight from a tap.

export type PushSupport = "ok" | "install" | "unsupported";

interface Env {
  navigator: { userAgent: string; maxTouchPoints?: number; standalone?: boolean; serviceWorker?: unknown };
  matchMedia?: (q: string) => { matches: boolean };
  PushManager?: unknown;
  Notification?: unknown;
}

export const isIOS = (env: Env) => /iPhone|iPad|iPod/.test(env.navigator.userAgent) || (/Macintosh/.test(env.navigator.userAgent) && (env.navigator.maxTouchPoints ?? 0) > 1);
export const isInstalled = (env: Env) => env.navigator.standalone === true || !!env.matchMedia?.("(display-mode: standalone)").matches;

/** Can this device show pop-ups from here? "install": yes, but only from the home-screen app. */
export function pushSupport(env: Env = window as unknown as Env): PushSupport {
  const able = "serviceWorker" in env.navigator && !!env.PushManager && !!env.Notification;
  if (isIOS(env) && !isInstalled(env)) return "install";
  return able ? "ok" : "unsupported";
}

export function deviceLabel(ua: string = navigator.userAgent, touch = navigator.maxTouchPoints ?? 0): string {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

/** The signing key as the browser wants it. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The id the database lists a device under: the SHA-256 of its push address. */
export async function deviceId(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  // `ready` never settles where no service worker is registered (a development build)
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
}

/** This device's sign-up, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export interface NewSubscription { endpoint: string; keys: { p256dh: string; auth: string }; device: string }

/** Ask for permission and sign this device up. Call it directly from a tap. */
export async function enablePush(publicKey: string): Promise<NewSubscription> {
  const permission = await Notification.requestPermission();        // first: iOS only shows the prompt inside the tap
  if (permission !== "granted") throw new Error(permission === "denied" ? "blocked" : "dismissed");
  const reg = await registration();
  if (!reg) throw new Error("not-ready");
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("not-ready");
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, device: deviceLabel() };
}

/** Stop pop-ups on this device → the address to forget, if there was one. */
export async function disablePush(): Promise<string | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  await sub.unsubscribe();
  return sub.endpoint;
}
