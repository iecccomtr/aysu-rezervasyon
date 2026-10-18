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

/** Hücre ya düz metin ya da {metin, renk} olabilir (Google'dan renkli okunduğunda). */
const metinOf = (h) => (h && typeof h === "object" ? h.metin : h);

/**
 * Yazı rengi siyah (veya varsayılan) mı?  Google renkleri 0–1 aralığında verir;
 * hiç renk yoksa varsayılan siyahtır.
 */
export function siyahMi(renk) {
  if (!renk) return true;
  if (renk.themeColor && renk.themeColor !== "TEXT") return false;
  const c = renk.rgbColor || {};
  return (c.red || 0) <= 0.25 && (c.green || 0) <= 0.25 && (c.blue || 0) <= 0.25;
}

/**
 * @param {(string|{metin:string, renk?:object})[][]} satirlar  Tablonun hücreleri
 * @returns {Map<string,{metin:string, siyah:boolean}>} anahtar: "gunNo|HH:MM" (gunNo 0 = pazartesi)
 */
export function haftalikTabloyuCoz(satirlar) {
  const dolu = new Map();
  satirlar = satirlar.map((r) => r || []);
  const baslikIdx = satirlar.findIndex((r) => r.some((h) => sadelestir(metinOf(h)) === "pazartesi"));
  if (baslikIdx === -1) return dolu;

  const baslik = satirlar[baslikIdx];
  const gunSutunu = {}; // gunNo -> sütun indeksi
  let saatSutunu = -1;
  baslik.forEach((h, i) => {
    const s = sadelestir(metinOf(h));
    const g = GUN_ADLARI.indexOf(s);
    if (g !== -1 && gunSutunu[g] === undefined) gunSutunu[g] = i;
    if (s === "saat" && saatSutunu === -1) saatSutunu = i;
  });
  if (saatSutunu === -1) return dolu;

  for (let r = baslikIdx + 1; r < satirlar.length; r++) {
    const satir = satirlar[r];
    const saatHucresi = metinOf(satir[saatSutunu]);
    const saat = saatNormalize(saatHucresi);
    if (!saat) {
      if (sadelestir(saatHucresi) === "saat") break; // alt başlık satırı: tablo bitti
      continue;
    }
    for (const [g, i] of Object.entries(gunSutunu)) {
      const h = satir[i];
      const metin = String(metinOf(h) || "").trim();
      if (!metin) continue;
      const renkli = Boolean(h && typeof h === "object"); // renk bilgisi okunabildi mi
      dolu.set(`${g}|${saat}`, { metin, renkli, siyah: renkli ? siyahMi(h.renk) : false });
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
