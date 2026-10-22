// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { simdi, isletmeGunu, gunEkle, haftaBasi } from "./time.js";
import { KURALLAR, FIYATLAR, IBAN, ISLETME, EKSTRALAR } from "./config.js";
import { bildir, epostaYolla, epostaKurulu } from "./bildirim.js";
import { dekontOku, dekontDegerlendir, ozet } from "./dekont-kontrol.js";
import { ROLLER } from "./store.js";
import { kasaPdf } from "./kasa-pdf.js";
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
    .map((g) => ({ tarih: g.tarih, gun: g.gun, saatler: g.detay.map((s) => ({ saat: s.saat, bos: s.bos, ...(s.opsiyon ? { opsiyon: s.opsiyon } : {}) })) }));
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
        ...(s.rez ? { rez: { ad: s.rez.ad, durum: s.rez.durum, kaynak: s.rez.kaynak, ekstra: s.rez.ekstra || [] } } : {}),
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
    await d.kayitTut(ben || { ad: "Kurulum kodu" }, "Tablodan içe aktarma", JSON.stringify(r).slice(0, 200));
    onbellegiTemizle(request, ctx);
    return json(r);
  }

  // --- Buradan sonrası giriş ister ---
  if (!ben) return json({ hata: "Oturum kapalı. Lütfen giriş yapın.", giris: true }, 401);

  // Temizlik Şefi ve Personel: sadece haftalık tabloyu görür
  if (request.method === "GET" && yol === "hafta") {
    // Geçmiş haftaları sadece Admin görür; diğerleri en fazla bu haftaya kadar geri gidebilir
    let bas = url.searchParams.get("bas");
    if (ben.rol !== "admin") {
      const n = simdi();
      const buHafta = haftaBasi(isletmeGunu(n.tarih, n.saat));
      if (!bas || bas < buHafta) bas = buHafta;
    }
    const h = await d.panelHafta(bas);
    h.gerisiVar = ben.rol === "admin";
    return json(yonetici ? h : haftaSaltOkur(h));
  }
  // Puantaj: her çalışan kendi giriş / çıkışını onaylar
  if (yol === "puantaj/bugun" && request.method === "GET") return json(await d.puantajBugun(ben));
  if (yol === "puantaj/giris" && post) { const r = await d.puantajGiris(ben); return json(r, r.hata ? 400 : 200); }
  if (yol === "puantaj/cikis" && post) {
    const r = await d.puantajCikis(ben);
    // Gün sonu: çalışana o günün özeti (yarım saat yol dahil) e-postayla
    if (r.basarili) ctx.waitUntil(puantajOzetGonder(env, d, ben, r).catch((e) => console.error("Puantaj e-postası", e)));
    return json(r, r.hata ? 400 : 200);
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
      gunTarihi: g.gun, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not, durum: g.durum, kapora: g.kapora, ekstra: g.ekstra,
    }));
    case "POST rez-guncelle": {
      const r = await d.panelRezGuncelle(g);
      if (r.basarili && (r.degisen || []).some((x) => x.startsWith("Durum: Onaylı → İptal"))) {
        ctx.waitUntil(iptalBildir(env, d, { ...r.rez, kimden: `${ben.ad} (${ROLLER[ben.rol]?.ad || ""}, panel)` }));
      }
      return degisti(r);
    }
    case "GET aboneler": return json(await d.aboneListe());
    case "POST abone": return degisti(await d.aboneKaydet(g));
    case "POST abone-sil": {
      const ab = (await d.aboneListe()).find((x) => x.id === g.id);
      const r = await d.aboneSil(g.id);
      return degisti(r && r.basarili ? { ...r, ad: ab ? `${ab.no ? "Abone " + ab.no + " · " : ""}${ab.ad}` : g.id } : r);
    }
    case "POST abone-atla": return degisti(await d.aboneAtla(g));
    case "POST abone-tasi": return degisti(await d.aboneTasi(g));
    case "GET musteriler": return json(await d.musteriler());
    case "GET musteri": {
      const m = await d.musteriDetay(url.searchParams.get("tel"));
      // Geçmiş rezervasyon kayıtlarını sadece Admin görür
      if (ben.rol !== "admin" && m.rezervasyonlar) {
        const n = simdi();
        m.rezervasyonlar = m.rezervasyonlar.filter((r) => (r.isletmeGunu || r.tarih) >= isletmeGunu(n.tarih, n.saat));
        m.gecmisGizli = true;
      }
      return json(m);
    }
    case "POST musteri-not": return degisti(await d.musteriNot(g));
    case "POST musteri-sil": { const r = await d.musteriSil(g.telefon, ben); return json(r, r.hata ? 400 : 200); }
    case "GET kullanicilar": return json(await d.kullanicilar());
    case "GET fiyat": return json(await d.fiyatAyar());
    case "GET puantaj": {
      // Aylık puantaj raporu: Admin ve Müdür herkesi, Müdür Yardımcısı sadece kendini görür
      const ay = url.searchParams.get("ay") || simdi().tarih.slice(0, 7);
      return json(await d.puantajAy(ay, ["admin", "mudur"].includes(ben.rol) ? null : ben.eposta));
    }
    case "POST puantaj/duzelt": return sonuc(await d.puantajDuzelt(g, ben));
    case "GET kasa": { const r = await d.kasaGetir(url.searchParams.get("gun"), ben); return json(alisGizle(r, ben), r.hata ? 403 : 200); }
    case "POST kasa": {
      const r = await d.kasaKaydet(g, ben);
      // Her kayıtta günlük kasa raporu PDF olarak sadece Admin'e gider
      if (r.basarili && !r.otomatik) ctx.waitUntil(kasaRaporuGonder(env, d, r.kayit, r.ilkKayit).catch((e) => console.error("Kasa PDF", e)));
      return json(alisGizle(r, ben), r.hata ? 400 : 200);
    }
    case "GET kasa/ay":
      if (ben.rol !== "admin") return json({ hata: "Aylık kasa özeti sadece Admin içindir." }, 403);
      return json(await d.kasaAy(url.searchParams.get("ay") || simdi().tarih.slice(0, 7)));
    case "POST siparis": {
      // Kantin siparişi WhatsApp'tan verildi: yöneticilere bilgi e-postası
      const satirlar = (Array.isArray(g.satirlar) ? g.satirlar : []).map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 60);
      if (!satirlar.length) return json({ hata: "Liste boş." }, 400);
      await d.kayitTut(ben, "Kantin siparişi verdi", satirlar.join(", ").slice(0, 280));
      const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
      ctx.waitUntil(epostaYolla(env, {
        kime, konu: `Kantin siparişi verildi (${satirlar.length} ürün)`,
        satirlar: [["Sipariş veren", `${ben.ad} (${ROLLER[ben.rol]?.ad || ""})`], ["Zaman", simdi().tarih.split("-").reverse().join(".") + " " + simdi().saat], ...satirlar.map((x, i) => [`${i + 1}.`, x])],
        alt: "Sipariş WhatsApp'tan Tespo'ya gönderildi. Mal gelince Kasa → Kantin stok'tan 'Gelen mal' girin.",
      }).catch((e) => console.error("Sipariş e-postası", e)));
      return json({ basarili: true });
    }
    case "POST veresiye-ode": return sonuc(await d.veresiyeOde(g, ben));
    case "GET urunler": return json(alisGizle({ urunler: await d.urunler() }, ben).urunler);
    case "POST urun": {
      // Alış fiyatını sadece Admin değiştirir (diğerleri göremez de)
      const r = await d.urunKaydet(ben.rol === "admin" ? g : { ...g, alis: undefined }, ben);
      return json(alisGizle(r, ben), r.hata ? 400 : 200);
    }
    case "POST fiyat": {
      const r = await d.fiyatKaydet(g, ben);
      if (r.basarili) onbellegiTemizle(request, ctx);
      return json(r, r.hata ? 400 : 200);
    }
    case "POST dekont-kontrol": {
      // Panelden "Dekontu yeniden kontrol et"
      const f = await d.dekontGetir(g.kayitNo);
      const b = f && (await d.kayitBul(g.kayitNo));
      if (!f || !b) return json({ hata: "Dekont bulunamadı." }, 400);
      const { k } = await dekontKontrolEt(env, d, b.kayit, f.veri instanceof Uint8Array ? f.veri : new Uint8Array(f.veri));
      if (k.onay) onbellegiTemizle(request, ctx);
      return json(k, k.hata ? 400 : 200);
    }
    case "GET dekont": {
      const f = await d.dekontGetir(url.searchParams.get("k"), url.searchParams.get("s"));
      if (!f) return json({ hata: "Dekont bulunamadı." }, 404);
      return new Response(f.veri, { headers: {
        "content-type": f.tur, "cache-control": "private, no-store",
        "content-disposition": `inline; filename="dekont-${encodeURIComponent(url.searchParams.get("k"))}"`,
        "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      } });
    }
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

/** Rezervasyon iptali: Müdür ve Müdür Yardımcısı'na e-posta (yoksa işletme adresine). */
async function iptalBildir(env, d, r) {
  const kime = await d.rolEpostalari(["mudur", "mudur_yrd"]);
  const ileti = {
    konu: `Rezervasyon iptal edildi: ${r.gun || ""} ${r.tarih} ${r.saat}`.replace(/\s+/g, " "),
    satirlar: [["Maç", `${r.gun ? r.gun + ", " : ""}${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad || "-"], ["Telefon", r.telefon || "-"],
      ["Kayıt no", r.kayitNo], ["İptal eden", r.kimden], ["Kapora", r.kapora ? `${r.kapora} (iade yok)` : "-"]],
  };
  if (kime.length) await epostaYolla(env, { kime, ...ileti });
  else await bildir(env, ileti);
}

/** Müşteriye dönen rezervasyon özeti (onay ekranı). */
const rezCevap = (r) => ({
  basarili: true, kayitNo: r.kayitNo, tarih: r.tarih, gun: r.gun, saat: r.saat, durum: r.durum,
  ucret: r.ucret, kapora: r.kaporaTutar ?? FIYATLAR.kapora, kalan: r.ucret - (r.kaporaTutar ?? FIYATLAR.kapora),
  iban: IBAN.no || null, alici: IBAN.alici || null, opsiyonBitis: r.opsiyonBitis || null, dekont: Boolean(r.dekont),
  // Telefon saati yanlış olabilir: kalan süre sunucudan milisaniye olarak
  opsiyonKalan: r.opsiyonBitis ? Math.max(0, r.opsiyonBitis - Date.now()) : null,
});

/** Dekontu okur, kurallara göre değerlendirir ve sonucu rezervasyona yazar. */
async function dekontKontrolEt(env, d, rez, veri) {
  const okunan = await dekontOku(env, { tur: rez.dekont.tur, veri });
  const deger = dekontDegerlendir(okunan, {
    iban: IBAN.no, alici: IBAN.alici, kapora: rez.kaporaTutar ?? FIYATLAR.kapora,
    rezTarihi: String(rez.olusturma || "").slice(0, 10) || null, bugun: simdi().tarih,
    tarihKontrol: KURALLAR.dekontTarihKontrol,
  });
  const k = await d.dekontSonuc(rez.kayitNo, await ozet(veri), deger);
  return { okunan, k };
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

async function puantajOzetGonder(env, d, ben, r) {
  const ay = await d.puantajAy(r.gun.slice(0, 7), ben.eposta);
  const kisi = ay.kisiler[0];
  const gunK = kisi?.gunler.find((x) => x.gun === r.gun);
  if (!gunK) return;
  const sa = (n) => `${String(n).replace(".", ",")} saat`;
  const tl = (n) => `${Math.round(n).toLocaleString("tr-TR")} TL`;
  const calisilan = Math.round((gunK.saat - KURALLAR.puantajYolSaat) * 100) / 100;
  await epostaYolla(env, {
    kime: [ben.eposta], konu: `Çalışma özeti ${r.gun.split("-").reverse().join(".")}: ${sa(gunK.saat)}`,
    satirlar: [
      ["Geldim", gunK.giris], ["Çıktım", gunK.cikis], ["Çalışılan", sa(calisilan)], ["Yol", sa(KURALLAR.puantajYolSaat)],
      ["Toplam", sa(gunK.saat)], ...(kisi.saatlikUcret ? [["Ücret", tl(gunK.saat * kisi.saatlikUcret)]] : []),
      ["Bu ay toplam", `${sa(kisi.saat)}${kisi.saatlikUcret ? " · " + tl(kisi.ucret) : ""}`],
    ],
    alt: "Saatlerde hata varsa yöneticinize bildirin. — Aysu Halı Saha",
  });
}

async function kasaRaporuGonder(env, d, k, ilk) {
  const kime = await d.rolEpostalari(["admin"]);
  if (!kime.length) return;
  const o = k.ozet;
  const para = (n) => `${Math.round(Number(n) || 0).toLocaleString("tr-TR")} TL`;
  const tarih = k.gun.split("-").reverse().join(".");
  await epostaYolla(env, {
    kime, konu: `Kasa raporu ${tarih}${ilk ? "" : " (güncellendi)"} — ciro ${para(o.ciro)}`,
    satirlar: [["Gün", tarih], ["Kaydeden", `${k.guncelleyen} · ${k.guncelleme}`], ["Günlük ciro", para(o.ciro)],
      ["Kasada olması gereken", para(o.olmasiGereken)], ...(k.sayilan !== null ? [["Sayılan / fark", `${para(k.sayilan)} / ${para(o.fark)}`]] : [])],
    alt: "Ayrıntılı rapor ekteki PDF'te.",
    ekler: [{ ad: `aysu-kasa-${k.gun}.pdf`, tur: "application/pdf", veri: kasaPdf(k) }],
  });
}

/** Kantin alış fiyatı ve kâr sadece Admin'e gider. */
function alisGizle(r, ben) {
  if (!r || ben.rol === "admin") return r;
  const v = JSON.parse(JSON.stringify(r));
  const temizle = (u) => { if (u && typeof u === "object") delete u.alis; };
  (v.urunler || []).forEach(temizle);
  temizle(v.urun);
  if (v.kayit) {
    Object.values(v.kayit.birimler || {}).forEach(temizle);
    if (v.kayit.ozet) delete v.kayit.ozet.kantinKar;
  }
  return v;
}

const ISLEM_ADLARI = {
  rez: "Rezervasyon ekledi", "rez-guncelle": "Rezervasyon güncelledi", abone: "Abone kaydetti",
  "abone-sil": "Abonelik sonlandırdı", "abone-atla": "Abone gelmiyor/geliyor", "abone-tasi": "Abone maçını taşıdı", "musteri-not": "Müşteri notu",
  kullanici: "Kullanıcı güncelledi", "kullanici-sil": "Kullanıcı sildi",
};
function islemDetayi(yol, g, r) {
  const k = r.rez || r;
  switch (yol) {
    case "rez": return `${g.gun} ${g.saat} · ${g.ad || ""}${g.telefon ? " · " + g.telefon : ""}${g.kapora ? " · kapora " + g.kapora : ""}${g.ekstra?.length ? " · VIP " + g.ekstra.join("+") : ""}`;
    case "rez-guncelle": return `${k.kayitNo || g.kayitNo} · ${k.isletmeGunu || k.tarih || ""} ${k.saat || ""} · ${k.ad || ""} · ${(r.degisen || []).join(" · ") || "değişiklik yok"}`;
    case "abone": return `${g.id ? "Düzenledi" : "Yeni"} · ${r.abone?.no ? "Abone " + r.abone.no + " · " : ""}${g.ad || ""} · ${(r.abone?.slotlar || []).map((x) => ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"][x.gun] + " " + x.saat).join(", ")}`;
    case "abone-sil": return `${r.ad || g.id}`;
    case "abone-tasi": return `${r.ad || ""} · ${r.eski} → ${r.yeni} (${r.kayitNo})`;
    case "abone-atla": return `${g.gun} ${g.saat || ""} · ${g.gelmiyor ? "gelmiyor" : "geliyor"} (${g.kapsam || "saat"})`;
    case "musteri-not": return `${g.telefon || ""} · etiket: ${g.etiket || "—"} · not: ${String(g.not || "—").slice(0, 80)}`;
    case "kullanici": return `${g.eposta} · ${[g.rol, g.durum].filter(Boolean).join(" · ")}`;
    case "kullanici-sil": return `${g.eposta}`;
    case "puantaj/duzelt": return "";
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
          const f = await depo(env).fiyatAyar();
          return json({
            gunler: await gunleriGetir(env), fiyat: f.mac, kapora: f.kapora,
            ekstralar: { spiker: { ad: EKSTRALAR.spiker.ad, ucret: f.spiker }, hakem: { ad: EKSTRALAR.hakem.ad, ucret: f.hakem } },
            dogrulama: env.TURNSTILE_SITE_KEY || null,
          });
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
        const r = await depo(env).olustur({ gunTarihi: g.tarih, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not || "", ekstra: g.ekstra });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        // E-posta gönderilmez: kapora (dekont) doğrulanınca "Yeni rezervasyon" e-postası gider
        return json(rezCevap(r));
      } catch (e) {
        console.error(e);
        return json({ hata: `Rezervasyon şu an kaydedilemedi. Lütfen ${ISLETME.telefon} numarasını arayın.` }, 502);
      }
    }

    // Müşteri kapora dekontunu yükler (kayıt no + telefon). İşletmeye e-postayla ek olarak gider.
    if (yol === "/api/dekont" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "dekont")) return cokFazla();
      if (Number(request.headers.get("content-length") || 0) > 2_600_000) return json({ hata: "Dosya çok büyük (en fazla 1,8 MB)." }, 413);
      const g = await govdeOku(request);
      if (!g || typeof g.dosya !== "string") return json({ hata: "Geçersiz istek." }, 400);
      let veri;
      try { veri = Uint8Array.from(atob(g.dosya), (c) => c.charCodeAt(0)); } catch { return json({ hata: "Dosya okunamadı." }, 400); }
      try {
        const d = depo(env);
        const r = await d.dekontYukle({ kayitNo: g.kayitNo, telefon: g.telefon, tur: g.tur, ad: g.ad, veri });
        if (!r.basarili) return json(r, 400);
        // Otomatik kontrol: doğru IBAN + alıcı + tutar + tarih → rezervasyon kesinleşir
        const { okunan, k } = await dekontKontrolEt(env, d, r, veri);
        if (k.onay) onbellegiTemizle(request, ctx);
        const uzanti = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[r.dekont.tur];
        // Sadece bu dekontla kesinleşen rezervasyon için "Yeni rezervasyon" e-postası
        // (doğrulanamayan dekont ya da kaporanın ikinci parçası için e-posta yok; eksik kapora 15 dk sonra bildirilir)
        if (k.onay && r.durum !== "Onaylı") ctx.waitUntil(bildir(env, {
          konu: `Yeni rezervasyon: ${r.gun} ${r.saat} (${r.kayitNo})`,
          satirlar: [["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Kayıt no", r.kayitNo],
            ["VIP", r.ekstra?.length ? r.ekstra.map((x) => EKSTRALAR[x].ad).join(", ") : "-"], ["Toplam ücret", `${r.ucret} TL`],
            ["Kapora", `${k.rez.kapora || "?"} TL (dekont ekte)`], ["Durum", "Onaylı — kapora dekontla doğrulandı"]],
          ekler: [{ ad: `dekont-${r.kayitNo}.${uzanti}`, tur: r.dekont.tur, veri }],
        }));
        return json({ basarili: true, kayitNo: r.kayitNo, onay: k.onay, nedenler: k.onay ? [] : k.nedenler,
          toplam: k.toplam, gereken: k.gereken, eksik: k.onay && k.eksik, durum: k.rez.durum });
      } catch (e) {
        console.error(e);
        return json({ hata: `Dekont şu an yüklenemedi. WhatsApp'tan gönderebilirsiniz.` }, 502);
      }
    }

    // "Rezervasyonumu kontrol et": gün + saat + ad soyad + telefon
    if (yol === "/api/rezervasyon-sorgula" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      const r = await depo(env).rezSorgula(g);
      if (!r.basarili) return json(r, 404);
      return json({ ...rezCevap(r), ad: r.ad, kaporaOdenen: r.kapora || null, ekstra: (r.ekstra || []).map((x) => EKSTRALAR[x]?.ad || x),
        opsiyonKalan: r.durum === "Kapora bekleniyor" && r.opsiyonBitis ? Math.max(0, r.opsiyonBitis - Date.now()) : null });
    }

    // Bağlantısı kopan müşteri opsiyonlu saatine dokunup telefonunu yazınca kaldığı yerden devam eder
    if (yol === "/api/opsiyon-devam" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      const r = await depo(env).opsiyonDevam(g);
      return r.basarili ? json(rezCevap(r)) : json(r, 400);
    }

    // Onay ekranı açıkken birkaç saniyede bir güncel durum (opsiyon süresi, onay, düşme)
    if (yol === "/api/rezervasyon-durum" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      const r = await depo(env).rezDurum(g);
      return json(r, r.hata ? 404 : 200);
    }

    // Müşteri telefon numarasıyla ileri tarihli rezervasyonlarını görür (dekont yükleme / iptal için)
    if (yol === "/api/rezervasyonlarim" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      const r = await depo(env).bul(g.telefon);
      return json(r, r.hata ? 400 : 200);
    }

    if (yol === "/api/iptal" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      try {
        const r = await depo(env).iptal({ kayitNo: g.kayitNo, tarih: g.tarih, saat: g.saat, telefon: g.telefon, ad: g.ad });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        if (r.onayliydi) ctx.waitUntil(iptalBildir(env, depo(env), { ...r, kimden: "Müşteri (siteden)", telefon: String(g.telefon).trim() }));
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
    // SMS için kısa bağlantı: aysuhalisaha.com/r
    if (yol === "/r" || yol === "/r/") return Response.redirect(url.origin + "/rezervasyon/", 302);
    // Rezervasyon kontrol sayfası: temiz adres /rezervasyon/kontrol (eski ?kontrol / ?iptal adresleri yönlenir)
    if (yol === "/rezervasyon/" && (url.searchParams.has("kontrol") || url.searchParams.has("iptal"))) {
      return Response.redirect(url.origin + "/rezervasyon/kontrol", 301);
    }
    if (yol === "/rezervasyon/kontrol" || yol === "/rezervasyon/kontrol/") {
      const sayfa = await env.ASSETS.fetch(new Request(url.origin + "/rezervasyon/", { headers: request.headers }));
      return new Response(sayfa.body, sayfa);
    }

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
    if (event?.cron === "0 0 * * 1") {
      ctx.waitUntil(depo(env).haftaTemizle().then((r) => console.log("Haftalık temizlik", JSON.stringify(r))));
      return;
    }
    // 5 dakikada bir: dekontu gelmeyen online opsiyonları düşür, işletmeye haber ver
    ctx.waitUntil(depo(env).opsiyonlariDusur());
    // Abone veresiyesi: abonenin sonraki maçında o günkü yöneticiye hatırlatma
    ctx.waitUntil((async () => {
      const l = await depo(env).veresiyeHatirlatmalari();
      const tl = (n) => `${Math.round(n).toLocaleString("tr-TR")} TL`;
      await Promise.all(l.filter((g) => g.kime.length).map((g) => epostaYolla(env, {
        kime: g.kime, konu: `Veresiye hatırlatması: ${g.abone} bugün ${g.saat} — ${tl(g.liste.reduce((t, v) => t + v.tutar, 0))}`,
        satirlar: g.liste.map((v) => [`${v.gun.split("-").reverse().join(".")} ${v.saat}`, `${v.kim}: ${v.urunler} = ${tl(v.tutar)}`]),
        alt: "Tahsil edince panelde Kasa → Açık veresiyeler bölümünden 'Ödendi'ye basın; tutar o günün kasa girişine eklenir.",
      })));
    })().catch((e) => console.error("Veresiye hatırlatma", e)));
    // İlk dekonttan 15 dk sonra kapora hâlâ eksikse Müdür ve Müdür Yardımcısı'na bir kez bilgi
    ctx.waitUntil((async () => {
      const d = depo(env);
      const liste = await d.eksikKaporalar();
      if (!liste.length) return;
      const kime = await d.rolEpostalari(["mudur", "mudur_yrd"]);
      await Promise.all(liste.map((r) => epostaYolla(env, {
        kime, konu: `Eksik kapora: ${r.gun} ${r.saat} — ${r.kaporaToplam ?? "?"} TL (${r.kayitNo})`,
        satirlar: [["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Kayıt no", r.kayitNo],
          ["Ödenen", `${r.kapora} TL`], ["Kapora", `${r.kaporaTutar ?? "?"} TL`], ["Toplam ücret", `${r.ucret} TL`]],
        alt: "Rezervasyon onaylı (IBAN ve hesap adı doğru). Eksik tutarı sahada tahsil edin.",
      })));
    })().catch((e) => console.error("Eksik kapora", e)));
  },
};
