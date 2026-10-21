// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { simdi, isletmeGunu, gunEkle } from "./time.js";
import { KURALLAR, FIYATLAR, IBAN, ISLETME } from "./config.js";
import { bildir, epostaYolla, epostaKurulu } from "./bildirim.js";
import { ROLLER } from "./store.js";
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

/**
 * Bot koruması: Cloudflare Turnstile (görünmez "ben robot değilim" doğrulaması).
 * TURNSTILE_SECRET tanımlı değilse atlanır (site yine çalışır; hız sınırı + bot tuzağı devrede).
 */
async function insanMi(env, request, token) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token || typeof token !== "string" || token.length > 4096) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const v = await r.json();
    return v.success === true;
  } catch (e) {
    console.error("Turnstile doğrulanamadı", e);
    return false;
  }
}
const robotHatasi = () => json({ hata: "Güvenlik doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.", dogrulama: true }, 403);

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

/** Salt-okur roller (Temizlik Şefi, Personel) için hafta: sadece kim/ne zaman; telefon, kapora, not yok. */
function haftaSaltOkur(h) {
  return {
    baslangic: h.baslangic, bugun: h.bugun, bekleyenler: [],
    gunler: h.gunler.map((g) => ({
      ...g,
      saatler: g.saatler.map((s) => ({
        saat: s.saat, tarih: s.tarih, gecmis: s.gecmis, tur: s.tur, ...(s.ozel ? { ozel: true } : {}),
        ...(s.rez ? { rez: { ad: s.rez.ad, durum: s.rez.durum, kaynak: s.rez.kaynak } } : {}),
        ...(s.abone ? { abone: { no: s.abone.no } } : {}),
      })),
    })),
  };
}

