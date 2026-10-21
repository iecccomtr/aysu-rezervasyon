// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { simdi, isletmeGunu, gunEkle } from "./time.js";
import { KURALLAR, FIYATLAR, IBAN, ISLETME } from "./config.js";
import { bildir } from "./bildirim.js";
export { RezervasyonDeposu } from "./store.js";

const OTURUM_CEREZ = "aysu_panel";

// Tesis fotoğrafları: public/galeri/ içinde yoksa eski siteden BİR KEZ indirilip veritabanında saklanır.
// (Alan adı Cloudflare'e geçmeden önce her fotoğrafın en az bir kez açılmış olması gerekir.)
const ESKI = "https://www.aysuhalisaha.com/app/dn_content/";
const FOTOLAR = {
  "saha-genis.jpg": ESKI + "5d873a9f2a848.jpg",
  "saha.jpg": ESKI + "5d873c9ebd44f.jpg",
  "soyunma.jpg": ESKI + "5d873bd02d43a.jpg",
  "dus.jpg": ESKI + "5d873b63a6a22.jpg",
  "kafeterya.jpg": ESKI + "5d873aefaf71a.jpg",
  "korner.jpg": ESKI + "5d873a2fcd7d4.jpg",
  "giris.jpg": ESKI + "5d8739b039a02.jpg",
  "dis.jpg": ESKI + "5d87395a455d7.jpg",
};

// Eski sitenin adresleri → yeni sayfalar (Google'daki eski linkler boşa düşmesin)
const ESKI_ADRESLER = {
  "/index.php": "/", "/hakkimizda.php": "/#konum", "/iletisim.php": "/#konum",
  "/foto-galeri.php": "/#tesis", "/galeri.php": "/#tesis", "/randevu.php": "/rezervasyon/",
  "/hizmetler.php": "/", "/blog.php": "/",
};

const json = (veri, durum = 200, ek = {}) => new Response(JSON.stringify(veri), {
  status: durum,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...ek },
});

