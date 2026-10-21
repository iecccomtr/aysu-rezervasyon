// Yerel deneme sunucusu: gerçek Worker kodunu Node'da çalıştırır.
// Google E-Tablo yerine demo depo kullanılır.
//   node --import ./test/register.mjs test/yerel-sunucu.mjs  → http://localhost:8787/rezervasyon/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/index.js";
import { demoDepo } from "./yardimci.mjs";

const PORT = 8787;
const KOD = "yerel-kurulum";
const depo = demoDepo({ PANEL_KURULUM_KODU: KOD });
// Örnek veriler
await depo.aboneKaydet({ ad: "Tolga Atalay", telefon: "05451230123", gun: 3, saat: "20:00", baslangic: "2026-01-01", ucret: "Eski abone" });
await depo.aboneKaydet({ ad: "Cihan Acar", telefon: "05058044791", gun: 0, saat: "22:00", baslangic: "2026-01-01" });
await depo.aboneKaydet({ ad: "Futbol Koleji", telefon: "05537048026", gun: 5, saat: "08:00", baslangic: "2026-01-01" });
for (let i = 0; i < 3; i++) {
  const g = new Date(Date.now() + 3 * 3600e3 + (i + 1) * 86400e3).toISOString().slice(0, 10);
  await depo.olustur({ gunTarihi: g, saat: ["21:00", "19:00", "23:00"][i], ad: ["Eren Yıldız", "Abdurrahman K.", "Yusuf Demir"][i], telefon: ["05321112233", "05334445566", "05357778899"][i] });
}

const TURLER = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const ASSETS = {
  async fetch(req) {
    let p = new URL(req.url).pathname;
    if (p.endsWith("/")) p += "index.html";
    try {
      const veri = await readFile(join("public", normalize(p)));
      return new Response(veri, { headers: { "content-type": TURLER[extname(p)] || "application/octet-stream" } });
    } catch {
      return new Response("Bulunamadı", { status: 404 });
    }
  },
};

// Yerel denemede e-postalar gönderilmez, konsola yazılır (onay / şifre bağlantılarını görmek için).
const gercekFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) {
    const e = JSON.parse(init.body);
    console.log(`\n[E-POSTA] ${e.to.join(", ")} — ${e.subject}\n${e.text}\n`);
    return new Response("{}");
  }
  return gercekFetch(url, init);
};

const env = {
  RESEND_API_KEY: "yerel",
  ASSETS,
  PANEL_KURULUM_KODU: KOD,
  REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
};

http.createServer(async (req, res) => {
  const govde = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
  const istek = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : govde,
  });
  const cevap = await worker.fetch(istek, env, { waitUntil: () => {} });
  res.writeHead(cevap.status, Object.fromEntries(cevap.headers));
  res.end(Buffer.from(await cevap.arrayBuffer()));
}).listen(PORT, () => console.log(`Hazır: http://localhost:${PORT}/  (panel kurulum kodu: ${KOD})`));
