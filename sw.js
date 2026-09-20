/* Offline shell. The app's data lives in localStorage, not here —
   this only makes sure the app itself opens with no internet. */
var CACHE = 'paisa-v1';
var SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest',
             'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Never cache the Apps Script API — always go to the network.
  if (url.hostname.indexOf('google.com') > -1) return;
  if (e.request.method !== 'GET') return;

  // Shell files: network first (so updates land), cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then(function (r) {
        if (r && r.status === 200 && url.origin === location.origin) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return r;
      })
      .catch(function () {
        return caches.match(e.request).then(function (m) {
          return m || caches.match('index.html');
        });
      })
  );
});
