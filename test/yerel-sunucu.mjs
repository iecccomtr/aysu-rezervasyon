// Yerel deneme sunucusu: gerçek Worker kodunu Node'da çalıştırır.
// Claude API yerine senaryolu bir taklit kullanır (API anahtarı gerekmez).
//   node --import ./test/register.mjs test/yerel-sunucu.mjs  → http://localhost:8787/rezervasyon/
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "../src/index.js";
import { demoDepo, haftalikTablo } from "./yardimci.mjs";
import { simdi } from "../src/time.js";

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

// --- Taklit Claude: son mesaja göre basit senaryo ---
function taklitClaude(govde) {
  const son = govde.messages.at(-1);
  const metin = (t) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
  const arac = (name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t" + Date.now(), name, input }] });
  if (Array.isArray(son.content)) {
    const s = JSON.parse(son.content[0].content);
    if (s.bosSaatler) {
      const aksam = s.bosSaatler.filter((x) => x >= "18:00" || x < "06:00");
      return metin(`Bu akşam için boş saatler: **${aksam.join(", ")}**\n20:00 ve 22:00 abonelerimize ait. Hangisini ayıralım?`);
    }
    if (s.basarili) {
      return metin(`Rezervasyonunuz alındı ✅\n\n${s.gun}, saat ${s.saat}\nKayıt no: ${s.kayitNo}\n\nKesinleşmesi için 1200 TL kapora gönderin, kalan 2500 TL sahada ödenir.\nIBAN: TR70 0015 7000 0000 0154 8342 35 (Ahmet Aysu)\nAçıklamaya kayıt numaranızı yazmayı unutmayın.`);
    }
    return metin("Bir sorun oluştu: " + (s.hata || ""));
  }
  const t = son.content.toLocaleLowerCase("tr");
  if (t.includes("akşam") || t.includes("bugün")) return arac("musaitlik_sorgula", { tarih: simdi().tarih });
  if (t.includes("evet")) return arac("rezervasyon_yap", { tarih: simdi().tarih, saat: "21:00", ad_soyad: "Ali Veli", telefon: "05321112233" });
  if (t.includes("21")) return metin("Özet:\n• Bugün, 21:00\n• Ad: Ali Veli • Tel: 0532 111 22 33\n• Ücret: 3700 TL (1200 TL kapora)\n\nOnaylıyor musunuz?");
  return metin("Hangi gün ve saat için bakayım?");
}

const env = {
  ASSETS,
  DEMO: "1",
  ANTHROPIC_API_KEY: "yerel-test",
  ANTHROPIC_BASE_URL: `http://localhost:${PORT}/taklit-claude`,
  REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
};

http.createServer(async (req, res) => {
  const govde = await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
  if (req.url.startsWith("/taklit-claude")) {
    await new Promise((r) => setTimeout(r, 400));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(taklitClaude(JSON.parse(govde))));
  }
  const istek = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : govde,
  });
  const cevap = await worker.fetch(istek, env, { waitUntil: () => {} });
  res.writeHead(cevap.status, Object.fromEntries(cevap.headers));
  res.end(Buffer.from(await cevap.arrayBuffer()));
}).listen(PORT, () => console.log(`Hazır: http://localhost:${PORT}/rezervasyon/`));
