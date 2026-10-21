// Yerel deneme sunucusu: gerçek Worker kodunu Node'da çalıştırır.
// Google E-Tablo yerine demo depo kullanılır.
//   node --import ./test/register.mjs test/yerel-sunucu.mjs  → http://localhost:8787/rezervasyon/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/index.js";
import { demoDepo, haftalikTablo } from "./yardimci.mjs";

const PORT = 8787;
const depo = demoDepo();
await depo.demoHaftalikAyarla(haftalikTablo({ "PAZARTESİ|20:00": "ABONE - 6", "PAZARTESİ|22:00": "ABONE - 4" }));

const TURLER = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
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

const env = {
  ASSETS,
  DEMO: "1",
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
}).listen(PORT, () => console.log(`Hazır: http://localhost:${PORT}/rezervasyon/`));
