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
import { SAATLER, KURALLAR, DURUM, EKSTRALAR, FIYATLAR } from "./config.js";
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
const takvimTarihi = (gun, saat) => (geceSaati(saat) ? gunEkle(gun, 1) : gun);
/** 0 = pazartesi */
const gunNo = (tarih) => (new Date(tarih + "T00:00:00Z").getUTCDay() + 6) % 7;
/** Abonenin haftalık saatleri: [{gun: 0-6 (0=pazartesi, işletme günü), saat: "HH:MM"}] (eski kayıtlarla uyumlu) */
const slotlarOf = (a) => (Array.isArray(a.slotlar) ? a.slotlar : (a.gun != null && a.saat ? [{ gun: a.gun, saat: a.saat }] : []));
/** Abone numarası: kayıtlı "no" ya da eski kayıtlarda nottaki "Abone 3" ifadesi. */
const aboneNo = (a) => (Number.isInteger(a.no) && a.no > 0 ? a.no : Number(String(a.not || "").match(/abone\s*(\d+)/i)?.[1]) || null);
const SAAT_SIRA = (saat) => (Number(saat.slice(0, 2)) < 6 ? 24 : 0) + Number(saat.slice(0, 2));
const slotSirala = (l) => [...l].sort((x, y) => x.gun - y.gun || SAAT_SIRA(x.saat) - SAAT_SIRA(y.saat));
/** ms → Türkiye saatiyle "HH:MM" */
const zamanYazi = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
/** Puantaj kaydındaki çalışılan saat (2 ondalık); çıkış yoksa 0 */
const saatFark = (k) => (k?.giris && k?.cikis ? Math.round(((k.cikis - k.giris) / 3600_000) * 100) / 100 : 0);
const simdiYazi = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
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
  ["FİLTRE / TÜRK KAHVESİ", 28, 70, 904],
  ["JETON", 4, 10, 96],
];

