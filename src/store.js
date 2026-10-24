// Aysu Halı Saha — kendi veritabanı (Cloudflare Durable Object).
//
// Tüm okuma/yazma işlemleri tek bir Durable Object üzerinden ve SIRAYLA yapılır,
// böylece aynı saate aynı anda gelen iki istek çift rezervasyona yol açamaz.
//
// Kayıt anahtarları:
//   r:<tarih>:<saat>:<kayitNo>   rezervasyon (tarih = maçın takvim tarihi; gece maçları ertesi gün)
//   k:<kayitNo>                  kayıt no → rezervasyon anahtarı
//   a:<id>                       abone (her hafta aynı gün/saat)
//   x:<isletmeGunu>:<saat>:<id>  abone o hafta gelmiyor ("bu hafta gelmiyor")
//   m:<telefon>                  müşteri notu / etiketi (CRM)
//   f:<dosya>                    eski siteden kopyalanan fotoğraf
//   u:<eposta>, o:<token>, s:<token>  panel kullanıcıları, oturumlar, şifre sıfırlama
//   d:<kayitNo>                  müşterinin yüklediği kapora dekontu (fotoğraf/PDF)

import { DurableObject } from "cloudflare:workers";
import { SAATLER, KURALLAR, DURUM, EKSTRALAR, FIYATLAR, IBAN, ABONE_KURALLARI, ANKET_SORULARI } from "./config.js";
import {
  simdi, gunAdi, gunEkle, macZamani, tarihNormalize, saatNormalize,
  telefonNormalize, telefonGercekci, gecerliSaat, fiyat, isletmeGunu, haftaBasi,
} from "./time.js";

export const GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const DURUMLAR = [DURUM.bekliyor, DURUM.onayli, DURUM.iptal];
const OTURUM_GUN = 30;
const DEKONT_TURLERI = ["image/jpeg", "image/png", "image/webp", "application/pdf"]; // JPG (ekran görüntüsü) ya da PDF
const DEKONT_EN_FAZLA = 1_800_000; // Durable Object kaydı başına 2 MB sınırının altında

/** Panel rolleri. yonetici: her şeye erişir; diğerleri sadece haftalık tabloyu görür. */
export const ROLLER = {
  admin: { ad: "Admin", yonetici: true },
  mudur: { ad: "Müdür", yonetici: true },
  mudur_yrd: { ad: "Müdür Yardımcısı", yonetici: true },
  temizlik: { ad: "Temizlik Şefi", yonetici: false },
  personel: { ad: "Personel", yonetici: false },
};
const ROL_SIRA = { admin: 0, mudur: 1, mudur_yrd: 2, temizlik: 3, personel: 4 };
/** Yetki seviyesi: kişi sadece kendinden alt seviyedeki hesapları yönetir (Admin herkesi). */
const SEVIYE = { admin: 3, mudur: 2, mudur_yrd: 1, temizlik: 0, personel: 0 };
const yonetebilir = (yapan, rol) => yapan.rol === "admin" || (SEVIYE[yapan.rol] ?? -1) > (SEVIYE[rol] ?? 0);
const epostaNormalize = (e) => {
  const s = String(e || "").trim().toLocaleLowerCase("en").slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};
/** Kullanıcıyı dışarı verirken şifre bilgilerini çıkar. */
const kullaniciDisi = ({ hash, tuz, ...u }) => ({ ...u, rolAd: ROLLER[u.rol]?.ad || "", istenenRolAd: ROLLER[u.istenenRol]?.ad || "" });

/**
 * Online rezervasyonun opsiyonu düştü mü? (dekont yüklenmeden süre doldu)
 * Telefonla/panelden girilen "Kapora bekleniyor" kayıtları düşmez.
 */
// Kapora gelmeden rezervasyon yok: online kayıt dekont doğrulanana kadar sadece "opsiyon"dur.
// Süre içinde doğrulanmazsa (dekont hiç gelmese de, gelip tutmasa da) yer boşa çıkar.
export const opsiyonDustu = (r, simdiMs = Date.now()) =>
  r.kaynak === "Online" && r.durum === DURUM.bekliyor && Number(r.opsiyonBitis) > 0 && Number(r.opsiyonBitis) <= simdiMs;
/** Başka müşteriye opsiyonlu yer: { dk } (kalan dakika). Değilse null. */
const opsiyonBilgisi = (r, simdiMs = Date.now()) => {
  if (!r || r.kaynak !== "Online" || r.durum !== DURUM.bekliyor || !r.opsiyonBitis) return null;
  return { dk: Math.max(1, Math.ceil((r.opsiyonBitis - simdiMs) / 60000)) };
};
/** Ad soyad karşılaştırma: büyük/küçük harf, Türkçe karakter ve boşluk farkı önemsiz; yazılan her kelime kayıtta geçmeli. */
const adSade = (s) => String(s || "").toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
  .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export const adEslesir = (yazilan, kayitli) => {
  const y = adSade(yazilan).split(" ").filter((x) => x.length > 1), k = adSade(kayitli).split(" ");
  return y.length > 0 && y.every((w) => k.includes(w));
};
const iptalMi = (durum) => String(durum || "").toLocaleLowerCase("tr").includes("iptal");
const geceSaati = (saat) => Number(saat.slice(0, 2)) < 6;
/** İşletme günü + saat → maçın takvim tarihi */
/** Saha ücreti: hafta içi (Pzt–Cum) 17:00'dan önce başlayan maçlar abone ücretinden, diğerleri normal maç ücretinden */
export const macFiyati = (f, gun, saat) => {
  const g = new Date(gun + "T00:00:00Z").getUTCDay();
  return g >= 1 && g <= 5 && !geceSaati(saat) && saat < KURALLAR.aboneUcretSaati ? f.abone : f.mac;
};
/** Nottaki "Kayıt 24.09.2026" → "2026-09-24" */
const notKayitTarihi = (not) => {
  const x = String(not || "").match(/kay[ıi]t\s*:?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i);
  return x ? tarihNormalize(`${x[3]}-${x[2].padStart(2, "0")}-${x[1].padStart(2, "0")}`) : null;
};
/** "2026-10-24" + 3 ay → "2027-01-24" */
const ayEkle = (gun, n) => { const d = new Date(gun + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
/** Yeni kurallı abone ilk 3 ayını doldurmadı mı? (eski abonelerde kural yok) */
export const aboneTaahhutte = (a, bugun) => Boolean(a?.kural?.yeni && a.kural.ilkMac && bugun < ayEkle(a.kural.ilkMac, KURALLAR.aboneEnAzAy));
const takvimTarihi = (gun, saat) => (geceSaati(saat) ? gunEkle(gun, 1) : gun);
/** 0 = pazartesi */
const gunNo = (tarih) => (new Date(tarih + "T00:00:00Z").getUTCDay() + 6) % 7;
/** Abonenin haftalık saatleri: [{gun: 0-6 (0=pazartesi, işletme günü), saat: "HH:MM"}] (eski kayıtlarla uyumlu) */
const slotlarOf = (a) => (Array.isArray(a.slotlar) ? a.slotlar : (a.gun != null && a.saat ? [{ gun: a.gun, saat: a.saat }] : []));
/** Abone numarası: kayıtlı "no" ya da eski kayıtlarda nottaki "Abone 3" ifadesi. */
const aboneNo = (a) => (!a ? null : Number.isInteger(a.no) && a.no > 0 ? a.no : Number(String(a.not || "").match(/abone\s*(\d+)/i)?.[1]) || null);
/** Veresiye izni: abonede "veresiye" işaretliyse (varsayılan: Abone 1 ve 2) */
// Abonelik sonlandırılmışsa (son maç kaydı aboneId taşır ama abone silinmiştir) veresiye yok
const veresiyeAcik = (a) => (!a ? false : a.veresiye !== undefined ? Boolean(a.veresiye) : [1, 2].includes(aboneNo(a)));
const SAAT_SIRA = (saat) => (Number(saat.slice(0, 2)) < 6 ? 24 : 0) + Number(saat.slice(0, 2));
const slotSirala = (l) => [...l].sort((x, y) => x.gun - y.gun || SAAT_SIRA(x.saat) - SAAT_SIRA(y.saat));
/** ms → Türkiye saatiyle "HH:MM" */
const zamanYazi = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
/** Puantaj kaydındaki çalışılan saat (2 ondalık); çıkış yoksa 0 */
const saatFark = (k) => (k?.giris && k?.cikis ? Math.round(((k.cikis - k.giris) / 3600_000) * 100) / 100 : 0);
/** Ödenecek saat: geldim–çıktım arası + yol parası (tamamlanan günlerde) */
// Çalışılan süre yarım saate yuvarlanır (ör. 5 sa 10 dk → 5; 5 sa 20 dk → 5,5), üstüne yol eklenir
const yarimSaat = (s) => Math.round(s * 2) / 2;
const odenecekSaat = (k) => { const s = saatFark(k); return s ? yarimSaat(s) + KURALLAR.puantajYolSaat : 0; };
const simdiYazi = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
const bugunIsletme = () => { const n = simdi(); return isletmeGunu(n.tarih, n.saat); };
const VARSAYILAN_GOREVLER = [
  { id: "wc", ad: "WC", aciklama: "Lavabo, klozet, ayna, zemin; sabun ve kâğıt kontrolü", rol: "hepsi" },
  { id: "soyunma", ad: "Soyunma odaları", aciklama: "Her takımdan sonra hızlı toparlama; terlikler eşit sayıda", rol: "hepsi" },
  { id: "kantin", ad: "Kantin", aciklama: "Tezgâh temizliği; çay 1,5 saatte bir taze demlenir", rol: "hepsi" },
  { id: "saha", ad: "Saha / Tribün", aciklama: "Tribün ve saha çevresi; toplar gece sahada bırakılmaz", rol: "hepsi" },
  { id: "cop", ad: "Çöp kovaları", aciklama: "Boşaltıldı, poşet değiştirildi", rol: "hepsi" },
  { id: "krampon", ad: "Krampon", aciklama: "İadede dezenfekte edildi, yerine kondu", rol: "hepsi" },
  { id: "yelek", ad: "Yelekler", aciklama: "Gece yıkandı", rol: "hepsi" },
  { id: "otopark1", ad: "Otopark 1", aciklama: "", rol: "hepsi" },
  { id: "otopark2", ad: "Otopark 2", aciklama: "", rol: "hepsi" },
  { id: "sarf", ad: "T. kâğıdı / Z kâğıdı / peçete / köpük", aciklama: "Eksikler tamamlandı", rol: "hepsi" },
];
const kirp = (s, n) => String(s ?? "").trim().slice(0, n);

function rastgele(n, harf = "ABCDEFGHJKLMNPRSTUVYZ23456789") {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += harf[b % harf.length];
  return s;
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sifreHash(sifre, tuz) {
  const anahtar = await crypto.subtle.importKey("raw", new TextEncoder().encode(sifre), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(tuz), iterations: 100_000 }, anahtar, 256);
  return hex(bits);
}

function esitMi(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let fark = 0;
  for (let i = 0; i < a.length; i++) fark |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return fark === 0;
}

const KANTIN_TOHUM = [
  ["BİSKREM", 20, 50, 0],
  ["POP KEK ÇİKOLATALI", 12, 30, 16],
  ["POP KEK MUZLU", 12, 30, 10],
  ["ÜLKER ÇİZİ", 14, 35, 19],
  ["ÇUBUK KRAKER BAHARATLI", 12, 30, 18],
  ["ÇUBUK KRAKER ACILI", 12, 30, 26],
  ["ÇUBUK KRAKER PEYNİR", 12, 30, 21],
  ["ÇUBUK KRAKER SADE", 6, 15, 24],
  ["TOPKEK MEYVELİ", 12, 30, 24],
  ["TOPKEK KAKAO", 12, 30, 23],
  ["BROWNİ INT", 22, 55, 15],
  ["PIZZA KRKR", 8, 20, 16],
  ["CANGA", 20, 50, 31],
  ["METRO", 14, 35, 34],
  ["Ç. GÖFRET", 14, 35, 16],
  ["LAVİVA", 22, 55, 10],
  ["ÇOKONAT", 22, 55, 13],
  ["DİDO", 22, 55, 8],
  ["KARAM", 24, 60, 0],
  ["ALBENİ", 16, 40, 15],
  ["SADE GAZOZ", 16, 40, 21],
  ["PORTAKALLI", 16, 40, 25],
  ["SU 0,50", 10, 25, 305],
  ["SODA LİMONLU", 20, 50, 34],
  ["SODA ELMALI", 20, 50, 33],
  ["SODA KARPUZ ÇİLEK", 20, 50, 29],
  ["SADE SODA", 12, 30, 26],
  ["FUSE TEA LİMONLU", 38, 95, 8],
  ["FUSE TEA ŞEFTALİ", 38, 95, 8],
  ["ÇAY - BARDAK - ORALET", 10, 25, 904],
  ["NESCAFE KLASİK", 12, 30, 41],
  ["NESCAFE 3Ü 1 ARADA", 12, 30, 0],
  ["NESCAFE 2Sİ 1 ARADA", 12, 30, 48],
  ["NESCAFE SÜTLÜ KÖPÜKLÜ", 12, 30, 65],
  ["KUTU MEYVE SUYU ŞEFTALİ", 14, 35, 26],
  ["KUTU MEYVE SUYU KARIŞIK", 14, 35, 26],
  ["ENERJİ", 40, 100, 6],
  ["FİLTRE KAHVE", 28, 70, 0],
  ["TÜRK KAHVESİ", 28, 70, 0],
  ["JETON", 4, 10, 96],
];

// ---- Bardak kuralı: sıcak içecekler "ÇAY - BARDAK - ORALET" stoğundan bardak düşer ----
//   Nescafe çeşitleri: kendi stoğundan 1 + 1 bardak. Filtre kahve: 1 bardak, Türk kahvesi: 2 bardak (kahve + su);
//   bu ikisinin ayrı stoğu yoktur, stokları bardak stoğuna bağlıdır (bardak girilince kendiliğinden yenilenir).
const buyuk = (s) => String(s || "").toLocaleUpperCase("tr");
export const bardakKurali = (ad) => {
  const a = buyuk(ad);
  if (a.includes("BARDAK")) return { bardakUrunu: true };
  if (a.includes("NESCAFE") || a.includes("NESKAFE")) return { bardak: 1, bagli: false };
  if (a.includes("TÜRK KAHVE")) return { bardak: 2, bagli: true };
  if (a.includes("FİLTRE")) return { bardak: 1, bagli: true };
  return {};
};
/** Satılan adetler {id: adet} → stoktan düşecek adetler (bardak dahil) */
export const stokTuketimi = (t, urunler) => {
  const m = new Map(urunler.map((u) => [u.id, u]));
  const bardak = urunler.find((u) => bardakKurali(u.ad).bardakUrunu);
  const r = {};
  for (const [id, a] of Object.entries(t)) {
    const k = bardakKurali(m.get(id)?.ad);
    if (!(bardak && k.bagli)) r[id] = (r[id] || 0) + a;
    if (bardak && k.bardak) r[bardak.id] = (r[bardak.id] || 0) + a * k.bardak;
  }
  return r;
};
/** Ekranda gösterilecek ürünler: bardağa bağlı ürünlerin stoğu = bardak stoğu ÷ bardak sayısı */
export const bardakGorunum = (urunler) => {
  const bardak = urunler.find((u) => bardakKurali(u.ad).bardakUrunu);
  return urunler.map((u) => {
    const k = bardakKurali(u.ad);
    if (!bardak || !k.bardak) return k.bardakUrunu ? { ...u, bardakUrunu: true } : u;
    return { ...u, bardak: k.bardak, bardakId: bardak.id, ...(k.bagli ? { bagli: true, stok: Math.floor((bardak.stok || 0) / k.bardak) } : {}) };
  });
};

// ---- Kasa defteri yardımcıları ----
/** "1.250 TL", "1250", 1250 → 1250 (negatif olmaz) */
const tutar = (v) => {
  const n = Math.round(Number(String(v ?? "").replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "")));
  return Number.isFinite(n) ? Math.min(10_000_000, Math.max(0, n)) : 0;
};
/** "1200", "1.200 TL", "500 + 700" → toplam kapora */
const kaporaSayi = (v) => String(v ?? "").split(/[+&]|\s(?:ve|\/)\s/).reduce((t, p) => t + tutar(p), 0);
/** Rezervasyonun alınan kaporası; dekont onaylı ama tutar okunamadıysa beklenen kapora tutarı */
const kaporaTutari = (r) => Number(r.kaporaToplam) || kaporaSayi(r.kapora)
  || (r.kaynak === "Online" && r.durum === DURUM.onayli && r.kaporaGunu ? Number(r.kaporaTutar) || 0 : 0);
/** Personel / ücretsiz tüketim satırları (kasaya para girmez, stoktan düşer) */
const IKRAM_KIMLER = ["VIP / ücretsiz ikram", "Müdür", "Müdür Yardımcısı", "Şef", "Personel"];
/** Bir kasa günündeki toplam ürün çıkışı {urunId: adet} (satış + ikram) */
export const kasaTuketim = (k) => {
  const t = {};
  const ekle = (o) => { for (const [id, a] of Object.entries(o || {})) t[id] = (t[id] || 0) + (Number(a) || 0); };
  for (const m of k.maclar || []) { ekle(m.kantin); ekle(m.veresiyeKantin); ekle(m.ikramKantin); }
  for (const o of Object.values(k.ikram || {})) ekle(o);
  return t;
};
/** Personel birim fiyatı: %40 indirimli (KURALLAR.personelIndirim), 5 TL'nin katına yukarı yuvarlanmış (25 → 15; 95 → 57 → 60) */
/**
 * Abone kantin anlaşması (ör. çay): ilk N adet ücretsiz (ikram), kalanlar toplam adede göre kademeli fiyattan.
 * anlasma: { urunId, ucretsiz, kademeler: [{ min, fiyat }] }  → n adet için ortalama birim fiyat
 */
export const anlasmaBirim = (anl, n, normal) => {
  if (!anl || !(n > 0)) return normal;
  const kademe = [...(anl.kademeler || [])].sort((a, c) => c.min - a.min).find((k) => n >= k.min);
  const fiyat = kademe ? kademe.fiyat : normal;
  const ucretli = Math.max(0, n - (Number(anl.ucretsiz) || 0));
  return (ucretli * fiyat) / n;
};
/** Kasa günündeki abone satırlarına anlaşmalı birim fiyatları yazar (m.ozelBirim) — adet o gün o abonenin toplamıdır */
export const anlasmaUygula = (k, anlasmalar = {}) => {
  const b = k.birimler || {};
  const toplam = {}; // aboneId|urunId → adet
  for (const m of k.maclar || []) {
    if (!m.aboneId || !anlasmalar[m.aboneId]) continue;
    for (const o of [m.kantin, m.veresiyeKantin]) for (const [id, a] of Object.entries(o || {})) toplam[`${m.aboneId}|${id}`] = (toplam[`${m.aboneId}|${id}`] || 0) + (Number(a) || 0);
  }
  for (const m of k.maclar || []) {
    delete m.ozelBirim;
    const l = anlasmalar[m.aboneId];
    if (!l) continue;
    const ozel = {};
    for (const anl of l) {
      const n = toplam[`${m.aboneId}|${anl.urunId}`];
      if (n) ozel[anl.urunId] = anlasmaBirim(anl, n, b[anl.urunId]?.satis || 0);
    }
    if (Object.keys(ozel).length) m.ozelBirim = ozel;
  }
  return k;
};
const satirFiyat = (m, b, id) => (m?.ozelBirim?.[id] ?? b[id]?.satis ?? 0);

/** Kantin satış fiyatı: alış × çarpan, 5 TL'nin katına yukarı yuvarlanır (12 × 2,5 = 30; 13 × 2,5 = 32,5 → 35) */
export const kantinSatis = (alis, carpan) => (alis > 0 ? Math.ceil((alis * (carpan || 2.5)) / 5 - 1e-9) * 5 : 0);
export const personelFiyat = (satis) => (satis > 0 ? Math.ceil((satis * (1 - KURALLAR.personelIndirim)) / 5) * 5 : 0);
/** Bir kasa gününde personelin kantin tüketimi {eposta: tutar} (maaştan düşülür) */
export const personelKesintileri = (k) => {
  const b = k?.birimler || {}, r = {};
  for (const [kim, v] of Object.entries(k?.ikram || {})) {
    if (!kim.startsWith("p:")) continue;
    r[kim.slice(2)] = Object.entries(v).reduce((t, [id, a]) => t + a * personelFiyat(b[id]?.satis || 0), 0);
  }
  return r;
};
/**
 * Aynı kasayı iki yönetici aynı anda düzenlerse: kişinin yaptığı değişiklikler (taban → yeni farkı)
 * sunucudaki son hâlin üstüne uygulanır. Adetler (kantin, krampon, eldiven, ikram) fark olarak eklenir,
 * böylece ikisinin girdiği ürünler de kaybolmaz; diğer alanlarda son değiştiren geçerli olur.
 */
export function kasaUcYol(guncel, taban, yeni) {
  const esit = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const sonuc = JSON.parse(JSON.stringify(guncel));
  const sayac = (g, t, y) => {
    const r = { ...(g || {}) };
    for (const id of new Set([...Object.keys(t || {}), ...Object.keys(y || {})])) {
      const fark = (Number(y?.[id]) || 0) - (Number(t?.[id]) || 0);
      if (!fark) continue;
      r[id] = Math.max(0, (Number(r[id]) || 0) + fark);
      if (!r[id]) delete r[id];
    }
    return r;
  };
  for (const a of ["devir", "sayilan", "birakilan", "not", "girisler", "cikislar", "veresiye", "avanslar"]) {
    if (!esit(yeni[a], taban[a])) sonuc[a] = yeni[a];
  }
  const tabanMac = new Map((taban.maclar || []).map((m) => [m.saat, m]));
  const yeniSaatler = new Set((yeni.maclar || []).map((m) => m.saat));
  sonuc.maclar = (sonuc.maclar || []).filter((m) => !(tabanMac.has(m.saat) && !yeniSaatler.has(m.saat))); // benim sildiğim satır
  for (const y of yeni.maclar || []) {
    const t = tabanMac.get(y.saat);
    const g = sonuc.maclar.find((m) => m.saat === y.saat);
    if (!g) { if (!t) sonuc.maclar.push(y); continue; }
    for (const a of ["ucret", "vip", "ekstra", "onOdeme", "iban", "veresiyeKim", "odendi", "odemeZamani", "tur", "ad"]) if (!esit(y[a], t?.[a])) g[a] = y[a];
    for (const a of ["krampon", "eldiven"]) g[a] = Math.max(0, (Number(g[a]) || 0) + ((Number(y[a]) || 0) - (Number(t?.[a]) || 0)));
    for (const a of ["kantin", "kantinOdenen", "veresiyeKantin", "ikramKantin"]) g[a] = sayac(g[a], t?.[a], y[a]);
  }
  sonuc.ikram = { ...(sonuc.ikram || {}) };
  for (const kim of new Set([...Object.keys(taban.ikram || {}), ...Object.keys(yeni.ikram || {})])) {
    sonuc.ikram[kim] = sayac(sonuc.ikram[kim], taban.ikram?.[kim], yeni.ikram?.[kim]);
  }
  return sonuc;
}

/** IBAN doğrulama (TR + 24 hane, mod-97 sağlaması) → boşluksuz büyük harf ya da null */
export function ibanGecerli(v) {
  const s = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^TR\d{24}$/.test(s)) return null;
  const d = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let k = 0;
  for (const c of d) k = (k * 10 + Number(c)) % 97;
  return k === 1 ? s : null;
}
const ibanYaz = (s) => s.replace(/(.{4})/g, "$1 ").trim();

