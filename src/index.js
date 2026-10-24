// Aysu Halı Saha — Cloudflare Worker girişi.
// Statik sayfalar /public klasöründen sunulur; /api/* istekleri burada işlenir.

import { simdi, isletmeGunu, gunEkle, haftaBasi } from "./time.js";
import { KURALLAR, FIYATLAR, IBAN, ISLETME, EKSTRALAR, ABONE_KURALLARI, ANKET_SORULARI } from "./config.js";
import { bildir, epostaYolla, epostaKurulu } from "./bildirim.js";
import * as bildirimModulu from "./bildirim.js";
import { TESIS_KURALLARI } from "./tesis-kurallari.js";
import { dekontOku, dekontDegerlendir, ozet } from "./dekont-kontrol.js";
import { ROLLER, ibanGecerli } from "./store.js";
import { kasaPdf, kasaPdfDetayli } from "./kasa-pdf.js";
import { takvimPdf } from "./takvim-pdf.js";
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
        ...(s.rez ? { rez: { ad: s.rez.ad, durum: s.rez.durum, kaynak: s.rez.kaynak, ekstra: s.rez.ekstra || [], ...(s.rez.aboneNo ? { aboneNo: s.rez.aboneNo } : {}) } } : {}),
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
    if (r.basarili && r.karar === "onayla" && r.eposta) ctx.waitUntil(kurallarGonder(env, [r.eposta], r.ad, r.rolAd, url.origin));
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
  if (yol === "puantaj/giris" && post) {
    const r = await d.puantajGiris(ben);
    // GELDİM: Admin ve Müdür'e bilgi
    if (r.basarili) ctx.waitUntil((async () => {
      const kime = (await d.rolEpostalari(["admin", "mudur"])).filter((e) => e !== ben.eposta);
      const saat = new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 16);
      await epostaYolla(env, {
        kime, konu: `${ben.ad} işe geldi (${saat})`,
        satirlar: [["Çalışan", `${ben.ad} (${ben.rolAd || ""})`], ["Geldim saati", saat]],
        dugme: { yazi: "Paneli aç", link: `${url.origin}/panel/` }, alt: "Aysu Halı Saha puantaj",
      });
    })().catch((e) => console.error("Geldim e-postası", e)));
    return json(r, r.hata ? 400 : 200);
  }
  if (yol === "puantaj/cikis" && post) {
    const r = await d.puantajCikis(ben);
    // Gün sonu: çalışana o günün özeti (yarım saat yol dahil) e-postayla
    if (r.basarili) ctx.waitUntil(puantajOzetGonder(env, d, ben, r).catch((e) => console.error("Puantaj e-postası", e)));
    return json(r, r.hata ? 400 : 200);
  }

  // Görevler: herkes görür, bugünün görevini "yaptım" diye onaylar → yöneticilere e-posta
  // Liste her hafta sıfırlanır: geçmiş haftaları sadece Admin görür
  if (yol === "videolar" && request.method === "GET") return json(await d.videolar());
  // Temizlik ürünleri stoğu: yöneticiler ve Temizlik Şefi
  if (yol === "temizlik" && (yonetici || ben.rol === "temizlik")) {
    if (request.method === "GET") return json(await d.temizlikUrunleri());
    if (post) { const r = await d.temizlikKaydet((await govdeOku(request)) || {}, ben); return json(r, r.hata ? 400 : 200); }
  }
  if (yol === "gorevler" && request.method === "GET") return json(await d.gorevHafta(ben.rol === "admin" ? url.searchParams.get("bas") : null));
  if (yol === "gorev" && post) {
    const g = (await govdeOku(request)) || {};
    const r = await d.gorevYap(g.id, g.not, ben);
    if (r.hata) return json(r, 400);
    // Görev bilgisi o gün çalışan (GELDİM diyen) yöneticiye gider; Admin'e gitmez
    const kime = (await d.gununYoneticileri(r.gun)).filter((e) => e !== ben.eposta);
    ctx.waitUntil(epostaYolla(env, {
      kime, konu: `Görev yapıldı: ${r.gorev.ad} — ${r.kayit.ad}`,
      satirlar: [["Görev", r.gorev.ad], ["Yapan", `${r.kayit.ad}${r.kayit.rol ? " (" + r.kayit.rol + ")" : ""}`],
        ["Zaman", `${r.gun.split("-").reverse().join(".")} ${r.kayit.saat}`], ...(r.kayit.not ? [["Not", r.kayit.not]] : [])],
      dugme: { yazi: "Görevler sayfası", link: `${url.origin}/panel/#gorevler` },
      alt: "Aysu Halı Saha görev takibi",
    }).catch(() => {}));
    return json(r);
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
  // Abone hareketleri (gelmiyor, son maç, taşıma, yeni abone): Admin + Müdür + Müdür Yardımcısı'na e-posta
  // Fiyat değişince Admin + Müdür + Müdür Yardımcısı'na
  const fiyatBildir = (fark) => yoneticiBildir(`Fiyat değişti: ${fark.map(([a]) => a).join(", ")}`, [...fark, ["Geçerlilik", "Hemen (yeni rezervasyon ve kasalarda). Eski günlerin kasası değişmez."]], "Fiyat e-postası");
  const aboneBildir = (konu, satirlar) => yoneticiBildir(konu, satirlar, "Abone e-postası");
  function yoneticiBildir(konu, satirlar, tur) { ctx.waitUntil((async () => {
    const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
    const ok = await epostaYolla(env, {
      kime, konu,
      satirlar: [...satirlar, ["İşlemi yapan", `${ben.ad} (${ben.rolAd || ""})`]],
      dugme: { yazi: "Paneli aç", link: `${url.origin}/panel/` }, alt: "Aysu Halı Saha · yönetici bildirimi",
    });
    // Gönderilemezse Admin işlem kaydında nedenini görsün
    await d.kayitTut(null, ok ? `${tur} gönderildi` : `${tur.toLocaleUpperCase("tr")} GÖNDERİLEMEDİ`, `${konu} → ${kime.join(", ") || "alıcı yok"}${ok ? "" : " · " + bildirimModulu.sonEpostaHatasi}`);
  })().catch((e) => console.error(tur, e))); }

  switch (`${request.method} ${yol}`) {
    case "POST rez": {
      const r = await d.panelRezEkle({
        gunTarihi: g.gun, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not, durum: g.durum, kapora: g.kapora, ekstra: g.ekstra, kod: ben.rol === "admin" ? g.kod : "", // ücretsiz kod sadece Admin
      });
      // Panelden (telefonla) alınan maç: Admin + Müdür + Müdür Yardımcısı'na bilgi
      if (r.basarili) yoneticiBildir(`Yeni maç kaydı: ${r.gun} ${trTarih(r.tarih)} ${r.saat} — ${r.ad}`, [
        ["Maç", `${r.gun}, ${trTarih(r.tarih)} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon || "—"],
        ["Durum", r.durum], ["Kapora", r.kapora || "—"], ["Ücret", `${r.ucret} TL${(r.ekstra || []).length ? " (VIP dahil)" : ""}`],
        ...(r.not ? [["Not", r.not]] : []), ["Kayıt no", r.kayitNo], ["Kaynak", "Panel (telefon)"]], "Yeni maç e-postası");
      return degisti(r);
    }
    case "POST rez-kod": // ücretsiz maç kodları Admin'e özel
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      return degisti(await d.rezKodUygula(g, ben));
    case "POST rez-guncelle": {
      const r = await d.panelRezGuncelle(g);
      if (r.basarili && r.rez?.aboneBasvuru && r.rez.durum === "Onaylı" && !r.rez.aboneId) ctx.waitUntil(aboneBasvuruIsle(env, d, r.rez.kayitNo).catch(() => {}));
      if (r.basarili && (r.degisen || []).some((x) => x.startsWith("Durum: Onaylı → İptal"))) {
        // Abone başvurusunun ilk maçı iptal edildi: başvuruyla açılan abonelik de kapanır (henüz başlamamış)
        if (r.rez.aboneBasvuru && r.rez.aboneId) {
          const ab = (await d.aboneListe()).find((x) => x.id === r.rez.aboneId);
          const rg = r.rez.isletmeGunu || r.rez.tarih;
          // İlk maçı iptal edilen başvuru: abonelik henüz başlamadıysa (ilk maç / kayıt günü bu gün ya da takvim sonra başlıyor) kapanır
          if (ab && (ab.kural?.ilkMac === rg || ab.kayitTarihi === rg || ab.baslangic > rg)) { await d.aboneSil(ab.id, {}); r.aboneKapandi = true; }
        }
        ctx.waitUntil(iptalBildir(env, d, { ...r.rez, kimden: `${ben.ad} (${ROLLER[ben.rol]?.ad || ""}, panel)`, aboneKapandi: r.aboneKapandi }));
      }
      return degisti(r);
    }
    case "GET aboneler": return json(await d.aboneListe());
    case "POST abone": {
      const r = await d.aboneKaydet({ ...g, epostaZorunlu: true }); // panelden kayıtta abone e-postası zorunlu
      // Yönetici e-postayı yeni girdiyse / değiştirdiyse aboneye kendi sayfasının bağlantısı gider
      if (r.basarili && r.epostaDegisti) ctx.waitUntil((async () => {
        const e = await d.aboneErisim(r.abone.id);
        if (e.basarili) await aboneSayfaGonder(env, e.abone, `${url.origin}/abone/${e.anahtar}`, r.abone.eposta);
      })().catch(() => {}));
      if (r.basarili && !g.id) aboneBildir(`Yeni abone: ${r.abone.no ? "Abone " + r.abone.no + " · " : ""}${r.abone.ad}`, [
        ["Abone", `${r.abone.no ? "Abone " + r.abone.no + " · " : ""}${r.abone.ad}`], ["Telefon", r.abone.telefon || "—"],
        ["Gün / saat", (r.abone.slotlar || []).map((x) => `${GUN_ADLARI[x.gun]} ${x.saat}`).join(", ")], ...(r.abone.depozito ? [["Depozito", r.abone.depozito]] : [])]);
      return degisti(r);
    }
    case "POST abone-sil": {
      if (String(g.neden || "").trim().length < 3) return json({ hata: "Aboneliği sonlandırmak için açıklama yazmanız gerekiyor." }, 400);
      const ab = (await d.aboneListe()).find((x) => x.id === g.id);
      const r = await d.aboneSil(g.id, { sonMacUcretsiz: Boolean(g.sonMacUcretsiz) });
      const ad = ab ? `${ab.no ? "Abone " + ab.no + " · " : ""}${ab.ad}` : g.id;
      const saatleri = ab ? (ab.slotlar || []).map((x) => `${GUN_ADLARI[x.gun]} ${x.saat}`).join(", ") : "";
      if (r && r.basarili) aboneBildir(`Abonelik sonlandırıldı: ${ad}${saatleri ? " — " + saatleri : ""}`, [["Abone", ad], ...(saatleri ? [["Boşalan gün / saat", `${saatleri} (her hafta)`]] : []),
        ["Sonlandırma", new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ").split(" ").map((x, i) => (i ? x : x.split("-").reverse().join("."))).join(" ")], ["Açıklama", String(g.neden).slice(0, 300)],
        ["Son maç", r.sonMac?.kayitNo ? `${trTarih(r.sonMac.g)} ${r.sonMac.saat} — depozito karşılığı ücretsiz` : r.sonMac?.hata ? `yazılamadı: ${r.sonMac.hata}` : "yok (saatleri boşa çıktı)"],
        ...(ab?.depozito ? [["Depozito", `${ab.depozito}${r.depozitoYandi ? " — ilk 3 ay dolmadığı için YANDI" : ""}`]] : r.depozitoYandi ? [["Depozito", "İlk 3 ay dolmadığı için yandı"]] : [])]);
      return degisti(r && r.basarili ? { ...r, ad } : r);
    }
    case "POST abone-atla": {
      const r = await d.aboneAtla(g);
      if (r.basarili && r.tarihler?.length) {
        const ad = `${r.no ? "Abone " + r.no + " · " : ""}${r.ad}`;
        aboneBildir(g.gelmiyor ? `${ad} bu hafta gelmiyor` : `${ad} yine geliyor (gelmiyor işareti kaldırıldı)`, [
          ["Abone", ad], [g.gelmiyor ? "Gelmeyeceği maç" : "Geleceği maç", r.tarihler.map((t) => `${trTarih(t.slice(0, 10))} ${t.slice(11)}`).join(", ")],
          ["Durum", g.gelmiyor ? "Saat boşa çıktı, rezervasyona açık" : "Saat yeniden aboneye ayrıldı"],
          ...(r.hakAsildi ? [["Kural", "Bu ay iptal hakkı aşıldı — kurala göre depozito yanar"]] : [])]);
      }
      return degisti(r);
    }
    case "GET anket":
      if (ben.rol !== "admin" && ben.rol !== "mudur") return json({ hata: "Sadece Admin ve Müdür." }, 403);
      return json(await d.anketOzet(Number(url.searchParams.get("gun")) || 30));
    case "POST kantin-carpan": {
      const r = await d.kantinCarpanKaydet(g, ben);
      if (r.basarili && r.fiyatFark?.length) fiyatBildir(r.fiyatFark);
      return json(r, r.hata ? 400 : 200);
    }
    case "POST abone-not": { const r = await d.aboneNotKaydet(g.id, g.not, ben); return degisti(r); }
    case "POST abone-talep-red": { const r = await d.aboneIptalTalebiReddet(g.id, ben); return json(r, r.hata ? 400 : 200); }
    case "POST abone-link": {
      // Aboneye özel sayfa bağlantısı; istenirse abonenin e-postasına gönderilir
      const r = await d.aboneErisim(g.id);
      if (r.hata) return json(r, 400);
      const link = `${url.origin}/abone/${r.anahtar}`;
      if (g.eposta) {
        const kime = String(g.eposta || r.abone.eposta || "").trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(kime)) return json({ hata: "Geçerli bir e-posta adresi yazın." }, 400);
        const ok = await aboneSayfaGonder(env, r.abone, link, kime);
        return ok ? json({ basarili: true, link, gonderildi: kime }) : json({ hata: "E-posta gönderilemedi." }, 500);
      }
      return json({ basarili: true, link });
    }
    case "POST abone-tasi": {
      const r = await d.aboneTasi(g);
      if (r.basarili) aboneBildir(`Abone maçı taşındı: ${r.ad || ""}`, [["Abone", r.ad || ""], ["Eski", r.eski], ["Yeni (kalıcı)", r.yeni]]);
      return degisti(r);
    }
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
    case "POST avans": return json(await d.avansEkle(g, ben));
    case "POST avans-sil": return json(await d.avansSil(g.anahtar, ben));
    case "GET kasa": { const r = await d.kasaGetir(url.searchParams.get("gun"), ben); return json(alisGizle(r, ben), r.hata ? 403 : 200); }
    case "POST kasa": {
      const r = await d.kasaKaydet(g, ben);
      // Her kayıtta günlük kasa raporu PDF olarak sadece Admin'e gider
      // "Kasayı gönder": önce o gün açık kalan çalışanlara ÇIKTIM yazılır (rapordaki saatler tamam olsun), sonra rapor
      if (r.basarili && !r.otomatik) ctx.waitUntil((async () => {
        const c = await d.puantajHepsiCikis(r.kayit.gun, ben).catch(() => ({ kapanan: [] }));
        for (const x of c.kapanan) await puantajOzetGonder(env, d, x, { gun: r.kayit.gun }).catch((e) => console.error("Puantaj e-postası", e));
        await kasaRaporuGonder(env, d, r.kayit, r.ilkKayit);
        await takvimRaporuGonder(env, d, r.kayit.gun).catch((e) => console.error("Takvim PDF", e));
      })().catch((e) => console.error("Kasa PDF", e)));
      return json(alisGizle(r, ben), r.hata ? 400 : 200);
    }
    case "GET kasa/ay":
      if (ben.rol !== "admin") return json({ hata: "Aylık kasa özeti sadece Admin içindir." }, 403);
      return json(await d.kasaAy(url.searchParams.get("ay") || simdi().tarih.slice(0, 7)));
    case "POST siparis": {
      // Kantin siparişi WhatsApp'tan verildi: yöneticilere bilgi e-postası
      const satirlar = (Array.isArray(g.satirlar) ? g.satirlar : []).map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 60);
      if (!satirlar.length) return json({ hata: "Liste boş." }, 400);
      const temizlik = g.tur === "temizlik", baslik = temizlik ? "Temizlik ürünleri" : "Kantin";
      await d.kayitTut(ben, `${baslik} siparişi verdi`, satirlar.join(", ").slice(0, 280));
      const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
      ctx.waitUntil(epostaYolla(env, {
        kime, konu: `${baslik} siparişi verildi (${satirlar.length} ürün)`,
        satirlar: [["Sipariş veren", `${ben.ad} (${ROLLER[ben.rol]?.ad || ""})`], ["Zaman", simdi().tarih.split("-").reverse().join(".") + " " + simdi().saat], ...satirlar.map((x, i) => [`${i + 1}.`, x])],
        alt: temizlik ? "Sipariş WhatsApp'tan temizlik tedarikçisine gönderildi. Mal gelince Kasa → Temizlik ürünleri'nden stoğu güncelleyin."
          : "Sipariş WhatsApp'tan Tespo'ya gönderildi. Mal gelince Kasa → Kantin stok'tan 'Gelen mal' girin.",
      }).catch((e) => console.error("Sipariş e-postası", e)));
      return json({ basarili: true });
    }
    case "POST kasa/kapora-sil": {
      const r = await d.gelenKaporaSil(g, ben);
      // Yönetici sildiyse Admin'e açıklamasıyla e-posta
      if (r.basarili && ben.rol !== "admin") ctx.waitUntil((async () => epostaYolla(env, {
        kime: await d.rolEpostalari(["admin"]), konu: `Kasadan kapora silindi: ${r.silinen?.ad || g.kayitNo} (${trTarih(r.gun)})`,
        satirlar: [["Kasa günü", trTarih(r.gun)], ["Kapora", r.silinen ? `${r.silinen.ad} — ${r.silinen.mac} maçı · ${Number(r.silinen.tutar).toLocaleString("tr-TR")} TL` : g.kayitNo],
          ["Kayıt no", g.kayitNo], ["Silen", `${ben.ad} (${ben.rolAd || ""})`], ["Açıklama", String(g.neden || "").slice(0, 300)]],
        alt: "Aysu Halı Saha · kasa bildirimi",
      }))().catch(() => {}));
      return json(r, r.hata ? 400 : 200);
    }
    case "POST veresiye-ode": return sonuc(await d.veresiyeOde(g, ben));
    case "POST puantaj/kisi-sil": { const r = await d.puantajKisiSil(g.ay, g.eposta, ben); return json(r, r.hata ? 400 : 200); }
    case "POST puantaj/eposta": {
      // Admin: bir çalışanın aylık maaş dökümü Admin'in e-postasına
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      const ay = /^\d{4}-\d{2}$/.test(g.ay || "") ? g.ay : simdi().tarih.slice(0, 7);
      const k = (await d.puantajAy(ay, g.eposta)).kisiler?.[0];
      if (!k) return json({ hata: "Bu ay için kayıt yok." }, 400);
      const tl = (n) => `${Math.round(n || 0).toLocaleString("tr-TR")} TL`;
      const sa = (n) => `${String(n).replace(".", ",")} saat`;
      const tr = (t) => t.split("-").reverse().join(".");
      const ok = await epostaYolla(env, {
        kime: [ben.eposta], konu: `${k.ad} — ${ay} maaş dökümü: ödenecek ${tl(k.kalan)}`,
        satirlar: [
          ["Çalışan", `${k.ad} (${k.rol})`], ["Saatlik ücret", tl(k.saatlikUcret)],
          ["Çalışılan", `${sa(k.saat)} (${k.gunler.length} gün, yarım saat yol dahil)`], ["Brüt", tl(k.brut)],
          ...(k.kesinti ? [["Personel kantini", `−${tl(k.kesinti)}`]] : []),
          ...(k.avans ? [["Avans / ödemeler", `−${tl(k.avans)}`]] : []),
          ["ÖDENECEK", tl(k.kalan)],
          ...k.gunler.map((x) => [tr(x.gun), `${x.giris || "—"} – ${x.cikis || "açık"} · ${sa(x.saat)}`]),
          ...(k.kantinListe || []).map((x) => [`Kantin ${tr(x.gun)}`, `${tl(x.tutar)} · ${x.urunler || ""}`]),
          ...(k.avansListe || []).map((x) => [`Avans ${tr(x.gun)}`, `${tl(x.tutar)}${x.not ? " · " + x.not : ""}`]),
        ],
        alt: "Aysu Halı Saha puantaj sistemi",
      });
      return ok ? json({ basarili: true }) : json({ hata: "E-posta gönderilemedi." }, 500);
    }
    case "GET iban":
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      return json({ ...(await d.ibanAyar()), gizliKontrol: Boolean(env.IBAN_PARMAK_IZI) });
    case "POST iban": {
      const r = await d.ibanKaydet(g, ben);
      if (!r.basarili) return json(r, 400);
      ctx.waitUntil((async () => epostaYolla(env, {
        kime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
        konu: "Kapora IBAN'ı değiştirildi",
        satirlar: [["Değiştiren", `${ben.ad} (Admin)`], ["Eski IBAN", `${r.eski.no} (${r.eski.alici})`], ["Yeni IBAN", `${r.yeni.no} (${r.yeni.alici})`], ["Zaman", r.yeni.zaman]],
        alt: "Bu değişikliği siz yapmadıysanız hemen Admin'e haber verin.",
      }))().catch((e) => console.error("IBAN e-postası", e)));
      return json({ basarili: true, iban: r.yeni, ozet: await ibanOzeti(r.yeni.no), gizliKontrol: Boolean(env.IBAN_PARMAK_IZI) });
    }
    case "GET kodlar":
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      return json(await d.kodlar());
    case "POST kod": { const r = await d.kodKaydet(g, ben); return json(r, r.hata ? 400 : 200); }
    case "POST videolar": { const r = await d.videolarKaydet(g.liste, ben); return json(r, r.hata ? 400 : 200); }
    case "POST gorevler": { const r = await d.gorevlerKaydet(g.liste, ben); return json(r, r.hata ? 400 : 200); }
    case "POST gorev/geri": // sadece Admin (depo kontrol eder)
      { const r = await d.gorevGeriAl(g.gun, g.id, ben); return json(r, r.hata ? 400 : 200); }
    case "GET rehber": return json(await d.rehber());
    case "POST rehber": { const r = await d.rehberKaydet(g.liste, ben); return json(r, r.hata ? 400 : 200); }
    case "GET urunler": return json(alisGizle({ urunler: await d.urunlerGorunum() }, ben).urunler);
    case "POST urun": {
      // Alış fiyatını sadece Admin değiştirir (diğerleri göremez de)
      // Müdür de yeni alış fiyatı girebilir (göremez); satış fiyatı çarpanla kendiliğinden hesaplanır
      const r = await d.urunKaydet(["admin", "mudur"].includes(ben.rol) ? g : { ...g, alis: undefined }, ben);
      if (r.fiyatFark?.length) fiyatBildir(r.fiyatFark);
      return json(alisGizle(r, ben), r.hata ? 400 : 200);
    }
    case "POST fiyat": {
      const r = await d.fiyatKaydet(g, ben);
      if (r.basarili) onbellegiTemizle(request, ctx);
      if (r.fiyatFark?.length) fiyatBildir(r.fiyatFark);
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
    case "POST kullanici": {
      const r = await d.kullaniciGuncelle(g, ben);
      // Yeni çalışan onaylandı: tesis kuralları ve görevler kendisine e-postayla
      if (r.ilkOnay) ctx.waitUntil(kurallarGonder(env, [r.kullanici.eposta], r.kullanici.ad, r.kullanici.rolAd, url.origin));
      return sonuc(r);
    }
    case "POST admin-devret": {
      const r = await d.adminDevret(g, ben);
      if (r.hata) return json(r, 400);
      ctx.waitUntil(epostaYolla(env, {
        kime: [r.yeniAdmin.eposta, r.eskiAdmin.eposta, ...(await d.rolEpostalari(["mudur", "mudur_yrd"]))],
        konu: `Admin yetkisi devredildi: ${r.eskiAdmin.ad} → ${r.yeniAdmin.ad}`,
        satirlar: [["Yeni Admin", `${r.yeniAdmin.ad} (${r.yeniAdmin.eposta})`], ["Önceki Admin", `${r.eskiAdmin.ad} — artık Müdür`], ["Zaman", new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ")]],
        alt: "Bu işlemi siz yapmadıysanız hemen yeni Admin ile iletişime geçin.",
      }).catch(() => {}));
      return json(r, 200, { "set-cookie": `${OTURUM_CEREZ}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    case "POST kasa/detayli": {
      // Admin: seçili günün detaylı kasa raporu (PDF) e-postasına
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      const k = (await d.kasaGetir(g.gun, ben))?.kayit;
      if (!k || !k.ozet) return json({ hata: "Bu günün kasası henüz kaydedilmedi." }, 400);
      const tarih = k.gun.split("-").reverse().join(".");
      const ok = await epostaYolla(env, {
        kime: [ben.eposta], konu: `Detaylı kasa raporu ${tarih}`,
        satirlar: [["Gün", tarih], ["Kaydeden", `${k.guncelleyen || ""} · ${k.guncelleme || ""}`]],
        alt: "Maç maç tablo, kantin ürünleri ve kâr, ikramlar, veresiye ve tam gün sonu ekteki PDF'te.",
        ekler: [{ ad: `aysu-kasa-detayli-${k.gun}.pdf`, tur: "application/pdf", veri: kasaPdfDetayli(k) }],
      });
      return ok ? json({ basarili: true }) : json({ hata: "E-posta gönderilemedi." }, 500);
    }
    case "POST yedek": {
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      const ok = await yedekGonder(env, d, [ben.eposta], "İsteğiniz üzerine alındı.");
      if (ok) await d.kayitTut(ben, "Veri yedeği aldı (e-posta)");
      return ok ? json({ basarili: true }) : json({ hata: "E-posta gönderilemedi." }, 500);
    }
    case "POST kurallar/gonder": {
      if (ben.rol !== "admin") return json({ hata: "Sadece Admin." }, 403);
      const ok = await kurallarGonder(env, [ben.eposta], ben.ad, ben.rolAd || "Admin", url.origin, true);
      return ok ? json({ basarili: true }) : json({ hata: "E-posta gönderilemedi." }, 500);
    }
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
  // Rolü o an Admin / Müdür / Müdür Yardımcısı olan herkes (yeni atananlar dahil)
  const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
  const ileti = {
    konu: `${r.aboneBasvuru ? "Abonelik başvurusu iptal edildi" : "Rezervasyon iptal edildi"}: ${r.gun || ""} ${r.tarih} ${r.saat}`.replace(/\s+/g, " "),
    satirlar: [["Maç", `${r.gun ? r.gun + ", " : ""}${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad || "-"], ["Telefon", r.telefon || "-"],
      ["Kayıt no", r.kayitNo], ["İptal eden", r.kimden], ...(r.iptalNedeni ? [["Açıklama", r.iptalNedeni]] : []), ["Kapora", r.kapora ? `${r.kapora} (iade yok)` : "-"],
      ...(r.aboneBasvuru ? [["Abonelik", r.aboneKapandi ? "Başvuruyla açılan abonelik de kapatıldı" : "Abone başvurusuydu"]] : [])],
  };
  if (kime.length) await epostaYolla(env, { kime, ...ileti });
  else await bildir(env, ileti);
}

/** Müşteriye dönen rezervasyon özeti (onay ekranı). */
/**
 * Gizli IBAN kontrolü: Cloudflare'de Secret olarak tanımlı IBAN_PARMAK_IZI (IBAN'ın SHA-256 özeti) ile
 * sistemdeki IBAN karşılaştırılır. Tutmazsa (kod ya da veri izinsiz değişmişse) müşteriye IBAN GÖSTERİLMEZ
 * ve Admin, Müdür, Müdür Yardımcısı'na acil e-posta gider.
 */
async function ibanOzeti(no) {
  const s = ibanGecerli(no) || "";
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function guvenliIban(env, d, ctx, nereden = "") {
  const ib = await d.ibanAyar();
  if (!env.IBAN_PARMAK_IZI) return ib;
  if ((await ibanOzeti(ib.no)) === String(env.IBAN_PARMAK_IZI).trim().toLowerCase()) return ib;
  const is = (async () => {
    if (!(await d.ibanUyariZamani())) return;
    await d.kayitTut(null, "IBAN GÜVENLİK UYARISI", `Sistemdeki IBAN onaylı IBAN ile tutmuyor: ${ib.no} (${ib.alici}) · ${nereden}`);
    const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
    await epostaYolla(env, {
      kime, konu: "Önemli: Sitedeki kapora IBAN'ı değişmiş görünüyor",
      satirlar: [["Sistemdeki IBAN", ib.no], ["Hesap adı", ib.alici], ["Son değiştiren", `${ib.guncelleyen || "-"} ${ib.zaman || ""}`], ["Nerede fark edildi", nereden || "-"]],
      alt: "Bu IBAN onayladığınız IBAN değil. Güvenlik için müşterilere IBAN gösterilmiyor ve dekont onayı durdu. Panelden ve Cloudflare'den kontrol edin; değişikliği siz yapmadıysanız şifreleri değiştirin.",
    });
  })().catch((e) => console.error("IBAN uyarısı", e));
  if (ctx) ctx.waitUntil(is); else await is;
  return null;
}

const rezCevap = (r, ib) => ({
  basarili: true, kayitNo: r.kayitNo, tarih: r.tarih, gun: r.gun, saat: r.saat, durum: r.durum, ad: r.ad, ucretsiz: Boolean(r.ucretsiz), abone: Boolean(r.aboneBasvuru),
  ucret: r.ucret, kapora: r.ucretsiz ? 0 : r.kaporaTutar ?? FIYATLAR.kapora,
  // Maç günü ödenecek: abone başvurusunda depozito da eklenir (depozito şimdi IBAN'a ödeniyorsa maç ücretinin tamamı kalır)
  kalan: r.aboneBasvuru?.depozitoIban ? r.ucret : r.ucret - (r.ucretsiz ? 0 : r.kaporaTutar ?? FIYATLAR.kapora) + (r.aboneBasvuru ? Number(r.aboneBasvuru.depozito) || 0 : 0),
  ...(r.aboneBasvuru ? { depozito: Number(r.aboneBasvuru.depozito) || 0, depozitoIban: Boolean(r.aboneBasvuru.depozitoIban) } : {}),
  iban: ib?.no || null, alici: ib?.alici || null, opsiyonBitis: r.opsiyonBitis || null, dekont: Boolean(r.dekont),
  // Telefon saati yanlış olabilir: kalan süre sunucudan milisaniye olarak
  opsiyonKalan: r.opsiyonBitis ? Math.max(0, r.opsiyonBitis - Date.now()) : null,
});

/** Dekontu okur, kurallara göre değerlendirir ve sonucu rezervasyona yazar. */
async function dekontKontrolEt(env, d, rez, veri) {
  const ib = await guvenliIban(env, d, null, "dekont kontrolü");
  const kurallar = {
    iban: ib?.no || "IBAN-ONAYSIZ", alici: ib?.alici || "-", kapora: rez.kaporaTutar ?? FIYATLAR.kapora,
    rezTarihi: String(rez.olusturma || "").slice(0, 10) || null, bugun: simdi().tarih,
    tarihKontrol: KURALLAR.dekontTarihKontrol, enAzTutar: KURALLAR.dekontEnAzTutar || 0,
    // Abone depozitosu IBAN'a: dekontta en az depozito tutarı okunmalı, altı / okunamayan kabul edilmez
    ...(rez.aboneBasvuru?.depozitoIban ? { enAzTutar: Number(rez.aboneBasvuru.depozito) || 0, tutarZorunlu: true } : {}),
  };
  // Bir model IBAN'ı / adı okuyamazsa sıradaki model de denenir, okumalar birleştirilir
  const okunan = await dekontOku(env, { tur: rez.dekont.tur, veri }, { yeterli: (o) => dekontDegerlendir(o, kurallar).onay });
  const deger = dekontDegerlendir(okunan, kurallar);
  const k = await d.dekontSonuc(rez.kayitNo, await ozet(veri), deger);
  if (k.onay && k.rez?.aboneBasvuru) await aboneBasvuruIsle(env, d, rez.kayitNo, { tur: rez.dekont?.tur, veri }).catch((e) => console.error("Abone başvurusu", e));
  return { okunan, k, deger };
}

/** Kaporası onaylanan abone başvurusu → abone kaydı + yöneticilere e-posta */
async function aboneBasvuruIsle(env, d, kayitNo, dekont = null) {
  const r = await d.aboneBasvuruKabul(kayitNo);
  if (!r) return;
  // Abone e-posta bıraktıysa kendi sayfasının bağlantısı gönderilir
  if (r.basarili && r.abone?.eposta) {
    const e = await d.aboneErisim(r.abone.id);
    if (e.basarili) await aboneSayfaGonder(env, e.abone, `https://aysuhalisaha.com/abone/${e.anahtar}`, r.abone.eposta);
  }
  const rz = r.rez || {};
  const uzanti = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[dekont?.tur] || "jpg";
  // İşletme adresi + Admin, Müdür, Müdür Yardımcısı: tek e-posta (rezervasyon e-postası ayrıca gitmez)
  await bildir(env, {
    ekKime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
    ...(dekont?.veri ? { ekler: [{ ad: `dekont-${rz.kayitNo}.${uzanti}`, tur: dekont.tur, veri: dekont.veri }] } : {}),
    konu: r.basarili ? `Yeni abone (online): ${rz.ad} — her hafta ${rz.gun} ${rz.saat}` : `Abone başvurusu kaydedilemedi: ${rz.ad}`,
    satirlar: [["Abone", `${r.abone ? "Abone " + r.abone.no + " · " : ""}${rz.ad}`], ["Telefon", rz.telefon || "—"],
      ["İlk maç", `${trTarih(r.ilkMac || rz.isletmeGunu)} ${rz.saat}`], ["Her hafta", `${rz.gun} ${rz.saat}`],
      [rz.aboneBasvuru?.depozitoIban ? "Depozito (IBAN)" : "Kapora", `${rz.kapora || "?"} TL${dekont?.veri ? " (dekont ekte)" : ""}`],
      ["İlk maçta alınacak", rz.aboneBasvuru?.depozitoIban ? `${Number(rz.ucret || 0).toLocaleString("tr-TR")} TL maç ücreti (depozito ödendi)`
        : `${Number(rz.ucret || 0).toLocaleString("tr-TR")} TL maç + ${Number(rz.aboneBasvuru?.depozito || 0).toLocaleString("tr-TR")} TL depozito − kapora`],
      ["Kurallar", "Müşteri abonelik kurallarını online onayladı (" + (rz.aboneBasvuru?.kabul || "") + ")"],
      ...(r.uyari ? [["Uyarı", r.uyari]] : []), ...(r.hata ? [["Hata", r.hata]] : [])],
    alt: "Aysu Halı Saha · abone bildirimi",
  });
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
  const calisilan = gunK.saat - KURALLAR.puantajYolSaat; // yarım saate yuvarlanmış
  await epostaYolla(env, {
    kime: [ben.eposta], konu: `Çalışma özeti ${r.gun.split("-").reverse().join(".")}: ${sa(gunK.saat)}`,
    satirlar: [
      ["Geldim", gunK.giris], ["Çıktım", gunK.cikis], ["Çalışılan (yarım saate yuvarlı)", sa(calisilan)], ["Yol", sa(KURALLAR.puantajYolSaat)],
      ["Toplam", sa(gunK.saat)],
      ...(kisi.saatlikUcret ? [["Bugünkü ücret", tl(gunK.saat * kisi.saatlikUcret)]] : []),
      ["Bu ay toplam", `${sa(kisi.saat)}${kisi.saatlikUcret ? " · " + tl(kisi.brut) : ""}`],
      ...(kisi.kesinti ? [["Bu ay personel kantini", `${tl(kisi.kesinti)} (ay sonu maaştan düşülür)`]] : []),
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
  // O gün çalışanlar: saat ve ücret (puantajdan)
  const ay = await d.puantajAy(k.gun.slice(0, 7)).catch(() => null);
  const calisanlar = (ay?.kisiler || []).map((p) => {
    const g = p.gunler.find((x) => x.gun === k.gun);
    return g ? { ad: p.ad, rol: p.rol, giris: g.giris, cikis: g.cikis, saat: g.saat, ucret: Math.round(g.saat * (p.saatlikUcret || 0)) } : null;
  }).filter(Boolean);
  const maclar = (k.maclar || []).filter((m) => m.tur !== "bos");
  await epostaYolla(env, {
    kime, konu: `Kasa raporu ${tarih}${ilk ? "" : " (güncellendi)"} — kasa toplamı ${para(o.kasaToplam - o.cikis - o.avans)}`,
    satirlar: [
      [`Oynanan maçlar (${maclar.length})`, `${para(o.mac + o.vip - o.onOdeme)}${o.onOdeme ? " (önceden alınan kapora düşülmüş)" : ""}`],
      ["Kantin", para(o.kantin)],
      [`Krampon / eldiven (${o.kramponAdet} / ${o.eldivenAdet})`, para(o.krampon + o.eldiven)],
      ["Kasa girişi (kapora + veresiye + diğer)", `${para(o.gelenKapora + o.giris + (o.veresiyeTahsil || 0))}${o.gelenKapora ? ` (kapora ${para(o.gelenKapora)})` : ""}${o.veresiyeTahsil ? ` (veresiye ${para(o.veresiyeTahsil)})` : ""}`],
      ["Kasa çıkışı (harcama + avans)", o.cikis || o.avans ? `${para(o.cikis + o.avans)}${o.avans ? ` (avans ${para(o.avans)})` : ""}` : "harcama yok"],
      ["Çalışanlar", calisanlar.length ? calisanlar.map((c) => `${c.ad} ${String(c.saat).replace(".", ",")} sa · ${para(c.ucret)}`).join(", ") : "—"],
      ["Kasa devri (ertesi gün)", k.birakilan !== null && k.birakilan !== undefined ? para(k.birakilan) : "girilmedi"],
      ["KASA TOPLAMI (harcamalar çıkmış)", para(o.kasaToplam - o.cikis - o.avans)],
    ],
    alt: `Kaydeden: ${k.guncelleyen} · ${k.guncelleme}. Ayrıntı ekteki PDF'te.`,
    ekler: [{ ad: `aysu-kasa-${k.gun}.pdf`, tur: "application/pdf", veri: kasaPdf(k, { calisanlar }) }],
  });
}

/** Kasa gönderilince: ertesi günün haftasının takvimi (PDF) Admin ve Müdür'e */
async function takvimRaporuGonder(env, d, gun) {
  const kime = await d.rolEpostalari(["admin", "mudur"]);
  if (!kime.length) return;
  const h = await d.panelHafta(gunEkle(gun, 1));
  const say = (t) => h.gunler.reduce((n, g) => n + g.saatler.filter((s) => s.tur === t).length, 0);
  const aralik = `${trTarih(h.gunler[0].tarih)} – ${trTarih(h.gunler[6].tarih)}`;
  await epostaYolla(env, {
    kime, konu: `Haftalık takvim ${aralik}`,
    satirlar: [["Hafta", aralik], ["Rezervasyon", `${say("rez")} saat`], ["Abone", `${say("abone")} saat`], ["Abone gelmiyor (boş)", `${say("abone-gelmiyor")} saat`]],
    alt: "Haftanın tablosu ekteki PDF'te. Kasa gönderildiğinde otomatik gelir.",
    ekler: [{ ad: `aysu-takvim-${h.gunler[0].tarih}.pdf`, tur: "application/pdf", veri: takvimPdf(h) }],
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
    case "abone-sil": return `${r.ad || g.id} · açıklama: ${String(g.neden || "").slice(0, 150)}${r.sonMac?.kayitNo ? ` · son maç ücretsiz (depozito): ${r.sonMac.g} ${r.sonMac.saat}` : ""}`;
    case "abone-tasi": return `${r.ad || ""} · ${r.eski} → ${r.yeni} (kalıcı)`;
    case "abone-atla": return `${g.gun} ${g.saat || ""} · ${g.gelmiyor ? "gelmiyor" : "geliyor"} (${g.kapsam || "saat"})`;
    case "musteri-not": return `${g.telefon || ""} · etiket: ${g.etiket || "—"} · not: ${String(g.not || "—").slice(0, 80)}`;
    case "kullanici": return `${g.eposta} · ${[g.rol, g.durum].filter(Boolean).join(" · ")}`;
    case "kullanici-sil": return `${g.eposta}`;
    case "puantaj/duzelt": return "";
    default: return "";
  }
}

/** Tesis kuralları ve görevler e-postası (yeni onaylanan çalışana; örnek = Admin'e deneme) */
/** Veri yedeğini (JSON) e-postayla gönderir */
async function yedekGonder(env, d, kime, neden = "") {
  const y = await d.yedek();
  const json = new TextEncoder().encode(JSON.stringify(y, null, 1));
  const tarih = y.olusturma.slice(0, 10);
  const ADLAR = { r: "Rezervasyon", a: "Abone", m: "Müşteri notu", kasa: "Kasa günü", urun: "Kantin ürünü", tu: "Temizlik ürünü", p: "Puantaj günü", av: "Avans", vr: "Veresiye", u: "Kullanıcı", l: "İşlem kaydı", gv: "Görev onayı", ayar: "Ayar" };
  return epostaYolla(env, {
    kime, konu: `Aysu Halı Saha yedeği — ${y.olusturma}`,
    giris: `${neden ? neden + " " : ""}Sitedeki bütün kayıtların yedeği ektedir (aysu-yedek-${tarih}.json). Bu dosyayı güvenli bir yerde saklayın; kişisel veri içerir.`,
    satirlar: [["Toplam kayıt", String(y.anahtarSayisi)], ["Boyut", `${Math.round(json.length / 1024)} KB`],
      ...Object.entries(y.sayac).filter(([k]) => ADLAR[k]).map(([k, n]) => [ADLAR[k], String(n)]),
      ["Kod", "Sitenin kodu GitHub'da: github.com/iecccomtr/aysu-rezervasyon"]],
    alt: "Güvenlik için oturumlar, şifreler ve dekont / fotoğraf dosyaları yedeğe konmadı. Yedek her Pazartesi otomatik gelir.",
    ekler: [{ ad: `aysu-yedek-${tarih}.json`, tur: "application/json", veri: json }],
  });
}

const GUN_ADLARI = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"]; // abone slot günü: 0 = Pazartesi
const trTarih = (t) => String(t || "").split("-").reverse().join(".");

/** Aboneye kendi sayfasının bağlantısı */
function aboneSayfaGonder(env, a, link, kime) {
  return epostaYolla(env, {
    kime: [kime], konu: `Aysu Halı Saha abone sayfanız${a.no ? " — Abone " + a.no : ""}`,
    giris: `Merhaba ${a.ad}, aboneliğinize ait size özel sayfanız hazır. Buradan maç günlerinizi görebilir, gelemeyeceğiniz haftayı bildirebilir, kantin harcamalarınızı ve açık veresiyenizi takip edebilirsiniz.`,
    satirlar: [["Saatleriniz", slotlarYazi(a)], ...(a.depozito ? [["Depozito", a.depozito]] : [])],
    dugme: { yazi: "Abone sayfamı aç", link },
    alt: "Bu bağlantı size özeldir, başkalarıyla paylaşmayın. — Aysu Halı Saha, 0 555 510 26 26",
  }).catch(() => false);
}
const slotlarYazi = (a) => (Array.isArray(a.slotlar) ? a.slotlar : []).map((x) => `${GUN_ADLARI[x.gun]} ${x.saat}`).join(", ");

function kurallarGonder(env, kime, ad, rolAd, koken = "https://aysuhalisaha.com", ornek = false) {
  return epostaYolla(env, {
    kime, konu: `${ornek ? "[Örnek] " : ""}Aysu Halı Saha'ya hoş geldiniz — tesis kuralları ve görevler`,
    giris: `Merhaba ${ad || ""}, hesabınız ${rolAd ? rolAd + " olarak " : ""}onaylandı. Aşağıdaki kurallar halı saha yönetimine aittir; lütfen dikkatle okuyun ve uygulayın.`,
    satirlar: [["Panel", `${koken}/panel/`], ["İşe gelince", "Panelde GELDİM, çıkarken ÇIKTIM"], ["Görevler", "Panelde Görevler sayfası → işi bitirince Yaptım"]],
    bolumler: TESIS_KURALLARI,
    dugme: { yazi: "Panele gir", link: `${koken}/panel/` },
    alt: "HALISAHA YÖNETİMİNE AİTTİR · Aysu Halı Saha",
  }).catch((e) => { console.error("Kurallar e-postası", e); return false; });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const yol = url.pathname;
    // Tek adres: www.aysuhalisaha.com → aysuhalisaha.com (Google'da iki ayrı site gibi görünmesin)
    if (url.hostname === "www.aysuhalisaha.com") {
      url.hostname = "aysuhalisaha.com";
      return Response.redirect(url.toString(), 301);
    }

    if (yol === "/api/saglik") return json({ tamam: true, depo: "cloudflare" });

    if (yol.startsWith("/api/panel/")) {
      try {
        return await panel(request, env, ctx, yol.slice("/api/panel/".length));
      } catch (e) {
        console.error("Panel hatası", yol, e);
        // Nedeni görünsün (sorunu bulmak için): hangi işlem, hangi hata
        const neden = String(e?.message || e).slice(0, 160);
        ctx.waitUntil(depo(env).kayitTut(null, "SUNUCU HATASI", `${request.method} ${yol} · ${neden}`).catch(() => {}));
        return json({ hata: `Sunucu hatası (${yol.slice("/api/panel/".length)}): ${neden}` }, 500);
      }
    }

    // Rezervasyon sayfası: önümüzdeki günlerin tüm saatleri (boş/dolu). Kişisel veri içermez.
    // ---- Kantin fiyat listesi (sahadaki QR → /kantin): canlı satış fiyatları, stok / alış gösterilmez ----
    if (yol === "/kantin") return Response.redirect(url.origin + "/kantin/", 301);
    if (yol === "/api/kantin" && request.method === "GET") {
      const l = (await depo(env).urunlerGorunum()).filter((u) => u.aktif !== false && u.satis > 0)
        .map((u) => ({ ad: u.ad, satis: u.satis, yok: !u.bagli && (u.stok || 0) <= 0 }));
      const f = await depo(env).fiyatAyar();
      return json({ urunler: l, kira: { krampon: f.krampon, eldiven: f.eldiven } }, 200, { "cache-control": "no-store" });
    }

    // ---- Memnuniyet anketi ----
    if (yol === "/anket") return Response.redirect(url.origin + "/anket/", 301);
    if (yol === "/api/anket" && request.method === "GET") return json({ sorular: ANKET_SORULARI });
    if (yol === "/api/anket" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "anket")) return cokFazla();
      const g = (await govdeOku(request)) || {};
      if (g.web) return json({ basarili: true }); // bot tuzağı
      const d = depo(env);
      const r = await d.anketKaydet(g);
      if (r.hata) return json(r, 400);
      // Düşük puan (1–2) ya da "tavsiye etmem": Admin ve Müdür'e hemen haber
      if (r.dusuk) ctx.waitUntil((async () => epostaYolla(env, {
        kime: await d.rolEpostalari(["admin", "mudur"]), konu: "Memnuniyet anketi: düşük puan",
        satirlar: [...ANKET_SORULARI.filter((q) => r.kayit.puan[q.id]).map((q) => [q.soru, `${r.kayit.puan[q.id]} / 5`]),
          ["Tavsiye eder mi", { evet: "Evet", belki: "Belki", hayir: "Hayır" }[r.kayit.tavsiye] || "—"], ["Öneri / şikâyet", r.kayit.oneri || "—"],
          ["Ad", r.kayit.ad || "—"], ["Telefon", r.kayit.telefon || "—"]],
        alt: "Aysu Halı Saha · memnuniyet anketi",
      }))().catch(() => {}));
      return json({ basarili: true });
    }

    // ---- Abone sayfası (aboneye özel bağlantı) ----
    if (yol.startsWith("/abone/") && !yol.startsWith("/abone/index")) {
      const sayfa = await env.ASSETS.fetch(new Request(url.origin + "/abone/index.html", { headers: request.headers }));
      return new Response(sayfa.body, { status: sayfa.status, headers: { ...Object.fromEntries(sayfa.headers), "x-robots-tag": "noindex", "cache-control": "no-store" } });
    }
    if (yol.startsWith("/api/abone")) {
      const d = depo(env);
      if (request.method === "GET" && yol === "/api/abone") {
        if (await sinirAsildi(env, request, "abone")) return cokFazla();
        const r = await d.aboneSayfa(url.searchParams.get("t"));
        return json(r, r.hata ? 404 : 200, { "cache-control": "no-store" });
      }
      if (request.method === "POST" && ayniKaynak(request)) {
        if (await sinirAsildi(env, request, "abone")) return cokFazla();
        const g = (await govdeOku(request)) || {};
        if (yol === "/api/abone/gelmiyor") {
          const r = await d.aboneKendiAtla(g.t, { gun: g.gun, saat: g.saat, gelmiyor: g.gelmiyor !== false, zorla: Boolean(g.zorla) });
          if (r.basarili) {
            onbellegiTemizle(request, ctx);
            const ad = `${r.no ? "Abone " + r.no + " · " : ""}${r.ad}`;
            ctx.waitUntil((async () => epostaYolla(env, {
              kime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
              konu: g.gelmiyor !== false ? `${ad} bu hafta gelmiyor (abone bildirdi)` : `${ad} yine geliyor (abone bildirdi)`,
              satirlar: [["Abone", ad], ["Maç", (r.tarihler || []).map((t) => `${trTarih(t.slice(0, 10))} ${t.slice(11)}`).join(", ")],
                ["Bildiren", "Abonenin kendisi (abone sayfasından)"], ...(r.hakAsildi ? [["Kural", "Bu ay iptal hakkı aşıldı — kurala göre depozito yanar"]] : [])],
              alt: "Aysu Halı Saha · abone bildirimi",
            }))().catch(() => {}));
          }
          return json(r, r.hata ? 400 : 200);
        }
        if (yol === "/api/abone/iptal") {
          const r = await d.aboneIptalTalebi(g.t, { neden: g.neden });
          if (r.basarili) ctx.waitUntil((async () => epostaYolla(env, {
            kime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
            konu: `Abonelik iptal talebi: ${r.abone.no ? "Abone " + r.abone.no + " · " : ""}${r.abone.ad}`,
            satirlar: [["Abone", `${r.abone.no ? "Abone " + r.abone.no + " · " : ""}${r.abone.ad}`], ["Telefon", r.abone.telefon || "—"],
              ["Neden", r.talep.neden || "—"], ["Depozito", r.abone.depozito || "—"],
              ["Kural", r.talep.taahhut ? "İlk 3 ay dolmadı: kurala göre depozito yanar" : "3 ay doldu: depozito karşılığı ücretsiz son maç hakkı var"],
              ["Yapılacak", "Panelde Aboneler → abone → Aboneliği sonlandır"]],
            alt: "Aysu Halı Saha · abone bildirimi",
          }))().catch(() => {}));
          return json(r, r.hata ? 400 : 200);
        }
      }
      return json({ hata: "Bulunamadı" }, 404);
    }

    if (yol === "/api/musaitlik" && request.method === "GET") {
      return onbellekli(request, ctx, 10, async () => {
        try {
          const f = await depo(env).fiyatAyar();
          return json({
            gunler: await gunleriGetir(env), fiyat: f.mac, aboneFiyat: f.abone, aboneSaati: KURALLAR.aboneUcretSaati, aboneKurallari: ABONE_KURALLARI, kapora: f.kapora,
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
        const r = await depo(env).olustur({ gunTarihi: g.tarih, saat: g.saat, ad: g.ad, telefon: g.telefon, not: g.not || "", ekstra: g.ekstra, kod: g.abone ? "" : g.kod, abone: Boolean(g.abone), kurallarKabul: Boolean(g.kurallarKabul), depozitoIban: Boolean(g.abone && g.depozitoIban), eposta: g.abone ? g.eposta : undefined });
        if (!r.basarili) return json(r, 409);
        onbellegiTemizle(request, ctx);
        // Ücretsiz kodla yapılan rezervasyon hemen kesinleşir: yöneticilere bilgi
        if (r.ucretsiz) ctx.waitUntil((async () => { const d2 = depo(env); await bildir(env, {
          ekKime: await d2.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
          konu: `Yeni rezervasyon (ücretsiz maç): ${r.gun} ${r.saat}`,
          satirlar: [["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Kayıt no", r.kayitNo],
            ["Ücretsiz", r.ucretsiz.neden], ["Ücret", r.ucret ? `${r.ucret} TL (VIP)` : "Ücretsiz"]],
        }); })().catch((e) => console.error("Kod e-postası", e)));
        // E-posta gönderilmez: kapora (dekont) doğrulanınca "Yeni rezervasyon" e-postası gider
        return json(rezCevap(r, await guvenliIban(env, depo(env), ctx, "rezervasyon")));
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
        const { okunan, k, deger } = await dekontKontrolEt(env, d, r, veri);
        if (k.onay) onbellegiTemizle(request, ctx);
        const uzanti = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[r.dekont.tur];
        // Sadece bu dekontla kesinleşen rezervasyon için "Yeni rezervasyon" e-postası
        // (doğrulanamayan dekont ya da kaporanın ikinci parçası için e-posta yok; eksik kapora 15 dk sonra bildirilir)
        // Abone başvurusunda ayrı "Yeni rezervasyon" e-postası gitmez: tek e-posta "Yeni abone (online)" (dekont ekli)
        if (k.onay && r.durum !== "Onaylı" && !r.aboneBasvuru) ctx.waitUntil((async () => bildir(env, {
          // İşletme adresi + Admin, Müdür ve Müdür Yardımcısı (rolü o an olan herkes)
          ekKime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
          konu: `Yeni rezervasyon: ${r.gun} ${r.saat} (${r.kayitNo})`,
          satirlar: [["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Kayıt no", r.kayitNo],
            ["VIP", r.ekstra?.length ? r.ekstra.map((x) => EKSTRALAR[x].ad).join(", ") : "-"], ["Toplam ücret", `${r.ucret} TL`],
            ["Kapora", `${k.rez.kapora || "?"} TL (dekont ekte)`], ["Durum", "Onaylı — kapora dekontla doğrulandı"]],
          ekler: [{ ad: `dekont-${r.kayitNo}.${uzanti}`, tur: r.dekont.tur, veri }],
        }))());
        // Tutar okunamadı ama IBAN / hesap adı doğru: onaylandı, Müdür ve Müdür Yardımcısı dekontu kontrol etsin
        if (k.onay && deger?.tutarOkunamadi) ctx.waitUntil((async () => {
          const kime = await d.rolEpostalari(["mudur", "mudur_yrd"]);
          if (!kime.length) return;
          await epostaYolla(env, {
            kime, konu: `Dekont kontrolü: tutar okunamadı — ${r.gun} ${r.saat} (${r.kayitNo})`,
            satirlar: [["Maç", `${r.gun}, ${r.tarih} saat ${r.saat}`], ["Ad soyad", r.ad], ["Telefon", r.telefon], ["Kayıt no", r.kayitNo],
              ["Beklenen kapora", `${r.kaporaTutar ?? "?"} TL`], ["Durum", "Onaylandı (IBAN ve hesap adı doğru), tutar okunamadı"]],
            alt: "Ekteki dekontta tutarı kontrol edin (en az 500 TL). Sorun varsa panelden kapora tutarını düzeltin ya da rezervasyonu iptal edin.",
            ekler: [{ ad: `dekont-${r.kayitNo}.${uzanti}`, tur: r.dekont.tur, veri }],
          });
        })().catch((e) => console.error("Dekont kontrol e-postası", e)));
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
      return json({ ...rezCevap(r, await guvenliIban(env, depo(env), ctx, "rezervasyon kontrol")), ad: r.ad, kaporaOdenen: r.kapora || null, ekstra: (r.ekstra || []).map((x) => EKSTRALAR[x]?.ad || x),
        opsiyonKalan: r.durum === "Kapora bekleniyor" && r.opsiyonBitis ? Math.max(0, r.opsiyonBitis - Date.now()) : null });
    }

    // Bağlantısı kopan müşteri opsiyonlu saatine dokunup telefonunu yazınca kaldığı yerden devam eder
    if (yol === "/api/opsiyon-devam" && request.method === "POST") {
      if (!ayniKaynak(request)) return json({ hata: "Yetkisiz istek." }, 403);
      if (await sinirAsildi(env, request, "iptal")) return cokFazla();
      const g = await govdeOku(request);
      if (!g) return json({ hata: "Geçersiz istek." }, 400);
      const r = await depo(env).opsiyonDevam(g);
      return r.basarili ? json(rezCevap(r, await guvenliIban(env, depo(env), ctx, "opsiyon devam"))) : json(r, 400);
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
    // Duvardaki "Abone kayıt" QR'ı: rezervasyon sayfası abonelik seçili açılır
    if (yol === "/abone-ol" || yol === "/abone-ol/") return Response.redirect(url.origin + "/rezervasyon/?abone=1", 302);
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
      // Önce yedek (temizlikten önceki hâl), sonra temizlik
      ctx.waitUntil((async () => {
        const d = depo(env);
        await yedekGonder(env, d, await d.rolEpostalari(["admin"]), "Haftalık otomatik yedek.").catch((e) => console.error("Yedek", e));
        console.log("Haftalık temizlik", JSON.stringify(await d.haftaTemizle()));
      })());
      return;
    }
    // 5 dakikada bir: dekontu gelmeyen online opsiyonları düşür, işletmeye haber ver
    ctx.waitUntil(depo(env).opsiyonlariDusur());
    // Tek seferlik: tesis kuralları e-postasının örneği Admin'e
    ctx.waitUntil((async () => {
      const d = depo(env);
      const kime = await d.rolEpostalari(["admin"]);
      if (kime.length && epostaKurulu(env) && (await d.birKez("ayar:kurallarOrnek"))) await kurallarGonder(env, kime, "Admin", "Admin", "https://aysuhalisaha.com", true);
      if (kime.length && epostaKurulu(env) && (await d.birKez("ayar:yedekIlk"))) await yedekGonder(env, d, kime, "İlk yedek.");
    })().catch(() => {}));
    // Gizli IBAN kontrolü: sistemdeki IBAN + sitenin sayfalarında yazan IBAN'lar onaylı IBAN mı?
    if (new Date().getUTCMinutes() < 5) ctx.waitUntil((async () => {
      const d = depo(env);
      const ib = await guvenliIban(env, d, null, "saatlik kontrol");
      if (!ib) return;
      const onayli = ibanGecerli(ib.no);
      for (const sayfa of ["/rezervasyon/", "/", "/kvkk.html"]) {
        const html = await (await env.ASSETS.fetch(new Request("https://aysuhalisaha.com" + sayfa))).text().catch(() => "");
        const bulunan = [...html.toUpperCase().matchAll(/TR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}/g)].map((m) => m[0].replace(/\s/g, ""));
        const yabanci = bulunan.filter((x) => x !== onayli);
        if (yabanci.length && (await d.ibanUyariZamani())) {
          await d.kayitTut(null, "IBAN GÜVENLİK UYARISI", `${sayfa} sayfasında onaysız IBAN: ${yabanci.join(", ")}`);
          await epostaYolla(env, {
            kime: await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]),
            konu: "Önemli: Site sayfasında farklı bir IBAN var",
            satirlar: [["Sayfa", `aysuhalisaha.com${sayfa}`], ["Bulunan IBAN", yabanci.join(", ")], ["Onaylı IBAN", ib.no]],
            alt: "Sitenin dosyaları izinsiz değiştirilmiş olabilir. GitHub ve Cloudflare'de son değişiklikleri kontrol edin.",
          });
        }
      }
    })().catch((e) => console.error("IBAN kontrolü", e)));
    // Her ayın son günü o ayın maaş özeti Admin'e
    ctx.waitUntil((async () => {
      const d = depo(env);
      const ay = await d.maasRaporuZamani();
      if (!ay) return;
      const p = await d.puantajAy(ay);
      const kime = await d.rolEpostalari(["admin"]);
      if (!kime.length) return;
      const tl = (n) => `${Math.round(n || 0).toLocaleString("tr-TR")} TL`;
      const AY = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
      const ayAd = `${AY[Number(ay.slice(5)) - 1]} ${ay.slice(0, 4)}`;
      const toplam = p.kisiler.reduce((t, k) => t + k.kalan, 0);
      await epostaYolla(env, {
        kime, konu: `${ayAd} maaş ödemeleri — toplam ${tl(toplam)}`,
        satirlar: [
          ...p.kisiler.map((k) => [`${k.ad} (${k.rol})`,
            `${String(k.saat).replace(".", ",")} saat × ${k.saatlikUcret} TL = ${tl(k.brut)}${k.kesinti ? ` − kantin ${tl(k.kesinti)}` : ""}${k.avans ? ` − avans ${tl(k.avans)}` : ""} → ÖDENECEK ${tl(k.kalan)}`]),
          ["TOPLAM ÖDENECEK", tl(toplam)],
        ],
        alt: "Saatlere günlük yarım saat yol dahildir. Bu e-posta ayın son günü sabah hazırlandı; bu akşamın vardiyası ve sonraki kantin / avans girişleri panelde Kullanıcılar → Puantaj bölümünde güncel görünür.",
      });
    })().catch((e) => console.error("Maaş raporu", e)));
    // İş başı saati geldi ama hiçbir çalışan GELDİM demedi → Admin, Müdür ve Müdür Yardımcısı'na uyarı
    ctx.waitUntil((async () => {
      const d = depo(env);
      const u = await d.acilisKontrol();
      if (!u) return;
      const kime = await d.rolEpostalari(["admin", "mudur", "mudur_yrd"]);
      if (!kime.length) return;
      await epostaYolla(env, {
        kime, konu: `Uyarı: İşyeri açılmadı — çalışan görünmüyor (${u.gunAd} ilk maç ${u.ilkMac})`,
        satirlar: [["Gün", `${u.gunAd} ${u.gun.split("-").reverse().join(".")}`], ["İş başı", u.baslama], ["İlk maç", u.ilkMac], ["Son maç", u.sonMac || "-"],
          ["Durum", "Henüz hiçbir çalışan panelden GELDİM demedi"]],
        alt: "Sahayı açacak çalışanı arayın. Çalışan geldiyse panelden GELDİM'e basmasını hatırlatın.",
      });
    })().catch((e) => console.error("Açılış uyarısı", e)));
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
