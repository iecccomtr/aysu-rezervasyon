// Günlük kasa raporu PDF'i (Admin'e e-postayla gider).

import { Pdf } from "./pdf.js";
import { KURALLAR } from "./config.js";
import { kasaOzet, personelFiyat } from "./store.js";

const GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const para = (n) => `${Math.round(Number(n) || 0).toLocaleString("tr-TR")} ₺`;
const tarihYaz = (g) => g.split("-").reverse().join(".");
const gunAd = (g) => GUNLER[(new Date(g + "T00:00:00Z").getUTCDay() + 6) % 7];

const MAVI = [0, 0.4, 0.64], GRI = [0.36, 0.42, 0.47], KIRMIZI = [0.7, 0.14, 0.09], TURUNCU = [0.94, 0.5, 0.1];

export function kasaPdf(k) {
  const o = k.ozet || kasaOzet(k);
  const b = k.birimler || {};
  const urunAd = (id) => b[id]?.ad || id;
  const pdf = new Pdf();
  const SOL = 36, SAG = pdf.genislik - 36, EN = SAG - SOL, ALT = pdf.yukseklik - 50;
  let y = 0;
  let sayfa = 1;

  const ust = () => {
    pdf.kutu(0, 0, pdf.genislik, 64, [0.02, 0.16, 0.27]);
    pdf.yazi(SOL, 30, "AYSU HALI SAHA", { boyut: 16, kalin: true, renk: [1, 1, 1] });
    pdf.yazi(SOL, 49, "Günlük kasa raporu", { boyut: 11, renk: [0.72, 0.83, 0.91] });
    pdf.yazi(SAG, 30, `${tarihYaz(k.gun)} ${gunAd(k.gun)}`, { boyut: 14, kalin: true, renk: [1, 1, 1], hiza: "sag" });
    pdf.yazi(SAG, 49, `Kaydeden: ${k.guncelleyen || "—"} · ${k.guncelleme || ""}`, { boyut: 9, renk: [0.72, 0.83, 0.91], hiza: "sag" });
    pdf.yazi(pdf.genislik / 2, pdf.yukseklik - 22, `Sayfa ${sayfa}`, { boyut: 8, renk: GRI, hiza: "orta" });
    y = 88;
  };
  const yer = (h) => { if (y + h > ALT) { pdf.yeniSayfa(); sayfa++; ust(); } };
  const baslik = (metin, sag = "") => {
    yer(40);
    y += 10;
    pdf.yazi(SOL, y, metin, { boyut: 13, kalin: true, renk: MAVI });
    if (sag) pdf.yazi(SAG, y, sag, { boyut: 11, kalin: true, renk: MAVI, hiza: "sag" });
    y += 6; pdf.cizgi(SOL, y, SAG, y, { kalinlik: 1.2, renk: MAVI }); y += 14;
  };
  const satir = (sol, sag, { kalin = false, renk, kucuk = false, alt = "" } = {}) => {
    yer(alt ? 28 : 17);
    const boyut = kucuk ? 9 : 10;
    pdf.yazi(SOL, y, sol, { boyut, kalin, renk, en: EN - 120 });
    pdf.yazi(SAG, y, sag, { boyut, kalin, renk, hiza: "sag" });
    if (alt) { y += 11; pdf.yazi(SOL + 8, y, alt, { boyut: 8, renk: GRI, en: EN - 8 }); }
    y += 6; pdf.cizgi(SOL, y, SAG, y, { kalinlik: 0.3 }); y += 11;
  };
  const urunListe = (o2) => Object.entries(o2 || {}).map(([id, a]) => `${urunAd(id)} ×${a}`).join(", ");

  ust();

  // ---- Maçlar ----
  baslik("Maçlar", para(o.ciro));
  const kol = [["Saat", 0, "sol"], ["Tür", 40, "sol"], ["İsim", 86, "sol"], ["Maç", 240, "sag"], ["VIP", 298, "sag"], ["Kramp.", 334, "sag"], ["Eldiv.", 372, "sag"], ["Kantin", 418, "sag"], ["Kapora", 466, "sag"], ["Kalan", EN, "sag"]];
  yer(20);
  pdf.kutu(SOL - 4, y - 11, EN + 8, 16, [0.93, 0.95, 0.97]);
  for (const [ad, x, h] of kol) pdf.yazi(SOL + x, y, ad, { boyut: 8.5, kalin: true, renk: GRI, hiza: h });
  y += 16;
  (k.maclar || []).forEach((m, i) => {
    const mo = o.maclar?.[i] || {};
    const detay = [
      m.kantin && Object.keys(m.kantin).length ? `Kantin: ${urunListe(m.kantin)}` : "",
      m.veresiyeKantin && Object.keys(m.veresiyeKantin).length ? `Veresiye${m.veresiyeKim ? " (" + m.veresiyeKim + ")" : ""}: ${urunListe(m.veresiyeKantin)} = ${para(mo.veresiye)}` : "",
      m.ikramKantin && Object.keys(m.ikramKantin).length ? `İkram: ${urunListe(m.ikramKantin)} = ${para(mo.ikram)}` : "",
            (m.ekstra || []).length ? `VIP: ${m.ekstra.map((x) => (x === "spiker" ? "spiker" : "hakem")).join(" + ")}` : "",
      m.depozito ? `Depozito: ${m.depozito}` : "",
    ].filter(Boolean).join(" · ");
    yer(detay ? 30 : 18);
    const kira = k.kira || { krampon: 0, eldiven: 0 };
    const deg = [m.saat, m.tur === "abone" ? "Abone" : m.tur === "bos" ? "Boş" : "Normal", m.ad, para(m.ucret), m.vip ? para(m.vip) : "—",
      m.krampon ? `${m.krampon}×` : "—", m.eldiven ? `${m.eldiven}×` : "—", mo.kantin ? para(mo.kantin) : "—", m.onOdeme ? "−" + para(m.onOdeme) : "—", para((mo.toplam || 0) - (m.onOdeme || 0) - (m.iban || 0))];
    kol.forEach(([, x, h], j) => pdf.yazi(SOL + x, y, deg[j], {
      boyut: 9.5, kalin: j === 0 || j === 9, hiza: h, en: j === 2 ? 110 : null,
      renk: j === 0 ? (m.tur === "abone" ? [0.11, 0.31, 0.85] : TURUNCU) : j === 8 && m.onOdeme ? KIRMIZI : undefined,
    }));
    void kira;
    if (detay) { y += 11; pdf.yazi(SOL + 40, y, detay, { boyut: 7.5, renk: GRI, en: EN - 40 }); }
    y += 6; pdf.cizgi(SOL, y, SAG, y, { kalinlik: 0.3 }); y += 12;
  });
  if (!(k.maclar || []).length) satir("Bu gün maç yok.", "", { renk: GRI });

  // ---- Kantin satış özeti ----
  const satis = {};
  for (const m of k.maclar || []) for (const [id, a] of Object.entries(m.kantin || {})) satis[id] = (satis[id] || 0) + a;
  if (Object.keys(satis).length) {
    baslik("Kantin satışları", para(o.kantin));
    for (const [id, a] of Object.entries(satis).sort((x, z) => z[1] - x[1])) {
      const bi = b[id] || {};
      satir(`${urunAd(id)}  ×${a}`, para(a * (bi.satis || 0)), { alt: `birim ${para(bi.satis)} · alış ${para(bi.alis)} · kâr ${para(a * ((bi.satis || 0) - (bi.alis || 0)))}` });
    }
  }

  // ---- Kaporalar / giriş / çıkış ----
  if ((k.gelenKaporalar || []).length) {
    baslik("Bugün gelen kaporalar (IBAN)", para(o.gelenKapora));
    for (const x of k.gelenKaporalar) satir(`${x.ad} — ${x.mac} maçı`, para(x.tutar), { alt: `${x.yol}${x.iptal ? " · iptal (iade yok)" : ""}` });
  }
  if ((k.girisler || []).length) { baslik("Diğer kasa girişi", para(o.giris)); for (const x of k.girisler) satir(x.aciklama || "—", para(x.tutar)); }
  if ((k.cikislar || []).length) { baslik("Kasa çıkışı", "−" + para(o.cikis)); for (const x of k.cikislar) satir(x.aciklama || "—", "−" + para(x.tutar), { renk: KIRMIZI }); }
  if ((k.veresiye || []).length) { baslik("Veresiye", "−" + para(o.veresiye)); for (const x of k.veresiye) satir(x.aciklama || "—", "−" + para(x.tutar)); }
  const ikram = Object.entries(k.ikram || {}).filter(([, v]) => Object.keys(v).length);
  if (ikram.length) {
    baslik("Personel kantini ve ücretsiz ikram", `personel ${para(o.personelKantin)} · ikram ${para(o.ikramDeger)}`);
    for (const [kim, v] of ikram) {
      const p = kim.startsWith("p:");
      satir(p ? `${k.ikramAdlari?.[kim] || kim.slice(2)} (%${Math.round(KURALLAR.personelIndirim * 100)} indirimli, ay sonu maaştan)` : kim,
        para(Object.entries(v).reduce((t, [id, a]) => t + a * (p ? personelFiyat(b[id]?.satis || 0) : b[id]?.satis || 0), 0)), { alt: urunListe(v) });
    }
  }

  // ---- Gün sonu ----
  baslik("Gün sonu");
  satir("Maç ücretleri", para(o.mac));
  if (o.vip) satir("VIP hizmet", para(o.vip));
  satir("Kantin", para(o.kantin));
  satir(`Krampon (${o.kramponAdet} adet)`, para(o.krampon));
  satir(`Eldiven (${o.eldivenAdet} adet)`, para(o.eldiven));
  satir("GÜNLÜK CİRO", para(o.ciro), { kalin: true, renk: MAVI });
  if (o.onOdeme) satir("Önceki günlerde alınan kaporalar (bugünkü maçlar)", "−" + para(o.onOdeme), { renk: KIRMIZI });
  satir("Bugün gelen kaporalar (IBAN, ileri tarihli maçlar)", para(o.gelenKapora));
  satir("Diğer kasa girişi", para(o.giris));
  satir("Kasa toplamı", para(o.kasaToplam), { kalin: true });
  satir("Kasa çıkışı", "−" + para(o.cikis), { renk: KIRMIZI });
  if (o.veresiye) satir("Veresiye", "−" + para(o.veresiye), { renk: KIRMIZI });
  if (o.avans) satir("Çalışan ödeme / avans", "−" + para(o.avans), { renk: KIRMIZI, alt: (k.avanslar || []).map((x) => `${x.ad} ${para(x.tutar)}`).join(" · ") });
  if (o.ibanOdeme) satir("IBAN'a ödenen (maç günü, kasaya nakit girmez)", "−" + para(o.ibanOdeme), { renk: KIRMIZI, alt: (k.maclar || []).filter((m) => m.iban).map((m) => `${m.saat} ${m.ad} ${para(m.iban)}`).join(" · ") });
  if (o.gelenKapora) satir("Gelen kaporalar IBAN'da (kasaya nakit girmez)", "−" + para(o.gelenKapora), { renk: KIRMIZI });
  satir("KASADA OLMASI GEREKEN", para(o.olmasiGereken), { kalin: true, renk: MAVI });
  if (k.sayilan !== null && k.sayilan !== undefined) {
    satir("Sayılan kasa", para(k.sayilan), { kalin: true });
    satir(o.fark === 0 ? "Fark" : o.fark > 0 ? "Fazla" : "Eksik", para(Math.abs(o.fark)), { kalin: true, renk: o.fark < 0 ? KIRMIZI : undefined });
  }
  if (k.birakilan !== null && k.birakilan !== undefined) {
    satir("Ertesi güne devir (kasada bırakılan)", para(k.birakilan));
    if (o.teslim !== null) satir("Teslim edilen", para(o.teslim));
  }
  satir("Kasa devir (toplama katılmaz)", para(o.devir), { renk: GRI });
  if (o.personelKantin) satir("Personel kantini (kasaya girmez, ay sonu maaştan)", para(o.personelKantin), { renk: GRI });
  if (o.ikramDeger) satir("İkram (ücretsiz, kasaya girmedi)", para(o.ikramDeger), { renk: GRI });
  if (o.veresiyeKantin) satir("Veresiye kantin (kasaya girmedi)", para(o.veresiyeKantin), { renk: GRI });
  satir("Kantin kârı (alış-satış farkı)", para(o.kantinKar), { renk: GRI });
  if (k.not) { baslik("Not"); satir(k.not, ""); }
  return pdf.bayt();
}