/** Kasa günü hesapları (sunucu ve panel aynı formülü kullanır) */
export const kasaOzet = (k) => {
  const b = k.birimler || {}, kira = k.kira || { krampon: 0, eldiven: 0 };
  const top = (l) => (l || []).reduce((t, x) => t + (Number(x.tutar) || 0), 0);
  const o = { mac: 0, vip: 0, kantin: 0, kantinKar: 0, kramponAdet: 0, eldivenAdet: 0, krampon: 0, eldiven: 0, onOdeme: 0, ikramDeger: 0, veresiyeKantin: 0 };
  o.maclar = (k.maclar || []).map((m) => {
    let kantin = 0;
    for (const [id, a] of Object.entries(m.kantin || {})) { kantin += a * satirFiyat(m, b, id); o.kantinKar += a * (satirFiyat(m, b, id) - (b[id]?.alis || 0)); }
    // Veresiye kantin: stoktan düşer, ciroya / kasaya girmez
    let veresiye = 0;
    for (const [id, a] of Object.entries(m.veresiyeKantin || {})) veresiye += a * satirFiyat(m, b, id);
    o.veresiyeKantin += veresiye;
    // Maçtaki ikram (ör. aboneye ücretsiz): stoktan düşer, ciroya girmez
    let ikram = 0;
    for (const [id, a] of Object.entries(m.ikramKantin || {})) ikram += a * (b[id]?.satis || 0);
    o.ikramDeger += ikram;
    const krampon = (m.krampon || 0) * kira.krampon, eldiven = (m.eldiven || 0) * kira.eldiven;
    kantin = Math.round(kantin); veresiye = Math.round(veresiye);
    o.mac += m.ucret || 0; o.vip += m.vip || 0; o.kantin += kantin; o.onOdeme += m.onOdeme || 0;
    o.kramponAdet += m.krampon || 0; o.eldivenAdet += m.eldiven || 0; o.krampon += krampon; o.eldiven += eldiven;
    return { saat: m.saat, kantin, veresiye, ikram, toplam: (m.ucret || 0) + (m.vip || 0) + kantin + krampon + eldiven };
  });
  // Personel tüketimi ("p:<eposta>") ay sonu maaştan kesilir; kasaya nakit girmez (ikram gibi stoktan düşer)
  o.personelKantin = 0;
  for (const [kim, v] of Object.entries(k.ikram || {})) for (const [id, a] of Object.entries(v)) {
    if (kim.startsWith("p:")) o.personelKantin += a * personelFiyat(b[id]?.satis || 0); else o.ikramDeger += a * (b[id]?.satis || 0);
  }
  o.ciro = o.mac + o.vip + o.kantin + o.krampon + o.eldiven;
  o.giris = top(k.girisler); o.cikis = top(k.cikislar); o.veresiye = top(k.veresiye);
  o.devir = Number(k.devir) || 0;
  o.gelenKapora = (k.gelenKaporalar || []).reduce((t, x) => t + (Number(x.tutar) || 0), 0);
  o.veresiyeTahsil = (k.veresiyeTahsil || []).reduce((t, x) => t + (Number(x.tutar) || 0), 0); // bugün tahsil edilen eski veresiyeler
  // Kapora parası geldiği günün kasasına girer (o gün gelen kaporalar +); maç günü o maçın kaporası düşülür (−).
  // Personel kantini (maaştan kesilir) eklenir; devir katılmaz
  o.kasaToplam = o.ciro - o.onOdeme + o.giris + o.gelenKapora + o.veresiyeTahsil; // personel kantini kasaya girmez, ay sonu maaştan kesilir
  // Önceden alınan kapora ve veresiye kasaya bugün girmez
  o.avans = (k.avanslar || []).reduce((t, x) => t + (Number(x.tutar) || 0), 0); // çalışana kasadan verilen günlük ödeme / avans
  o.ibanOdeme = (k.maclar || []).reduce((t, m) => t + (Number(m.iban) || 0), 0); // maç günü IBAN'a ödenen (kasaya nakit girmez)
  // Gelen kaporalar IBAN'a yatar: kasa toplamına (günün gelirine) girer ama çekmecede nakit olarak beklenmez
  o.ibanToplam = o.ibanOdeme + o.gelenKapora;
  o.olmasiGereken = o.kasaToplam - o.cikis - o.veresiye - o.avans - o.ibanToplam;
  o.fark = k.sayilan === null || k.sayilan === undefined ? null : k.sayilan - o.olmasiGereken;
  o.teslim = k.birakilan === null || k.birakilan === undefined ? null : (k.sayilan ?? o.olmasiGereken) - k.birakilan;
  return o;
};

