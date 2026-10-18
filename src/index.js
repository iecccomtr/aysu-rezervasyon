// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { cevapla, gecmisiTemizle } from "./agent.js";
export { RezervasyonDeposu } from "./store.js";

const json = (veri, durum = 200) => new Response(JSON.stringify(veri), {
  status: durum,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function depo(env) {
  // Tek bir depo örneği: tüm rezervasyon işlemleri sırayla yürür.
  return env.REZERVASYON_DEPOSU.get(env.REZERVASYON_DEPOSU.idFromName("aysu"));
}

function ayniKaynak(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/saglik") {
      return json({ tamam: true, depo: env.SHEET_ID ? "google-sheets" : "demo" });
    }

    if (url.pathname === "/api/sohbet" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek" }, 403);
      if (!env.ANTHROPIC_API_KEY) return json({ hata: "ANTHROPIC_API_KEY tanımlı değil" }, 500);

      // Kötüye kullanıma karşı IP başına sınır (wrangler.jsonc → ratelimits).
      if (env.SINIR) {
        const ip = request.headers.get("cf-connecting-ip") || "yerel";
        const { success } = await env.SINIR.limit({ key: ip });
        if (!success) return json({ cevap: "Çok hızlı mesaj gönderdiniz, lütfen biraz bekleyin." }, 429);
      }

      let govde;
      try {
        govde = await request.json();
      } catch {
        return json({ hata: "Geçersiz istek" }, 400);
      }
      const gecmis = gecmisiTemizle(govde.mesajlar);
      if (!gecmis) return json({ hata: "Mesaj bulunamadı" }, 400);

      try {
        const cevap = await cevapla(env, depo(env), gecmis, ctx);
        return json({ cevap });
      } catch (e) {
        console.error(e);
        return json({ cevap: "Şu an bir sorun yaşıyoruz. Lütfen 0 555 510 26 26 numarasını arayın." }, 502);
      }
    }

    // Sadece demo/yerel test: haftalık tabloyu taklit etmek için.
    if (url.pathname === "/api/demo/haftalik" && request.method === "POST" && env.DEMO === "1" && !env.SHEET_ID) {
      return json(await depo(env).demoHaftalikAyarla(await request.json()));
    }

    if (url.pathname.startsWith("/api/")) return json({ hata: "Bulunamadı" }, 404);
    return env.ASSETS.fetch(request);
  },
};
