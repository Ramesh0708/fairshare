// sw.js - Service Worker for FairShare offline caching
const CACHE_NAME = "fairshare-v8";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./fairshare.css",
  "./fairshare_logo.jpg",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch((err) => {
        console.warn("Offline caching note:", url, err);
      })));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).catch(() => {
        return caches.match("./index.html");
      });
    })
  );
});