// Aysu Halı Saha — telefon uygulaması (PWA) için hizmet çalışanı.
// Her şey her zaman internetten gelir (rezervasyonlar hep güncel olsun); internet yoksa
// sayfa açılışlarında "bağlantı yok" ekranı gösterilir. /api/ istekleri hiç önbelleğe alınmaz.
const ONBELLEK = "aysu-v1";
const DOSYALAR = ["/cevrimdisi.html", "/img/aysu-logo.svg", "/img/ikon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(ONBELLEK).then((c) => c.addAll(DOSYALAR)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((anahtarlar) => Promise.all(anahtarlar.filter((k) => k !== ONBELLEK).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // sayfa dışındaki istekler olduğu gibi internete
  e.respondWith(fetch(e.request).catch(() => caches.match("/cevrimdisi.html")));
});
