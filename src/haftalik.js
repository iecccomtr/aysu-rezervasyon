// Çalışanların kullandığı haftalık tabloyu (REZERVASYON sekmesi) okur.
// Düzen: bir satırda gün adları (PAZARTESİ ... PAZAR) ve "SAAT" başlıkları,
// altındaki satırlarda saatler ve o saatin hücre içerikleri.

import { saatNormalize } from "./time.js";

const GUN_ADLARI = ["pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar"];

function sadelestir(s) {
  return String(s || "").trim().toLocaleLowerCase("tr")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ç/g, "c")
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * @param {string[][]} satirlar  Tablonun ham hücreleri
 * @returns {Map<string,string>} anahtar: "gunNo|HH:MM" (gunNo 0 = pazartesi), değer: hücre metni
 */
export function haftalikTabloyuCoz(satirlar) {
  const dolu = new Map();
  const baslikIdx = satirlar.findIndex((r) => (r || []).some((h) => sadelestir(h) === "pazartesi"));
  if (baslikIdx === -1) return dolu;

  const baslik = satirlar[baslikIdx];
  const gunSutunu = {}; // gunNo -> sütun indeksi
  let saatSutunu = -1;
  baslik.forEach((h, i) => {
    const s = sadelestir(h);
    const g = GUN_ADLARI.indexOf(s);
    if (g !== -1 && gunSutunu[g] === undefined) gunSutunu[g] = i;
    if (s === "saat" && saatSutunu === -1) saatSutunu = i;
  });
  if (saatSutunu === -1) return dolu;

  for (let r = baslikIdx + 1; r < satirlar.length; r++) {
    const satir = satirlar[r] || [];
    const saat = saatNormalize(satir[saatSutunu]);
    if (!saat) {
      if (sadelestir(satir[saatSutunu]) === "saat") break; // alt başlık satırı: tablo bitti
      continue;
    }
    for (const [g, i] of Object.entries(gunSutunu)) {
      const metin = String(satir[i] || "").trim();
      if (metin) dolu.set(`${g}|${saat}`, metin);
    }
  }
  return dolu;
}

export function aboneMi(metin) {
  return sadelestir(metin).includes("abone");
}

/** Takvim gününden (YYYY-MM-DD) tablo gün numarasına: 0 = pazartesi. */
export function gunNo(tarih) {
  return (new Date(tarih + "T00:00:00Z").getUTCDay() + 6) % 7;
}
