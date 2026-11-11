import { describe, expect, it } from "vitest";
import { deviceId, deviceLabel, keyBytes, pushSupport } from "./push";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const able = { PushManager: {}, Notification: {} };

describe("can this device show pop-ups", () => {
  it("an iPhone only from the home-screen app", () => {
    expect(pushSupport({ navigator: { userAgent: IPHONE } })).toBe("install");                                  // a Safari tab has no push at all
    expect(pushSupport({ navigator: { userAgent: IPHONE, serviceWorker: {} }, ...able })).toBe("install");      // even where the pieces exist
    expect(pushSupport({ navigator: { userAgent: IPHONE, standalone: true, serviceWorker: {} }, ...able })).toBe("ok");
    expect(pushSupport({ navigator: { userAgent: IPHONE, standalone: true, serviceWorker: {} } })).toBe("unsupported");   // iOS older than 16.4
  });
  it("an iPad that calls itself a Mac is still an iPad", () => {
    expect(pushSupport({ navigator: { userAgent: MAC, maxTouchPoints: 5 } })).toBe("install");
    expect(deviceLabel(MAC, 5)).toBe("iPad");
  });
  it("a laptop browser with the pieces, or without", () => {
    expect(pushSupport({ navigator: { userAgent: MAC, maxTouchPoints: 0, serviceWorker: {} }, ...able })).toBe("ok");
    expect(pushSupport({ navigator: { userAgent: MAC, maxTouchPoints: 0 } })).toBe("unsupported");
    expect(pushSupport({ navigator: { userAgent: MAC, serviceWorker: {} }, ...able, matchMedia: () => ({ matches: true }) })).toBe("ok");
  });
  it("names the device for the list in Settings", () => {
    expect(deviceLabel(IPHONE, 5)).toBe("iPhone");
    expect(deviceLabel(MAC, 0)).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe("Windows PC");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36", 5)).toBe("Android phone");
    expect(deviceLabel("something else", 0)).toBe("This device");
  });
});

describe("keys and ids", () => {
  it("turns the signing key into the 65 bytes a browser expects", () => {
    const key = keyBytes("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U");
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);                      // an uncompressed point
  });
  it("matches the id the database gives a device", async () => {
    // select encode(sha256(convert_to('https://push.example.com/send/abc123', 'UTF8')), 'hex')
    // the same address and id as tests/test_db_access.py checks against public.app_push_devices
    expect(await deviceId("https://push.example.com/send/abc123")).toBe("e6f1e563ad6145546e8846b0788d243bf8bb43d19dcd717437303d8370963c17");
  });
});
