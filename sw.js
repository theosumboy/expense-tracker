/* Offline shell. The app's data lives in localStorage, not here —
   this only makes sure the app itself opens with no internet. */
var CACHE = 'paisa-v2';
var KEEP = [CACHE, 'paisa-share'];
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
          return KEEP.indexOf(k) > -1 ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Android share sheet: the OS POSTs the shared image here. Stash it, then
   send the app to ?shared=1 so it can pick the image up and scan it. */
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname.indexOf('share-target') > -1) {
    e.respondWith((function () {
      return e.request.formData()
        .then(function (fd) {
          var file = fd.get('image');
          if (!file) return;
          return caches.open('paisa-share').then(function (c) {
            return c.put('shared-image', new Response(file, {
              headers: { 'Content-Type': file.type || 'image/jpeg' }
            }));
          });
        })
        .catch(function () {})
        .then(function () { return Response.redirect('./?shared=1', 303); });
    })());
    return;
  }

  var url = u;

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