async function panel(request, env, ctx, yol) {
  const d = depo(env);
  const url = new URL(request.url);
  const post = request.method === "POST";
  if (post && !ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
  const token = cerez(request, OTURUM_CEREZ);
  const girisCevabi = (r, hataKodu = 400) => (r.basarili && r.token
    ? json({ basarili: true }, 200, { "set-cookie": oturumCerezi(r.token, r.bitis) })
    : json(r, r.basarili ? 200 : hataKodu));

  if (yol === "durum") {
    const { kurulu } = await d.panelDurum();
    const k = await d.oturum(token);
    return json({ kurulu, girisli: Boolean(k), kullanici: k, eposta: epostaKurulu(env), dogrulama: env.TURNSTILE_SITE_KEY || null });
  }
  if (post && ["kur", "giris", "kayit", "sifre-unuttum", "sifre-sifirla"].includes(yol)) {
    if (await sinirAsildi(env, request, "giris")) return cokFazla();
    const g = (await govdeOku(request)) || {};
    if (g.web) return json({ hata: "İstek reddedildi." }, 400); // bot tuzağı
    if ((yol === "kayit" || yol === "sifre-unuttum") && !(await insanMi(env, request, g.dogrulama))) return robotHatasi();
    if (yol === "kur") return girisCevabi(await d.panelKur(g));
    if (yol === "giris") return girisCevabi(await d.panelGiris(g), 401);
    if (yol === "sifre-sifirla") return girisCevabi(await d.sifreSifirla(g));
    if (yol === "kayit") {
      const r = await d.kayitOl(g);
      if (r.basarili) ctx.waitUntil(onayEpostalari(env, d, r.kullanici, url.origin).catch((e) => console.error("Onay e-postası", e)));
      return json(r.basarili ? { basarili: true } : r, r.basarili ? 200 : 400);
    }
    // Şifremi unuttum: hesap olsun olmasın aynı cevap (kimin kayıtlı olduğu anlaşılmasın)
    const r = await d.sifirlamaOlustur(g.eposta);
    if (r.basarili) {
      const link = `${url.origin}/panel/#sifirla=${r.token}`;
      ctx.waitUntil(epostaYolla(env, {
        kime: [r.eposta], konu: "Aysu Halı Saha panel şifre sıfırlama",
        satirlar: [["Merhaba", r.ad], ["Geçerlilik", "1 saat, tek kullanımlık"]],
        dugme: { yazi: "Şifremi yenile", link },
        alt: "Bu isteği siz yapmadıysanız bu e-postayı yok sayın.",
      }));
    }
    return json({ basarili: true, eposta: epostaKurulu(env) });
  }
  // E-postadaki onay bağlantısı: GET bilgi gösterir, onay/ret POST ile (e-posta tarayıcılarının
  // bağlantıyı önceden açması kullanıcıyı kendiliğinden onaylamasın diye)
  if (yol === "onay") {
    if (await sinirAsildi(env, request, "giris")) return cokFazla();
    if (!post) {
      const r = await d.onayBilgisi(url.searchParams.get("t"));
      return json(r, r.hata ? 400 : 200);
    }
    const g = (await govdeOku(request)) || {};
    const r = await d.onayKarari(g.token, g.karar === "reddet" ? "reddet" : "onayla");
    return json(r, r.hata ? 400 : 200);
  }
  if (yol === "cikis" && post) {
    await d.cikis(token);
    return json({ basarili: true }, 200, { "set-cookie": `${OTURUM_CEREZ}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  const ben = await d.oturum(token);
  const yonetici = Boolean(ben && ROLLER[ben.rol]?.yonetici);

  // Tablodan toplu aktarım: yönetici oturumu ya da kurulum kodu (x-kurulum-kodu başlığı) ile
  if (yol === "ice-aktar" && post) {
    const kod = request.headers.get("x-kurulum-kodu");
    const yetkili = (kod && env.PANEL_KURULUM_KODU && kod === env.PANEL_KURULUM_KODU) || yonetici;
    if (!yetkili) return json({ hata: "Yetkisiz." }, 401);
    const g = (await govdeOku(request)) || {};
    const r = await d.iceAktar(g);
    onbellegiTemizle(request, ctx);
    return json(r);
  }

  // --- Buradan sonrası giriş ister ---
  if (!ben) return json({ hata: "Oturum kapalı. Lütfen giriş yapın.", giris: true }, 401);

  // Temizlik Şefi ve Personel: sadece haftalık tabloyu görür
  if (request.method === "GET" && yol === "hafta") {
    const h = await d.panelHafta(url.searchParams.get("bas"));
    return json(yonetici ? h : haftaSaltOkur(h));
  }
  if (!yonetici) return json({ hata: "Bu işlem için yetkiniz yok." }, 403);

  const g = post ? (await govdeOku(request)) || {} : null;
  // Admin kontrolü için her başarılı değişiklik işlem kaydına yazılır
  const kaydet = async (r) => {
    if (r && r.basarili && post) {
      const islem = ISLEM_ADLARI[yol] || yol;
      await d.kayitTut(ben, islem, islemDetayi(yol, g, r)).catch((e) => console.error("Kayıt yazılamadı", e));
    }
  };
  const degisti = async (r) => {
    if (r && r.basarili) {
      onbellegiTemizle(request, ctx);
    }
    await kaydet(r);
    return json(r, r && r.hata ? 400 : 200);
  };
  const sonuc = async (r) => { await kaydet(r); return json(r, r && r.hata ? 400 : 200); };

  switch (`${request.method} ${yol}`) {
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
    case "GET kullanicilar": return json(await d.kullanicilar());
    case "GET islemler":
      if (ben.rol !== "admin") return json({ hata: "Bu bölüm sadece Admin içindir." }, 403);
      return json(await d.islemler(url.searchParams.get("adet")));
    case "POST kullanici": return sonuc(await d.kullaniciGuncelle(g, ben));
    case "POST kullanici-sil": return sonuc(await d.kullaniciSil(g.eposta, ben));
    case "POST sifirlama-linki": {
      // E-posta kurulu değilse yönetici bağlantıyı alıp WhatsApp'tan iletebilir
      const r = await d.sifirlamaOlustur(g.eposta);
      if (!r.basarili) return json({ hata: "Kullanıcı bulunamadı." }, 400);
      await d.kayitTut(ben, "Şifre yenileme bağlantısı aldı", r.eposta);
      return json({ basarili: true, link: `${url.origin}/panel/#sifirla=${r.token}` });
    }
    default: return json({ hata: "Bulunamadı" }, 404);
  }
}

/** Yeni kayıt: Admin ve Müdür(ler)e tek tıkla onay bağlantısı. */
async function onayEpostalari(env, d, kullanici, koken) {
  if (!epostaKurulu(env)) return;
  const baglantilar = await d.onayBaglantilari(kullanici.eposta);
  await Promise.all(baglantilar.map((b) => epostaYolla(env, {
    kime: [b.kime],
    konu: `Onay bekliyor: ${kullanici.ad} (${kullanici.istenenRolAd})`,
    satirlar: [["Merhaba", b.ad], ["Ad soyad", kullanici.ad], ["E-posta", kullanici.eposta], ["Telefon", kullanici.telefon || "-"],
      ["İstediği görev", kullanici.istenenRolAd]],
    dugme: { yazi: `${kullanici.ad} kullanıcısını onayla`, link: `${koken}/panel/#onay=${b.token}` },
    alt: "Bağlantı 7 gün geçerli ve tek kullanımlık. Açılan sayfada Onayla ya da Reddet'i seçin. Kişiyi tanımıyorsanız reddedin.",
  })));
}

const ISLEM_ADLARI = {
  rez: "Rezervasyon ekledi", "rez-guncelle": "Rezervasyon güncelledi", abone: "Abone kaydetti",
  "abone-sil": "Abonelik sonlandırdı", "abone-atla": "Abone gelmiyor/geliyor", "musteri-not": "Müşteri notu",
  kullanici: "Kullanıcı güncelledi", "kullanici-sil": "Kullanıcı sildi",
};
function islemDetayi(yol, g, r) {
  const k = r.rez || r;
  switch (yol) {
    case "rez": return `${g.gun} ${g.saat} · ${g.ad || ""}`;
    case "rez-guncelle": return `${k.kayitNo || g.kayitNo} · ${k.tarih || ""} ${k.saat || ""} · ${k.ad || ""} · ${g.durum || ""}${g.kapora ? " · kapora " + g.kapora : ""}`;
    case "abone": return `${g.ad || ""}`;
    case "abone-sil": return `${g.id}`;
    case "abone-atla": return `${g.gun} ${g.saat || ""} · ${g.gelmiyor ? "gelmiyor" : "geliyor"} (${g.kapsam || "saat"})`;
    case "musteri-not": return `${g.telefon || ""} · ${g.etiket || ""}`;
    case "kullanici": return `${g.eposta} · ${[g.rol, g.durum].filter(Boolean).join(" · ")}`;
    case "kullanici-sil": return `${g.eposta}`;
    default: return "";
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
          return json({ gunler: await gunleriGetir(env), fiyat: FIYATLAR.gunduz, kapora: FIYATLAR.kapora, dogrulama: env.TURNSTILE_SITE_KEY || null });
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
      if (!(await insanMi(env, request, g.dogrulama))) return robotHatasi();
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

  // Zamanlanmış görev (wrangler.jsonc → triggers.crons).
  async scheduled(event, env, ctx) {
    // Pazartesi 03:00 (Türkiye): geçen haftanın listesini temizle (aboneler kalır)
    ctx.waitUntil(depo(env).haftaTemizle().then((r) => console.log("Haftalık temizlik", JSON.stringify(r))));
  },
};
