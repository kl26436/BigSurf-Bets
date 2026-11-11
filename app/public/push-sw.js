// Pop-ups. Loaded into the service worker next to the caching code (vite.config.ts → importScripts).
// The pipeline sends {title, body, url, tag}; every push must show something, or iOS withdraws the permission.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Big Surf Bets", {
    body: d.body || "", icon: "/icons/web-192.png", badge: "/icons/web-192.png", tag: d.tag || undefined, data: { url: d.url || "/" },
  }));
});

// Tapping it opens the app on the screen the alert is about.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) {
      if ("focus" in c) {
        await c.focus();
        if ("navigate" in c) { try { await c.navigate(url); } catch { /* the page stays where it was */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
