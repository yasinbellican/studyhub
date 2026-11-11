// StudyHub service worker: makes the app installable and lets the app shell open
// instantly (and offline). Class data always comes live from the server.
const CACHE = 'ejust-shell-v5';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon-32.png', '/icons/apple-touch-icon.png', '/icons/emblem-64.png', '/logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // never cache API calls, uploads or anything that isn't a plain GET on our own site
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/healthz')) return;

  // Pages and app code: answer from the saved copy straight away (instant start, works offline) and fetch the
  // newest version in the background. If it changed, the open app is told and switches to it on the next page change.
  const key = req.mode === 'navigate' ? '/' : req;
  const sig = (r) => r && (r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length'));
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    const fresh = fetch(req, { cache: 'no-cache' }).then(async (res) => {
      if (res.ok) {
        const changed = hit && sig(hit) !== sig(res) && /\.(js|css)$|^\/$/.test(key === '/' ? '/' : url.pathname);
        await cache.put(key, res.clone());
        if (changed) (await self.clients.matchAll()).forEach((c) => c.postMessage({ type: 'app-updated' }));
      }
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || Response.error();
  })());
});

// ---------- push notifications (arrive even when the app is closed) ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'E-JUST', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'E-JUST', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    tag: d.id ? 'n' + d.id : undefined,
    data: { url: d.url || '#/notifications' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || '#/notifications';
  const target = /^https?:/.test(url) ? url : self.registration.scope + url.replace(/^\//, '');
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (mine && !/^https?:/.test(url)) { await mine.focus(); return mine.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
