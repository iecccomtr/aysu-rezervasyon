// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { simdi, isletmeGunu, gunEkle } from "./time.js";
import { KURALLAR, FIYATLAR, IBAN, ISLETME } from "./config.js";
import { bildir } from "./bildirim.js";
export { RezervasyonDeposu } from "./store.js";

const json = (veri, durum = 200, onbellekSn = 0) => new Response(JSON.stringify(veri), {
  status: durum,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": onbellekSn ? `public, max-age=${onbellekSn}` : "no-store",
  },
});

function depo(env) {
  // Tek bir depo örneği: tüm rezervasyon işlemleri sırayla yürür, çift kayıt olmaz.
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

/** Kötüye kullanıma karşı IP başına sınır (wrangler.jsonc → ratelimits). */
async function sinirAsildi(env, request, tur) {
  if (!env.SINIR) return false;
  const ip = request.headers.get("cf-connecting-ip") || "yerel";
  const { success } = await env.SINIR.limit({ key: `${tur}:${ip}` });
  return !success;
}

async function govdeOku(request) {
  try {
    const g = await request.json();
    return g && typeof g === "object" ? g : null;
  } catch {
    return null;
  }
}

/** Kısa süreli önbellek: Google E-Tablo okuma kotasını korur. */
async function onbellekli(request, ctx, sn, uret) {
  const onbellek = typeof caches !== "undefined" ? caches.default : null;
  const anahtar = new Request(new URL(request.url).origin + new URL(request.url).pathname);
  const kayitli = onbellek && (await onbellek.match(anahtar));
  if (kayitli) return kayitli;
  const cevap = await uret();
  if (onbellek && cevap.ok) ctx.waitUntil(onbellek.put(anahtar, cevap.clone()));
  return cevap;
}

function onbellegiTemizle(request, ctx) {
  if (typeof caches === "undefined") return;
  const koken = new URL(request.url).origin;
  ctx.waitUntil(Promise.all(["/api/musaitlik", "/api/bos-saatler"]
    .map((p) => caches.default.delete(new Request(koken + p)))));
}

/**
 * Rezervasyon sayfasının göstereceği günler: bugünden itibaren KURALLAR.enFazlaGunSonra gün.
 * Gece yarısından sonra önceki günün gece maçları hâlâ açıksa o gün de listede kalır.
 */
async function gunleriGetir(env) {
  const n = simdi();
  const ilk = isletmeGunu(n.tarih, n.saat);
  const tarihler = [];
  for (let t = ilk; t <= gunEkle(n.tarih, KURALLAR.enFazlaGunSonra); t = gunEkle(t, 1)) tarihler.push(t);
  const sonuc = await depo(env).musaitlikCoklu(tarihler);
  return sonuc
    .filter((g) => !g.hata && g.detay.length > 0)
    .map((g) => ({ tarih: g.tarih, gun: g.gun, saatler: g.detay.map((s) => ({ saat: s.saat, bos: s.bos })) }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const yol = url.pathname;

    if (yol === "/api/saglik") {
      return json({ tamam: true, depo: env.SHEET_ID ? "google-sheets" : "demo" });
    }

    // Rezervasyon sayfası: önümüzdeki günlerin tüm saatleri (boş/dolu). Kişisel veri içermez.
    if (yol === "/api/musaitlik" && request.method === "GET") {
      return onbellekli(request, ctx, 15, async () => {
        try {
          return json({
            gunler: await gunleriGetir(env),
            fiyat: FIYATLAR.gunduz, kapora: FIYATLAR.kapora,
          }, 200, 15);
        } catch (e) {
          console.error(e);
          return json({ hata: "Boş saatler şu an okunamıyor." }, 503);
        }
      });
    }

    // Ana sayfa tabelası: bugün ve yarın.
    if (yol === "/api/bos-saatler" && request.method === "GET") {
      return onbellekli(request, ctx, 60, async () => {
        try {
          const gunler = await gunleriGetir(env);
          return json({ bugun: gunler[0] || null, yarin: gunler[1] || null }, 200, 60);
        } catch (e) {
          console.error(e);
          return json({ hata: "Boş saatler şu an okunamıyor." }, 503);
        }
      });
    }

    if (yol === "/api/rezervasyon" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "rez")) {
        return json({ hata: "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin." }, 429);
      }
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      // Bot tuzağı: insanların görmediği alan doluysa sessizce reddet.
      if (g.web) return json({ hata: "İstek reddedildi." }, 400);
      if (g.kvkk !== true) return json({ hata: "Devam etmek için aydınlatma metnini onaylayın." }, 400);

      try {
        const r = await depo(env).olustur({
          gunTarihi: g.tarih, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not || "",
        });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        ctx.waitUntil(bildir(env, {
          konu: `Yeni rezervasyon: ${r.gun} ${r.saat} (${r.kayitNo})`,
          satirlar: [
            ["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`],
            ["Ad soyad", String(g.ad).trim()],
            ["Telefon", String(g.telefon).trim()],
            ["Not", String(g.not || "").trim() || "-"],
            ["Kayıt no", r.kayitNo],
            ["Durum", `${r.durum} (${FIYATLAR.kapora} TL)`],
          ],
        }));
        return json({
          ...r,
          kapora: FIYATLAR.kapora,
          kalan: r.ucret - FIYATLAR.kapora,
          iban: IBAN.no || null,
          alici: IBAN.alici || null,
        });
      } catch (e) {
        console.error(e);
        return json({ hata: `Rezervasyon şu an kaydedilemedi. Lütfen ${ISLETME.telefon} numarasını arayın.` }, 502);
      }
    }

    if (yol === "/api/iptal" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) {
        return json({ hata: "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin." }, 429);
      }
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      try {
        const r = await depo(env).iptal({ kayitNo: g.kayitNo, telefon: g.telefon });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        ctx.waitUntil(bildir(env, {
          konu: `İptal: ${r.tarih} ${r.saat} (${r.kayitNo})`,
          satirlar: [["Maç", `${r.tarih} saat ${r.saat}`], ["Kayıt no", r.kayitNo], ["Telefon", String(g.telefon).trim()]],
        }));
        return json(r);
      } catch (e) {
        console.error(e);
        return json({ hata: `İptal şu an yapılamadı. Lütfen ${ISLETME.telefon} numarasını arayın.` }, 502);
      }
    }

    // Sadece demo/yerel test: haftalık tabloyu taklit etmek için.
    if (yol === "/api/demo/haftalik" && request.method === "POST" && env.DEMO === "1" && !env.SHEET_ID) {
      return json(await depo(env).demoHaftalikAyarla(await request.json()));
    }

    if (yol.startsWith("/api/")) return json({ hata: "Bulunamadı" }, 404);
    return env.ASSETS.fetch(request);
  },
};