export class RezervasyonDeposu extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.kuyruk = Promise.resolve();
  }

  /** İşlemleri sıraya sokar: bir işlem bitmeden diğeri başlamaz. */
  kilitli(fn) {
    const p = this.kuyruk.then(fn, fn);
    this.kuyruk = p.catch(() => {});
    return p;
  }

  get st() { return this.ctx.storage; }

  // ================= Okuma yardımcıları =================

  /** [ilk, son] takvim tarihleri arasındaki rezervasyonlar (iptaller dahil). */
  async rezervasyonlar(ilk, son) {
    const m = await this.st.list({ start: `r:${ilk}`, end: `r:${son}~` });
    return [...m.values()];
  }

  async aboneler() {
    const m = await this.st.list({ prefix: "a:" });
    // Bir kez: eski abonelerin notundaki "Kayıt 24.09.2026" kayıt (başlangıç) tarihi olarak alınır
    if (!this._kayitTasindi && !(await this.st.get("ayar:aboneKayitTarihi"))) {
      const yaz = { "ayar:aboneKayitTarihi": true };
      for (const [k, a] of m) {
        if (a.kayitTarihi) continue;
        const t = notKayitTarihi(a.not);
        if (t) { yaz[k] = { ...a, kayitTarihi: t }; m.set(k, yaz[k]); }
      }
      await this.st.put(yaz);
    }
    this._kayitTasindi = true;
    return [...m.values()];
  }

  async atlananlar(ilkGun, sonGun) {
    const m = await this.st.list({ start: `x:${ilkGun}`, end: `x:${sonGun}~` });
    return new Set([...m.keys()]);
  }

  /** Belirli bir aralık için doluluk bilgisini tek seferde yükler. */
  async durumYukle(ilkGun, sonGun) {
    const [rez, abone, atla] = await Promise.all([
      this.rezervasyonlar(ilkGun, gunEkle(sonGun, 1)),
      this.aboneler(),
      this.atlananlar(ilkGun, sonGun),
    ]);
    const rezMap = new Map();
    // Süresi dolmuş opsiyonlar yer tutmaz (zamanlanmış görev ayrıca "İptal" olarak işaretler)
    for (const r of rez) if (!iptalMi(r.durum) && !opsiyonDustu(r)) rezMap.set(`${r.tarih}|${r.saat}`, r);
    return { rezMap, abone, atla };
  }

  /** Standart saatler + aralıktaki (iptal olmayan) özel saatli rezervasyonların saatleri, işletme günü sırasıyla. */
  saatListesi(durum, ilkGun, sonGun) {
    const ekstra = new Set();
    for (const r of durum.rezMap.values()) {
      const g = r.isletmeGunu || isletmeGunu(r.tarih, r.saat);
      if (g >= ilkGun && g <= sonGun && !SAATLER.includes(r.saat)) ekstra.add(r.saat);
    }
    return [...SAATLER, ...ekstra].sort((a, b) => SAAT_SIRA(a) - SAAT_SIRA(b));
  }

  /** İşletme günü + saat için slotun durumu. */
  slot(durum, gun, saat) {
    const tarih = takvimTarihi(gun, saat);
    const rez = durum.rezMap.get(`${tarih}|${saat}`);
    if (rez) return { tur: "rez", rez };
    const gn = gunNo(gun);
    const a = durum.abone.find((x) => x.baslangic <= gun && (!x.bitis || gun <= x.bitis)
      && slotlarOf(x).some((sl) => sl.gun === gn && sl.saat === saat));
    if (a) {
      const gelmiyor = durum.atla.has(`x:${gun}:${saat}:${a.id}`);
      return { tur: gelmiyor ? "abone-gelmiyor" : "abone", abone: a };
    }
    return { tur: "bos" };
  }

  // ================= Site (müşteri) işlemleri =================

  gunHesapla(durum, gunGirdi) {
    const tarih = tarihNormalize(gunGirdi);
    if (!tarih) return { hata: "Tarih anlaşılamadı." };
    const bugun = simdi().tarih;
    if (tarih < gunEkle(bugun, -1)) return { hata: "Geçmiş bir tarih için rezervasyon yapılamaz." };
    if (tarih > gunEkle(bugun, KURALLAR.enFazlaGunSonra)) {
      return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
    }
    const simdiMs = Date.now();
    const detay = SAATLER
      .filter((saat) => macZamani(takvimTarihi(tarih, saat), saat) > simdiMs)
      .map((saat) => {
        const s = this.slot(durum, tarih, saat);
        const ops = opsiyonBilgisi(s.rez, simdiMs);
        return { saat, bos: s.tur === "bos" || s.tur === "abone-gelmiyor", ...(ops ? { opsiyon: ops } : {}) };
      });
    return { tarih, gun: gunAdi(tarih), bosSaatler: detay.filter((s) => s.bos).map((s) => s.saat), detay };
  }

  async musaitlik(gun) {
    return (await this.musaitlikCoklu([gun]))[0];
  }

  async musaitlikCoklu(gunler) {
    return this.kilitli(async () => {
      const sirali = [...gunler].sort();
      const durum = await this.durumYukle(sirali[0], sirali.at(-1));
      return gunler.map((g) => this.gunHesapla(durum, g));
    });
  }

  /** Ortak kayıt oluşturma. `panel` true ise müşteri sınırları uygulanmaz. */
  async rezervasyonYaz({ gunTarihi, saat: s, ad, telefon: tel, not = "", durum, kaynak, kapora = "", ekstra = [], kod, abone, kurallarKabul, depozitoIban, eposta }, panel) {
    const gun = tarihNormalize(gunTarihi);
    const saat = saatNormalize(s);
    const telefon = telefonNormalize(tel);
    if (!gun) return { hata: "Geçersiz tarih." };
    // Panel özel durumlarda standart dışı saate de (ör. 05:00) maç yazabilir; müşteri sadece standart saatlere
    if (!saat || !(gecerliSaat(saat) || (panel && saat.endsWith(":00")))) return { hata: `Geçersiz saat. Maç saatleri: ${SAATLER.join(", ")}` };
    if (!kirp(ad, 60) || kirp(ad, 60).length < (panel ? 2 : 3)) return { hata: "Ad soyad gerekli." };
    if (!telefon && !(panel && !kirp(tel, 20))) {
      return { hata: "Geçersiz telefon. 05XX XXX XX XX biçiminde bir cep telefonu gerekli." };
    }
    if (!panel && !telefonGercekci(telefon)) {
      return { hata: "Bu telefon numarası geçerli görünmüyor. Lütfen kendi cep telefonunuzu doğru yazın (05XX XXX XX XX)." };
    }
    const tarih = takvimTarihi(gun, saat);
    const f = await this.fiyatAyar();
    if (!panel) {
      if (macZamani(tarih, saat) <= Date.now()) return { hata: "Bu saat geçmiş." };
      if (gun > gunEkle(simdi().tarih, KURALLAR.enFazlaGunSonra)) {
        return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
      }
    }
    const d = await this.durumYukle(gun, gun);
    const sl = this.slot(d, gun, saat);
    if (sl.tur === "rez" || sl.tur === "abone") {
      const ops = opsiyonBilgisi(sl.rez);
      if (ops && !panel) {
        return { hata: `Bu saat şu an başka bir müşteriye ${KURALLAR.opsiyonDakika} dakikalığına ayrılmış. Ödeme gelmezse yaklaşık ${ops.dk} dakika sonra boşa çıkar; o zaman tekrar deneyin.` };
      }
      return { hata: "Bu saat dolu. Lütfen başka bir saat seçin." };
    }
    // Ücretsiz maç kodu (Admin belirler): geçerliyse maç ücretsiz, kapora gerekmez, rezervasyon hemen kesinleşir
    let kodBilgi = null;
    if (kirp(kod, 30)) {
      kodBilgi = await this.kodKontrol(kod);
      if (kodBilgi.hata) return kodBilgi;
    }
    if (!panel && !kodBilgi) {
      const gelecek = (await this.rezervasyonlar(simdi().tarih, gunEkle(simdi().tarih, 60)))
        .filter((r) => r.telefon === telefon && !iptalMi(r.durum) && !opsiyonDustu(r) && macZamani(r.tarih, r.saat) > Date.now());
      // Kapora ödenmiş rezervasyonlarda sınır yok; aynı numarayla aynı anda sadece BİR ödemesi bekleyen opsiyon olabilir
      const bekleyen = gelecek.find((r) => r.durum === DURUM.bekliyor);
      if (bekleyen) {
        return { hata: `Bu numarayla ödemesi beklenen bir rezervasyonunuz var (${bekleyen.gun} ${bekleyen.saat}). O saate (⏳) dokunup telefonunuzu yazarak dekontunu yükleyin; süre dolunca yeni rezervasyon yapabilirsiniz.` };
      }
    }
    const kayit = {
      tarih, saat,
      gun: gunAdi(gun) + (geceSaati(saat) ? " gecesi" : ""),
      isletmeGunu: gun,
      ad: kirp(ad, 60), telefon: telefon || "",
      durum: DURUMLAR.includes(durum) ? durum : DURUM.bekliyor,
      kayitNo: `AY-${rastgele(5)}`, not: kirp(not, 200), kapora: kirp(kapora, 60),
      kaynak: kaynak || "Online", olusturma: simdiYazi(),
      // VIP spiker / VIP hakem: ücrete eklenir
      ekstra: [...new Set(Array.isArray(ekstra) ? ekstra : [])].filter((x) => EKSTRALAR[x]),
      ...(kirp(kapora, 60) ? { kaporaGunu: bugunIsletme() } : {}), // kasada "o gün gelen kaporalar"
      kaporaTutar: f.kapora, // o anki kapora tutarı (fiyat sonradan değişse de bu rezervasyon için geçerli)
      ...(!panel ? { opsiyonBitis: Date.now() + KURALLAR.opsiyonDakika * 60_000 } : {}),
    };
    // Abone başvurusu: kurallar onaylanır; ilk maç abone ücretinden, ilk maçta 1 maç bedeli depozito alınır (kapora ikisinden düşer)
    if (abone) {
      if (!panel && !kurallarKabul) return { hata: "Abone olmak için abonelik kurallarını onaylamanız gerekiyor." };
      if (!panel && !epostaNormalize(eposta)) return { hata: "Abone olmak için e-posta adresinizi yazın (abone sayfanızın bağlantısı gönderilir)." };
      if ((await this.aboneler()).some((a) => !a.bitis && slotlarOf(a).some((x) => x.gun === gunNo(gun) && x.saat === saat))) {
        return { hata: "Bu gün ve saatte zaten bir abonemiz var. Abonelik için başka bir saat seçin." };
      }
      kayit.aboneBasvuru = { kabul: simdiYazi(), depozito: f.abone, kurallar: ABONE_KURALLARI.length, ...(depozitoIban ? { depozitoIban: true } : {}), ...(epostaNormalize(eposta) ? { eposta: epostaNormalize(eposta) } : {}) };
      // Depozitoyu şimdi IBAN'a gönderecekse kapora yerine depozito istenir (dekontta en az depozito tutarı görünmeli)
      if (depozitoIban) kayit.kaporaTutar = f.abone;
      kayit.not = kirp(`Abone başvurusu — her hafta ${GUNLER[gunNo(gun)]} ${saat}${kayit.not ? " · " + kayit.not : ""}`, 200);
    }
    const saha = abone ? f.abone : macFiyati(f, gun, saat);
    kayit.ucret = saha + kayit.ekstra.reduce((t, x) => t + (f[x] ?? EKSTRALAR[x].ucret), 0);
    if (kodBilgi) {
      await this.kodKullan(kodBilgi.kod, kayit.kayitNo);
      Object.assign(kayit, {
        ucret: kayit.ucret - saha, kaporaTutar: 0, durum: DURUM.onayli, opsiyonBitis: null,
        ucretsiz: { kod: kodBilgi.kod, neden: kodBilgi.aciklama || "Ücretsiz maç kodu" },
      });
    }
    const anahtar = `r:${tarih}:${saat}:${kayit.kayitNo}`;
    await this.st.put({ [anahtar]: kayit, [`k:${kayit.kayitNo}`]: anahtar });
    return { basarili: true, ...kayit };
  }

  // ---- Abone sayfası (aboneye özel bağlantı: /abone/<anahtar>) ----
  //   ae:<anahtar> → abone id
  async aboneErisim(id) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a) return { hata: "Abone bulunamadı." };
      if (a.erisim) return { basarili: true, anahtar: a.erisim, abone: a };
      const anahtar = rastgele(24, "abcdefghjkmnpqrstuvwxyz23456789");
      await this.st.put({ [`a:${id}`]: { ...a, erisim: anahtar }, [`ae:${anahtar}`]: id });
      return { basarili: true, anahtar, abone: { ...a, erisim: anahtar } };
    });
  }

  async aboneAnahtarla(anahtar) {
    if (!/^[a-z0-9]{24}$/.test(String(anahtar || ""))) return null;
    const id = await this.st.get(`ae:${anahtar}`);
    const a = id && (await this.st.get(`a:${id}`));
    return a && !a.bitis && a.erisim === anahtar ? a : null;
  }

  /** Abonenin kendi sayfası: saatleri, önümüzdeki maçları, kantin geçmişi, açık veresiye, kurallar */
  async aboneSayfa(anahtar) {
    const a = await this.aboneAnahtarla(anahtar);
    if (!a) return { hata: "Bağlantı geçersiz ya da abonelik sona ermiş." };
    const bugun = bugunIsletme();
    const son = gunEkle(bugun, 27);
    const d = await this.durumYukle(bugun, son);
    const maclar = [];
    for (let i = 0; i <= 27; i++) {
      const g = gunEkle(bugun, i);
      for (const x of slotlarOf(a).filter((x) => x.gun === gunNo(g))) {
        const zaman = macZamani(takvimTarihi(g, x.saat), x.saat);
        if (zaman <= Date.now() || g < a.baslangic) continue;
        const s = this.slot(d, g, x.saat);
        const gelmiyor = s.tur !== "abone" || s.abone?.id !== a.id;
        maclar.push({ gun: g, gunAd: gunAdi(g), saat: x.saat, gelmiyor, baskasi: gelmiyor && s.tur === "rez",
          bildirimSuresi: zaman - Date.now() >= KURALLAR.aboneGelmiyorSaat * 3600_000 });
      }
    }
    // Kantin geçmişi (son 60 gün): maç maç ne yenip içildi
    const kasalar = await this.st.list({ start: `kasa:${gunEkle(bugun, -60)}`, end: `kasa:${bugun}~` });
    const kantin = [];
    for (const k of [...kasalar.values()].reverse()) {
      const b = k.birimler || {};
      for (const m of k.maclar || []) {
        if (m.aboneId !== a.id) continue;
        const liste = (o, tur) => Object.entries(o || {}).filter(([, n]) => n > 0).map(([id, n]) => ({ ad: b[id]?.ad || "Ürün", adet: n, tutar: Math.round(n * (tur === "ikram" ? b[id]?.satis || 0 : satirFiyat(m, b, id))), tur }));
        const kalemler = [...liste(m.kantin, "kantin"), ...liste(m.veresiyeKantin, "veresiye"), ...liste(m.ikramKantin, "ikram")];
        if (m.krampon) kalemler.push({ ad: "Krampon kirası", adet: m.krampon, tutar: m.krampon * (k.kira?.krampon || 0), tur: "kira" });
        if (m.eldiven) kalemler.push({ ad: "Eldiven kirası", adet: m.eldiven, tutar: m.eldiven * (k.kira?.eldiven || 0), tur: "kira" });
        if (kalemler.length) kantin.push({ gun: k.gun, saat: m.saat, kalemler });
      }
    }
    const veresiye = (await this.acikVeresiyeler()).filter((v) => v.aboneId === a.id).map((v) => ({ gun: v.gun, saat: v.saat, tutar: v.tutar, urunler: v.urunler }));
    const ay = bugun.slice(0, 7);
    const iptalAy = new Set([...(await this.st.list({ start: `x:${ay}-01`, end: `x:${ay}-31~` })).keys()].filter((k) => k.endsWith(`:${a.id}`)).map((k) => k.split(":")[1])).size;
    return {
      basarili: true, no: aboneNo(a), ad: a.ad, slotlar: slotSirala(slotlarOf(a)).map((x) => `${GUNLER[x.gun]} ${x.saat}`),
      baslangic: a.kural?.ilkMac || a.kayitTarihi || a.baslangic, depozito: a.depozito || "", kural: Boolean(a.kural?.yeni),
      taahhutBitis: a.kural?.yeni && a.kural.ilkMac ? ayEkle(a.kural.ilkMac, KURALLAR.aboneEnAzAy) : null,
      iptalHakki: a.kural?.yeni ? Math.max(0, KURALLAR.aboneAylikIptal - iptalAy) : null,
      bildirimSaat: KURALLAR.aboneGelmiyorSaat, maclar, kantin, veresiye, kurallar: ABONE_KURALLARI,
      iptalTalebi: a.iptalTalebi || null, not: a.not || "",
      anlasma: (a.anlasma || []).map((x) => ({ ad: x.ad, ucretsiz: x.ucretsiz, kademeler: x.kademeler, not: x.not })),
    };
  }

  /** Abone kendi sayfasından "bu hafta gelmiyoruz" / "geliyoruz" */
  async aboneKendiAtla(anahtar, { gun, saat, gelmiyor, zorla }) {
    const a = await this.aboneAnahtarla(anahtar);
    if (!a) return { hata: "Bağlantı geçersiz." };
    const g = tarihNormalize(gun), s1 = saatNormalize(saat);
    if (!g || !s1) return { hata: "Maç bulunamadı." };
    const kalan = macZamani(takvimTarihi(g, s1), s1) - Date.now();
    if (kalan < KURALLAR.aboneGelmiyorSaat * 3600_000) return { hata: `Maça ${KURALLAR.aboneGelmiyorSaat} saatten az kaldı; değişiklik için lütfen bizi arayın (0 555 510 26 26).` };
    const r = await this.aboneAtla({ id: a.id, gun: g, saat: s1, gelmiyor, kapsam: "saat", zorla });
    if (r.onayGerekli) r.uyari = `Bu ay iptal hakkınızı kullandınız. Kurala göre ayda ${KURALLAR.aboneAylikIptal} erteleme hakkı var; bu iptal depozitonuzun yanmasına yol açar. Yine de bildirmek istiyor musunuz?`;
    if (r.basarili) await this.kayitTut({ ad: `${a.ad} (abone sayfası)` }, gelmiyor ? "Abone: bu hafta gelmiyoruz" : "Abone: yine geliyoruz", `${g} ${s1}${r.hakAsildi ? " · iptal hakkı aşıldı" : ""}`);
    return r;
  }

  /** Abone kendi sayfasından abonelik iptali ister (yönetici sonlandırır) */
  async aboneIptalTalebi(anahtar, { neden }) {
    return this.kilitli(async () => {
      const a = await this.aboneAnahtarla(anahtar);
      if (!a) return { hata: "Bağlantı geçersiz." };
      if (a.iptalTalebi) return { hata: "İptal talebiniz zaten alındı; sizinle iletişime geçeceğiz." };
      const taahhut = aboneTaahhutte(a, bugunIsletme());
      const talep = { zaman: simdiYazi(), neden: kirp(neden, 300), taahhut };
      await this.st.put(`a:${a.id}`, { ...a, iptalTalebi: talep });
      await this.kayitTut({ ad: `${a.ad} (abone sayfası)` }, "Abone: abonelik iptal talebi", `${talep.neden || "—"}${taahhut ? " · 3 ay dolmadı" : ""}`);
      return { basarili: true, talep, abone: { id: a.id, ad: a.ad, no: aboneNo(a), telefon: a.telefon, depozito: a.depozito } };
    });
  }

  /** Takvimden hızlı: abone notu */
  async aboneNotKaydet(id, not, yapan) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a) return { hata: "Abone bulunamadı." };
      await this.st.put(`a:${id}`, { ...a, not: kirp(not, 500) });
      await this.kayitTut(yapan, "Abone notunu güncelledi", `${a.ad}: ${kirp(not, 120)}`);
      return { basarili: true };
    });
  }

  /** Yönetici abonenin iptal talebini geri çevirir (abonelik devam eder) */
  async aboneIptalTalebiReddet(id, yapan) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a?.iptalTalebi) return { hata: "Bekleyen iptal talebi yok." };
      const { iptalTalebi, ...kalan } = a;
      await this.st.put(`a:${id}`, kalan);
      await this.kayitTut(yapan, "Abone iptal talebini geri çevirdi", `${a.ad} · ${iptalTalebi.zaman}`);
      return { basarili: true };
    });
  }

  /**
   * Online abone başvurusunun kaporası onaylanınca: abone kaydı açılır (ilk maç = başvurulan maç, sonraki haftadan itibaren
   * her hafta), rezervasyon aboneye bağlanır. Depozito ilk maç günü kasada alınır.
   */
  async aboneBasvuruKabul(kayitNo) {
    this._urunOnbellek = await this.urunler();
    const b = await this.kayitBul(kayitNo);
    const r = b?.kayit;
    if (!r?.aboneBasvuru || r.aboneId || r.durum !== DURUM.onayli) return null;
    const ilk = r.isletmeGunu || r.tarih;
    const sonuc = await this.aboneKaydet({
      ad: r.ad, telefon: r.telefon, gun: gunNo(ilk), saat: r.saat, baslangic: gunEkle(ilk, 1),
      depozito: r.aboneBasvuru.depozitoIban ? `${r.aboneBasvuru.depozito.toLocaleString("tr-TR")} TL (IBAN ile ödendi ${String(r.kaporaGunu || "").split("-").reverse().join(".")})`
        : `${r.aboneBasvuru.depozito.toLocaleString("tr-TR")} TL (ilk maçta alınacak)`,
      not: "Online abone başvurusu", yeniKural: true, ilkMac: ilk, eposta: r.aboneBasvuru.eposta || "",
      // Abonelere ilk 14 çay ikram (kayıt formunda yazan söz): kasada kendiliğinden uygulanır
      anlasma: (() => { const cay = (this._urunOnbellek || []).find((u) => bardakKurali(u.ad).bardakUrunu); return cay ? [{ urunId: cay.id, ad: cay.ad, ucretsiz: KURALLAR.aboneCayIkram, kademeler: [], not: "Abone ikramı" }] : []; })(),
    });
    if (!sonuc.basarili) return sonuc;
    await this.kilitli(async () => {
      const g = await this.kayitBul(kayitNo);
      if (g) await this.st.put(g.anahtar, { ...g.kayit, aboneId: sonuc.abone.id });
    });
    return { ...sonuc, ilkMac: ilk, rez: r };
  }

  async olustur(girdi) {
    return this.kilitli(() => this.rezervasyonYaz({ ...girdi, durum: DURUM.bekliyor, kaynak: "Online", kapora: "" }, false));
  }

  async kayitBul(kayitNo) {
    const anahtar = await this.st.get(`k:${String(kayitNo || "").trim().toUpperCase()}`);
    if (!anahtar) return null;
    const kayit = await this.st.get(anahtar);
    return kayit ? { anahtar, kayit } : null;
  }

  /** "Rezervasyonumu kontrol et": gün + saat + telefon + ad soyad eşleşirse rezervasyon özeti. */
  async rezSorgula({ tarih: gunGirdi, saat: s, telefon: tel, ad }) {
    return this.kilitli(async () => {
      const gun = tarihNormalize(gunGirdi), saat = saatNormalize(s), telefon = telefonNormalize(tel);
      const sl = gun && saat && telefon ? this.slot(await this.durumYukle(gun, gun), gun, saat) : null;
      if (!sl || sl.tur !== "rez" || sl.rez.telefon !== telefon || !adEslesir(ad, sl.rez.ad)) {
        return { hata: "Seçtiğiniz gün ve saatte bu ad soyad ve telefonla rezervasyon bulunamadı." };
      }
      return { basarili: true, ...sl.rez };
    });
  }

  /** Bağlantısı kopan müşteri: opsiyonlu saatine telefonla geri döner. */
  async opsiyonDevam({ tarih: gunGirdi, saat: s, telefon: tel }) {
    return this.kilitli(async () => {
      const gun = tarihNormalize(gunGirdi), saat = saatNormalize(s), telefon = telefonNormalize(tel);
      if (!gun || !saat || !telefon) return { hata: "Telefon numarası eşleşmedi." };
      const sl = this.slot(await this.durumYukle(gun, gun), gun, saat);
      if (sl.tur !== "rez" || sl.rez.telefon !== telefon || sl.rez.durum !== DURUM.bekliyor) return { hata: "Telefon numarası eşleşmedi." };
      return { basarili: true, ...sl.rez };
    });
  }

  /** Müşterinin onay ekranı için güncel durum (kayıt no + telefon). */
  async rezDurum({ kayitNo, telefon: tel }) {
    const telefon = telefonNormalize(tel);
    const b = await this.kayitBul(kayitNo);
    if (!b || !telefon || b.kayit.telefon !== telefon) return { hata: "Rezervasyon bulunamadı." };
    const r = b.kayit;
    const dustu = opsiyonDustu(r) || Boolean(r.opsiyonDustu);
    return {
      durum: dustu ? "Düştü" : iptalMi(r.durum) ? "İptal" : r.durum,
      opsiyonBitis: r.durum === DURUM.bekliyor && !dustu ? r.opsiyonBitis || null : null,
      opsiyonKalan: r.durum === DURUM.bekliyor && !dustu && r.opsiyonBitis ? Math.max(0, r.opsiyonBitis - Date.now()) : null,
      dekont: r.dekont ? { onay: Boolean(r.dekont.kontrol?.onay), nedenler: r.dekont.kontrol?.nedenler || [] } : null,
    };
  }

  async bul(tel) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const liste = (await this.rezervasyonlar(simdi().tarih, gunEkle(simdi().tarih, 60)))
        .filter((r) => r.telefon === telefon && !iptalMi(r.durum) && !opsiyonDustu(r) && macZamani(r.tarih, r.saat) > Date.now())
        .sort((a, b) => (a.tarih + a.saat).localeCompare(b.tarih + b.saat))
        .map((r) => ({
          kayitNo: r.kayitNo, tarih: r.tarih, isletmeGunu: r.isletmeGunu || r.tarih, gun: r.gun, saat: r.saat, durum: r.durum,
          dekont: Boolean(r.dekont), opsiyonBitis: r.durum === DURUM.bekliyor ? r.opsiyonBitis || null : null,
          ucret: r.ucret || null,
        }));
      return { rezervasyonlar: liste };
    });
  }

  /** Müşteri dekont yükler (kayıt no + telefonla). Aynı rezervasyona yeniden yüklenirse eskisinin yerine geçer. */
  async dekontYukle({ kayitNo, telefon: tel, tur, ad, veri }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const b = await this.kayitBul(kayitNo);
      if (!b || b.kayit.telefon !== telefon || (iptalMi(b.kayit.durum) && !b.kayit.opsiyonDustu)) {
        return { hata: "Bu numaraya ait böyle bir aktif rezervasyon bulunamadı." };
      }
      // Opsiyon süresi dolduysa: yer hâlâ boşsa rezervasyon geri gelir, doluysa dekont alınmaz
      if (opsiyonDustu(b.kayit) || b.kayit.opsiyonDustu) {
        const gun = b.kayit.isletmeGunu || isletmeGunu(b.kayit.tarih, b.kayit.saat);
        const sl = this.slot(await this.durumYukle(gun, gun), gun, b.kayit.saat);
        if (sl.tur === "rez" || sl.tur === "abone") {
          return { hata: `${KURALLAR.opsiyonDakika} dakikalık opsiyon süresi dolduğu için bu saat başka birine verildi. Ödeme yaptıysanız lütfen hemen arayın: 0 555 510 26 26.` };
        }
        b.kayit = { ...b.kayit, durum: DURUM.bekliyor, opsiyonDustu: false, iptalEden: undefined, opsiyonBitis: Date.now() + 5 * 60_000 };
      }
      if (!DEKONT_TURLERI.includes(tur)) return { hata: "Dekontu PDF ya da JPG (ekran görüntüsü) olarak yükleyin." };
      if (!(veri instanceof Uint8Array) || veri.byteLength < 100) return { hata: "Dosya okunamadı." };
      if (veri.byteLength > DEKONT_EN_FAZLA) return { hata: "Dosya çok büyük (en fazla 1,8 MB)." };
      // Kapora parça parça gelebilir (ör. 500 + 700): her dekont ayrı saklanır
      const sira = (b.kayit.dekontlar || []).length + 1;
      if (sira > 5) return { hata: "Bu rezervasyona en fazla 5 dekont yüklenebilir. Lütfen arayın." };
      const anahtarD = sira === 1 ? `d:${b.kayit.kayitNo}` : `d:${b.kayit.kayitNo}:${sira}`;
      const dekont = { zaman: simdiYazi(), tur, ad: kirp(ad, 80) || "dekont", boyut: veri.byteLength, anahtar: anahtarD, sira };
      await this.st.put(anahtarD, { ...dekont, veri });
      const kayit = { ...b.kayit, dekont, dekontlar: [...(b.kayit.dekontlar || []), dekont] };
      await this.st.put(b.anahtar, kayit);
      return { basarili: true, ...kayit };
    });
  }

  /**
   * Otomatik kontrol sonucunu işler. Aynı dosya başka bir rezervasyonda kullanıldıysa onaylamaz.
   * deger: dekontDegerlendir() sonucu
   */
  async dekontSonuc(kayitNo, dosyaOzeti, deger) {
    return this.kilitli(async () => {
      const b = await this.kayitBul(kayitNo);
      if (!b) return { hata: "Rezervasyon bulunamadı." };
      const nedenler = [...deger.nedenler];
      const onceki = await this.st.get(`dh:${dosyaOzeti}`);
      // Aynı rezervasyona aynı dekont ikinci kez yüklenirse tutar iki kez sayılmaz
      // (Önceki yükleme onaylanmadıysa aynı dosya yeniden değerlendirilir: ilk denemede okuma takılmış olabilir)
      const ayniDosya = onceki && onceki.kayitNo === b.kayit.kayitNo && (b.kayit.dekontlar || []).length > 1
        && (b.kayit.dekontlar || []).slice(0, -1).some((x) => x.kontrol?.onay);
      // Dekont başka rezervasyonda kullanılmışsa reddedilir; ancak o rezervasyon İPTAL edildiyse (yönetici iptal etmiş,
      // para gelmiş olabilir) dekont yeni rezervasyona aktarılır: kapora parası tek sefer sayılır
      let aktarilan = null;
      if (KURALLAR.dekontTekrarKontrol && onceki && onceki.kayitNo !== b.kayit.kayitNo) {
        const eskiB = await this.kayitBul(onceki.kayitNo);
        if (eskiB && iptalMi(eskiB.kayit.durum) && !eskiB.kayit.kaporaAktarildi) aktarilan = eskiB;
        else nedenler.unshift("Bu dekont daha önce başka bir rezervasyon için kullanılmış.");
      }
      const baskasinda = KURALLAR.dekontTekrarKontrol && onceki && onceki.kayitNo !== b.kayit.kayitNo && !aktarilan;
      if (baskasinda) { /* neden yukarıda eklendi */ }
      else if (ayniDosya) nedenler.unshift("Bu dekontu zaten yüklediniz.");
      else await this.st.put(`dh:${dosyaOzeti}`, { kayitNo: b.kayit.kayitNo, tarih: simdi().tarih, ...(aktarilan ? { onceki: aktarilan.kayit.kayitNo } : {}) });
      const onay = nedenler.length === 0;
      const o = deger.okunan || {};
      const kontrol = {
        onay, nedenler, tutar: deger.tutar, zaman: simdiYazi(),
        okunan: { iban: o.alici_iban || null, ad: o.alici_ad || null, tutar: o.tutar ?? null, tarih: o.tarih || null, model: o._model || null },
      };
      const dekontlar = [...(b.kayit.dekontlar || [])];
      if (dekontlar.length) dekontlar[dekontlar.length - 1] = { ...dekontlar.at(-1), kontrol };
      const kayit = { ...b.kayit, dekont: { ...(b.kayit.dekont || {}), kontrol }, dekontlar };
      if (onay && kayit.durum === DURUM.bekliyor) {
        kayit.durum = DURUM.onayli;
        kayit.opsiyonBitis = null;
        kayit.onaylayan = "Dekont (otomatik)";
      }
      // Onaylı dekontların tutarları toplanır: kapora "500 + 700", toplam 1200
      const parcalar = dekontlar.filter((x) => x.kontrol?.onay);
      const tutarlar = parcalar.map((x) => x.kontrol.tutar).filter((x) => x != null);
      if (parcalar.length) {
        kayit.kapora = tutarlar.length ? tutarlar.join(" + ") : "dekontta okunamadı";
        const yeniToplam = tutarlar.reduce((t, x) => t + x, 0);
        if (yeniToplam !== kayit.kaporaToplam || !kayit.kaporaGunu) kayit.kaporaGunu = bugunIsletme();
        kayit.kaporaToplam = yeniToplam;
        const gereken = kayit.kaporaTutar ?? (await this.fiyatAyar()).kapora;
        kayit.eksikKapora = tutarlar.length !== parcalar.length || kayit.kaporaToplam < gereken;
      }
      if (onay && aktarilan) {
        // Para iptal edilen rezervasyonun dekontuyla geldiği gün kasaya girmişti: yeni rezervasyonda tekrar "bugün gelen kapora" sayılmaz
        kayit.kaporaGunu = aktarilan.kayit.kaporaGunu || kayit.kaporaGunu;
        kayit.kaporaAktarim = { kayitNo: aktarilan.kayit.kayitNo, zaman: simdiYazi() };
        await this.st.put(aktarilan.anahtar, { ...aktarilan.kayit, kaporaAktarildi: kayit.kayitNo });
      }
      await this.st.put(b.anahtar, kayit);
      if (onay && aktarilan) await this.kayitTut(null, "Dekont iptal edilen rezervasyondan aktarıldı", `${aktarilan.kayit.kayitNo} (${aktarilan.kayit.ad}, iptal) → ${kayit.kayitNo} (${kayit.ad})`);
      await this.kayitTut(null, onay ? "Dekont otomatik onaylandı" : "Dekont kontrol gerekiyor",
        `${kayit.kayitNo} · ${kayit.ad} · ${onay ? deger.tutar + " TL" : nedenler.join(" ")}`);
      return { basarili: true, onay, nedenler, rez: kayit, ...(aktarilan ? { aktarilan: aktarilan.kayit.kayitNo } : {}), eksik: Boolean(kayit.eksikKapora), tutar: deger.tutar,
        toplam: kayit.kaporaToplam ?? null, gereken: kayit.kaporaTutar ?? null };
    });
  }

  /**
   * Kaporası eksik kalan onaylı online rezervasyonlar (ilk dekonttan 15 dk sonra hâlâ eksikse) — bir kez bildirilir.
   * Müşteri bu sürede ikinci parçanın dekontunu yükleyebilir.
   */
  async eksikKaporalar() {
    return this.kilitli(async () => {
      const n = simdi();
      const liste = await this.st.list({ start: `r:${gunEkle(n.tarih, -1)}`, end: `r:${gunEkle(n.tarih, 40)}~` });
      const sonuc = [];
      for (const [anahtar, r] of liste) {
        if (r.durum !== DURUM.onayli || !r.eksikKapora || r.eksikBildirildi || !r.dekontlar?.length) continue;
        const ilk = Date.parse(r.dekontlar[0].zaman.replace(" ", "T") + ":00+03:00");
        if (Date.now() - ilk < KURALLAR.opsiyonDakika * 60_000) continue;
        await this.st.put(anahtar, { ...r, eksikBildirildi: true });
        sonuc.push(r);
      }
      return sonuc;
    });
  }

  /** Süresi dolan online opsiyonları "İptal" olarak işaretler (zamanlanmış görev, 5 dakikada bir). */
  async opsiyonlariDusur() {
    return this.kilitli(async () => {
      const n = simdi();
      const liste = await this.st.list({ start: `r:${gunEkle(n.tarih, -1)}`, end: `r:${gunEkle(n.tarih, 40)}~` });
      const dusen = [];
      for (const [anahtar, r] of liste) {
        if (!opsiyonDustu(r)) continue;
        const yeni = { ...r, durum: DURUM.iptal, iptalEden: "Opsiyon süresi doldu (dekont gelmedi)", opsiyonDustu: true };
        await this.st.put(anahtar, yeni);
        dusen.push(yeni);
      }
      if (dusen.length) await this.kayitTut(null, "Opsiyon düştü", dusen.map((r) => `${r.kayitNo} ${r.tarih} ${r.saat} ${r.ad}`).join(" · "));
      return dusen;
    });
  }

  async dekontGetir(kayitNo, sira) {
    const no = String(kayitNo || "").trim().toUpperCase();
    const n = Number(sira) || 1;
    return (await this.st.get(n > 1 ? `d:${no}:${n}` : `d:${no}`)) || null;
  }

  /** Müşteri iptali: kayıt no ile ya da seçtiği gün + saat ile (telefon eşleşmeli). */
  async iptal({ kayitNo, tarih: gunGirdi, saat: s, telefon: tel, ad }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      if (!kayitNo && gunGirdi && s) {
        const gun = tarihNormalize(gunGirdi), saat = saatNormalize(s);
        const sl = gun && saat ? this.slot(await this.durumYukle(gun, gun), gun, saat) : null;
        // Telefon + rezervasyondaki ad soyad birlikte eşleşmeli
        if (!sl || sl.tur !== "rez" || sl.rez.telefon !== telefon || !adEslesir(ad, sl.rez.ad)) {
          return { hata: "Seçtiğiniz gün ve saatte bu telefon ve ad soyad ile rezervasyon bulunamadı." };
        }
        kayitNo = sl.rez.kayitNo;
      }
      const b = await this.kayitBul(kayitNo);
      if (!b || b.kayit.telefon !== telefon || iptalMi(b.kayit.durum)) {
        return { hata: "Bu numaraya ait böyle bir aktif rezervasyon bulunamadı." };
      }
      const kalanSaat = (macZamani(b.kayit.tarih, b.kayit.saat) - Date.now()) / 3600_000;
      // Onaylanmamış online opsiyon her zaman bırakılabilir; onaylı rezervasyonda 3 saat kuralı
      const opsiyon = b.kayit.kaynak === "Online" && b.kayit.durum === DURUM.bekliyor;
      if (!opsiyon && kalanSaat < KURALLAR.iptalEnGecSaat) {
        return { hata: `Maça ${KURALLAR.iptalEnGecSaat} saatten az kaldığı için çevrimiçi iptal yapılamıyor. Lütfen işletmeyi arayın.` };
      }
      await this.st.put(b.anahtar, { ...b.kayit, durum: DURUM.iptal, iptalEden: "Müşteri" });
      if (b.kayit.durum === DURUM.onayli) {
        await this.kayitTut({ ad: "Müşteri (site)" }, "Müşteri rezervasyonu iptal etti", `${b.kayit.kayitNo} · ${b.kayit.isletmeGunu || b.kayit.tarih} ${b.kayit.saat} · ${b.kayit.ad} · ${telefon}`);
      }
      return { basarili: true, kayitNo: b.kayit.kayitNo, tarih: b.kayit.tarih, saat: b.kayit.saat, gun: b.kayit.gun, ad: b.kayit.ad, kapora: b.kayit.kapora,
        onayliydi: b.kayit.durum === DURUM.onayli };
    });
  }

  // ================= Panel: kullanıcılar ve giriş =================
  //   u:<eposta>   kullanıcı { eposta, ad, telefon, rol, durum: bekliyor|aktif|pasif, hash, tuz, kayit }
  //   o:<token>    oturum { eposta, bitis }
  //   s:<token>    şifre sıfırlama { eposta, bitis } (1 saat geçerli, tek kullanımlık)

  async kullaniciListesi() {
    const m = await this.st.list({ prefix: "u:" });
    return [...m.values()];
  }

  async panelDurum() {
    return { kurulu: (await this.kullaniciListesi()).some((u) => u.rol === "admin" && u.durum === "aktif") };
  }

  /** İlk kurulum / acil durum: PANEL_KURULUM_KODU ile bir Admin hesabı oluşturur veya şifresini yeniler. */
  async panelKur({ kurulumKodu, eposta, ad, sifre }) {
    return this.kilitli(async () => {
      const kod = this.env.PANEL_KURULUM_KODU;
      if (!kod || !esitMi(String(kurulumKodu || ""), kod)) return { hata: "Kurulum kodu hatalı." };
      const e = epostaNormalize(eposta);
      if (!e) return { hata: "Geçerli bir e-posta adresi girin." };
      if (typeof sifre !== "string" || sifre.length < 8) return { hata: "Şifre en az 8 karakter olmalı." };
      const eski = await this.st.get(`u:${e}`);
      const tuz = rastgele(16);
      await this.st.put(`u:${e}`, {
        ...(eski || { kayit: simdiYazi(), telefon: "" }),
        eposta: e, ad: kirp(ad, 60) || eski?.ad || "Admin", rol: "admin", durum: "aktif",
        hash: await sifreHash(sifre, tuz), tuz,
      });
      await this.oturumlariKapat(e);
      await this.kayitTut({ ad: kirp(ad, 60) || eski?.ad || "Admin", eposta: e, rol: "admin" }, "Kurulum kodu ile Admin girişi");
      return this.oturumAc(e);
    });
  }

  /** Kendi kendine kayıt: hesap Müdür / Müdür Yardımcısı onaylayıp rol verene kadar kapalıdır. */
  async kayitOl({ eposta, ad, telefon: tel, sifre, rol }) {
    return this.kilitli(async () => {
      const e = epostaNormalize(eposta);
      if (!e) return { hata: "Geçerli bir e-posta adresi girin." };
      if (kirp(ad, 60).length < 2) return { hata: "Adınızı ve soyadınızı yazın." };
      if (typeof sifre !== "string" || sifre.length < 8) return { hata: "Şifre en az 8 karakter olmalı." };
      if (!ROLLER[rol] || rol === "admin") return { hata: "Görevinizi (rol) seçin." };
      if (await this.st.get(`u:${e}`)) return { hata: "Bu e-posta ile zaten bir hesap var. Giriş yapın ya da şifrenizi sıfırlayın." };
      const tuz = rastgele(16);
      const u = {
        eposta: e, ad: kirp(ad, 60), telefon: telefonNormalize(tel) || "", rol: null, istenenRol: rol, durum: "bekliyor",
        hash: await sifreHash(sifre, tuz), tuz, kayit: simdiYazi(),
      };
      await this.st.put(`u:${e}`, u);
      await this.kayitTut(u, "Kayıt oldu", `İstenen görev: ${ROLLER[rol].ad}`);
      return { basarili: true, kullanici: kullaniciDisi(u) };
    });
  }

  async panelGiris({ eposta, sifre }) {
    return this.kilitli(async () => {
      const e = epostaNormalize(eposta);
      const u = e && (await this.st.get(`u:${e}`));
      // Hesap olmasa da hash hesapla: yanıt süresinden e-postanın kayıtlı olup olmadığı anlaşılmasın
      const hash = await sifreHash(String(sifre || ""), u ? u.tuz : "yok");
      if (!u || !esitMi(hash, u.hash)) return { hata: "E-posta veya şifre hatalı." };
      if (u.durum === "bekliyor") return { hata: "Hesabınız Müdür onayı bekliyor. Onaylanınca giriş yapabilirsiniz." };
      if (u.durum !== "aktif" || !ROLLER[u.rol]) return { hata: "Hesabınız kapalı. Müdürle görüşün." };
      await this.kayitTut(u, "Giriş yaptı");
      return this.oturumAc(e);
    });
  }

  async oturumAc(eposta) {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const bitis = Date.now() + OTURUM_GUN * 86400_000;
    await this.st.put(`o:${token}`, { eposta, bitis });
    return { basarili: true, token, bitis };
  }

  async oturumlariKapat(eposta) {
    const m = await this.st.list({ prefix: "o:" });
    const sil = [...m].filter(([, o]) => !o.eposta || o.eposta === eposta).map(([k]) => k);
    if (sil.length) await this.st.delete(sil);
  }

  /** Geçerli oturumun kullanıcısı (aktif ve rolü olan) ya da null. */
  async oturum(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const o = await this.st.get(`o:${token}`);
    if (!o || !o.eposta) return null;
    if (o.bitis < Date.now()) { await this.st.delete(`o:${token}`); return null; }
    const u = await this.st.get(`u:${o.eposta}`);
    if (!u || u.durum !== "aktif" || !ROLLER[u.rol]) return null;
    return kullaniciDisi(u);
  }

  async cikis(token) {
    if (token && /^[0-9a-f]{64}$/.test(token)) await this.st.delete(`o:${token}`);
    return { basarili: true };
  }

  /** Şifre sıfırlama bağlantısı üretir (yalnızca aktif ya da onay bekleyen hesaplar için). */
  async sifirlamaOlustur(eposta) {
    return this.kilitli(async () => {
      const e = epostaNormalize(eposta);
      const u = e && (await this.st.get(`u:${e}`));
      if (!u || u.durum === "pasif") return { yok: true };
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      await this.st.put(`s:${token}`, { eposta: e, bitis: Date.now() + 3600_000 });
      return { basarili: true, token, eposta: e, ad: u.ad };
    });
  }

  async sifreSifirla({ token, sifre }) {
    return this.kilitli(async () => {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return { hata: "Bağlantı geçersiz." };
      const s = await this.st.get(`s:${token}`);
      if (!s || s.bitis < Date.now()) {
        if (s) await this.st.delete(`s:${token}`);
        return { hata: "Bağlantının süresi dolmuş. Yeniden \"Şifremi unuttum\" deyin." };
      }
      if (typeof sifre !== "string" || sifre.length < 8) return { hata: "Şifre en az 8 karakter olmalı." };
      const u = await this.st.get(`u:${s.eposta}`);
      if (!u) return { hata: "Hesap bulunamadı." };
      const tuz = rastgele(16);
      await this.st.put(`u:${s.eposta}`, { ...u, hash: await sifreHash(sifre, tuz), tuz });
      await this.st.delete(`s:${token}`);
      await this.oturumlariKapat(s.eposta);
      await this.kayitTut(u, "Şifresini yeniledi");
      if (u.durum !== "aktif" || !ROLLER[u.rol]) return { basarili: true, onayBekliyor: true };
      return { ...(await this.oturumAc(s.eposta)), basarili: true };
    });
  }

  // ---------- E-postadaki bağlantıyla onay ----------
  //   t:<token>  { eposta (onaylanacak), onaylayan (eposta), bitis } — 7 gün geçerli, tek kullanımlık

  /** Yeni kaydı onaylayabilecek kişiler (Admin her zaman; Müdür, istenen rol kendinden alttaysa) için birer bağlantı. */
  async onayBaglantilari(eposta) {
    return this.kilitli(async () => {
      const u = await this.st.get(`u:${eposta}`);
      if (!u || u.durum !== "bekliyor") return [];
      const onaylayanlar = (await this.kullaniciListesi())
        .filter((x) => x.durum === "aktif" && (x.rol === "admin" || x.rol === "mudur") && yonetebilir(x, u.istenenRol));
      const sonuc = [];
      for (const x of onaylayanlar) {
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        await this.st.put(`t:${token}`, { eposta: u.eposta, onaylayan: x.eposta, bitis: Date.now() + 7 * 86400_000 });
        sonuc.push({ kime: x.eposta, ad: x.ad, token });
      }
      return sonuc;
    });
  }

  async onayBaglantilariniSil(eposta) {
    const sil = [...(await this.st.list({ prefix: "t:" }))].filter(([, v]) => v.eposta === eposta).map(([k]) => k);
    if (sil.length) await this.st.delete(sil);
  }

  async onayBilgisi(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return { hata: "Bağlantı geçersiz." };
    const t = await this.st.get(`t:${token}`);
    if (!t || t.bitis < Date.now()) return { hata: "Bağlantının süresi dolmuş ya da daha önce kullanılmış." };
    const u = await this.st.get(`u:${t.eposta}`);
    if (!u) return { hata: "Bu kayıt artık yok." };
    if (u.durum !== "bekliyor") return { hata: `${u.ad} zaten ${u.durum === "aktif" ? "onaylanmış" : "kapatılmış"}.` };
    return { ad: u.ad, eposta: u.eposta, telefon: u.telefon, rolAd: ROLLER[u.istenenRol]?.ad || "", kayit: u.kayit };
  }

  /** karar: "onayla" (istenen rolle hesabı açar) ya da "reddet" (kaydı siler). */
  async onayKarari(token, karar) {
    return this.kilitli(async () => {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return { hata: "Bağlantı geçersiz." };
      const t = await this.st.get(`t:${token}`);
      if (!t || t.bitis < Date.now()) return { hata: "Bağlantının süresi dolmuş ya da daha önce kullanılmış." };
      const [u, yapan] = await Promise.all([this.st.get(`u:${t.eposta}`), this.st.get(`u:${t.onaylayan}`)]);
      const tumu = await this.st.list({ prefix: "t:" });
      const sil = [...tumu].filter(([, v]) => v.eposta === t.eposta).map(([k]) => k);
      if (!u || u.durum !== "bekliyor") { if (sil.length) await this.st.delete(sil); return { hata: "Bu kayıt artık onay beklemiyor." }; }
      if (!yapan || yapan.durum !== "aktif" || !yonetebilir(yapan, u.istenenRol)) return { hata: "Bu bağlantıyla onay yetkiniz kalmamış." };
      if (sil.length) await this.st.delete(sil); // tüm onaylayıcıların bağlantıları geçersiz olur
      if (karar === "reddet") {
        await this.st.delete(`u:${u.eposta}`);
        await this.kayitTut(yapan, "Kaydı reddetti (e-posta bağlantısı)", `${u.ad} · ${u.eposta}`);
        return { basarili: true, karar, ad: u.ad };
      }
      if (!ROLLER[u.istenenRol]) return { hata: "Kayıtta görev seçilmemiş; panelden onaylayın." };
      await this.st.put(`u:${u.eposta}`, { ...u, rol: u.istenenRol, durum: "aktif" });
      await this.kayitTut(yapan, "Kullanıcı onayladı (e-posta bağlantısı)", `${u.ad} · ${u.eposta} · ${ROLLER[u.istenenRol].ad}`);
      return { basarili: true, karar: "onayla", ad: u.ad, rolAd: ROLLER[u.istenenRol].ad, eposta: u.eposta };
    });
  }

  /** Belirli rollerdeki aktif kullanıcıların e-postaları (bilgilendirme için). */
  async rolEpostalari(roller) {
    return (await this.kullaniciListesi()).filter((u) => u.durum === "aktif" && roller.includes(u.rol)).map((u) => u.eposta);
  }

  async kullanicilar() {
    return (await this.kullaniciListesi())
      .map(kullaniciDisi)
      .sort((a, b) => (a.durum === "bekliyor" ? -1 : 0) - (b.durum === "bekliyor" ? -1 : 0)
        || (ROL_SIRA[a.rol] ?? 9) - (ROL_SIRA[b.rol] ?? 9) || a.ad.localeCompare(b.ad, "tr"));
  }

  /** Rol / durum / bilgi değişikliği. Yapan: oturumdaki yönetici. */
  async kullaniciGuncelle({ eposta, rol, durum, ad, telefon: tel, saatlikUcret }, yapan) {
    return this.kilitli(async () => {
      const e = epostaNormalize(eposta);
      const u = e && (await this.st.get(`u:${e}`));
      if (!u) return { hata: "Kullanıcı bulunamadı." };
      const yeni = { ...u };
      if (rol !== undefined) {
        if (!ROLLER[rol]) return { hata: "Geçersiz rol." };
        yeni.rol = rol;
      }
      if (durum !== undefined) {
        if (!["aktif", "pasif"].includes(durum)) return { hata: "Geçersiz durum." };
        yeni.durum = durum;
      }
      if (ad !== undefined && kirp(ad, 60).length >= 2) yeni.ad = kirp(ad, 60);
      if (tel !== undefined) yeni.telefon = telefonNormalize(tel) || "";
      if (saatlikUcret !== undefined && saatlikUcret !== null && saatlikUcret !== "") {
        if (yapan?.rol !== "admin") return { hata: "Saatlik ücreti sadece Admin belirler." };
        const n = Number(String(saatlikUcret).replace(",", "."));
        if (!Number.isFinite(n) || n < 0 || n > 100000) return { hata: "Geçersiz saatlik ücret." };
        yeni.saatlikUcret = Math.round(n * 100) / 100;
      }
      if (yeni.durum === "aktif" && !ROLLER[yeni.rol]) return { hata: "Hesabı açmak için önce bir rol seçin." };

      const hata = this.yetkiKontrol(u, yeni, yapan);
      if (hata) return { hata };
      if (u.rol === "admin" && u.durum === "aktif" && (yeni.rol !== "admin" || yeni.durum !== "aktif")) {
        const digerAdmin = (await this.kullaniciListesi()).some((x) => x.eposta !== e && x.rol === "admin" && x.durum === "aktif");
        if (!digerAdmin) return { hata: "En az bir aktif Admin kalmalı." };
      }
      await this.st.put(`u:${e}`, yeni);
      if (yeni.durum !== "aktif" || yeni.rol !== u.rol) await this.oturumlariKapat(e);
      if (u.durum === "bekliyor" && yeni.durum !== "bekliyor") await this.onayBaglantilariniSil(e);
      return { basarili: true, kullanici: kullaniciDisi(yeni), ...(u.durum === "bekliyor" && yeni.durum === "aktif" ? { ilkOnay: true } : {}) };
    });
  }

  /**
   * Veri yedeği: bütün kayıtlar (rezervasyon, abone, müşteri, kasa, ürün, puantaj, ayarlar…) tek JSON.
   * Güvenlik için oturumlar, şifre sıfırlama / onay bağlantıları ve şifre özetleri yedeğe girmez;
   * dekont / fotoğraf dosyaları (büyük ikili veri) da girmez.
   */
  async yedek() {
    const HARIC = ["o:", "s:", "t:", "d:", "f:"];
    const veri = {};
    const sayac = {};
    let start;
    for (;;) {
      const m = await this.st.list({ start, limit: 1000 });
      if (!m.size) break;
      for (const [k, v] of m) {
        start = k + "\0";
        if (HARIC.some((h) => k.startsWith(h))) continue;
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) continue;
        const on = k.split(":")[0];
        sayac[on] = (sayac[on] || 0) + 1;
        veri[k] = k.startsWith("u:") && v && typeof v === "object" ? (({ hash, tuz, ...u }) => u)(v) : v;
      }
      if (m.size < 1000) break;
    }
    return { surum: 1, olusturma: simdiYazi(), anahtarSayisi: Object.keys(veri).length, sayac, veri };
  }

  /** O gün GELDİM diyen Müdür / Müdür Yardımcısı e-postaları; kimse yoksa tüm Müdür ve Müdür Yardımcıları */
  async gununYoneticileri(gun = bugunIsletme()) {
    const kullanicilar = await this.kullaniciListesi();
    const gelenler = [...(await this.st.list({ prefix: `p:${gun}:` })).keys()].map((k) => k.split(":").slice(2).join(":"));
    const y = kullanicilar.filter((u) => u.durum === "aktif" && ["mudur", "mudur_yrd"].includes(u.rol));
    const bugun = y.filter((u) => gelenler.includes(u.eposta)).map((u) => u.eposta);
    return bugun.length ? bugun : y.map((u) => u.eposta);
  }

  // ---- Memnuniyet anketi (sahadaki QR → /anket) ----
  //   an:<ISO zaman>:<rastgele>  { zaman, puan: {soruId: 1-5}, oneri, tavsiye, ad, telefon }
  async anketKaydet({ puan, tavsiye, oneri, ad, telefon }) {
    const p = {};
    for (const q of ANKET_SORULARI) { const n = Math.round(Number(puan?.[q.id])); if (n >= 1 && n <= 5) p[q.id] = n; }
    if (!Object.keys(p).length && !kirp(oneri, 1000)) return { hata: "Lütfen en az bir soruyu puanlayın." };
    const kayit = { zaman: simdiYazi(), puan: p, tavsiye: ["evet", "belki", "hayir"].includes(tavsiye) ? tavsiye : "",
      oneri: kirp(oneri, 1000), ad: kirp(ad, 60), telefon: telefonNormalize(telefon) || "" };
    await this.st.put(`an:${new Date().toISOString()}:${rastgele(4)}`, kayit);
    return { basarili: true, kayit, dusuk: Object.values(p).some((n) => n <= 2) || kayit.tavsiye === "hayir" };
  }

  /** Admin: son N gün anket özeti (ortalamalar) ve son yorumlar */
  async anketOzet(gunSayisi = 30) {
    const bas = new Date(Date.now() - gunSayisi * 86400_000).toISOString();
    const l = [...(await this.st.list({ start: `an:${bas}`, end: "an:~" })).values()].reverse();
    const ort = ANKET_SORULARI.map((q) => {
      const v = l.map((x) => x.puan?.[q.id]).filter(Boolean);
      return { ...q, ortalama: v.length ? Math.round((v.reduce((t, n) => t + n, 0) / v.length) * 10) / 10 : null, sayi: v.length };
    });
    const tav = { evet: 0, belki: 0, hayir: 0 };
    for (const x of l) if (tav[x.tavsiye] !== undefined) tav[x.tavsiye]++;
    return { gun: gunSayisi, toplam: l.length, ortalamalar: ort, tavsiye: tav, son: l.slice(0, 50) };
  }

  /** Tek seferlik bayrak: yoksa koyar ve true döner */
  async birKez(anahtar) {
    return this.kilitli(async () => {
      if (await this.st.get(anahtar)) return false;
      await this.st.put(anahtar, Date.now());
      return true;
    });
  }

  yetkiKontrol(eski, yeni, yapan) {
    if (!yapan || !ROLLER[yapan.rol]?.yonetici) return "Bu işlem için yetkiniz yok.";
    if (eski.eposta === yapan.eposta && (yeni.rol !== eski.rol || yeni.durum !== eski.durum)) return "Kendi rolünüzü veya durumunuzu değiştiremezsiniz.";
    if (!yonetebilir(yapan, eski.rol) || !yonetebilir(yapan, yeni.rol)) {
      return `${ROLLER[eski.rol]?.ad || ROLLER[yeni.rol]?.ad} hesaplarını yönetme yetkiniz yok.`;
    }
    return null;
  }

  async kullaniciSil(eposta, yapan) {
    return this.kilitli(async () => {
      const e = epostaNormalize(eposta);
      const u = e && (await this.st.get(`u:${e}`));
      if (!u) return { hata: "Kullanıcı bulunamadı." };
      if (u.eposta === yapan?.eposta) return { hata: "Kendi hesabınızı silemezsiniz." };
      const hata = this.yetkiKontrol(u, u, yapan);
      if (hata) return { hata };
      if (u.rol === "admin" && u.durum === "aktif"
        && !(await this.kullaniciListesi()).some((x) => x.eposta !== e && x.rol === "admin" && x.durum === "aktif")) {
        return { hata: "En az bir aktif Admin kalmalı." };
      }
      await this.st.delete(`u:${e}`);
      await this.oturumlariKapat(e);
      await this.onayBaglantilariniSil(e);
      return { basarili: true };
    });
  }

  // ================= Puantaj (çalışan giriş / çıkış, saatlik ödeme) =================
  //   p:<işletme günü>:<eposta>  { giris, cikis (ms), duzelten, not }

  /** Bir işletme günü için beklenen işe başlama: ilk maçtan 1 saat önce. */
  async beklenenBaslama(gun) {
    const d = await this.durumYukle(gun, gun);
    const dolu = this.saatListesi(d, gun, gun).filter((saat) => { const t = this.slot(d, gun, saat).tur; return t === "rez" || t === "abone"; });
    const ilk = dolu[0], son = dolu.at(-1);
    if (!ilk) return { gun, ilkMac: null, baslama: null, sonMac: null, bitis: null };
    const h = (Number(ilk.slice(0, 2)) + 23) % 24;
    // Beklenen çıkış: son maç bitişi (+1 saat) + 30 dk
    const bitisDk = (Number(son.slice(0, 2)) + 1) * 60 + Number(son.slice(3, 5)) + KURALLAR.puantajCikisEk;
    const bitis = `${String(Math.floor(bitisDk / 60) % 24).padStart(2, "0")}:${String(bitisDk % 60).padStart(2, "0")}`;
    return { gun, ilkMac: ilk, sonMac: son, baslama: `${String(h).padStart(2, "0")}:00`, bitis };
  }

  /**
   * Açılış uyarısı: maç olan günde iş başı saati (ilk maçtan 1 saat önce) geldiği hâlde
   * hiçbir çalışan GELDİM dememişse bir kez uyarı döner (Admin / Müdür / Müdür Yrd.'a e-posta).
   *   ua:<gün>  gönderildi işareti
   */
  async acilisKontrol(simdiMs = Date.now()) {
    return this.kilitli(async () => {
      const n = simdi();
      const gun = isletmeGunu(n.tarih, n.saat);
      const b = await this.beklenenBaslama(gun);
      if (!b.baslama || !b.ilkMac) return null;
      const baslamaMs = macZamani(takvimTarihi(gun, b.baslama), b.baslama);
      const macMs = macZamani(takvimTarihi(gun, b.ilkMac), b.ilkMac);
      if (simdiMs < baslamaMs || simdiMs > macMs + 3600_000) return null;
      if (await this.st.get(`ua:${gun}`)) return null;
      const gelen = [...(await this.st.list({ prefix: `p:${gun}:` })).values()].some((k) => k.giris);
      if (gelen) return null;
      await this.st.put(`ua:${gun}`, { zaman: simdiYazi() });
      await this.kayitTut(null, "Açılış uyarısı", `${gun} · iş başı ${b.baslama}, ilk maç ${b.ilkMac} · GELDİM diyen çalışan yok`);
      return { gun, gunAd: gunAdi(gun), baslama: b.baslama, ilkMac: b.ilkMac, sonMac: b.sonMac };
    });
  }

  /** Çalışanın bugünkü kartı: beklenen saat, kendi giriş/çıkışı, bu ayki toplam. */
  async puantajBugun(ben) {
    const n = simdi();
    const gun = isletmeGunu(n.tarih, n.saat);
    const [b, kayit, ay, u] = await Promise.all([
      this.beklenenBaslama(gun), this.st.get(`p:${gun}:${ben.eposta}`), this.puantajAy(gun.slice(0, 7), ben.eposta),
      this.st.get(`u:${ben.eposta}`),
    ]);
    const k = ay.kisiler[0];
    return { ...b, yolSaat: KURALLAR.puantajYolSaat, kayit: kayit || null, buAy: { saat: k?.saat || 0, ucret: k?.ucret || 0 }, saatlikUcret: u?.saatlikUcret || 0 };
  }

  async puantajGiris(ben) {
    return this.kilitli(async () => {
      const n = simdi();
      const gun = isletmeGunu(n.tarih, n.saat);
      const anahtar = `p:${gun}:${ben.eposta}`;
      const k = await this.st.get(anahtar);
      if (k?.giris && !k.cikis) return { hata: "Girişiniz zaten onaylı. İşten çıkarken 'Çıkışı onayla'ya basın." };
      if (k?.cikis) return { hata: "Bugünkü giriş ve çıkışınız kayıtlı. Düzeltme için yöneticinize başvurun." };
      const kayit = { giris: Date.now(), cikis: null, ad: ben.ad };
      await this.st.put(anahtar, kayit);
      await this.kayitTut(ben, "İşe giriş onayladı", `${gun} · ${zamanYazi(kayit.giris)}`);
      return { basarili: true, gun, kayit };
    });
  }

  async puantajCikis(ben) {
    return this.kilitli(async () => {
      const n = simdi();
      // Gece yarısını geçen vardiya: önce bugünün, yoksa dünün açık girişine bakılır
      const gunler = [isletmeGunu(n.tarih, n.saat), gunEkle(isletmeGunu(n.tarih, n.saat), -1)];
      for (const gun of gunler) {
        const anahtar = `p:${gun}:${ben.eposta}`;
        const k = await this.st.get(anahtar);
        if (k?.giris && !k.cikis) {
          if (Date.now() - k.giris > 20 * 3600_000) return { hata: "Açık girişiniz çok eski. Yöneticinizden düzeltmesini isteyin." };
          const kayit = { ...k, cikis: Date.now() };
          await this.st.put(anahtar, kayit);
          await this.kayitTut(ben, "İşten çıkış onayladı", `${gun} · ${zamanYazi(kayit.cikis)} · ${saatFark(kayit)} saat`);
          return { basarili: true, gun, kayit };
        }
      }
      return { hata: "Açık bir girişiniz yok. Önce 'Girişi onayla'ya basın." };
    });
  }

  /** Kasa gönderilince: o günün açık girişlerinin hepsine şimdiki saatle ÇIKTIM yazılır */
  async puantajHepsiCikis(gun, yapan) {
    return this.kilitli(async () => {
      const m = await this.st.list({ prefix: `p:${gun}:` });
      const simdiMs = Date.now(), yaz = {}, kapanan = [];
      for (const [anahtar, k] of m) {
        if (!k?.giris || k.cikis || simdiMs - k.giris > 20 * 3600_000) continue;
        yaz[anahtar] = { ...k, cikis: simdiMs, otomatikCikis: `Kasa gönderildi (${yapan?.ad || ""})` };
        kapanan.push({ eposta: anahtar.split(":").slice(2).join(":"), ad: k.ad || "" });
      }
      if (!kapanan.length) return { kapanan };
      await this.st.put(yaz);
      await this.kayitTut(yapan, "Kasa gönderildi: çalışanlara ÇIKTIM yazıldı", `${gun} · ${zamanYazi(simdiMs)} · ${kapanan.map((x) => x.ad || x.eposta).join(", ")}`);
      return { kapanan, gun };
    });
  }

  /** Aylık puantaj: kişi kişi günler, saatler ve ödenecek tutar. eposta verilirse sadece o kişi. */
  async puantajAy(ay, eposta) {
    if (!/^\d{4}-\d{2}$/.test(ay || "")) return { hata: "Geçersiz ay." };
    const [m, kullanicilar, avM, ayKasa] = await Promise.all([this.st.list({ start: `p:${ay}-01`, end: `p:${ay}-31~` }), this.kullaniciListesi(),
      this.st.list({ start: `av:${ay}-01`, end: `av:${ay}-31~` }), this.st.list({ start: `kasa:${ay}-01`, end: `kasa:${ay}-31~` })]);
    // Personel kantini günlük düşülmez: ay boyunca toplanır, ay sonu maaştan kesilir
    const kantinAy = new Map();
    for (const k of ayKasa.values()) {
      for (const [e, t] of Object.entries(personelKesintileri(k))) {
        if (!t) continue;
        const l = kantinAy.get(e) || [];
        l.push({ gun: k.gun, tutar: Math.round(t), urunler: Object.entries(k.ikram?.[`p:${e}`] || {}).map(([id, a]) => `${k.birimler?.[id]?.ad || id} ×${a}`).join(", ") });
        kantinAy.set(e, l);
      }
    }
    // Avanslar: Admin'in puantajdan girdikleri + kasadan verilen günlük ödemeler
    const avanslar = [...avM.entries()].map(([k, v]) => ({ ...v, anahtar: k }));
    for (const k of ayKasa.values()) for (const a of k.avanslar || []) avanslar.push({ ...a, gun: k.gun, not: "kasadan", kasadan: true });
    const kisiler = new Map();
    for (const [anahtar, k] of m) {
      const [, gun, ...ep] = anahtar.split(":");
      const e = ep.join(":");
      if (eposta && e !== eposta) continue;
      const u = kullanicilar.find((x) => x.eposta === e);
      if (!kisiler.has(e)) kisiler.set(e, { eposta: e, ad: u?.ad || k.ad || e, rol: ROLLER[u?.rol]?.ad || "", saatlikUcret: u?.saatlikUcret || 0, gunler: [], saat: 0, ucret: 0, brut: 0, kesinti: 0 });
      const kisi = kisiler.get(e);
      const saat = odenecekSaat(k);
      kisi.gunler.push({ gun, giris: k.giris ? zamanYazi(k.giris) : null, cikis: k.cikis ? zamanYazi(k.cikis) : null, saat, acik: Boolean(k.giris && !k.cikis), duzelten: k.duzelten || null });
      kisi.saat = Math.round((kisi.saat + saat) * 100) / 100;
    }
    for (const a of avanslar) {
      if (eposta && a.eposta !== eposta) continue;
      if (!kisiler.has(a.eposta)) {
        const u = kullanicilar.find((x) => x.eposta === a.eposta);
        kisiler.set(a.eposta, { eposta: a.eposta, ad: u?.ad || a.ad, rol: ROLLER[u?.rol]?.ad || "", saatlikUcret: u?.saatlikUcret || 0, gunler: [], saat: 0, ucret: 0, brut: 0, kesinti: 0 });
      }
      const kisi = kisiler.get(a.eposta);
      kisi.avans = (kisi.avans || 0) + a.tutar;
      (kisi.avansListe ||= []).push({ gun: a.gun, tutar: a.tutar, not: a.not || "", anahtar: a.anahtar, ekleyen: a.ekleyen || "", kasadan: Boolean(a.kasadan) });
    }
    for (const [e, l] of kantinAy) {
      if (eposta && e !== eposta) continue;
      if (!kisiler.has(e)) {
        const u = kullanicilar.find((x) => x.eposta === e);
        kisiler.set(e, { eposta: e, ad: u?.ad || e, rol: ROLLER[u?.rol]?.ad || "", saatlikUcret: u?.saatlikUcret || 0, gunler: [], saat: 0, ucret: 0, brut: 0, kesinti: 0 });
      }
      const kisi = kisiler.get(e);
      kisi.kantinListe = l; kisi.kesinti = l.reduce((t, x) => t + x.tutar, 0);
    }
    // Ay sonu ödenecek = saat × saatlik ücret − ayın personel kantini; kalan = ödenecek − verilen avanslar
    for (const kisi of kisiler.values()) {
      kisi.brut = Math.round(kisi.saat * kisi.saatlikUcret); kisi.ucret = kisi.brut - kisi.kesinti;
      kisi.avans = kisi.avans || 0; kisi.kalan = kisi.ucret - kisi.avans;
    }
    return { ay, kisiler: [...kisiler.values()].sort((a, b) => a.ad.localeCompare(b.ad, "tr")) };
  }

  /** Ay sonu maaş e-postası: her ayın SON GÜNÜ 09:00'dan sonra o ay için bir kez (o akşamın vardiyası panelde eklenir) */
  async maasRaporuZamani() {
    return this.kilitli(async () => {
      const n = simdi();
      if (gunEkle(n.tarih, 1).slice(8) !== "01" || n.saat < "09:00") return null;
      const ay = n.tarih.slice(0, 7);
      if (await this.st.get(`mr:${ay}`)) return null;
      await this.st.put(`mr:${ay}`, { zaman: simdiYazi() });
      return ay;
    });
  }

  /** Çalışana verilen avans / ödeme (Admin): av:<gün>:<eposta>:<id>  { eposta, ad, gun, tutar, not } */
  async avansEkle({ eposta, gun, tutar: t, not }, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Avansı sadece Admin girer." };
      const u = await this.st.get(`u:${epostaNormalize(eposta)}`);
      const g = tarihNormalize(gun) || bugunIsletme();
      const tt = tutar(t);
      if (!u) return { hata: "Çalışan bulunamadı." };
      if (!tt) return { hata: "Tutar girin." };
      const a = `av:${g}:${u.eposta}:${rastgele(5)}`;
      await this.st.put(a, { eposta: u.eposta, ad: u.ad, gun: g, tutar: tt, not: kirp(not, 80), ekleyen: yapan.ad, zaman: simdiYazi() });
      await this.kayitTut(yapan, "Avans / ödeme girdi", `${u.ad} · ${g} · ${tt} TL${not ? " · " + kirp(not, 80) : ""}`);
      return { basarili: true };
    });
  }

  async avansSil(anahtar, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Avansı sadece Admin siler." };
      const v = typeof anahtar === "string" && anahtar.startsWith("av:") ? await this.st.get(anahtar) : null;
      if (!v) return { hata: "Kayıt bulunamadı." };
      await this.st.delete(anahtar);
      await this.kayitTut(yapan, "Avans / ödeme sildi", `${v.ad} · ${v.gun} · ${v.tutar} TL`);
      return { basarili: true };
    });
  }

  /** Admin: bir kişiyi o ayın puantajından tamamen kaldırır (giriş-çıkış günleri, avanslar, kasadaki ödemeler ve personel kantini; kantin stoğu geri gelir). */
  async puantajKisiSil(ay, eposta, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Sadece Admin." };
      if (!/^\d{4}-\d{2}$/.test(ay || "") || !eposta) return { hata: "Eksik bilgi." };
      const [pM, avM, ayKasa, urunler] = await Promise.all([this.st.list({ start: `p:${ay}-01`, end: `p:${ay}-31~` }),
        this.st.list({ start: `av:${ay}-01`, end: `av:${ay}-31~` }), this.st.list({ start: `kasa:${ay}-01`, end: `kasa:${ay}-31~` }), this.urunler()]);
      const sil = [...pM.keys()].filter((k) => k.split(":").slice(2).join(":") === eposta)
        .concat([...avM.entries()].filter(([, v]) => v.eposta === eposta).map(([k]) => k));
      const yaz = {}, stok = {};
      for (const [k, kayit] of ayKasa) {
        const ikram = kayit.ikram?.[`p:${eposta}`], av = (kayit.avanslar || []).some((x) => x.eposta === eposta);
        if (!ikram && !av) continue;
        const y = { ...kayit, ikram: { ...(kayit.ikram || {}) }, avanslar: (kayit.avanslar || []).filter((x) => x.eposta !== eposta) };
        delete y.ikram[`p:${eposta}`];
        for (const [id, a] of Object.entries(stokTuketimi(ikram || {}, urunler))) stok[id] = (stok[id] || 0) + a;
        y.ozet = kasaOzet(y);
        yaz[k] = y;
      }
      for (const u of urunler) if (stok[u.id]) yaz[`urun:${u.id}`] = { ...u, stok: (u.stok || 0) + stok[u.id] };
      if (!sil.length && !Object.keys(yaz).length) return { hata: "Bu ay için kayıt yok." };
      if (sil.length) await this.st.delete(sil);
      if (Object.keys(yaz).length) await this.st.put(yaz);
      await this.kayitTut(yapan, "Puantajdan kişi kaldırdı", `${eposta} · ${ay} · ${sil.length} kayıt, ${Object.keys(yaz).filter((k) => k.startsWith("kasa:")).length} kasa günü`);
      return { basarili: true };
    });
  }

  /** Yönetici düzeltmesi (unutulan çıkış vb.): saatler "HH:MM", gece yarısını geçen çıkış ertesi güne yazılır. */
  async puantajDuzelt({ eposta, gun, giris, cikis, sil }, yapan) {
    return this.kilitli(async () => {
      if (!yapan || !["admin", "mudur"].includes(yapan.rol)) return { hata: "Puantajı sadece Admin ve Müdür düzeltebilir." };
      const g = tarihNormalize(gun);
      const u = await this.st.get(`u:${epostaNormalize(eposta)}`);
      if (!g || !u) return { hata: "Kişi veya gün bulunamadı." };
      const anahtar = `p:${g}:${u.eposta}`;
      const eski = await this.st.get(anahtar);
      if (sil) {
        if (yapan.rol !== "admin") return { hata: "Puantaj kaydını sadece Admin silebilir." };
        await this.st.delete(anahtar);
        await this.kayitTut(yapan, "Puantaj kaydını sildi", `${u.ad} · ${g}${eski?.giris ? ` · ${zamanYazi(eski.giris)}–${eski.cikis ? zamanYazi(eski.cikis) : "?"}` : ""}`);
        return { basarili: true };
      }
      const ms = (s, sonraki) => {
        const x = saatNormalize(s); if (!x) return null;
        const t = macZamani(g, x);
        return sonraki && Number(x.slice(0, 2)) < 6 ? t + 86400_000 : t;
      };
      const gi = ms(giris, false), ci = cikis ? ms(cikis, true) : null;
      if (!gi) return { hata: "Giriş saati gerekli (SS:DD)." };
      if (ci && ci <= gi) return { hata: "Çıkış girişten sonra olmalı." };
      const yeni = { ...(eski || {}), ad: u.ad, giris: gi, cikis: ci, duzelten: yapan.ad };
      await this.st.put(anahtar, yeni);
      await this.kayitTut(yapan, "Puantaj düzeltti", `${u.ad} · ${g} · giriş ${eski?.giris ? zamanYazi(eski.giris) : "—"} → ${zamanYazi(gi)} · çıkış ${eski?.cikis ? zamanYazi(eski.cikis) : "—"} → ${ci ? zamanYazi(ci) : "—"}`);
      return { basarili: true, kayit: yeni };
    });
  }

  // ================= Fiyatlar (Admin panelden değiştirir) =================
  //   ayar:fiyat  { mac, kapora, spiker, hakem }

  async fiyatAyar() {
    if (!this._fiyat) {
      const k = (await this.st.get("ayar:fiyat")) || {};
      this._fiyat = {
        mac: k.mac ?? FIYATLAR.gunduz, kapora: k.kapora ?? FIYATLAR.kapora,
        spiker: k.spiker ?? EKSTRALAR.spiker.ucret, hakem: k.hakem ?? EKSTRALAR.hakem.ucret,
        abone: k.abone ?? 3200, krampon: k.krampon ?? 100, eldiven: k.eldiven ?? 100,
        kantinCarpan: k.kantinCarpan ?? 2.5, // kantin satış fiyatı = alış × çarpan (5 TL'ye yukarı yuvarlanır)
        siparisTel: k.siparisTel ?? "05434764687", // kantin tedarikçisi (Tespo) WhatsApp
        temizlikTel: k.temizlikTel ?? "05545618282", // temizlik ürünleri tedarikçisi WhatsApp
      };
    }
    return this._fiyat;
  }

  async fiyatKaydet(girdi, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Fiyatları sadece Admin değiştirebilir." };
      const eski = await this.fiyatAyar();
      const yeni = { ...eski };
      for (const [a, enAz, enCok] of [["mac", 100, 100000], ["kapora", 0, 100000], ["spiker", 0, 100000], ["hakem", 0, 100000], ["abone", 0, 100000], ["krampon", 0, 10000], ["eldiven", 0, 10000]]) {
        if (girdi[a] === undefined || girdi[a] === "") continue;
        const n = Math.round(Number(String(girdi[a]).replace(/[^\d]/g, "")));
        if (!Number.isFinite(n) || n < enAz || n > enCok) return { hata: "Geçersiz tutar." };
        yeni[a] = n;
      }
      if (girdi.temizlikTel !== undefined && girdi.temizlikTel !== "") {
        const t = telefonNormalize(girdi.temizlikTel);
        if (!t) return { hata: "Temizlik sipariş numarası geçersiz (05XX XXX XX XX)." };
        yeni.temizlikTel = t;
      }
      if (girdi.siparisTel !== undefined && girdi.siparisTel !== "") {
        const t = telefonNormalize(girdi.siparisTel);
        if (!t) return { hata: "Sipariş numarası geçersiz (05XX XXX XX XX)." };
        yeni.siparisTel = t;
      }
      if (yeni.kapora > yeni.mac) return { hata: "Kapora maç ücretinden büyük olamaz." };
      await this.st.put("ayar:fiyat", yeni);
      this._fiyat = yeni;
      const ad = { mac: "Maç", kapora: "Kapora", spiker: "VIP spiker", hakem: "VIP hakem", abone: "Abone maç", krampon: "Krampon kirası", eldiven: "Eldiven kirası", siparisTel: "Tespo sipariş no", temizlikTel: "Temizlik sipariş no" };
      const fark = Object.keys(ad).filter((a) => eski[a] !== yeni[a]).map((a) => `${ad[a]}: ${eski[a]} → ${yeni[a]}${a.endsWith("Tel") ? "" : " TL"}`);
      if (fark.length) await this.kayitTut(yapan, "Fiyatları değiştirdi", fark.join(" · "));
      return { basarili: true, fiyat: yeni, fiyatFark: Object.keys(ad).filter((a) => !a.endsWith("Tel") && eski[a] !== yeni[a]).map((a) => [ad[a], `${(eski[a] ?? 0).toLocaleString("tr-TR")} TL → ${yeni[a].toLocaleString("tr-TR")} TL`]) };
    });
  }

  // ================= Kasa defteri (günlük kasa raporu) =================
  //   urun:<id>        kantin ürünü { id, ad, alis, satis, stok, sira, aktif }
  //   kasa:<iş. günü>  { gun, devir, maclar[], girisler[], cikislar[], veresiye[], ikram{}, birakilan, sayilan, not, birimler{}, kira{}, ozet{} }

  async urunler() {
    const m = await this.st.list({ prefix: "urun:" });
    if (!m.size && !(await this.st.get("ayar:urunTohum"))) {
      // İlk açılışta eski Excel kasa raporundaki ürünler (alış, satış, son stok)
      const yeni = {};
      KANTIN_TOHUM.forEach(([ad, alis, satis, stok], i) => {
        const id = `u${String(i + 1).padStart(3, "0")}`;
        yeni[`urun:${id}`] = { id, ad, alis, satis, stok, sira: i + 1, aktif: true };
      });
      yeni["ayar:urunTohum"] = true;
      const anahtarlar = Object.keys(yeni);
      for (let i = 0; i < anahtarlar.length; i += 100) {
        await this.st.put(Object.fromEntries(anahtarlar.slice(i, i + 100).map((k) => [k, yeni[k]])));
      }
      return Object.entries(yeni).filter(([k]) => k.startsWith("urun:")).map(([, v]) => v);
    }
    if (!(await this.st.get("ayar:kahveAyrildi"))) {
      // Eski tek ürün "FİLTRE / TÜRK KAHVESİ" ikiye ayrılır (Türk kahvesi 2 bardak düşer)
      const yeni = { "ayar:kahveAyrildi": true };
      const eski = [...m.values()].find((u) => buyuk(u.ad).includes("FİLTRE") && buyuk(u.ad).includes("TÜRK"));
      if (eski) {
        yeni[`urun:${eski.id}`] = { ...eski, ad: "FİLTRE KAHVE" };
        const id = `u${Date.now().toString(36)}tk`;
        yeni[`urun:${id}`] = { id, ad: "TÜRK KAHVESİ", alis: eski.alis, satis: eski.satis, stok: 0, sira: (eski.sira || 0) + 0.5, aktif: eski.aktif !== false };
      }
      await this.st.put(yeni);
      for (const [k, v] of Object.entries(yeni)) if (k.startsWith("urun:")) m.set(k, v);
    }
    return [...m.values()].sort((a, b) => (a.sira || 0) - (b.sira || 0));
  }

  async urunlerGorunum() { return bardakGorunum(await this.urunler()); }

  /** Ürün ekle / düzenle / stok sayımı (Admin, Müdür). stokEkle: gelen mal adedi. */
  /** Admin / Müdür: kantin kâr çarpanı; istenirse bütün ürünlerin satış fiyatı yeniden hesaplanır */
  async kantinCarpanKaydet({ carpan, hepsine }, yapan) {
    return this.kilitli(async () => {
      if (!["admin", "mudur"].includes(yapan?.rol)) return { hata: "Kâr çarpanını sadece Admin ve Müdür değiştirir." };
      const c = Math.round(Number(String(carpan).replace(",", ".")) * 100) / 100;
      if (!(c >= 1 && c <= 10)) return { hata: "Çarpan 1 ile 10 arasında olmalı (ör. 2,5)." };
      const f = await this.fiyatAyar();
      const eskiC = f.kantinCarpan;
      const yeniF = { ...((await this.st.get("ayar:fiyat")) || {}), kantinCarpan: c };
      await this.st.put("ayar:fiyat", yeniF);
      this._fiyat = null;
      const degisen = [];
      if (hepsine) {
        const yaz = {};
        for (const u of await this.urunler()) {
          if (!u.alis) continue;
          const satis = kantinSatis(u.alis, c);
          if (satis !== u.satis) { yaz[`urun:${u.id}`] = { ...u, satis }; degisen.push([`Kantin: ${u.ad}`, `${(u.satis ?? 0).toLocaleString("tr-TR")} TL → ${satis.toLocaleString("tr-TR")} TL`]); }
        }
        const anahtarlar = Object.keys(yaz);
        for (let i = 0; i < anahtarlar.length; i += 100) await this.st.put(Object.fromEntries(anahtarlar.slice(i, i + 100).map((k) => [k, yaz[k]])));
      }
      await this.kayitTut(yapan, "Kantin kâr çarpanını değiştirdi", `${eskiC} → ${c}${hepsine ? ` · ${degisen.length} ürünün satış fiyatı güncellendi` : ""}`);
      return { basarili: true, carpan: c, fiyatFark: degisen };
    });
  }

  async urunKaydet({ id, ad, alis, satis, stok, stokEkle, aktif, sil }, yapan) {
    return this.kilitli(async () => {
      if (!["admin", "mudur"].includes(yapan?.rol)) return { hata: "Ürünleri sadece Admin ve Müdür düzenler." };
      await this.urunler();
      const eski = id ? await this.st.get(`urun:${id}`) : null;
      if (id && !eski) return { hata: "Ürün bulunamadı." };
      if (sil) {
        await this.st.delete(`urun:${id}`);
        await this.kayitTut(yapan, "Kantin ürünü sildi", eski.ad);
        return { basarili: true };
      }
      const yeni = eski ? { ...eski } : { id: `u${Date.now().toString(36)}${rastgele(2)}`, stok: 0, aktif: true, sira: 9999 };
      if (ad !== undefined) { yeni.ad = kirp(ad, 40).toLocaleUpperCase("tr"); if (!yeni.ad) return { hata: "Ürün adı gerekli." }; }
      if (!yeni.ad) return { hata: "Ürün adı gerekli." };
      if (alis !== undefined && alis !== "") yeni.alis = tutar(alis);
      if (satis !== undefined && satis !== "") yeni.satis = tutar(satis);
      // Alış fiyatı değişti ve satış elle değiştirilmediyse: satış = alış × kâr çarpanı (5 TL'ye yukarı)
      else if (yeni.alis && yeni.alis !== eski?.alis) yeni.satis = kantinSatis(yeni.alis, (await this.fiyatAyar()).kantinCarpan);
      if (bardakKurali(yeni.ad).bagli) { stok = undefined; stokEkle = 0; } // stoğu bardak stoğuna bağlı
      if (stok !== undefined && stok !== "") yeni.stok = Math.round(Number(stok)) || 0;
      if (stokEkle) yeni.stok = (yeni.stok || 0) + (Math.round(Number(stokEkle)) || 0);
      if (aktif !== undefined) yeni.aktif = Boolean(aktif);
      await this.st.put(`urun:${yeni.id}`, yeni);
      const fark = eski
        ? ["ad", "alis", "satis", "stok", "aktif"].filter((a) => eski[a] !== yeni[a]).map((a) => `${{ ad: "ad", alis: "alış", satis: "satış", stok: "stok", aktif: "satışta" }[a]}: ${eski[a]} → ${yeni[a]}`)
        : [`alış ${yeni.alis || 0} · satış ${yeni.satis || 0} · stok ${yeni.stok}`];
      if (fark.length) await this.kayitTut(yapan, eski ? "Kantin ürünü düzenledi" : "Kantin ürünü ekledi", `${yeni.ad} · ${fark.join(" · ")}`);
      return { basarili: true, urun: yeni, ...(eski && eski.satis !== yeni.satis ? { fiyatFark: [[`Kantin: ${yeni.ad}`, `${(eski.satis ?? 0).toLocaleString("tr-TR")} TL → ${(yeni.satis ?? 0).toLocaleString("tr-TR")} TL`]] } : {}) };
    });
  }

  // ---- Ücretsiz maç kodları (Admin belirler) ----
  //   ayar:kodlar  [{ kod, aciklama, hak, kullanilan, aktif, kullanimlar[] }]
  async kodlar() { return (await this.st.get("ayar:kodlar")) || []; }

  async kodKontrol(kod) {
    const k = kirp(kod, 30).toLocaleUpperCase("tr").replace(/İ/g, "I").replace(/\s/g, "");
    const x = (await this.kodlar()).find((y) => y.kod === k);
    if (!x || !x.aktif) return { hata: "Ücretsiz maç kodu geçersiz." };
    if (x.hak && x.kullanilan >= x.hak) return { hata: "Bu kodun kullanım hakkı dolmuş." };
    return x;
  }

  async kodKullan(kod, kayitNo) {
    const l = await this.kodlar();
    const x = l.find((y) => y.kod === kod);
    if (!x) return;
    x.kullanilan = (x.kullanilan || 0) + 1;
    x.kullanimlar = [...(x.kullanimlar || []), { kayitNo, zaman: simdiYazi() }].slice(-50);
    await this.st.put("ayar:kodlar", l);
  }

  async kodKaydet({ kod, aciklama, hak, aktif, sil }, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Kodları sadece Admin düzenler." };
      const k = kirp(kod, 30).toLocaleUpperCase("tr").replace(/İ/g, "I").replace(/\s/g, "");
      if (!/^[A-Z0-9ÇĞÖŞÜ-]{3,30}$/.test(k)) return { hata: "Kod 3–30 harf/rakam olmalı." };
      const l = await this.kodlar();
      const i = l.findIndex((y) => y.kod === k);
      if (sil) { if (i >= 0) l.splice(i, 1); }
      else if (i >= 0) Object.assign(l[i], { aciklama: kirp(aciklama ?? l[i].aciklama, 80), hak: Math.max(0, Math.round(Number(hak ?? l[i].hak)) || 0), aktif: aktif ?? l[i].aktif });
      else l.push({ kod: k, aciklama: kirp(aciklama, 80), hak: Math.max(0, Math.round(Number(hak)) || 0), kullanilan: 0, aktif: true, olusturma: simdiYazi() });
      await this.st.put("ayar:kodlar", l);
      await this.kayitTut(yapan, sil ? "Ücretsiz kodu sildi" : i >= 0 ? "Ücretsiz kodu güncelledi" : "Ücretsiz kod ekledi", `${k}${aciklama ? " · " + kirp(aciklama, 80) : ""}`);
      return { basarili: true, kodlar: l };
    });
  }

  /** Paneldeki rezervasyona sonradan ücretsiz kod uygula */
  async rezKodUygula({ kayitNo, kod }, yapan) {
    return this.kilitli(async () => {
      const b = await this.kayitBul(kayitNo);
      if (!b) return { hata: "Kayıt bulunamadı." };
      if (b.kayit.ucretsiz) return { hata: "Bu rezervasyon zaten ücretsiz." };
      const x = await this.kodKontrol(kod);
      if (x.hata) return x;
      const f = await this.fiyatAyar();
      const vip = (b.kayit.ekstra || []).reduce((t, e) => t + (f[e] ?? EKSTRALAR[e]?.ucret ?? 0), 0);
      const k = { ...b.kayit, ucret: vip, ucretsiz: { kod: x.kod, neden: x.aciklama || "Ücretsiz maç kodu" }, durum: DURUM.onayli, opsiyonBitis: null };
      await this.kodKullan(x.kod, k.kayitNo);
      await this.st.put(b.anahtar, k);
      await this.kayitTut(yapan, "Ücretsiz kod uyguladı", `${k.kayitNo} · ${k.isletmeGunu || k.tarih} ${k.saat} · ${k.ad} · ${x.kod}`);
      return { basarili: true, rez: k };
    });
  }

  // ---- Kapora IBAN'ı (sadece Admin, şifresiyle değiştirir; her değişiklik yöneticilere e-postayla bildirilir) ----
  //   ayar:iban  { no, alici, guncelleyen, zaman }
  async ibanAyar() {
    const k = await this.st.get("ayar:iban");
    return k || { no: IBAN.no, alici: IBAN.alici, guncelleyen: "Kurulum", zaman: null };
  }

  /** Admin yetkisini başka bir aktif kullanıcıya devreder; devreden Müdür olur. Şifre ister. */
  async adminDevret({ eposta, sifre }, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Sadece Admin devredebilir." };
      const ben = await this.st.get(`u:${yapan.eposta}`);
      if (!ben || !esitMi(await sifreHash(String(sifre || ""), ben.tuz), ben.hash)) return { hata: "Şifreniz hatalı. Devir yapılmadı." };
      const e = epostaNormalize(eposta);
      const hedef = e && (await this.st.get(`u:${e}`));
      if (!hedef || hedef.durum !== "aktif") return { hata: "Devredilecek kişi aktif bir kullanıcı olmalı." };
      if (hedef.eposta === ben.eposta) return { hata: "Kendinize devredemezsiniz." };
      if (hedef.rol === "admin") return { hata: `${hedef.ad} zaten Admin.` };
      const eskiRol = ROLLER[hedef.rol]?.ad || "";
      await this.st.put({ [`u:${hedef.eposta}`]: { ...hedef, rol: "admin" }, [`u:${ben.eposta}`]: { ...ben, rol: "mudur" } });
      await this.oturumlariKapat(ben.eposta);
      await this.oturumlariKapat(hedef.eposta);
      await this.kayitTut(yapan, "ADMİN YETKİSİNİ DEVRETTİ", `${ben.ad} → ${hedef.ad} (${hedef.eposta}, önceki görevi ${eskiRol}); ${ben.ad} artık Müdür`);
      return { basarili: true, yeniAdmin: { eposta: hedef.eposta, ad: hedef.ad }, eskiAdmin: { eposta: ben.eposta, ad: ben.ad } };
    });
  }

  async ibanKaydet({ no, alici, sifre }, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "IBAN'ı sadece Admin değiştirebilir." };
      const u = await this.st.get(`u:${yapan.eposta}`);
      if (!u || !esitMi(await sifreHash(String(sifre || ""), u.tuz), u.hash)) return { hata: "Şifreniz hatalı. IBAN değiştirilmedi." };
      const temiz = ibanGecerli(no);
      if (!temiz) return { hata: "IBAN geçersiz (TR ile başlayan 26 karakter, sağlama hanesi tutmalı)." };
      const ad = kirp(alici, 60);
      if (ad.length < 3) return { hata: "Hesap sahibinin adı gerekli." };
      const eski = await this.ibanAyar();
      const yeni = { no: ibanYaz(temiz), alici: ad, guncelleyen: yapan.ad, zaman: simdiYazi() };
      await this.st.put("ayar:iban", yeni);
      await this.kayitTut(yapan, "KAPORA IBAN'INI DEĞİŞTİRDİ", `${eski.no} (${eski.alici}) → ${yeni.no} (${yeni.alici})`);
      return { basarili: true, eski, yeni };
    });
  }

  /** Gizli kontrol uyarısı en fazla 6 saatte bir gönderilsin */
  async ibanUyariZamani() {
    return this.kilitli(async () => {
      const son = await this.st.get("ayar:ibanUyari");
      if (son && Date.now() - son < 6 * 3600_000) return false;
      await this.st.put("ayar:ibanUyari", Date.now());
      return true;
    });
  }

  // ---- Tedarikçi / usta rehberi (Admin yazar; kasada WhatsApp düğmesi olur) ----
  //   ayar:rehber  [{ ad, tel, mesaj }]  (mesaj: WhatsApp'ta hazır açılan yazı)
  async rehber() {
    const r = await this.st.get("ayar:rehber");
    return Array.isArray(r) ? r : [
      { ad: "Elektrikçi", tel: "05424980226", mesaj: "" },
      { ad: "PAKSU (tuz)", tel: "05323226819", mesaj: "Merhaba, 10 çuval tuz alabilir miyiz? Aysu Halı Saha" },
    ];
  }

  async rehberKaydet(liste, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Rehberi sadece Admin düzenler." };
      const l = [];
      for (const x of Array.isArray(liste) ? liste.slice(0, 30) : []) {
        const ad = kirp(x?.ad, 40), tel = telefonNormalize(x?.tel), mesaj = kirp(x?.mesaj, 300);
        if (!ad && !x?.tel) continue;
        if (!ad || !tel) return { hata: `Geçersiz satır: ${ad || "(ad yok)"} ${x?.tel || ""}` };
        l.push({ ad, tel, mesaj });
      }
      await this.st.put("ayar:rehber", l);
      await this.kayitTut(yapan, "Tedarikçi rehberini güncelledi", l.map((x) => `${x.ad} ${x.tel}`).join(", "));
      return { basarili: true, rehber: l };
    });
  }

  // ---- Tesis kullanım videoları (YouTube "liste dışı" / Google Drive bağlantıları) ----
  async videolar() { return (await this.st.get("ayar:videolar")) || []; }
  async videolarKaydet(liste, yapan) {
    return this.kilitli(async () => {
      if (!["admin", "mudur"].includes(yapan?.rol)) return { hata: "Videoları Admin ve Müdür düzenler." };
      const l = [];
      for (const x of Array.isArray(liste) ? liste.slice(0, 50) : []) {
        const baslik = kirp(x?.baslik, 80), link = kirp(x?.link, 300);
        if (!baslik && !link) continue;
        if (!/^https:\/\/[^\s]+$/.test(link)) return { hata: `Geçersiz bağlantı: ${baslik || link || "(boş)"}` };
        l.push({ baslik: baslik || "Video", link, aciklama: kirp(x?.aciklama, 200), kategori: ["acil", "tesis", "diger"].includes(x?.kategori) ? x.kategori : "tesis" });
      }
      await this.st.put("ayar:videolar", l);
      await this.kayitTut(yapan, "Tesis videolarını güncelledi", l.map((x) => x.baslik).join(", "));
      return { basarili: true, videolar: l };
    });
  }

  // ---- Görevler (temizlik şefi / personel iş takibi) ----
  //   ayar:gorevler  [{ id, ad, aciklama, rol: "hepsi"|"temizlik"|"personel" }]
  //   gv:<işletme günü>:<id>  { eposta, ad, rol, zaman, not }
  async gorevler() {
    const g = await this.st.get("ayar:gorevler");
    return Array.isArray(g) ? g : VARSAYILAN_GOREVLER;
  }

  async gorevlerKaydet(liste, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Görev listesini sadece Admin düzenler." };
      const l = [], idler = new Set();
      for (const x of Array.isArray(liste) ? liste.slice(0, 40) : []) {
        const ad = kirp(x?.ad, 50);
        if (!ad) continue;
        let id = /^[a-z0-9-]{1,30}$/.test(x?.id || "") ? x.id : ad.toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "g";
        while (idler.has(id)) id += "x";
        idler.add(id);
        l.push({ id, ad, aciklama: kirp(x?.aciklama, 200), rol: ["temizlik", "personel"].includes(x?.rol) ? x.rol : "hepsi" });
      }
      await this.st.put("ayar:gorevler", l);
      await this.kayitTut(yapan, "Görev listesini güncelledi", l.map((x) => x.ad).join(", "));
      return { basarili: true, gorevler: l };
    });
  }

  async gorevHafta(bas) {
    const b = haftaBasi(/^\d{4}-\d{2}-\d{2}$/.test(bas || "") ? bas : bugunIsletme());
    const gunler = Array.from({ length: 7 }, (_, i) => gunEkle(b, i));
    const yapilan = {};
    for (const gun of gunler) {
      const m = await this.st.list({ prefix: `gv:${gun}:` });
      yapilan[gun] = {};
      for (const [k, v] of m) yapilan[gun][k.split(":")[2]] = { ...v, saat: zamanYazi(v.zaman) };
    }
    return { bas: b, bugun: bugunIsletme(), gunler, gorevler: await this.gorevler(), yapilan };
  }

  /** Bugünün görevini "yaptım" olarak işaretler (sadece bugün; geçmişi Admin/Müdür düzeltir). */
  async gorevYap(id, not, yapan) {
    return this.kilitli(async () => {
      if (!["admin", "temizlik", "personel"].includes(yapan?.rol)) return { hata: "Görevleri personel ve temizlik şefi onaylar; Müdür ve Müdür Yardımcısı sadece görür." };
      const g = (await this.gorevler()).find((x) => x.id === id);
      if (!g) return { hata: "Görev bulunamadı." };
      const gun = bugunIsletme(), k = `gv:${gun}:${id}`;
      const onceki = await this.st.get(k);
      if (onceki) return { hata: `${g.ad} bugün zaten ${onceki.ad} tarafından onaylandı (${zamanYazi(onceki.zaman)}).` };
      const kayit = { eposta: yapan.eposta, ad: yapan.ad, rol: ROLLER[yapan.rol]?.ad || "", zaman: Date.now(), not: kirp(not, 200) };
      await this.st.put(k, kayit);
      return { basarili: true, gun, gorev: g, kayit: { ...kayit, saat: zamanYazi(kayit.zaman) } };
    });
  }

  async gorevGeriAl(gun, id, yapan) {
    return this.kilitli(async () => {
      if (yapan?.rol !== "admin") return { hata: "Onayı sadece Admin geri alabilir." };
      const k = `gv:${gun}:${id}`, v = await this.st.get(k);
      if (!v) return { hata: "Kayıt yok." };
      await this.st.delete(k);
      await this.kayitTut(yapan, "Görev onayını geri aldı", `${gun} ${id} (${v.ad})`);
      return { basarili: true };
    });
  }

  // ---- Temizlik ürünleri (elle eklenir; satış yok, sadece stok ve sipariş) ----
  //   tu:<id>  { id, ad, stok }
  async temizlikUrunleri() {
    return [...(await this.st.list({ prefix: "tu:" })).values()].sort((a, b) => a.ad.localeCompare(b.ad, "tr"));
  }

  async temizlikKaydet({ id, ad, stok, stokEkle, sil }, yapan) {
    return this.kilitli(async () => {
      // Yöneticiler ve Temizlik Şefi temizlik stoğunu girer (silmeyi yöneticiler yapar)
      if (!ROLLER[yapan?.rol]?.yonetici && yapan?.rol !== "temizlik") return { hata: "Yetkiniz yok." };
      if (sil && !ROLLER[yapan?.rol]?.yonetici) return { hata: "Ürünü sadece yöneticiler siler." };
      const eski = id ? await this.st.get(`tu:${id}`) : null;
      if (id && !eski) return { hata: "Ürün bulunamadı." };
      if (sil) {
        await this.st.delete(`tu:${id}`);
        await this.kayitTut(yapan, "Temizlik ürünü sildi", eski.ad);
        return { basarili: true };
      }
      const yeni = eski ? { ...eski } : { id: `t${Date.now().toString(36)}${rastgele(2)}`, stok: 0 };
      if (ad !== undefined) yeni.ad = kirp(ad, 50).toLocaleUpperCase("tr");
      if (!yeni.ad) return { hata: "Ürün adı gerekli." };
      if (stok !== undefined && stok !== "") yeni.stok = Math.max(0, Math.round(Number(stok)) || 0);
      if (stokEkle) yeni.stok = (yeni.stok || 0) + (Math.round(Number(stokEkle)) || 0);
      await this.st.put(`tu:${yeni.id}`, yeni);
      await this.kayitTut(yapan, eski ? "Temizlik ürünü güncelledi" : "Temizlik ürünü ekledi", `${yeni.ad} · stok ${eski ? `${eski.stok} → ` : ""}${yeni.stok}`);
      return { basarili: true, urun: yeni };
    });
  }

  /** Admin her günü; Müdür / Müdür Yrd. sadece bugünü ve dünü görür, düzenler. */
  kasaYetkili(yapan, gun) {
    if (!yapan || !ROLLER[yapan.rol]?.yonetici) return false;
    if (yapan.rol === "admin") return true;
    const n = simdi();
    const bugun = isletmeGunu(n.tarih, n.saat);
    return gun === bugun || gun === gunEkle(bugun, -1);
  }

  /** O günün takvimindeki maçlar → kasa satırı önerisi */
  async kasaTakvim(gun) {
    const [d, f] = await Promise.all([this.durumYukle(gun, gun), this.fiyatAyar()]);
    const satirlar = [];
    for (const saat of this.saatListesi(d, gun, gun)) {
      const s = this.slot(d, gun, saat);
      if (s.tur === "abone") {
        const no = aboneNo(s.abone);
        satirlar.push({ saat, tur: "abone", aboneId: s.abone.id, veresiyeAcik: veresiyeAcik(s.abone), ad: no ? `Abone ${no}` : s.abone.ad, ucret: tutar(s.abone.ucret) || f.abone, vip: 0, onOdeme: 0, kaynak: "takvim", ...(s.abone.depozito ? { depozito: s.abone.depozito } : {}) });
      } else if (s.tur === "rez" && s.rez.durum === DURUM.onayli) {
        const r = s.rez;
        const vip = (r.ekstra || []).reduce((t, x) => t + (f[x] ?? EKSTRALAR[x]?.ucret ?? 0), 0);
        // Kapora maç günü alındıysa ayrıca düşülmez: maçın toplamı bugün kasaya girer
        const onOdeme = r.kaporaGunu === gun || r.aboneBasvuru?.depozitoIban ? 0 : kaporaTutari(r);
        // İlk abone maçında depozito da alınır (önceden IBAN'a ödendiyse alınmaz; o ödeme depozitodur, maçtan düşülmez)
        const depIban = Boolean(r.aboneBasvuru?.depozitoIban);
        const dep = r.aboneBasvuru && !r.ucretsiz && !depIban ? Number(r.aboneBasvuru.depozito) || 0 : 0;
        const rAboneNo = r.aboneId ? aboneNo(d.abone.find((a) => a.id === r.aboneId)) : null;
        satirlar.push({ saat, tur: r.aboneId || r.aboneBasvuru ? "abone" : "normal", ...(r.aboneId ? { aboneId: r.aboneId } : {}), ...(dep ? { depozito: `İlk maç: ${dep.toLocaleString("tr-TR")} ₺ depozito ücrete dahil` } : {}), ad: rAboneNo ? `Abone ${rAboneNo}` : r.ad, ucret: Math.max(0, (Number.isFinite(Number(r.ucret)) && r.ucret !== null && r.ucret !== undefined ? Number(r.ucret) : macFiyati(f, gun, saat)) - vip) + dep, vip, ekstra: (r.ekstra || []).filter((x) => EKSTRALAR[x]), onOdeme, tkOn: onOdeme, kayitNo: r.kayitNo, kaynak: "takvim",
          ...(r.ucretsiz ? { ucretsiz: r.ucretsiz.neden || "Ücretsiz" } : {}) });
      }
    }
    return satirlar;
  }

  /**
   * Kayıtlı kasa gününü takvimle eşitler: yeni rezervasyon / abone satırı eklenir; iptal edilen ya da
   * başkasına geçen saatin satırı (henüz krampon, eldiven, kantin girilmemişse) kaldırılır / yenilenir.
   * Elle eklenen satırlara dokunulmaz.
   */
  kasaTakvimBirlestir(kayit, takvim) {
    const veriYok = (m) => !m.krampon && !m.eldiven && !Object.keys(m.kantin || {}).length;
    const t = new Map(takvim.map((x) => [x.saat, x]));
    const degisenler = [];
    const maclar = [];
    for (const m of kayit.maclar || []) {
      const y = t.get(m.saat);
      if (m.kaynak === "takvim" && !y && veriYok(m)) { degisenler.push(`${m.saat} kaldırıldı (${m.ad})`); continue; }
      if (m.kaynak === "takvim" && y && (y.ad !== m.ad || y.tur !== m.tur) && veriYok(m)) {
        maclar.push({ ...y, krampon: 0, eldiven: 0, kantin: {} }); degisenler.push(`${m.saat} ${m.ad} → ${y.ad}`); continue;
      }
      // Rezervasyona sonradan ücretsiz kod uygulandıysa kasadaki ücret de sıfırlanır
      if (m.kaynak === "takvim" && y && y.ucretsiz && !m.ucretsiz) {
        degisenler.push(`${m.saat} ${m.ad} ücretsiz (${y.ucretsiz})`);
        maclar.push({ ...m, ucret: y.ucret, ucretsiz: y.ucretsiz }); continue;
      }
      // Rezervasyona sonradan kapora girildiyse / değiştiyse kasadaki kapora da güncellenir
      if (m.kaynak === "takvim" && y && y.ad === m.ad && (y.onOdeme || 0) !== (m.tkOn ?? m.onOdeme ?? 0)) {
        degisenler.push(`${m.saat} ${m.ad} kapora ${m.onOdeme || 0} → ${y.onOdeme || 0}`);
        maclar.push({ ...m, onOdeme: y.onOdeme || 0, tkOn: y.onOdeme || 0 }); continue;
      }
      maclar.push(m);
    }
    for (const y of takvim) {
      if (!maclar.some((m) => m.saat === y.saat)) { maclar.push({ ...y, krampon: 0, eldiven: 0, kantin: {} }); degisenler.push(`${y.saat} eklendi (${y.ad})`); }
    }
    maclar.sort((a, b) => SAAT_SIRA(a.saat || "00:00") - SAAT_SIRA(b.saat || "00:00"));
    return { maclar, degisenler };
  }

  /** O gün alınan kaporalar (ileri tarihli maçlar için; iptal olsa da kapora iade edilmediği için sayılır) */
  async gelenKaporalar(gun) {
    const [l, haric] = await Promise.all([this.rezervasyonlar(gunEkle(gun, -2), gunEkle(gun, KURALLAR.enFazlaGunSonra + 3)), this.st.get(`kh:${gun}`)]);
    return l.filter((r) => r.kaporaGunu === gun && (r.isletmeGunu || r.tarih) !== gun) // aynı gün maçın kaporası maç toplamında
      .filter((r) => !(haric || []).includes(r.kayitNo)) // Admin'in kasadan çıkardıkları
      .filter((r) => !r.kaporaAktarildi) // dekontu yeni rezervasyona aktarılan iptal kaydı (para yeni kayıtta sayılır)
      .map((r) => ({ kayitNo: r.kayitNo, mac: `${(r.isletmeGunu || r.tarih).split("-").reverse().slice(0, 2).join(".")} ${r.saat}`, ad: r.ad,
        tutar: kaporaTutari(r), yol: r.kaynak === "Online" ? "IBAN (dekont)" : (r.kaynak || "Panel"), iptal: iptalMi(r.durum) }))
      .filter((x) => x.tutar > 0);
  }

  /** Admin: "bugün gelen kaporalar" listesinden bir kaydı çıkarır (yanlış / mükerrer) */
  async gelenKaporaSil({ gun, kayitNo, neden }, yapan) {
    return this.kilitli(async () => {
      if (!["admin", "mudur", "mudur_yrd"].includes(yapan?.rol)) return { hata: "Kaporayı kasadan sadece yöneticiler silebilir." };
      if (yapan.rol !== "admin" && kirp(neden, 300).length < 3) return { hata: "Kaporayı silmek için açıklama yazmanız gerekiyor." };
      const g = tarihNormalize(gun);
      if (!g || !kayitNo) return { hata: "Gün ve kayıt gerekli." };
      const l = (await this.st.get(`kh:${g}`)) || [];
      if (!l.includes(kayitNo)) l.push(kirp(kayitNo, 20));
      await this.st.put(`kh:${g}`, l);
      const k = await this.st.get(`kasa:${g}`);
      const silinen = (k?.gelenKaporalar || []).find((x) => x.kayitNo === kayitNo);
      if (k) {
        const yeni = { ...k, gelenKaporalar: (k.gelenKaporalar || []).filter((x) => x.kayitNo !== kayitNo) };
        yeni.ozet = kasaOzet(yeni);
        await this.st.put(`kasa:${g}`, yeni);
      }
      await this.kayitTut(yapan, "Kasadan kapora sildi", `${g} · ${kayitNo}${silinen ? ` · ${silinen.ad} · ${silinen.tutar} TL` : ""}${kirp(neden, 300) ? ` · açıklama: ${kirp(neden, 300)}` : ""}`);
      return { basarili: true, silinen: silinen || null, gun: g };
    });
  }

  async kasaGetir(gunGirdi, yapan) {
    const n = simdi();
    const gun = tarihNormalize(gunGirdi) || isletmeGunu(n.tarih, n.saat);
    if (!this.kasaYetkili(yapan, gun)) return { hata: "Geçmiş günlerin kasasını sadece Admin görebilir." };
    // Kayıtlı gün takvimdeki son duruma göre kendiliğinden güncellenir (rezervasyon eklendi / iptal edildi)
    const takvimSimdi = await this.kasaTakvim(gun);
    await this.kilitli(async () => {
      const k = await this.st.get(`kasa:${gun}`);
      if (!k) return;
      const { maclar, degisenler } = this.kasaTakvimBirlestir(k, takvimSimdi);
      const gk = await this.gelenKaporalar(gun);
      if (JSON.stringify(gk) !== JSON.stringify(k.gelenKaporalar || [])) degisenler.push(`gelen kaporalar ${gk.reduce((t, x) => t + x.tutar, 0)} TL`);
      if (!degisenler.length) return;
      const yeni = { ...k, maclar, gelenKaporalar: gk };
      yeni.ozet = kasaOzet(yeni);
      await this.st.put(`kasa:${gun}`, yeni);
      await this.kayitTut(null, "Kasa takvimden güncellendi", `${gun} · ${degisenler.join(" · ")}`);
    });
    const [kayit, takvim, urunler, fiyat, onceki, puantaj] = await Promise.all([
      this.st.get(`kasa:${gun}`), Promise.resolve(takvimSimdi), this.urunler(), this.fiyatAyar(),
      this.st.list({ start: "kasa:", end: `kasa:${gun}`, reverse: true, limit: 1 }),
      this.st.list({ prefix: `p:${gun}:` }),
    ]);
    const oncekiKasa = [...onceki.values()][0];
    // Veresiye izni abone ayarından gelir (kaydedilmiş günlerde de güncel olsun)
    if (kayit) for (const m of kayit.maclar || []) { const t = takvim.find((x) => x.saat === m.saat && x.aboneId && x.aboneId === m.aboneId); if (t) m.veresiyeAcik = t.veresiyeAcik; }
    const kullanicilar = await this.kullaniciListesi();
    const calisanlar = [...puantaj].map(([k, v]) => {
      const u = kullanicilar.find((x) => x.eposta === k.split(":").slice(2).join(":"));
      const saat = odenecekSaat(v);
      const e = k.split(":").slice(2).join(":");
      const kesinti = 0; // personel kantini ay sonu maaştan kesilir
      return { eposta: e, ad: u?.ad || v.ad, rol: ROLLER[u?.rol]?.ad || "", saat, kesinti, ucret: Math.round(saat * (u?.saatlikUcret || 0)) - kesinti, acik: Boolean(v.giris && !v.cikis) };
    });
    const tahsil = await this.veresiyeTahsilleri(gun);
    const anlasmalar = Object.fromEntries((await this.aboneler()).filter((a) => !a.bitis && a.anlasma?.length).map((a) => [a.id, a.anlasma]));
    if (kayit) { kayit.veresiyeTahsil = tahsil; anlasmaUygula(kayit, anlasmalar); kayit.ozet = kasaOzet(kayit); }
    return {
      gun, gunAd: gunAdi(gun), bugun: isletmeGunu(n.tarih, n.saat), kayitli: Boolean(kayit),
      kayit: kayit || { gun, veresiyeTahsil: tahsil, gelenKaporalar: await this.gelenKaporalar(gun), devir: oncekiKasa?.birakilan ?? 0, maclar: takvim.map((x) => ({ ...x, krampon: 0, eldiven: 0, kantin: {} })), girisler: [], cikislar: [], veresiye: [], ikram: {}, birakilan: null, sayilan: null, not: "" },
      oncekiDevir: oncekiKasa ? { gun: oncekiKasa.gun, tutar: oncekiKasa.birakilan ?? 0 } : null,
      takvim, urunler: bardakGorunum(urunler), fiyat, calisanlar, anlasmalar, ikramKimler: IKRAM_KIMLER, temizlik: await this.temizlikUrunleri(), rehber: await this.rehber(), personelIndirim: KURALLAR.personelIndirim,
      personel: kullanicilar.filter((u) => u.durum === "aktif" && u.rol !== "admin" && ROLLER[u.rol])
        .map((u) => ({ eposta: u.eposta, ad: u.ad, calisiyor: puantaj.has(`p:${gun}:${u.eposta}`) })), acikVeresiyeler: await this.veresiyeSonrakiMac(await this.acikVeresiyeler()),
    };
  }

  async kasaKaydet(g, yapan) {
    return this.kilitli(async () => {
      const gun = tarihNormalize(g.gun);
      if (!gun) return { hata: "Gün gerekli." };
      if (!this.kasaYetkili(yapan, gun)) return { hata: "Geçmiş günlerin kasasını sadece Admin düzenleyebilir." };
      const [eski, urunler, f] = await Promise.all([this.st.get(`kasa:${gun}`), this.urunler(), this.fiyatAyar()]);
      // Eşzamanlı düzenleme: kişi eski bir sürümün üstünden kaydediyorsa değişiklikleri son hâlle birleştir
      let birlesti = false;
      if (eski && g.taban && typeof g.taban === "object" && (g.taban.surum || 0) !== (eski.surum || 0)) {
        g = { ...kasaUcYol(eski, g.taban, g), gun, otomatik: g.otomatik };
        birlesti = true;
      }
      const urunMap = new Map(urunler.map((u) => [u.id, u]));
      const aboneMap = new Map((await this.aboneler()).map((a) => [a.id, a]));
      const tumKullanicilar = await this.kullaniciListesi();
      const kisiAnahtarlari = tumKullanicilar.map((u) => `p:${u.eposta}`);
      const veresiyeIzin = (m) => Boolean(m?.aboneId && veresiyeAcik(aboneMap.get(m.aboneId)));
      const kantinTemiz = (o) => {
        const r = {};
        for (const [id, a] of Object.entries(o && typeof o === "object" ? o : {})) {
          const adet = Math.min(999, Math.max(0, Math.round(Number(a)) || 0));
          if (adet && (urunMap.has(id) || eski?.birimler?.[id] !== undefined)) r[id] = adet;
        }
        return r;
      };
      const satirlar = (l) => (Array.isArray(l) ? l : []).slice(0, 40)
        .map((x) => ({ aciklama: kirp(x?.aciklama, 120), tutar: tutar(x?.tutar) })).filter((x) => x.aciklama || x.tutar);
      const kayit = {
        gun, devir: tutar(g.devir),
        maclar: (Array.isArray(g.maclar) ? g.maclar : []).slice(0, 30).map((m) => ({
          saat: saatNormalize(m?.saat) || "", tur: ["abone", "normal", "bos"].includes(m?.tur) ? m.tur : "normal",
          ad: kirp(m?.ad, 40), ucret: tutar(m?.ucret), vip: tutar(m?.vip), onOdeme: tutar(m?.onOdeme), iban: tutar(m?.iban),
          krampon: Math.min(50, Math.max(0, Math.round(Number(m?.krampon)) || 0)),
          eldiven: Math.min(50, Math.max(0, Math.round(Number(m?.eldiven)) || 0)),
          kantin: kantinTemiz(m?.kantin), kantinOdenen: kantinTemiz(m?.kantinOdenen), veresiyeKantin: veresiyeIzin(m) || Object.keys(eski?.maclar?.find((x) => x.saat === m?.saat)?.veresiyeKantin || {}).length ? kantinTemiz(m?.veresiyeKantin) : {},
          veresiyeKim: kirp(m?.veresiyeKim, 60), ...(m?.veresiyeAcik ? { veresiyeAcik: true } : {}), ikramKantin: kantinTemiz(m?.ikramKantin),
          ...(m?.odendi ? { odendi: true, odemeZamani: kirp(m.odemeZamani, 20) } : {}), ...(m?.kayitNo ? { kayitNo: kirp(m.kayitNo, 20) } : {}),
          ...(m?.kaynak === "takvim" ? { kaynak: "takvim", tkOn: tutar(m?.tkOn ?? m?.onOdeme) } : {}),
          ...(m?.depozito ? { depozito: kirp(m.depozito, 120) } : {}),
          ...(m?.aboneId ? { aboneId: kirp(m.aboneId, 20) } : {}),
          ...(m?.ucretsiz ? { ucretsiz: kirp(m.ucretsiz, 80) } : {}),
          ekstra: [...new Set(Array.isArray(m?.ekstra) ? m.ekstra : [])].filter((x) => EKSTRALAR[x]),
        })).sort((a, b) => SAAT_SIRA(a.saat || "00:00") - SAAT_SIRA(b.saat || "00:00")),
        girisler: satirlar(g.girisler), cikislar: satirlar(g.cikislar),
        avanslar: (Array.isArray(g.avanslar) ? g.avanslar : []).slice(0, 30)
          .map((x) => ({ eposta: epostaNormalize(x?.eposta), tutar: tutar(x?.tutar) }))
          .filter((x) => x.eposta && x.tutar && tumKullanicilar.some((u) => u.eposta === x.eposta))
          .map((x) => ({ ...x, ad: tumKullanicilar.find((u) => u.eposta === x.eposta).ad })),
        gelenKaporalar: await this.gelenKaporalar(gun),
        veresiyeTahsil: await this.veresiyeTahsilleri(gun),
        veresiye: (Array.isArray(g.veresiye) ? g.veresiye : []).slice(0, 40)
          .map((x) => ({ aciklama: kirp(x?.aciklama, 120), tutar: tutar(x?.tutar) })).filter((x) => x.aciklama || x.tutar),
        ikram: Object.fromEntries([...IKRAM_KIMLER, ...kisiAnahtarlari].map((k) => [k, kantinTemiz(g.ikram?.[k])]).filter(([, v]) => Object.keys(v).length)),
        ikramAdlari: Object.fromEntries(tumKullanicilar.map((u) => [`p:${u.eposta}`, u.ad])),
        birakilan: g.birakilan === null || g.birakilan === "" || g.birakilan === undefined ? null : tutar(g.birakilan),
        sayilan: g.sayilan === null || g.sayilan === "" || g.sayilan === undefined ? null : tutar(g.sayilan),
        not: kirp(g.not, 500),
        // O günün birim fiyatları sabitlenir: sonradan fiyat değişse de eski günün cirosu değişmez
        birimler: { ...(eski?.birimler || {}) },
        kira: eski?.kira || { krampon: f.krampon, eldiven: f.eldiven },
        guncelleyen: yapan.ad, guncelleme: simdiYazi(), olusturan: eski?.olusturan || yapan.ad, surum: (eski?.surum || 0) + 1,
      };
      for (const id of Object.keys(kasaTuketim(kayit))) {
        if (kayit.birimler[id] === undefined) kayit.birimler[id] = { satis: urunMap.get(id)?.satis || 0, alis: urunMap.get(id)?.alis || 0, ad: urunMap.get(id)?.ad || id };
      }
      anlasmaUygula(kayit, Object.fromEntries([...aboneMap.values()].filter((a) => a.anlasma?.length).map((a) => [a.id, a.anlasma])));
      kayit.ozet = kasaOzet(kayit);
      // Stok: önceki kayda göre fark kadar düşülür (aynı günü tekrar kaydetmek stoğu iki kez düşmez)
      const once = stokTuketimi(kasaTuketim(eski || {}), urunler), simdiT = stokTuketimi(kasaTuketim(kayit), urunler);
      const degisen = [];
      for (const id of new Set([...Object.keys(once), ...Object.keys(simdiT)])) {
        const fark = (simdiT[id] || 0) - (once[id] || 0);
        const u = urunMap.get(id);
        // Stok bitince satış durur
        if (fark > 0 && u && (u.stok || 0) - fark < 0) return { hata: bardakKurali(u.ad).bardakUrunu ? `Bardak yetmiyor: ${u.ad} kalan ${Math.max(0, u.stok || 0)} (Türk kahvesi 2, Nescafe / filtre kahve 1 bardak düşer).` : `${u.ad} stokta yok (kalan ${Math.max(0, u.stok || 0)}).` };
        if (fark && u) { u.stok = (u.stok || 0) - fark; degisen.push([`urun:${id}`, u]); }
      }
      if (degisen.length) await this.st.put(Object.fromEntries(degisen));
      await this.st.put(`kasa:${gun}`, kayit);
      await this.veresiyeEsitle(kayit);
      // Otomatik (arka planda) kayıtlar işlem kaydına yazılmaz; "Kasayı gönder" düğmesi yazar
      if (g.otomatik) return { basarili: true, kayit, ilkKayit: !eski, otomatik: true, birlesti };
      const o = kayit.ozet, para = (x) => `${Math.round(x).toLocaleString("tr-TR")} TL`;
      await this.kayitTut(yapan, eski ? "Kasa raporunu güncelledi" : "Kasa raporunu kaydetti",
        `${gun} · ciro ${para(o.ciro)} · giriş ${para(o.giris)} · çıkış ${para(o.cikis)} · kasada olması gereken ${para(o.olmasiGereken)}${kayit.sayilan !== null ? ` · sayılan ${para(kayit.sayilan)} (fark ${para(o.fark)})` : ""}`);
      return { basarili: true, kayit, ilkKayit: !eski, birlesti };
    });
  }

  // ---- Veresiye takibi ----
  //   vr:<gün>:<saat>  { gun, saat, ad, kim, aboneId, tutar, urunler, odendi, odeyen, odemeZamani, hatirlatilan[] }
  async veresiyeEsitle(k) {
    const b = k.birimler || {};
    const mevcut = await this.st.list({ prefix: `vr:${k.gun}:` });
    const yeni = new Map();
    for (const m of k.maclar || []) {
      const v = m.veresiyeKantin || {};
      if (!Object.keys(v).length) continue;
      const anahtar = `vr:${k.gun}:${m.saat}`;
      const eski = mevcut.get(anahtar) || {};
      yeni.set(anahtar, {
        ...eski, gun: k.gun, saat: m.saat, ad: m.ad, kim: m.veresiyeKim || m.ad, aboneId: m.aboneId || null,
        tutar: Math.round(Object.entries(v).reduce((t, [id, a]) => t + a * satirFiyat(m, b, id), 0)),
        urunler: Object.entries(v).map(([id, a]) => `${b[id]?.ad || id} ×${a}`).join(", "),
        odendi: eski.odendi || false, hatirlatilan: eski.hatirlatilan || [],
      });
    }
    for (const [a, v] of mevcut) if (!yeni.has(a) && !v.odendi) await this.st.delete(a);
    if (yeni.size) await this.st.put(Object.fromEntries(yeni));
  }

  async acikVeresiyeler() {
    return [...(await this.st.list({ prefix: "vr:" })).values()].filter((v) => !v.odendi).sort((a, c) => (a.gun + a.saat).localeCompare(c.gun + c.saat));
  }

  /** O gün tahsil edilen (eski günlerden kalan) veresiyeler: tahsil edildiği günün kasasına girer */
  async veresiyeTahsilleri(gun) {
    return [...(await this.st.list({ prefix: "vr:" })).values()].filter((v) => v.odendi && v.odemeGunu === gun)
      .map((v) => ({ kim: v.kim, gun: v.gun, saat: v.saat, tutar: v.tutar, odeyen: v.odeyen || "" }));
  }

  /** Açık abone veresiyelerine abonenin sonraki maç günü eklenir (14 gün içinde) */
  async veresiyeSonrakiMac(liste) {
    const bugun = bugunIsletme();
    const d = await this.durumYukle(bugun, gunEkle(bugun, 14));
    return liste.map((v) => {
      if (!v.aboneId) return v;
      for (let i = 0; i <= 14; i++) {
        const g = gunEkle(bugun, i);
        if (g <= v.gun) continue;
        const sl = slotlarOf(d.abone.find((a) => a.id === v.aboneId) || {});
        for (const x of sl.filter((x) => x.gun === gunNo(g))) {
          const s = this.slot(d, g, x.saat);
          if (s.tur === "abone" && s.abone.id === v.aboneId) return { ...v, sonrakiMac: { gun: g, saat: x.saat } };
        }
      }
      return v;
    });
  }

  async veresiyeOde({ gun, saat }, yapan) {
    return this.kilitli(async () => {
      const a = `vr:${tarihNormalize(gun)}:${saatNormalize(saat)}`;
      const v = await this.st.get(a);
      if (!v) return { hata: "Veresiye bulunamadı." };
      if (v.odendi) return { hata: "Bu veresiye zaten ödenmiş." };
      const bugun = bugunIsletme();
      Object.assign(v, { odendi: true, odeyen: yapan.ad, odemeZamani: simdiYazi(), odemeGunu: bugun });
      await this.st.put(a, v);
      // Para bugün geldi: bugünün kasası kayıtlıysa tahsilat oraya işlenir
      const kasa = await this.st.get(`kasa:${bugun}`);
      if (kasa) { const y = { ...kasa, veresiyeTahsil: await this.veresiyeTahsilleri(bugun) }; y.ozet = kasaOzet(y); await this.st.put(`kasa:${bugun}`, y); }
      await this.kayitTut(yapan, "Veresiye tahsil etti", `${v.kim} · ${v.gun} ${v.saat} · ${v.tutar} TL · ${v.urunler}`);
      return { basarili: true, veresiye: v, bugun, veresiyeTahsil: await this.veresiyeTahsilleri(bugun) };
    });
  }

  /**
   * Abone veresiyesi hatırlatması: abonenin en yakın (sonraki) aynı saatli maçında, maçtan 1 saat önce
   * o gün GELDİM demiş Müdür / Müdür Yardımcısı'na (yoksa hepsine) e-posta. Ödenene kadar her maçta tekrarlanır.
   */
  async veresiyeHatirlatmalari(simdiMs = Date.now()) {
    return this.kilitli(async () => {
      const acik = (await this.acikVeresiyeler()).filter((v) => v.aboneId);
      if (!acik.length) return [];
      const n = simdi();
      const bugun = isletmeGunu(n.tarih, n.saat);
      const d = await this.durumYukle(bugun, bugun);
      const gruplar = new Map(); // saat → veresiyeler
      for (const v of acik) {
        if (v.gun >= bugun || (v.hatirlatilan || []).includes(bugun)) continue;
        const s = this.slot(d, bugun, v.saat);
        if (s.tur !== "abone" || s.abone.id !== v.aboneId) continue;
        const macMs = macZamani(takvimTarihi(bugun, v.saat), v.saat);
        if (simdiMs < macMs - 3600_000 || simdiMs > macMs + 2 * 3600_000) continue;
        v.hatirlatilan = [...(v.hatirlatilan || []), bugun];
        await this.st.put(`vr:${v.gun}:${v.saat}`, v);
        const g = gruplar.get(v.saat) || { saat: v.saat, abone: s.abone.no ? `Abone ${s.abone.no}` : s.abone.ad, liste: [] };
        g.liste.push(v);
        gruplar.set(v.saat, g);
      }
      if (!gruplar.size) return [];
      // O gün GELDİM demiş yöneticiler
      const kullanicilar = await this.kullaniciListesi();
      const gelenler = [...(await this.st.list({ prefix: `p:${bugun}:` })).keys()].map((k) => k.split(":").slice(2).join(":"));
      let kime = kullanicilar.filter((u) => u.durum === "aktif" && ["mudur", "mudur_yrd"].includes(u.rol) && gelenler.includes(u.eposta)).map((u) => u.eposta);
      if (!kime.length) kime = kullanicilar.filter((u) => u.durum === "aktif" && ["mudur", "mudur_yrd"].includes(u.rol)).map((u) => u.eposta);
      return [...gruplar.values()].map((g) => ({ ...g, gun: bugun, kime }));
    });
  }

  /** Aylık kasa özeti (Admin) */
  async kasaAy(ay) {
    if (!/^\d{4}-\d{2}$/.test(ay || "")) return { hata: "Geçersiz ay." };
    const m = await this.st.list({ start: `kasa:${ay}-01`, end: `kasa:${ay}-31~` });
    const gunler = [...m.values()].map((k) => ({ gun: k.gun, gunAd: gunAdi(k.gun), ...k.ozet, guncelleyen: k.guncelleyen }));
    const toplam = {};
    for (const a of ["mac", "vip", "kantin", "kantinKar", "krampon", "eldiven", "ciro", "giris", "gelenKapora", "ibanOdeme", "cikis", "veresiye", "veresiyeKantin", "onOdeme", "ikramDeger"]) {
      toplam[a] = gunler.reduce((t, x) => t + (x[a] || 0), 0);
    }
    return { ay, gunler, toplam };
  }

  // ================= İşlem kaydı (Admin kontrolü) =================
  //   l:<zaman ISO>:<rastgele>  { zaman, kim, rol, islem, detay }

  async kayitTut(kim, islem, detay = "") {
    const z = new Date(Date.now()).toISOString();
    this.sira = ((this.sira || 0) + 1) % 1e6; // aynı milisaniyedeki kayıtlar da sırasını korusun
    await this.st.put(`l:${z}:${String(this.sira).padStart(6, "0")}${rastgele(3)}`, {
      zaman: simdiYazi(), kim: kim?.ad || "Sistem", eposta: kim?.eposta || "", rol: ROLLER[kim?.rol]?.ad || "",
      islem: kirp(islem, 60), detay: kirp(detay, 300),
    });
  }

  async islemler(adet = 200) {
    const m = await this.st.list({ prefix: "l:", reverse: true, limit: Math.min(Number(adet) || 200, 500) });
    return [...m.values()];
  }

  // ================= Panel: takvim =================

  /** Pazartesiden başlayan 7 işletme günü; her saatin tam durumu + kapora bekleyenler. */
  async panelHafta(baslangicGirdi) {
    return this.kilitli(async () => {
      const n = simdi();
      const bas = haftaBasi(tarihNormalize(baslangicGirdi) || isletmeGunu(n.tarih, n.saat));
      const son = gunEkle(bas, 6);
      const d = await this.durumYukle(bas, son);
      const haftaSaatleri = this.saatListesi(d, bas, son);
      const gunler = [];
      for (let i = 0; i < 7; i++) {
        const gun = gunEkle(bas, i);
        gunler.push({
          tarih: gun, gun: gunAdi(gun),
          saatler: haftaSaatleri.map((saat) => {
            const s = this.slot(d, gun, saat);
            const tarih = takvimTarihi(gun, saat);
            return {
              saat, tarih, gecmis: macZamani(tarih, saat) < Date.now() - 3600_000, tur: s.tur,
              ...(SAATLER.includes(saat) ? {} : { ozel: true }),
              // Abone başvurusunun ilk maçı (rezervasyon) da "Abone N" olarak görünsün
              ...(s.rez ? { rez: s.rez.aboneId ? { ...s.rez, aboneNo: aboneNo(d.abone.find((a) => a.id === s.rez.aboneId)) } : s.rez } : {}),
              ...(s.abone ? { abone: { id: s.abone.id, no: aboneNo(s.abone), ad: s.abone.ad, telefon: s.abone.telefon, not: s.abone.not, depozito: s.abone.depozito || "", slotlar: slotlarOf(s.abone), anlasma: s.abone.anlasma || [] } } : {}),
            };
          }),
        });
      }
      return { baslangic: bas, gunler, bekleyenler: [], bugun: isletmeGunu(n.tarih, n.saat), fiyat: await this.fiyatAyar() };
    });
  }

  async panelRezEkle(girdi) {
    return this.kilitli(() => this.rezervasyonYaz({
      ...girdi, kaynak: girdi.kaynak || "Telefon", durum: girdi.durum || DURUM.onayli,
    }, true));
  }

  async panelRezGuncelle({ kayitNo, durum, kapora, not, ad, telefon, iptalNedeni }) {
    return this.kilitli(async () => {
      const b = await this.kayitBul(kayitNo);
      if (!b) return { hata: "Kayıt bulunamadı." };
      const k = { ...b.kayit };
      if (durum !== undefined) {
        if (!DURUMLAR.includes(durum)) return { hata: "Geçersiz durum." };
        if (iptalMi(k.durum) && !iptalMi(durum)) {
          // İptalden geri alma: saat hâlâ boş mu?
          const d = await this.durumYukle(k.isletmeGunu || k.tarih, k.isletmeGunu || k.tarih);
          const sl = this.slot(d, k.isletmeGunu || k.tarih, k.saat);
          if (sl.tur === "rez" || sl.tur === "abone") return { hata: "Bu saat artık dolu, iptal geri alınamaz." };
        }
        if (iptalMi(durum) && !iptalMi(k.durum)) {
          if (kirp(iptalNedeni, 200).length < 3) return { hata: "İptal için açıklama yazmanız gerekiyor." };
          k.iptalNedeni = kirp(iptalNedeni, 200);
        }
        k.durum = durum;
        if (iptalMi(durum)) k.iptalEden = "Panel";
      }
      if (kapora !== undefined && kirp(kapora, 60) !== (k.kapora || "")) {
        k.kapora = kirp(kapora, 60);
        if (k.kapora) k.kaporaGunu = bugunIsletme();
      }
      if (not !== undefined) k.not = kirp(not, 200);
      if (ad !== undefined && kirp(ad, 60)) k.ad = kirp(ad, 60);
      if (telefon !== undefined) {
        const t = telefonNormalize(telefon);
        if (telefon && !t) return { hata: "Geçersiz telefon." };
        k.telefon = t || "";
      }
      k.guncelleme = simdiYazi();
      await this.st.put(b.anahtar, k);
      // İşlem kaydı için ne değişti (önce → sonra)
      const degisen = [["durum", "Durum"], ["iptalNedeni", "İptal açıklaması"], ["kapora", "Kapora"], ["not", "Not"], ["ad", "Ad"], ["telefon", "Telefon"]]
        .filter(([a]) => (b.kayit[a] || "") !== (k[a] || ""))
        .map(([a, ad]) => `${ad}: ${b.kayit[a] || "—"} → ${k[a] || "—"}`);
      return { basarili: true, rez: k, degisen };
    });
  }

  // ================= Panel: aboneler =================

  async aboneListe() {
    const liste = (await this.aboneler()).map((a) => ({ ...a, no: aboneNo(a), slotlar: slotSirala(slotlarOf(a)) }));
    const ilk = (a) => a.slotlar[0] || { gun: 9, saat: "00:00" };
    // Abone numarasına göre (numarasızlar en sonda), sonra ilk gün/saat
    return liste.sort((a, b) => (a.no || 1e9) - (b.no || 1e9)
      || ilk(a).gun - ilk(b).gun || SAAT_SIRA(ilk(a).saat) - SAAT_SIRA(ilk(b).saat) || a.ad.localeCompare(b.ad, "tr"));
  }

  /** slotlar: [{gun, saat}] — ya da eski biçimde tek gun + saat */
  async aboneKaydet({ id, ad, telefon, slotlar, gun, saat, baslangic, not = "", ucret = "", depozito, veresiye, no, yeniKural, ilkMac, eposta, epostaZorunlu, anlasma, kayitTarihi }) {
    return this.kilitli(async () => {
      if (epostaZorunlu && !epostaNormalize(eposta)) return { hata: "Abonenin e-posta adresi zorunludur (abone sayfası ve bildirimler için)." };
      let liste = Array.isArray(slotlar) ? slotlar : [{ gun, saat }];
      liste = liste.map((x) => ({ gun: Number(x.gun), saat: saatNormalize(x.saat) }));
      if (!kirp(ad, 60)) return { hata: "Abone adı gerekli." };
      if (!liste.length) return { hata: "En az bir gün ve saat seçin." };
      for (const x of liste) {
        if (!(x.gun >= 0 && x.gun <= 6)) return { hata: "Geçersiz gün." };
        if (!x.saat || !gecerliSaat(x.saat)) return { hata: "Geçersiz saat." };
      }
      // tekrarları ayıkla
      liste = slotSirala([...new Map(liste.map((x) => [`${x.gun}|${x.saat}`, x])).values()]);
      const tel = telefon ? telefonNormalize(telefon) : "";
      if (telefon && !tel) return { hata: "Geçersiz telefon." };
      const n = simdi();
      const bas = tarihNormalize(baslangic) || haftaBasi(isletmeGunu(n.tarih, n.saat));
      const digerleri = (await this.aboneler()).filter((a) => a.id !== id && !a.bitis);
      for (const x of liste) {
        const c = digerleri.find((a) => slotlarOf(a).some((sl) => sl.gun === x.gun && sl.saat === x.saat));
        if (c) return { hata: `${GUNLER[x.gun]} ${x.saat} saatinde zaten abone var: ${c.ad}.` };
      }
      const eski = id ? await this.st.get(`a:${id}`) : null;
      // Abone numarası: girilmezse eskisi, o da yoksa ilk boş numara
      const tumu = (await this.aboneler()).filter((a) => a.id !== id && !a.bitis);
      const kullanilan = new Set(tumu.map(aboneNo).filter(Boolean));
      let numara = no === "" || no == null ? (eski ? aboneNo(eski) : null) : Number(no);
      if (numara != null && !(Number.isInteger(numara) && numara > 0 && numara < 1000)) return { hata: "Abone numarası 1–999 arası olmalı." };
      if (numara && kullanilan.has(numara)) return { hata: `Abone ${numara} numarası başka bir abonede kayıtlı.` };
      if (!numara) { numara = 1; while (kullanilan.has(numara)) numara++; }
      const abone = {
        no: numara,
        id: eski?.id || rastgele(8, "abcdefghjkmnpqrstuvwxyz23456789"),
        ad: kirp(ad, 60), telefon: tel, slotlar: liste, baslangic: bas, bitis: null,
        not: kirp(not, 500), ucret: kirp(ucret, 40), depozito: depozito === undefined ? (eski?.depozito || "") : kirp(depozito, 120),
        olusturma: eski?.olusturma || simdiYazi(),
        ...(veresiye !== undefined ? { veresiye: Boolean(veresiye) } : eski?.veresiye !== undefined ? { veresiye: eski.veresiye } : {}),
        eposta: eposta === undefined ? (eski?.eposta || "") : (epostaNormalize(eposta) || ""),
        // Kayıt (abonelik başlangıcı / ilk maç) tarihi: 3 ay ve ücretsiz son maç kuralları buna göre
        kayitTarihi: tarihNormalize(kayitTarihi) || tarihNormalize(ilkMac) || eski?.kayitTarihi || notKayitTarihi(not) || (eski ? null : bas),
        // Kantin anlaşması: [{ urunId, ad, ucretsiz, kademeler: [{ min, fiyat }], not }]
        anlasma: anlasma === undefined ? (eski?.anlasma || []) : (Array.isArray(anlasma) ? anlasma : []).slice(0, 10).map((x) => ({
          urunId: kirp(x?.urunId, 30), ad: kirp(x?.ad, 40), ucretsiz: Math.max(0, Math.round(Number(x?.ucretsiz) || 0)), not: kirp(x?.not, 200),
          kademeler: (Array.isArray(x?.kademeler) ? x.kademeler : []).slice(0, 6).map((k) => ({ min: Math.max(1, Math.round(Number(k?.min) || 0)), fiyat: tutar(k?.fiyat) })).filter((k) => k.min > 0),
        })).filter((x) => x.urunId),
        ...(eski?.erisim ? { erisim: eski.erisim } : {}),
        ...(eski?.iptalTalebi ? { iptalTalebi: eski.iptalTalebi } : {}),
        // Yeni abone kuralları (3 ay taahhüt, ayda 1 iptal): eski abonelerde uygulanmaz
        kural: yeniKural === undefined ? (eski?.kural || null)
          : yeniKural ? { yeni: true, ilkMac: tarihNormalize(kayitTarihi) || tarihNormalize(ilkMac) || eski?.kural?.ilkMac || eski?.kayitTarihi || bas } : null,
      };
      await this.st.put(`a:${abone.id}`, abone);
      // Uyarı: abonenin saatlerine denk gelen ileri tarihli aktif rezervasyonlar
      const cakisanRez = (await this.rezervasyonlar(n.tarih, gunEkle(n.tarih, 60)))
        .filter((r) => !iptalMi(r.durum) && (r.isletmeGunu || r.tarih) >= bas
          && liste.some((x) => x.saat === r.saat && x.gun === gunNo(r.isletmeGunu || r.tarih)));
      return { basarili: true, abone, epostaDegisti: Boolean(abone.eposta && abone.eposta !== (eski?.eposta || "")), uyari: cakisanRez.length ? `${cakisanRez.length} ileri tarihli rezervasyon bu abonenin saatlerine denk geliyor, kontrol edin.` : null };
    });
  }

  async aboneSil(id, { sonMacUcretsiz = false } = {}) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a) return { hata: "Abone bulunamadı." };
      const taahhut = aboneTaahhutte(a, bugunIsletme());
      if (taahhut && sonMacUcretsiz) return { hata: `İlk ${KURALLAR.aboneEnAzAy} ay dolmadı (ilk maç ${a.kural.ilkMac.split("-").reverse().join(".")}): depozito yanar, ücretsiz son maç verilemez.` };
      // Depozito karşılığı son maç: abonenin en yakın (gelecekteki) saatine ücretsiz, onaylı rezervasyon
      let sonMac = null;
      if (sonMacUcretsiz) {
        const n = simdi();
        const bugun = isletmeGunu(n.tarih, n.saat);
        const adaylar = [];
        for (let i = 0; i < 8; i++) {
          const g = gunEkle(bugun, i);
          for (const sl of slotlarOf(a)) if (sl.gun === gunNo(g) && macZamani(takvimTarihi(g, sl.saat), sl.saat) > Date.now()) adaylar.push({ g, saat: sl.saat });
        }
        adaylar.sort((x, y) => x.g.localeCompare(y.g) || SAAT_SIRA(x.saat) - SAAT_SIRA(y.saat));
        sonMac = adaylar[0] || null;
      }
      await this.st.delete(`a:${id}`);
      const atla = await this.st.list({ prefix: "x:" });
      const sil = [...atla.keys()].filter((k) => k.endsWith(`:${id}`));
      if (sil.length) await this.st.delete(sil);
      if (sonMac) {
        const no = aboneNo(a);
        const r = await this.rezervasyonYaz({
          gunTarihi: sonMac.g, saat: sonMac.saat, ad: `${no ? `Abone ${no} · ` : ""}${a.ad}`, telefon: a.telefon || "",
          durum: DURUM.onayli, kaynak: "Abone", not: `Son maç — depozito karşılığı ücretsiz${a.depozito ? ` (depozito: ${a.depozito})` : ""}`,
        }, true);
        if (r.basarili) {
          const anahtar = `r:${r.tarih}:${r.saat}:${r.kayitNo}`;
          await this.st.put(anahtar, { ...(await this.st.get(anahtar)), ucret: 0, kaporaTutar: 0, aboneId: a.id, ucretsiz: { kod: "DEPOZİTO", neden: "Abonelik bitişi — depozito karşılığı son maç" } });
          sonMac = { ...sonMac, kayitNo: r.kayitNo };
        } else sonMac = { ...sonMac, hata: r.hata };
      }
      return { basarili: true, sonMac, ...(taahhut ? { depozitoYandi: true } : {}) };
    });
  }

  /**
   * Abone gelmiyor (gelmiyor=true) / yine geliyor (false).
   * kapsam: "saat" (sadece `saat`), "gun" (o işletme gününün tüm saatleri), "hafta" (o haftanın tüm saatleri).
   */
  /**
   * Abonenin bir saatini kalıcı olarak başka gün/saate taşır (ör. Perşembe 20:00 → Cuma 22:00, her hafta).
   * Sadece o haftalık değişiklik için "bu hafta gelmiyor" kullanılır.
   */
  async aboneTasi({ id, gun: eskiGun, saat, yeniGun, yeniSaat }) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      const s1 = saatNormalize(saat), ys = saatNormalize(yeniSaat);
      const eg = Number(eskiGun), yg = Number(yeniGun);
      if (!a || !s1 || !(eg >= 0 && eg <= 6)) return { hata: "Abone veya saat bulunamadı." };
      if (!(yg >= 0 && yg <= 6) || !ys || !gecerliSaat(ys)) return { hata: "Yeni gün ve saati seçin." };
      if (eg === yg && s1 === ys) return { hata: "Yeni gün/saat eskisiyle aynı." };
      const slotlar = slotlarOf(a);
      if (!slotlar.some((x) => x.gun === eg && x.saat === s1)) return { hata: "Bu saat abonenin saatlerinde yok." };
      if (slotlar.some((x) => x.gun === yg && x.saat === ys)) return { hata: "Abone zaten bu gün/saatte oynuyor." };
      const diger = (await this.aboneler()).find((x) => x.id !== a.id && !x.bitis && slotlarOf(x).some((sl) => sl.gun === yg && sl.saat === ys));
      if (diger) return { hata: `${GUNLER[yg]} ${ys} saatinde başka abone var: ${diger.ad}.` };
      // Yeni saate denk gelen ileri tarihli rezervasyonlar (4 hafta)
      const n = simdi();
      const bugun = isletmeGunu(n.tarih, n.saat);
      const cakisan = (await this.rezervasyonlar(bugun, gunEkle(bugun, 30)))
        .filter((r) => !iptalMi(r.durum) && !opsiyonDustu(r) && r.saat === ys && gunNo(r.isletmeGunu || r.tarih) === yg && (r.isletmeGunu || r.tarih) >= bugun);
      if (cakisan.length) {
        const ilk = cakisan.sort((x, y) => (x.isletmeGunu || x.tarih).localeCompare(y.isletmeGunu || y.tarih))[0];
        return { hata: `${GUNLER[yg]} ${ys}: ${(ilk.isletmeGunu || ilk.tarih).split("-").reverse().join(".")} tarihinde rezervasyon var (${ilk.ad}). Önce onu taşıyın / iptal edin.` };
      }
      const yeni = slotSirala(slotlar.map((x) => (x.gun === eg && x.saat === s1 ? { gun: yg, saat: ys } : x)));
      await this.st.put(`a:${a.id}`, { ...a, slotlar: yeni, gun: undefined, saat: undefined });
      const no = aboneNo(a);
      return { basarili: true, ad: `${no ? `Abone ${no} · ` : ""}${a.ad}`, eski: `${GUNLER[eg]} ${s1}`, yeni: `${GUNLER[yg]} ${ys}` };
    });
  }

  async aboneAtla({ id, gun, saat, gelmiyor, kapsam = "saat", zorla = false }) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      const g = tarihNormalize(gun);
      if (!a || !g) return { hata: "Abone veya tarih bulunamadı." };
      const sl = slotlarOf(a);
      let hedef = [];
      if (kapsam === "hafta") {
        const bas = haftaBasi(g);
        for (let i = 0; i < 7; i++) {
          const t = gunEkle(bas, i);
          for (const x of sl) if (x.gun === gunNo(t)) hedef.push({ t, saat: x.saat });
        }
      } else if (kapsam === "ayni-saat") {
        // Bu hafta abonenin aynı saatteki bütün günleri (ör. Cmt 08:00 + Paz 08:00)
        const s1 = saatNormalize(saat);
        const bas = haftaBasi(g);
        for (let i = 0; i < 7; i++) {
          const t = gunEkle(bas, i);
          if (sl.some((x) => x.gun === gunNo(t) && x.saat === s1)) hedef.push({ t, saat: s1 });
        }
      } else if (kapsam === "gun") {
        hedef = sl.filter((x) => x.gun === gunNo(g)).map((x) => ({ t: g, saat: x.saat }));
      } else {
        const s1 = saatNormalize(saat) || (sl.length === 1 ? sl[0].saat : null);
        if (s1 && sl.some((x) => x.gun === gunNo(g) && x.saat === s1)) hedef = [{ t: g, saat: s1 }];
      }
      if (!hedef.length) return { hata: "Bu tarih abonenin günlerine denk gelmiyor." };
      let hakAsildi = false;
      if (gelmiyor && a.kural?.yeni) {
        // Yeni abone: ayda en fazla 1 iptal; fazlası depozito yakar (yönetici onaylarsa işaretlenir)
        const ay = hedef[0].t.slice(0, 7);
        const m = await this.st.list({ start: `x:${ay}-01`, end: `x:${ay}-31~` });
        const gunler = new Set([...m.keys()].filter((k) => k.endsWith(`:${a.id}`)).map((k) => k.split(":")[1]));
        hedef.forEach((h) => gunler.delete(h.t));
        if (gunler.size + new Set(hedef.map((h) => h.t)).size > KURALLAR.aboneAylikIptal) {
          hakAsildi = true;
          if (!zorla) return { onayGerekli: true, uyari: `${a.ad} bu ay iptal hakkını kullandı (${[...gunler].map((g) => g.split("-").reverse().join(".")).join(", ")}). Kurala göre ayda ${KURALLAR.aboneAylikIptal} iptal hakkı var; fazlasında depozito yanar. Yine de işaretlensin mi?` };
        }
      }
      if (gelmiyor) {
        const kayit = {};
        for (const h of hedef) kayit[`x:${h.t}:${h.saat}:${a.id}`] = { olusturma: simdiYazi() };
        await this.st.put(kayit);
        return { basarili: true, sayi: hedef.length, ad: a.ad, no: aboneNo(a), tarihler: hedef.map((h) => `${h.t} ${h.saat}`), ...(hakAsildi ? { hakAsildi: true } : {}) };
      }
      // Geri alırken bu arada rezervasyon alınmış saatleri atla
      const ilk = hedef.reduce((m, h) => (h.t < m ? h.t : m), hedef[0].t);
      const son = hedef.reduce((m, h) => (h.t > m ? h.t : m), hedef[0].t);
      const d = await this.durumYukle(ilk, son);
      const dolu = hedef.filter((h) => d.rezMap.get(`${takvimTarihi(h.t, h.saat)}|${h.saat}`));
      const sil = hedef.filter((h) => !dolu.includes(h)).map((h) => `x:${h.t}:${h.saat}:${a.id}`);
      if (sil.length) await this.st.delete(sil);
      if (!sil.length && dolu.length) return { hata: "Bu saate bu hafta başka rezervasyon alınmış. Önce onu iptal edin." };
      return { basarili: true, sayi: sil.length, atlanan: dolu.length, ad: a.ad, no: aboneNo(a),
        tarihler: hedef.filter((h) => !dolu.includes(h)).map((h) => `${h.t} ${h.saat}`) };
    });
  }

  /** Tablodan toplu aktarım (bir kez). Aynı isimli abone ve dolu saatler atlanır. */
  async iceAktar({ aboneler = [], rezervasyonlar = [], gelmiyor = [] }) {
    const sonuc = { abone: 0, rez: 0, gelmiyor: 0, atlanan: [] };
    const idAd = {};
    const mevcut = await this.aboneler();
    for (const a of aboneler) {
      const var_ = mevcut.find((m) => m.ad.toLocaleLowerCase("tr") === String(a.ad).toLocaleLowerCase("tr"));
      if (var_) { idAd[a.ad] = var_.id; sonuc.atlanan.push(`abone: ${a.ad} (zaten var)`); continue; }
      const r = await this.aboneKaydet(a);
      if (r.basarili) { sonuc.abone++; idAd[a.ad] = r.abone.id; } else sonuc.atlanan.push(`abone: ${a.ad} (${r.hata})`);
    }
    for (const g of gelmiyor) {
      const r = await this.aboneAtla({ id: idAd[g.ad], gun: g.gun, saat: g.saat, gelmiyor: true });
      if (r.basarili) sonuc.gelmiyor++; else sonuc.atlanan.push(`gelmiyor: ${g.ad} ${g.gun} (${r.hata})`);
    }
    for (const z of rezervasyonlar) {
      const r = await this.panelRezEkle(z);
      if (r.basarili) sonuc.rez++; else sonuc.atlanan.push(`rez: ${z.ad} ${z.gunTarihi} ${z.saat} (${r.hata})`);
    }
    return sonuc;
  }

  // ================= Fotoğraflar (eski siteden bir kez kopyalanır) =================

  /** `f:<ad>` altında saklı fotoğrafı döndürür; yoksa `kaynak` adresinden indirip saklar. */
  async foto(ad, kaynak) {
    const kayit = await this.st.get(`f:${ad}`);
    if (kayit) return kayit;
    if (!kaynak) return null;
    const res = await fetch(kaynak);
    const tur = res.headers.get("content-type") || "";
    if (!res.ok || !tur.startsWith("image/")) return null;
    const veri = new Uint8Array(await res.arrayBuffer());
    if (veri.byteLength > 1_900_000) return null; // depolama sınırı (2 MB)
    const yeni = { tur, veri, alindi: simdiYazi() };
    await this.st.put(`f:${ad}`, yeni);
    return yeni;
  }

  // ================= Panel: müşteriler (CRM) =================

  async musteriler() {
    return this.kilitli(async () => {
      const [rezMap, aboneler, notlar] = await Promise.all([
        this.st.list({ prefix: "r:" }), this.aboneler(), this.st.list({ prefix: "m:" }),
      ]);
      const kisiler = new Map();
      const kisi = (telefon, ad) => {
        if (!kisiler.has(telefon)) {
          kisiler.set(telefon, { telefon, ad, mac: 0, iptal: 0, bekleyen: 0, ilk: null, son: null, gelecek: null, abone: [], not: "", etiket: "" });
        }
        const k = kisiler.get(telefon);
        if (ad && !k.ad) k.ad = ad;
        return k;
      };
      const simdiMs = Date.now();
      for (const r of [...rezMap.values()].sort((a, b) => (a.tarih + a.saat).localeCompare(b.tarih + b.saat))) {
        if (!r.telefon) continue;
        const k = kisi(r.telefon, r.ad);
        k.ad = r.ad || k.ad; // en güncel isim
        if (iptalMi(r.durum)) { k.iptal++; continue; }
        const zaman = macZamani(r.tarih, r.saat);
        if (zaman <= simdiMs) {
          k.mac++;
          k.ilk = k.ilk || r.tarih;
          k.son = r.tarih;
        } else if (!k.gelecek) {
          k.gelecek = { tarih: r.tarih, saat: r.saat, gun: r.gun };
        }
        if (r.durum === DURUM.bekliyor && zaman > simdiMs) k.bekleyen++;
      }
      for (const a of aboneler) {
        if (!a.telefon) continue;
        const k = kisi(a.telefon, a.ad);
        if (!a.bitis) k.aktifAbone = true;
        if (!a.bitis && aboneNo(a)) k.aboneNo = Math.min(k.aboneNo || 999, aboneNo(a));
        for (const x of slotSirala(slotlarOf(a))) k.abone.push(`${GUNLER[x.gun]} ${x.saat}`);
      }
      for (const [anahtar, v] of notlar) {
        const k = kisi(anahtar.slice(2), v.ad || "");
        k.not = v.not || "";
        k.etiket = v.etiket || "";
        if (v.arsiv) { // haftalık temizlikte silinmiş eski maçlar
          k.mac += v.arsiv.mac; k.iptal += v.arsiv.iptal;
          if (v.arsiv.ilk && (!k.ilk || v.arsiv.ilk < k.ilk)) k.ilk = v.arsiv.ilk;
          if (v.arsiv.son && (!k.son || v.arsiv.son > k.son)) k.son = v.arsiv.son;
        }
      }
      return [...kisiler.values()].sort((a, b) =>
        (b.son || b.gelecek?.tarih || "").localeCompare(a.son || a.gelecek?.tarih || "") || a.ad.localeCompare(b.ad, "tr"));
    });
  }

  /**
   * Haftalık temizlik (her Pazar gecesi bittikten sonra, Pazartesi 03:00):
   * bu haftadan önceki tek seferlik rezervasyonlar ve "gelmiyor" işaretleri silinir. Aboneler kalır.
   * Müşteri kartındaki sayılar kaybolmasın diye silinen maçlar m:<telefon>.arsiv içine özetlenir.
   */
  async haftaTemizle() {
    return this.kilitli(async () => {
      const n = simdi();
      const sinir = haftaBasi(n.tarih); // takvime göre bu haftanın pazartesisi (Pazar gecesi maçları bitmiş olur)
      const eskiRez = await this.st.list({ start: "r:", end: `r:${gunEkle(sinir, 1)}` });
      const silinecek = [];
      const ozet = new Map();
      for (const [anahtar, r] of eskiRez) {
        if ((r.isletmeGunu || isletmeGunu(r.tarih, r.saat)) >= sinir) continue; // bu haftanın gece maçı
        silinecek.push(anahtar, `k:${r.kayitNo}`);
        if (!r.telefon) continue;
        const o = ozet.get(r.telefon) || { mac: 0, iptal: 0, ilk: null, son: null, ad: "" };
        if (iptalMi(r.durum)) o.iptal++;
        else { o.mac++; o.ilk = !o.ilk || r.tarih < o.ilk ? r.tarih : o.ilk; o.son = !o.son || r.tarih > o.son ? r.tarih : o.son; }
        o.ad = r.ad || o.ad;
        ozet.set(r.telefon, o);
      }
      for (const [tel, o] of ozet) {
        const m = (await this.st.get(`m:${tel}`)) || {};
        const a = m.arsiv || { mac: 0, iptal: 0, ilk: null, son: null };
        await this.st.put(`m:${tel}`, {
          ...m, ad: m.ad || o.ad,
          arsiv: {
            mac: a.mac + o.mac, iptal: a.iptal + o.iptal,
            ilk: [a.ilk, o.ilk].filter(Boolean).sort()[0] || null,
            son: [a.son, o.son].filter(Boolean).sort().at(-1) || null,
          },
        });
      }
      const atla = await this.st.list({ start: "x:", end: `x:${sinir}` });
      silinecek.push(...atla.keys());
      // süresi dolmuş oturum ve şifre bağlantıları
      // Dekontlar 3 ay saklanır (anlaşmazlık / muhasebe kontrolü için), sonra silinir
      for (const [k, v] of await this.st.list({ prefix: "d:" })) if (!v.zaman || v.zaman.slice(0, 10) < gunEkle(sinir, -90)) silinecek.push(k);
      // İşlem kaydı 1 yıl saklanır
      for (const k of (await this.st.list({ prefix: "l:", end: `l:${gunEkle(sinir, -365)}` })).keys()) silinecek.push(k);
      // 90 günden eski dekont özetleri
      for (const [k, v] of await this.st.list({ prefix: "dh:" })) if (!v.tarih || v.tarih < gunEkle(sinir, -90)) silinecek.push(k);
      for (const k of (await this.st.list({ start: "ua:", end: `ua:${gunEkle(sinir, -7)}` })).keys()) silinecek.push(k);
      for (const onek of ["o:", "s:", "t:"]) {
        for (const [k, v] of await this.st.list({ prefix: onek })) if (!v.bitis || v.bitis < Date.now()) silinecek.push(k);
      }
      for (let i = 0; i < silinecek.length; i += 128) await this.st.delete(silinecek.slice(i, i + 128));
      const rezSayi = silinecek.filter((k) => k.startsWith("r:")).length;
      await this.kayitTut(null, "Haftalık temizlik", `${sinir} öncesi ${rezSayi} rezervasyon ve ${atla.size} "gelmiyor" işareti silindi; aboneler korundu`);
      return { basarili: true, sinir, rezervasyon: rezSayi, gelmiyor: atla.size };
    });
  }

  /**
   * Müşteriyi ve geçmiş rezervasyonlarını kalıcı olarak siler (KVKK silme talebi vb.).
   * İleri tarihli aktif rezervasyonu ya da aboneliği varsa önce onların kaldırılması istenir.
   */
  async musteriSil(tel, yapan) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const tum = [...(await this.st.list({ prefix: "r:" }))].filter(([, r]) => r.telefon === telefon);
      const aktif = tum.filter(([, r]) => !iptalMi(r.durum) && !opsiyonDustu(r) && macZamani(r.tarih, r.saat) > Date.now());
      if (aktif.length) return { hata: `Bu müşterinin ${aktif.length} ileri tarihli aktif rezervasyonu var. Önce iptal edin.` };
      const abone = (await this.aboneler()).filter((a) => a.telefon === telefon && !a.bitis);
      if (abone.length) return { hata: `Bu numara aboneye kayıtlı (${abone.map((a) => a.ad).join(", ")}). Önce aboneliği sonlandırın.` };
      const sil = [`m:${telefon}`];
      for (const [k, r] of tum) sil.push(k, `k:${r.kayitNo}`, `d:${r.kayitNo}`, ...(r.dekontlar || []).map((x) => x.anahtar).filter(Boolean));
      for (let i = 0; i < sil.length; i += 128) await this.st.delete(sil.slice(i, i + 128));
      await this.kayitTut(yapan, "Müşteri sildi", `${telefon} · ${tum.length} rezervasyon kaydı`);
      return { basarili: true, silinen: tum.length };
    });
  }

  async musteriDetay(tel) {
    const telefon = telefonNormalize(tel);
    if (!telefon) return { hata: "Geçersiz telefon." };
    const tum = [...(await this.st.list({ prefix: "r:" })).values()]
      .filter((r) => r.telefon === telefon)
      .sort((a, b) => (b.tarih + b.saat).localeCompare(a.tarih + a.saat));
    const m = (await this.st.get(`m:${telefon}`)) || {};
    const abone = (await this.aboneler()).filter((a) => a.telefon === telefon).map((a) => ({ ...a, no: aboneNo(a), slotlar: slotSirala(slotlarOf(a)) }));
    return { telefon, ad: tum[0]?.ad || abone[0]?.ad || m.ad || "", not: m.not || "", etiket: m.etiket || "", rezervasyonlar: tum.slice(0, 100), abone, arsiv: m.arsiv || null };
  }

  async musteriNot({ telefon: tel, not, etiket, ad }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const eski = (await this.st.get(`m:${telefon}`)) || {};
      await this.st.put(`m:${telefon}`, {
        ...eski,
        ...(not !== undefined ? { not: kirp(not, 1000) } : {}),
        ...(etiket !== undefined ? { etiket: kirp(etiket, 40) } : {}),
        ...(ad ? { ad: kirp(ad, 60) } : {}),
      });
      return { basarili: true };
    });
  }
}
