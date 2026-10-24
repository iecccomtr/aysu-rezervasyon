// Haftalık takvim PDF'i (kasa gönderilince Admin ve Müdür'e gider).
import { Pdf } from "./pdf.js";

const KISA = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const tarihYaz = (g) => g.split("-").reverse().join(".");

/** h: depo.panelHafta() sonucu */
export function takvimPdf(h) {
  const pdf = new Pdf();
  const SOL = 28, SAG = pdf.genislik - 28, EN = SAG - SOL;
  const saatEn = 38, gunEn = (EN - saatEn) / 7;
  const satirlar = h.gunler[0].saatler.map((x) => x.saat);
  const ustY = 92, satirY = Math.min(34, (pdf.yukseklik - ustY - 70) / satirlar.length);
  // Başlık
  pdf.kutu(0, 0, pdf.genislik, 60, [0.02, 0.16, 0.27]);
  pdf.yazi(SOL, 28, "AYSU HALI SAHA", { boyut: 15, kalin: true, renk: [1, 1, 1] });
  pdf.yazi(SOL, 46, "Haftalık takvim", { boyut: 10, renk: [0.72, 0.83, 0.91] });
  pdf.yazi(SAG, 34, `${tarihYaz(h.gunler[0].tarih)} – ${tarihYaz(h.gunler[6].tarih)}`, { boyut: 13, kalin: true, renk: [1, 1, 1], hiza: "sag" });
  // Sütun başlıkları
  pdf.kutu(SOL, ustY - 22, EN, 22, [0.02, 0.16, 0.27]);
  pdf.yazi(SOL + saatEn / 2, ustY - 8, "Saat", { boyut: 8, kalin: true, renk: [1, 1, 1], hiza: "orta" });
  h.gunler.forEach((g, i) => {
    const x = SOL + saatEn + i * gunEn;
    pdf.yazi(x + gunEn / 2, ustY - 8, `${KISA[i]} ${tarihYaz(g.tarih).slice(0, 5)}`, { boyut: 8, kalin: true, renk: [1, 1, 1], hiza: "orta" });
  });
  let dolu = 0, abone = 0;
  satirlar.forEach((saat, r) => {
    const y = ustY + r * satirY;
    if (r % 2) pdf.kutu(SOL, y, saatEn, satirY, [0.96, 0.97, 0.98]);
    pdf.yazi(SOL + saatEn / 2, y + satirY / 2 + 3, saat, { boyut: 8.5, kalin: true, hiza: "orta" });
    h.gunler.forEach((g, i) => {
      const s = g.saatler[r];
      const x = SOL + saatEn + i * gunEn;
      let renk = null, yazi = "", alt = "";
      if (s.tur === "rez") {
        const bek = s.rez.durum === "Kapora bekleniyor";
        renk = bek ? [1, 0.96, 0.76] : [0.9, 0.97, 0.92];
        yazi = s.rez.ad || ""; alt = `${bek ? "opsiyon" : "onaylı"}${(s.rez.ekstra || []).length ? " · VIP" : ""}`; dolu++;
      } else if (s.tur === "abone") {
        renk = [0.89, 0.93, 0.99]; yazi = s.abone.no ? `Abone ${s.abone.no}` : "Abone"; alt = s.abone.ad || ""; abone++;
      } else if (s.tur === "abone-gelmiyor") {
        renk = [0.95, 0.95, 0.95]; yazi = "Boş"; alt = `${s.abone.no ? "Abone " + s.abone.no : "Abone"} gelmiyor`;
      }
      if (renk) pdf.kutu(x + 1, y + 1, gunEn - 2, satirY - 2, renk);
      if (yazi) pdf.yazi(x + 4, y + satirY / 2 + (alt ? -1 : 3), yazi, { boyut: 7.5, kalin: true, en: gunEn - 8 });
      if (alt) pdf.yazi(x + 4, y + satirY / 2 + 9, alt, { boyut: 6.5, renk: [0.36, 0.42, 0.47], en: gunEn - 8 });
    });
    pdf.cizgi(SOL, y + satirY, SAG, y + satirY, { kalinlik: 0.3 });
  });
  for (let i = 0; i <= 7; i++) { const x = SOL + saatEn + i * gunEn; pdf.cizgi(x, ustY - 22, x, ustY + satirlar.length * satirY, { kalinlik: 0.3 }); }
  pdf.cizgi(SOL, ustY - 22, SOL, ustY + satirlar.length * satirY, { kalinlik: 0.3 });
  const altY = ustY + satirlar.length * satirY + 18;
  pdf.yazi(SOL, altY, `Rezervasyon: ${dolu} saat · Abone: ${abone} saat · Yeşil: onaylı, sarı: opsiyon (ödeme bekleniyor), mavi: abone, gri: abone gelmiyor (boş)`, { boyut: 8, renk: [0.36, 0.42, 0.47], en: EN });
  pdf.yazi(SOL, altY + 12, "00:00–02:00 satırları sütundaki günün gecesidir.", { boyut: 8, renk: [0.36, 0.42, 0.47] });
  return pdf.bayt();
}
