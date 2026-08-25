// Service worker registration is paused while we force-clear stale offline
// shells (cached payment banner / old HTML). Re-enable /sw.js register() when ready.

async function unregisterAllAndClearCaches() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(registrations.map((r) => r.unregister()));
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.allSettled(names.map((name) => caches.delete(name)));
}

export function registerOfflineShell() {
  void unregisterAllAndClearCaches();
}
