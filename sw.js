const CACHE = "preventivatore-offline-v1";
const SHELL = ["/index.html", "/modifica_listini.html", "/sw.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        const path = url.pathname;
        if (path === "/" || path.endsWith(".html") || path === "/sw.js") cache.put(event.request, response.clone());
      }
      return response;
    } catch (e) {
      return (await cache.match(event.request)) || (await cache.match("/index.html")) || Response.error();
    }
  })());
});