// ---- Kasa defteri yardımcıları ----
/** "1.250 TL", "1250", 1250 → 1250 (negatif olmaz) */
const tutar = (v) => {
  const n = Math.round(Number(String(v ?? "").replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "")));
  return Number.isFinite(n) ? Math.min(10_000_000, Math.max(0, n)) : 0;
};
/** "1200", "1.200 TL", "500 + 700" → toplam kapora */
const kaporaSayi = (v) => String(v ?? "").split(/[+&]|\s(?:ve|\/)\s/).reduce((t, p) => t + tutar(p), 0);
/** Personel / ücretsiz tüketim satırları (kasaya para girmez, stoktan düşer) */
const IKRAM_KIMLER = ["VIP / ücretsiz ikram", "Müdür", "Müdür Yardımcısı", "Şef", "Personel"];
/** Bir kasa günündeki toplam ürün çıkışı {urunId: adet} (satış + ikram) */
export const kasaTuketim = (k) => {
  const t = {};
  const ekle = (o) => { for (const [id, a] of Object.entries(o || {})) t[id] = (t[id] || 0) + (Number(a) || 0); };
  for (const m of k.maclar || []) ekle(m.kantin);
  for (const o of Object.values(k.ikram || {})) ekle(o);
  return t;
};
/** Kasa günü hesapları (sunucu ve panel aynı formülü kullanır) */
export const kasaOzet = (k) => {
  const b = k.birimler || {}, kira = k.kira || { krampon: 0, eldiven: 0 };
  const top = (l) => (l || []).reduce((t, x) => t + (Number(x.tutar) || 0), 0);
  const o = { mac: 0, vip: 0, kantin: 0, kantinKar: 0, kramponAdet: 0, eldivenAdet: 0, krampon: 0, eldiven: 0, onOdeme: 0, ikramDeger: 0 };
  o.maclar = (k.maclar || []).map((m) => {
    let kantin = 0;
    for (const [id, a] of Object.entries(m.kantin || {})) { kantin += a * (b[id]?.satis || 0); o.kantinKar += a * ((b[id]?.satis || 0) - (b[id]?.alis || 0)); }
    const krampon = (m.krampon || 0) * kira.krampon, eldiven = (m.eldiven || 0) * kira.eldiven;
    o.mac += m.ucret || 0; o.vip += m.vip || 0; o.kantin += kantin; o.onOdeme += m.onOdeme || 0;
    o.kramponAdet += m.krampon || 0; o.eldivenAdet += m.eldiven || 0; o.krampon += krampon; o.eldiven += eldiven;
    return { saat: m.saat, kantin, toplam: (m.ucret || 0) + (m.vip || 0) + kantin + krampon + eldiven };
  });
  for (const v of Object.values(k.ikram || {})) for (const [id, a] of Object.entries(v)) o.ikramDeger += a * (b[id]?.satis || 0);
  o.ciro = o.mac + o.vip + o.kantin + o.krampon + o.eldiven;
  o.giris = top(k.girisler); o.cikis = top(k.cikislar); o.veresiye = top(k.veresiye);
  o.devir = Number(k.devir) || 0;
  o.kasaToplam = o.devir + o.ciro + o.giris;
  // Önceden alınan kapora ve veresiye kasaya bugün girmez
  o.olmasiGereken = o.kasaToplam - o.cikis - o.veresiye - o.onOdeme;
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
    return [...(await this.st.list({ prefix: "a:" })).values()];
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
  async rezervasyonYaz({ gunTarihi, saat: s, ad, telefon: tel, not = "", durum, kaynak, kapora = "", ekstra = [] }, panel) {
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
    if (!panel) {
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
      kaporaTutar: f.kapora, // o anki kapora tutarı (fiyat sonradan değişse de bu rezervasyon için geçerli)
      ...(!panel ? { opsiyonBitis: Date.now() + KURALLAR.opsiyonDakika * 60_000 } : {}),
    };
    kayit.ucret = f.mac + kayit.ekstra.reduce((t, x) => t + (f[x] ?? EKSTRALAR[x].ucret), 0);
    const anahtar = `r:${tarih}:${saat}:${kayit.kayitNo}`;
    await this.st.put({ [anahtar]: kayit, [`k:${kayit.kayitNo}`]: anahtar });
    return { basarili: true, ...kayit };
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
      const ayniDosya = onceki && onceki.kayitNo === b.kayit.kayitNo && (b.kayit.dekontlar || []).length > 1;
      if (KURALLAR.dekontTekrarKontrol && onceki && onceki.kayitNo !== b.kayit.kayitNo) nedenler.unshift("Bu dekont daha önce başka bir rezervasyon için kullanılmış.");
      else if (ayniDosya) nedenler.unshift("Bu dekontu zaten yüklediniz.");
      else await this.st.put(`dh:${dosyaOzeti}`, { kayitNo: b.kayit.kayitNo, tarih: simdi().tarih });
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
        kayit.kaporaToplam = tutarlar.reduce((t, x) => t + x, 0);
        const gereken = kayit.kaporaTutar ?? (await this.fiyatAyar()).kapora;
        kayit.eksikKapora = tutarlar.length !== parcalar.length || kayit.kaporaToplam < gereken;
      }
      await this.st.put(b.anahtar, kayit);
      await this.kayitTut(null, onay ? "Dekont otomatik onaylandı" : "Dekont kontrol gerekiyor",
        `${kayit.kayitNo} · ${kayit.ad} · ${onay ? deger.tutar + " TL" : nedenler.join(" ")}`);
      return { basarili: true, onay, nedenler, rez: kayit, eksik: Boolean(kayit.eksikKapora), tutar: deger.tutar,
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
      return { basarili: true, karar: "onayla", ad: u.ad, rolAd: ROLLER[u.istenenRol].ad };
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
      return { basarili: true, kullanici: kullaniciDisi(yeni) };
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
    const ilk = this.saatListesi(d, gun, gun).find((saat) => { const t = this.slot(d, gun, saat).tur; return t === "rez" || t === "abone"; });
    if (!ilk) return { gun, ilkMac: null, baslama: null };
    const h = (Number(ilk.slice(0, 2)) + 23) % 24;
    return { gun, ilkMac: ilk, baslama: `${String(h).padStart(2, "0")}:00` };
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
    return { ...b, kayit: kayit || null, buAy: { saat: k?.saat || 0, ucret: k?.ucret || 0 }, saatlikUcret: u?.saatlikUcret || 0 };
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

  /**
   * Günlük "GELDİM / ÇIKTIM" e-postası: ilk maçtan 2 saat önce (beklenen girişten 1 saat önce)
   * Admin dışındaki aktif kullanıcılara bir kez gider. Dönen listeyi Worker gönderir.
   */
  async puantajEpostalari(simdiMs = Date.now()) {
    return this.kilitli(async () => {
      const n = simdi();
      const gun = isletmeGunu(n.tarih, n.saat);
      const b = await this.beklenenBaslama(gun);
      if (!b.baslama) return [];
      const baslamaMs = macZamani(takvimTarihi(gun, b.baslama), b.baslama);
      if (simdiMs < baslamaMs - 3600_000 || simdiMs > baslamaMs + 4 * 3600_000) return [];
      const liste = [];
      for (const u of await this.kullaniciListesi()) {
        if (u.durum !== "aktif" || u.rol === "admin" || !ROLLER[u.rol]) continue;
        if (await this.st.get(`pe:${gun}:${u.eposta}`)) continue;
        const token = hex(crypto.getRandomValues(new Uint8Array(24)));
        await this.st.put(`pt:${token}`, { eposta: u.eposta, gun, bitis: baslamaMs + 30 * 3600_000 });
        await this.st.put(`pe:${gun}:${u.eposta}`, { zaman: simdiYazi() });
        liste.push({ eposta: u.eposta, ad: u.ad, gun, gunAd: gunAdi(gun), baslama: b.baslama, ilkMac: b.ilkMac, token });
      }
      return liste;
    });
  }

  /** E-postadaki bağlantı: kişi, gün ve o günkü giriş/çıkış durumu */
  async puantajBaglanti(token) {
    const t = typeof token === "string" && /^[0-9a-f]{48}$/.test(token) ? await this.st.get(`pt:${token}`) : null;
    if (!t || t.bitis < Date.now()) return { hata: "Bağlantının süresi dolmuş. Panelden giriş / çıkış yapabilirsiniz." };
    const u = await this.st.get(`u:${t.eposta}`);
    if (!u || u.durum !== "aktif") return { hata: "Hesap bulunamadı." };
    const k = (await this.st.get(`p:${t.gun}:${u.eposta}`)) || null;
    const b = await this.beklenenBaslama(t.gun);
    return {
      ben: { eposta: u.eposta, ad: u.ad, rol: u.rol }, gun: t.gun, gunAd: gunAdi(t.gun), baslama: b.baslama, ilkMac: b.ilkMac,
      giris: k?.giris ? zamanYazi(k.giris) : null, cikis: k?.cikis ? zamanYazi(k.cikis) : null, saat: saatFark(k),
    };
  }

  async puantajBaglantiIsle(token, islem) {
    const b = await this.puantajBaglanti(token);
    if (b.hata) return b;
    const n = simdi();
    if (islem === "geldim") {
      if (isletmeGunu(n.tarih, n.saat) !== b.gun) return { hata: "Bu bağlantı başka bir gün içindir. Panelden giriş yapın." };
      const r = await this.puantajGiris(b.ben);
      return r.hata ? r : this.puantajBaglanti(token);
    }
    if (islem === "ciktim") {
      const r = await this.puantajCikis(b.ben);
      return r.hata ? r : this.puantajBaglanti(token);
    }
    return { hata: "Geçersiz işlem." };
  }

  /** Aylık puantaj: kişi kişi günler, saatler ve ödenecek tutar. eposta verilirse sadece o kişi. */
  async puantajAy(ay, eposta) {
    if (!/^\d{4}-\d{2}$/.test(ay || "")) return { hata: "Geçersiz ay." };
    const [m, kullanicilar] = await Promise.all([this.st.list({ start: `p:${ay}-01`, end: `p:${ay}-31~` }), this.kullaniciListesi()]);
    const kisiler = new Map();
    for (const [anahtar, k] of m) {
      const [, gun, ...ep] = anahtar.split(":");
      const e = ep.join(":");
      if (eposta && e !== eposta) continue;
      const u = kullanicilar.find((x) => x.eposta === e);
      if (!kisiler.has(e)) kisiler.set(e, { eposta: e, ad: u?.ad || k.ad || e, rol: ROLLER[u?.rol]?.ad || "", saatlikUcret: u?.saatlikUcret || 0, gunler: [], saat: 0, ucret: 0 });
      const kisi = kisiler.get(e);
      const saat = saatFark(k);
      kisi.gunler.push({ gun, giris: k.giris ? zamanYazi(k.giris) : null, cikis: k.cikis ? zamanYazi(k.cikis) : null, saat, acik: Boolean(k.giris && !k.cikis), duzelten: k.duzelten || null });
      kisi.saat = Math.round((kisi.saat + saat) * 100) / 100;
    }
    for (const kisi of kisiler.values()) kisi.ucret = Math.round(kisi.saat * kisi.saatlikUcret);
    return { ay, kisiler: [...kisiler.values()].sort((a, b) => a.ad.localeCompare(b.ad, "tr")) };
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
        await this.st.delete(anahtar);
        await this.kayitTut(yapan, "Puantaj kaydını sildi", `${u.ad} · ${g}`);
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
      if (yeni.kapora > yeni.mac) return { hata: "Kapora maç ücretinden büyük olamaz." };
      await this.st.put("ayar:fiyat", yeni);
      this._fiyat = yeni;
      const ad = { mac: "Maç", kapora: "Kapora", spiker: "VIP spiker", hakem: "VIP hakem", abone: "Abone maç", krampon: "Krampon kirası", eldiven: "Eldiven kirası" };
      const fark = Object.keys(ad).filter((a) => eski[a] !== yeni[a]).map((a) => `${ad[a]}: ${eski[a]} → ${yeni[a]} TL`);
      if (fark.length) await this.kayitTut(yapan, "Fiyatları değiştirdi", fark.join(" · "));
      return { basarili: true, fiyat: yeni };
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
    return [...m.values()].sort((a, b) => (a.sira || 0) - (b.sira || 0));
  }

  /** Ürün ekle / düzenle / stok sayımı (Admin, Müdür). stokEkle: gelen mal adedi. */
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
      if (stok !== undefined && stok !== "") yeni.stok = Math.round(Number(stok)) || 0;
      if (stokEkle) yeni.stok = (yeni.stok || 0) + (Math.round(Number(stokEkle)) || 0);
      if (aktif !== undefined) yeni.aktif = Boolean(aktif);
      await this.st.put(`urun:${yeni.id}`, yeni);
      const fark = eski
        ? ["ad", "alis", "satis", "stok", "aktif"].filter((a) => eski[a] !== yeni[a]).map((a) => `${{ ad: "ad", alis: "alış", satis: "satış", stok: "stok", aktif: "satışta" }[a]}: ${eski[a]} → ${yeni[a]}`)
        : [`alış ${yeni.alis || 0} · satış ${yeni.satis || 0} · stok ${yeni.stok}`];
      if (fark.length) await this.kayitTut(yapan, eski ? "Kantin ürünü düzenledi" : "Kantin ürünü ekledi", `${yeni.ad} · ${fark.join(" · ")}`);
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
        satirlar.push({ saat, tur: "abone", ad: no ? `Abone ${no}` : s.abone.ad, ucret: tutar(s.abone.ucret) || f.abone, vip: 0, onOdeme: 0, kaynak: "takvim" });
      } else if (s.tur === "rez" && s.rez.durum === DURUM.onayli) {
        const r = s.rez;
        const vip = (r.ekstra || []).reduce((t, x) => t + (f[x] ?? EKSTRALAR[x]?.ucret ?? 0), 0);
        const onOdeme = Number(r.kaporaToplam) || kaporaSayi(r.kapora);
        satirlar.push({ saat, tur: "normal", ad: r.ad, ucret: Math.max(0, (Number(r.ucret) || f.mac) - vip), vip, ekstra: (r.ekstra || []).filter((x) => EKSTRALAR[x]), onOdeme, tkOn: onOdeme, kayitNo: r.kayitNo, kaynak: "takvim" });
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
      if (!degisenler.length) return;
      const yeni = { ...k, maclar };
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
    const kullanicilar = await this.kullaniciListesi();
    const calisanlar = [...puantaj].map(([k, v]) => {
      const u = kullanicilar.find((x) => x.eposta === k.split(":").slice(2).join(":"));
      const saat = saatFark(v);
      return { ad: u?.ad || v.ad, rol: ROLLER[u?.rol]?.ad || "", saat, ucret: Math.round(saat * (u?.saatlikUcret || 0)), acik: Boolean(v.giris && !v.cikis) };
    });
    return {
      gun, gunAd: gunAdi(gun), bugun: isletmeGunu(n.tarih, n.saat), kayitli: Boolean(kayit),
      kayit: kayit || { gun, devir: oncekiKasa?.birakilan ?? 0, maclar: takvim.map((x) => ({ ...x, krampon: 0, eldiven: 0, kantin: {} })), girisler: [], cikislar: [], veresiye: [], ikram: {}, birakilan: null, sayilan: null, not: "" },
      oncekiDevir: oncekiKasa ? { gun: oncekiKasa.gun, tutar: oncekiKasa.birakilan ?? 0 } : null,
      takvim, urunler, fiyat, calisanlar, ikramKimler: IKRAM_KIMLER,
    };
  }

  async kasaKaydet(g, yapan) {
    return this.kilitli(async () => {
      const gun = tarihNormalize(g.gun);
      if (!gun) return { hata: "Gün gerekli." };
      if (!this.kasaYetkili(yapan, gun)) return { hata: "Geçmiş günlerin kasasını sadece Admin düzenleyebilir." };
      const [eski, urunler, f] = await Promise.all([this.st.get(`kasa:${gun}`), this.urunler(), this.fiyatAyar()]);
      const urunMap = new Map(urunler.map((u) => [u.id, u]));
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
          ad: kirp(m?.ad, 40), ucret: tutar(m?.ucret), vip: tutar(m?.vip), onOdeme: tutar(m?.onOdeme),
          krampon: Math.min(50, Math.max(0, Math.round(Number(m?.krampon)) || 0)),
          eldiven: Math.min(50, Math.max(0, Math.round(Number(m?.eldiven)) || 0)),
          kantin: kantinTemiz(m?.kantin), ...(m?.kayitNo ? { kayitNo: kirp(m.kayitNo, 20) } : {}),
          ...(m?.kaynak === "takvim" ? { kaynak: "takvim", tkOn: tutar(m?.tkOn ?? m?.onOdeme) } : {}),
          ekstra: [...new Set(Array.isArray(m?.ekstra) ? m.ekstra : [])].filter((x) => EKSTRALAR[x]),
        })).sort((a, b) => SAAT_SIRA(a.saat || "00:00") - SAAT_SIRA(b.saat || "00:00")),
        girisler: satirlar(g.girisler), cikislar: satirlar(g.cikislar),
        veresiye: (Array.isArray(g.veresiye) ? g.veresiye : []).slice(0, 40)
          .map((x) => ({ aciklama: kirp(x?.aciklama, 120), tutar: tutar(x?.tutar) })).filter((x) => x.aciklama || x.tutar),
        ikram: Object.fromEntries(IKRAM_KIMLER.map((k) => [k, kantinTemiz(g.ikram?.[k])]).filter(([, v]) => Object.keys(v).length)),
        birakilan: g.birakilan === null || g.birakilan === "" || g.birakilan === undefined ? null : tutar(g.birakilan),
        sayilan: g.sayilan === null || g.sayilan === "" || g.sayilan === undefined ? null : tutar(g.sayilan),
        not: kirp(g.not, 500),
        // O günün birim fiyatları sabitlenir: sonradan fiyat değişse de eski günün cirosu değişmez
        birimler: { ...(eski?.birimler || {}) },
        kira: eski?.kira || { krampon: f.krampon, eldiven: f.eldiven },
        guncelleyen: yapan.ad, guncelleme: simdiYazi(), olusturan: eski?.olusturan || yapan.ad,
      };
      for (const id of Object.keys(kasaTuketim(kayit))) {
        if (kayit.birimler[id] === undefined) kayit.birimler[id] = { satis: urunMap.get(id)?.satis || 0, alis: urunMap.get(id)?.alis || 0, ad: urunMap.get(id)?.ad || id };
      }
      kayit.ozet = kasaOzet(kayit);
      // Stok: önceki kayda göre fark kadar düşülür (aynı günü tekrar kaydetmek stoğu iki kez düşmez)
      const once = kasaTuketim(eski || {}), simdiT = kasaTuketim(kayit);
      const degisen = [];
      for (const id of new Set([...Object.keys(once), ...Object.keys(simdiT)])) {
        const fark = (simdiT[id] || 0) - (once[id] || 0);
        const u = urunMap.get(id);
        if (fark && u) { u.stok = (u.stok || 0) - fark; degisen.push([`urun:${id}`, u]); }
      }
      if (degisen.length) await this.st.put(Object.fromEntries(degisen));
      await this.st.put(`kasa:${gun}`, kayit);
      const o = kayit.ozet, para = (x) => `${Math.round(x).toLocaleString("tr-TR")} TL`;
      await this.kayitTut(yapan, eski ? "Kasa raporunu güncelledi" : "Kasa raporunu kaydetti",
        `${gun} · ciro ${para(o.ciro)} · giriş ${para(o.giris)} · çıkış ${para(o.cikis)} · kasada olması gereken ${para(o.olmasiGereken)}${kayit.sayilan !== null ? ` · sayılan ${para(kayit.sayilan)} (fark ${para(o.fark)})` : ""}`);
      return { basarili: true, kayit };
    });
  }

  /** Aylık kasa özeti (Admin) */
  async kasaAy(ay) {
    if (!/^\d{4}-\d{2}$/.test(ay || "")) return { hata: "Geçersiz ay." };
    const m = await this.st.list({ start: `kasa:${ay}-01`, end: `kasa:${ay}-31~` });
    const gunler = [...m.values()].map((k) => ({ gun: k.gun, gunAd: gunAdi(k.gun), ...k.ozet, guncelleyen: k.guncelleyen }));
    const toplam = {};
    for (const a of ["mac", "vip", "kantin", "kantinKar", "krampon", "eldiven", "ciro", "giris", "cikis", "veresiye", "onOdeme", "ikramDeger"]) {
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
              ...(s.rez ? { rez: s.rez } : {}),
              ...(s.abone ? { abone: { id: s.abone.id, no: aboneNo(s.abone), ad: s.abone.ad, telefon: s.abone.telefon, not: s.abone.not, slotlar: slotlarOf(s.abone) } } : {}),
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

  async panelRezGuncelle({ kayitNo, durum, kapora, not, ad, telefon }) {
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
        k.durum = durum;
        if (iptalMi(durum)) k.iptalEden = "Panel";
      }
      if (kapora !== undefined) k.kapora = kirp(kapora, 60);
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
      const degisen = [["durum", "Durum"], ["kapora", "Kapora"], ["not", "Not"], ["ad", "Ad"], ["telefon", "Telefon"]]
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
  async aboneKaydet({ id, ad, telefon, slotlar, gun, saat, baslangic, not = "", ucret = "", no }) {
    return this.kilitli(async () => {
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
        not: kirp(not, 200), ucret: kirp(ucret, 40), olusturma: eski?.olusturma || simdiYazi(),
      };
      await this.st.put(`a:${abone.id}`, abone);
      // Uyarı: abonenin saatlerine denk gelen ileri tarihli aktif rezervasyonlar
      const cakisanRez = (await this.rezervasyonlar(n.tarih, gunEkle(n.tarih, 60)))
        .filter((r) => !iptalMi(r.durum) && (r.isletmeGunu || r.tarih) >= bas
          && liste.some((x) => x.saat === r.saat && x.gun === gunNo(r.isletmeGunu || r.tarih)));
      return { basarili: true, abone, uyari: cakisanRez.length ? `${cakisanRez.length} ileri tarihli rezervasyon bu abonenin saatlerine denk geliyor, kontrol edin.` : null };
    });
  }

  async aboneSil(id) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a) return { hata: "Abone bulunamadı." };
      await this.st.delete(`a:${id}`);
      const atla = await this.st.list({ prefix: "x:" });
      const sil = [...atla.keys()].filter((k) => k.endsWith(`:${id}`));
      if (sil.length) await this.st.delete(sil);
      return { basarili: true };
    });
  }

  /**
   * Abone gelmiyor (gelmiyor=true) / yine geliyor (false).
   * kapsam: "saat" (sadece `saat`), "gun" (o işletme gününün tüm saatleri), "hafta" (o haftanın tüm saatleri).
   */
  async aboneAtla({ id, gun, saat, gelmiyor, kapsam = "saat" }) {
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
      if (gelmiyor) {
        const kayit = {};
        for (const h of hedef) kayit[`x:${h.t}:${h.saat}:${a.id}`] = { olusturma: simdiYazi() };
        await this.st.put(kayit);
        return { basarili: true, sayi: hedef.length };
      }
      // Geri alırken bu arada rezervasyon alınmış saatleri atla
      const ilk = hedef.reduce((m, h) => (h.t < m ? h.t : m), hedef[0].t);
      const son = hedef.reduce((m, h) => (h.t > m ? h.t : m), hedef[0].t);
      const d = await this.durumYukle(ilk, son);
      const dolu = hedef.filter((h) => d.rezMap.get(`${takvimTarihi(h.t, h.saat)}|${h.saat}`));
      const sil = hedef.filter((h) => !dolu.includes(h)).map((h) => `x:${h.t}:${h.saat}:${a.id}`);
      if (sil.length) await this.st.delete(sil);
      if (!sil.length && dolu.length) return { hata: "Bu saate bu hafta başka rezervasyon alınmış. Önce onu iptal edin." };
      return { basarili: true, sayi: sil.length, atlanan: dolu.length };
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
      for (const k of (await this.st.list({ start: "pe:", end: `pe:${gunEkle(sinir, -7)}` })).keys()) silinecek.push(k);
      for (const onek of ["o:", "s:", "t:", "pt:"]) {
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
