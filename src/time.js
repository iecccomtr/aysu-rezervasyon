// Türkiye saati yardımcıları (Türkiye 2016'dan beri sabit UTC+3).
import { SAATLER, FIYATLAR } from "./config.js";

const OFFSET_MS = 3 * 60 * 60 * 1000;
const GUNLER = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

/** Şu anki Türkiye saatini {tarih:"YYYY-MM-DD", saat:"HH:MM", gun:"Pazartesi"} olarak verir. */
export function simdi(now = Date.now()) {
  const d = new Date(now + OFFSET_MS);
  const tarih = d.toISOString().slice(0, 10);
  const saat = d.toISOString().slice(11, 16);
  return { tarih, saat, gun: GUNLER[d.getUTCDay()] };
}

export function gunAdi(tarih) {
  return GUNLER[new Date(tarih + "T00:00:00Z").getUTCDay()];
}

export function gunEkle(tarih, n) {
  const d = new Date(tarih + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bir maçın başlangıç anını epoch ms olarak verir. */
export function macZamani(tarih, saat) {
  return Date.parse(`${tarih}T${saat}:00Z`) - OFFSET_MS;
}

/** "24.10.2026", "24/10/2026", "2026-10-24" → "2026-10-24". Tanınmazsa null. */
export function tarihNormalize(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // Google Sheets seri tarih sayısı (ör. 46319)
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** "21", "21:00", "21.00", "9:00" → "21:00" / "09:00". Tanınmazsa null. */
export function saatNormalize(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
}

/** Türk cep telefonu → "05XXXXXXXXX". Geçersizse null. */
export function telefonNormalize(v) {
  if (v == null) return null;
  let d = String(v).replace(/\D/g, "");
  if (d.startsWith("90") && d.length === 12) d = "0" + d.slice(2);
  if (d.length === 10 && d.startsWith("5")) d = "0" + d;
  return /^05\d{9}$/.test(d) ? d : null;
}

/**
 * Müşterinin yazdığı cep telefonu gerçekçi mi? (normalize edilmiş 05XXXXXXXXX)
 * - Türkiye GSM önekleri: 50x, 53x, 54x, 55x, 56x
 * - Son 7 hane hep aynı olamaz (0555 555 55 55 gibi uydurma numaralar), 1234567 gibi ardışık olamaz
 */
export function telefonGercekci(t) {
  if (!/^05\d{9}$/.test(t || "")) return false;
  if (!/^05[03456]/.test(t)) return false;
  const son7 = t.slice(4);
  if (/^(\d)\1{6}$/.test(son7)) return false;
  if ("0123456789".includes(son7) || "9876543210".includes(son7)) return false;
  return true;
}

/** Gece saatleri (00:00–05:59) bir önceki günün gecesine aittir. Maçın "işletme günü"nü verir. */
export function isletmeGunu(tarih, saat) {
  return Number(saat.slice(0, 2)) < 6 ? gunEkle(tarih, -1) : tarih;
}

/** Tarihin içinde bulunduğu haftanın pazartesisi. */
export function haftaBasi(tarih) {
  const gun = new Date(tarih + "T00:00:00Z").getUTCDay(); // 0 = pazar
  return gunEkle(tarih, -((gun + 6) % 7));
}

export function gecerliSaat(saat) {
  return SAATLER.includes(saat);
}

/** Verilen tarih/saat için saatlik ücret. */
export function fiyat(tarih, saat) {
  const gun = new Date(tarih + "T00:00:00Z").getUTCDay();
  const h = Number(saat.slice(0, 2));
  // Gece yarısından sonraki saatler bir önceki günün gecesine aittir.
  const oncekiGun = h < 6 ? (gun + 6) % 7 : gun;
  if (oncekiGun === 0 || oncekiGun === 6) return FIYATLAR.haftaSonu;
  if (h < 6 || h >= FIYATLAR.aksamBaslangic) return FIYATLAR.aksam;
  return FIYATLAR.gunduz;
}