function depo(env) {
  // Tek bir depo örneği: tüm işlemler sırayla yürür, çift kayıt olmaz.
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

const cokFazla = () => json({ hata: "Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin." }, 429);

function onbellegiTemizle(request, ctx) {
  if (typeof caches === "undefined") return;
  const koken = new URL(request.url).origin;
  ctx.waitUntil(Promise.all(["/api/musaitlik", "/api/bos-saatler"]
    .map((p) => caches.default.delete(new Request(koken + p)))));
}

/** Kısa süreli önbellek (yoğun anlarda depoyu korur). Rezervasyon sonrası temizlenir. */
async function onbellekli(request, ctx, sn, uret) {
  const onbellek = typeof caches !== "undefined" ? caches.default : null;
  const u = new URL(request.url);
  const anahtar = new Request(u.origin + u.pathname);
  const kayitli = onbellek && (await onbellek.match(anahtar));
  if (kayitli) return kayitli;
  const cevap = await uret();
  if (onbellek && cevap.ok) {
    const c = new Response(cevap.clone().body, cevap);
    c.headers.set("cache-control", `public, max-age=${sn}`);
    ctx.waitUntil(onbellek.put(anahtar, c));
  }
  return cevap;
}

/** Sitenin göstereceği günler: bugünden itibaren KURALLAR.enFazlaGunSonra gün. */
async function gunleriGetir(env) {
  const n = simdi();
  const ilk = isletmeGunu(n.tarih, n.saat);
  const tarihler = [];
  for (let t = ilk; t <= gunEkle(n.tarih, KURALLAR.enFazlaGunSonra); t = gunEkle(t, 1)) tarihler.push(t);
  return (await depo(env).musaitlikCoklu(tarihler))
    .filter((g) => !g.hata && g.detay.length > 0)
    .map((g) => ({ tarih: g.tarih, gun: g.gun, saatler: g.detay.map((s) => ({ saat: s.saat, bos: s.bos })) }));
}

function cerez(request, ad) {
  const c = request.headers.get("cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${ad}=([^;]+)`));
  return m ? m[1] : null;
}

function oturumCerezi(token, bitis) {
  const sn = Math.max(0, Math.floor((bitis - Date.now()) / 1000));
  return `${OTURUM_CEREZ}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sn}`;
}

// ================= Panel API =================

async function panel(request, env, ctx, yol) {
  const d = depo(env);
  const url = new URL(request.url);
  const post = request.method === "POST";
  if (post && !ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
  const token = cerez(request, OTURUM_CEREZ);

  if (yol === "durum") {
    const { kurulu } = await d.panelDurum();
    return json({ kurulu, girisli: await d.oturumGecerli(token) });
  }
  if (yol === "kur" && post) {
    if (await sinirAsildi(env, request, "giris")) return cokFazla();
    const g = (await govdeOku(request)) || {};
    const r = await d.panelKur({ kurulumKodu: g.kurulumKodu, sifre: g.sifre });
    if (!r.basarili) return json(r, 400);
    return json({ basarili: true }, 200, { "set-cookie": oturumCerezi(r.token, r.bitis) });
  }
  if (yol === "giris" && post) {
    if (await sinirAsildi(env, request, "giris")) return cokFazla();
    const g = (await govdeOku(request)) || {};
    const r = await d.panelGiris(g.sifre);
    if (!r.basarili) return json(r, 401);
    return json({ basarili: true }, 200, { "set-cookie": oturumCerezi(r.token, r.bitis) });
  }
  if (yol === "cikis" && post) {
    await d.cikis(token);
    return json({ basarili: true }, 200, { "set-cookie": `${OTURUM_CEREZ}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // --- Buradan sonrası giriş ister ---
  if (!(await d.oturumGecerli(token))) return json({ hata: "Oturum kapalı. Lütfen giriş yapın.", giris: true }, 401);

  const g = post ? (await govdeOku(request)) || {} : null;
  const degisti = (r) => {
    if (r && r.basarili) onbellegiTemizle(request, ctx);
    return json(r, r && r.hata ? 400 : 200);
  };

  switch (`${request.method} ${yol}`) {
    case "GET hafta": return json(await d.panelHafta(url.searchParams.get("bas")));
    case "POST rez": return degisti(await d.panelRezEkle({
      gunTarihi: g.gun, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not, durum: g.durum, kapora: g.kapora,
    }));
    case "POST rez-guncelle": return degisti(await d.panelRezGuncelle(g));
    case "GET aboneler": return json(await d.aboneListe());
    case "POST abone": return degisti(await d.aboneKaydet(g));
    case "POST abone-sil": return degisti(await d.aboneSil(g.id));
    case "POST abone-atla": return degisti(await d.aboneAtla(g));
    case "GET musteriler": return json(await d.musteriler());
    case "GET musteri": return json(await d.musteriDetay(url.searchParams.get("tel")));
    case "POST musteri-not": return degisti(await d.musteriNot(g));
    default: return json({ hata: "Bulunamadı" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const yol = url.pathname;

    if (yol === "/api/saglik") return json({ tamam: true, depo: "cloudflare" });

    if (yol.startsWith("/api/panel/")) {
      try {
        return await panel(request, env, ctx, yol.slice("/api/panel/".length));
      } catch (e) {
        console.error(e);
        return json({ hata: "Sunucu hatası. Tekrar deneyin." }, 500);
      }
    }

    // Rezervasyon sayfası: önümüzdeki günlerin tüm saatleri (boş/dolu). Kişisel veri içermez.
    if (yol === "/api/musaitlik" && request.method === "GET") {
      return onbellekli(request, ctx, 10, async () => {
        try {
          return json({ gunler: await gunleriGetir(env), fiyat: FIYATLAR.gunduz, kapora: FIYATLAR.kapora });
        } catch (e) {
          console.error(e);
          return json({ hata: "Boş saatler şu an okunamıyor." }, 503);
        }
      });
    }

    // Ana sayfa tabelası: bugün ve yarın.
    if (yol === "/api/bos-saatler" && request.method === "GET") {
      return onbellekli(request, ctx, 30, async () => {
        try {
          const gunler = await gunleriGetir(env);
          return json({ bugun: gunler[0] || null, yarin: gunler[1] || null });
        } catch (e) {
          console.error(e);
          return json({ hata: "Boş saatler şu an okunamıyor." }, 503);
        }
      });
    }

    if (yol === "/api/rezervasyon" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "rez")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      if (g.web) return json({ hata: "İstek reddedildi." }, 400); // bot tuzağı
      if (g.kvkk !== true) return json({ hata: "Devam etmek için aydınlatma metnini onaylayın." }, 400);
      try {
        const r = await depo(env).olustur({ gunTarihi: g.tarih, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not || "" });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        ctx.waitUntil(bildir(env, {
          konu: `Yeni rezervasyon: ${r.gun} ${r.saat} (${r.kayitNo})`,
          satirlar: [
            ["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`],
            ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Not", r.not || "-"],
            ["Kayıt no", r.kayitNo], ["Durum", `${r.durum} (${FIYATLAR.kapora} TL)`],
          ],
        }));
        return json({
          basarili: true, kayitNo: r.kayitNo, tarih: r.tarih, gun: r.gun, saat: r.saat, durum: r.durum,
          ucret: r.ucret, kapora: FIYATLAR.kapora, kalan: r.ucret - FIYATLAR.kapora,
          iban: IBAN.no || null, alici: IBAN.alici || null,
        });
      } catch (e) {
        console.error(e);
        return json({ hata: `Rezervasyon şu an kaydedilemedi. Lütfen ${ISLETME.telefon} numarasını arayın.` }, 502);
      }
    }

    if (yol === "/api/iptal" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
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

    if (yol.startsWith("/api/")) return json({ hata: "Bulunamadı" }, 404);
    if (yol === "/panel") return Response.redirect(url.origin + "/panel/", 301);
    if (ESKI_ADRESLER[yol]) return Response.redirect(url.origin + ESKI_ADRESLER[yol], 301);
    if (yol.startsWith("/blog/") || yol.startsWith("/form/")) return Response.redirect(url.origin + "/", 301);
    if (yol === "/rezervasyon") return Response.redirect(url.origin + "/rezervasyon/", 301);

    const statik = await env.ASSETS.fetch(request);
    const fotoAd = yol.startsWith("/galeri/") ? yol.slice("/galeri/".length) : null;
    if (statik.status === 404 && fotoAd && FOTOLAR[fotoAd]) {
      try {
        const f = await depo(env).foto(fotoAd, FOTOLAR[fotoAd]);
        if (f) {
          return new Response(f.veri, { headers: { "content-type": f.tur, "cache-control": "public, max-age=604800" } });
        }
      } catch (e) {
        console.error("Fotoğraf alınamadı", fotoAd, e);
      }
    }
    return statik;
  },
};
