// Service worker: appen åpner raskt, fungerer med dårlig nett, og viser varsler om nye beskjeder.
const CACHE = 'familie-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'data.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const same = url.origin === location.origin, cdn = url.host === 'cdn.jsdelivr.net';
  if (!same && !cdn) return; // Supabase går rett på nett
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (cdn) { const hit = await cache.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok) cache.put(e.request, r.clone()); return r; }
    try { const r = await fetch(e.request, { cache: 'no-cache' }); if (r.ok) cache.put(e.request, r.clone()); return r; }
    catch { return (await cache.match(e.request)) || (await cache.match('index.html')); }
  })());
});

// Varsel fra serveren (funksjonen familie-varsel i Supabase).
// iPhone krever at det alltid vises et varsel, ellers slår den av varslene for appen.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Ny beskjed', {
    body: d.body || 'Åpne appen for å lese beskjeden.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || self.registration.scope + '?tab=msg' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); win.postMessage({ type: 'open-msg' }); return; }
    await self.clients.openWindow(url);
  })());
});
