// Dekont otomatik kontrolü (Cloudflare Workers AI).
//
// Müşterinin yüklediği dekonttan (fotoğraf ya da PDF) alıcı IBAN'ı, alıcı adı, tutar ve tarih okunur.
// Hepsi doğruysa rezervasyon kendiliğinden "Onaylı" olur; bir şey eksik/şüpheliyse "Kapora bekleniyor"
// kalır ve panelde neden yazılır. Sahte dekont ihtimaline karşı:
//   - aynı dosya ikinci bir rezervasyon için kullanılamaz (dosya özeti saklanır),
//   - dekont tarihi rezervasyondan eski olamaz,
//   - tutar kaporadan azsa yine onaylanır ama Müdür / Müdür Yardımcısı'na e-posta gider.
// Yine de banka hesabını gün sonunda kontrol etmek önerilir.

const METIN_MODELI = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Sırayla denenir; biri hata verirse sonraki. (Modellerin görsel giriş biçimleri farklı.)
const GORSEL_DENEMELER = [
  { model: "@cf/meta/llama-4-scout-17b-16e-instruct", bicim: "openai" },
  { model: "@cf/mistralai/mistral-small-3.1-24b-instruct", bicim: "openai" },
  { model: "@cf/meta/llama-3.2-11b-vision-instruct", bicim: "prompt", onay: true },
];
const TOPLAM_SURE = 40_000;   // modeller AYNI ANDA çalışır; müşteri en fazla ~40 sn bekler
const zamanAsimi = (p, ms) => Promise.race([p, new Promise((_, red) => setTimeout(() => red(new Error("zaman aşımı")), ms))]);

const TALIMAT = `Bu bir Türk bankası havale/EFT/FAST dekontu. SADECE şu JSON'u döndür, başka hiçbir şey yazma:
{"alici_iban": "...", "alici_ad": "...", "tutar": 0, "tarih": "YYYY-AA-GG", "aciklama": "...", "gonderen": "...", "tum_metin": "..."}
- alici_iban: paranın GÖNDERİLDİĞİ (alıcı) IBAN, boşluksuz. Gönderen IBAN'ı değil.
- alici_ad: alıcı adı soyadı / unvanı.
- tutar: GÖNDERİLEN işlem tutarı (İşlem Tutarı / Tutar / Gönderilen Tutar), sayı olarak (ör. 1.200,00 TL → 1200). Bakiye, masraf ya da komisyon değil.
- tarih: işlem tarihi.
- tum_metin: dekonttaki bütün yazıları olduğu gibi tek satırda yaz.
Bulamadığın alan için null yaz.`;

const b64 = (veri) => {
  let s = "";
  for (let i = 0; i < veri.length; i += 0x8000) s += String.fromCharCode(...veri.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Model yanıtından ilk JSON nesnesini çıkarır. */
function jsonAl(yanit) {
  if (yanit && typeof yanit.response === "object" && yanit.response) return yanit.response;
  const metin = typeof yanit === "string" ? yanit : String(yanit?.response ?? "");
  const m = metin.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** İki okumayı birleştirir: ilk bulunan alanlar + bütün metinler (bir model IBAN'ı, öbürü adı okuyabilir) */
function birlestir(a, b) {
  if (!a) return b;
  return {
    alici_iban: a.alici_iban || b.alici_iban || null, alici_ad: a.alici_ad || b.alici_ad || null,
    tutar: a.tutar ?? b.tutar ?? null, tarih: a.tarih || b.tarih || null, aciklama: a.aciklama || b.aciklama || null,
    gonderen: a.gonderen || b.gonderen || null,
    _metin: [a._metin, b._metin, b.alici_iban, b.alici_ad].filter(Boolean).join(" | "),
    _model: [a._model, b._model].filter(Boolean).join(" + "),
  };
}

/**
 * Dekontu okur. Dönen: { alici_iban, alici_ad, tutar, tarih, aciklama, gonderen, _metin } ya da { hata }
 * yeterli(okunan): okuma kontrolü geçiyorsa true — geçmiyorsa sıradaki model de denenir ve sonuçlar birleştirilir.
 */
export async function dekontOku(env, { tur, veri }, { yeterli = () => true } = {}) {
  if (!env.AI) return { hata: "Otomatik kontrol kapalı (Workers AI bağlı değil)." };
  try {
    if (tur === "application/pdf") {
      // PDF → metin → alanlar
      const [md] = await zamanAsimi(env.AI.toMarkdown([{ name: "dekont.pdf", blob: new Blob([veri], { type: tur }) }]), 15_000);
      const metin = String(md?.data || "").slice(0, 12000);
      if (!metin.trim()) return { hata: "PDF'ten yazı okunamadı (taranmış PDF olabilir). Ekran görüntüsünü JPG olarak yükleyin." };
      // Model alanları çıkaramasa bile IBAN / hesap adı / tarih düz metinde aranır
      let j = {};
      try {
        j = jsonAl(await zamanAsimi(env.AI.run(METIN_MODELI, { messages: [{ role: "system", content: TALIMAT }, { role: "user", content: metin }], max_tokens: 400 }), 15_000)) || {};
      } catch { /* düz metin yedeği yeter */ }
      return { ...j, ...metindenAlanlar(metin, j), _metin: metin, _model: j.alici_iban ? "pdf" : "pdf-metin" };
    }
    const resim = `data:${tur};base64,${b64(veri)}`;
    const hatalar = [];
    let sonuc = null;
    // Bütün modeller aynı anda denenir (biri yavaşsa / hesapta kapalıysa diğeri yetişir); okumalar birleştirilir
    const gorev = async (d) => {
      let girdi;
      if (d.bicim === "openai") {
        girdi = { messages: [{ role: "user", content: [{ type: "text", text: TALIMAT }, { type: "image_url", image_url: { url: resim } }] }], max_tokens: 900 };
      } else {
        if (d.onay) await zamanAsimi(env.AI.run(d.model, { prompt: "agree" }), 5000).catch(() => {}); // Meta lisans onayı (ilk kullanım)
        girdi = { prompt: TALIMAT, image: Array.from(veri), max_tokens: 900 };
      }
      const y = await env.AI.run(d.model, girdi);
      const j = jsonAl(y);
      const hamMetin = typeof y?.response === "string" ? y.response : (typeof y?.description === "string" ? y.description : "");
      if (!j && !hamMetin) throw new Error("boş yanıt");
      return { ...(j || {}), _model: d.model.split("/").pop(), _metin: [j?.tum_metin, hamMetin].filter(Boolean).join(" ") };
    };
    const isler = GORSEL_DENEMELER.map((d) => ({ ad: d.model.split("/").pop(), p: gorev(d) }));
    // Yedek: Cloudflare'in görselden metin çıkarma aracı
    isler.push({ ad: "toMarkdown", p: (async () => {
      const [md] = await env.AI.toMarkdown([{ name: "dekont.jpg", blob: new Blob([veri], { type: tur }) }]);
      const metin = String(md?.data || "");
      if (!metin.trim()) throw new Error("metin yok");
      return { _model: "toMarkdown", _metin: metin };
    })() });
    let bekleyen = isler.map((x, i) => ({ i, p: x.p.then((r) => ({ i, r }), (e) => ({ i, e })) }));
    const bitis = Date.now() + TOPLAM_SURE;
    while (bekleyen.length) {
      const kalan = bitis - Date.now();
      if (kalan <= 0) { hatalar.push(...bekleyen.map((x) => `${isler[x.i].ad}: zaman aşımı`)); break; }
      const sonucu = await Promise.race([...bekleyen.map((x) => x.p), new Promise((ok) => setTimeout(() => ok(null), kalan))]);
      if (!sonucu) continue;
      bekleyen = bekleyen.filter((x) => x.i !== sonucu.i);
      if (sonucu.e) { hatalar.push(`${isler[sonucu.i].ad}: ${String(sonucu.e?.message || sonucu.e).slice(0, 100)}`); continue; }
      sonuc = birlestir(sonuc, { ...sonucu.r, ...metindenAlanlar(sonucu.r._metin, sonucu.r) });
      if (yeterli(sonuc)) return sonuc;
    }
    if (sonuc) return sonuc; // kısmi okuma: değerlendirme hangi alanın tutmadığını yazar
    return { hata: "Dekont okunamadı — " + hatalar.join(" | ") };
  } catch (e) {
    return { hata: "Dekont okunamadı: " + String(e?.message || e) };
  }
}

/** Model alan çıkaramazsa PDF metninden IBAN, hesap adı, tutar ve tarihi düz arama ile bulur. */
function metindenAlanlar(metin, j) {
  const t = String(metin);
  const ibanlar = [...t.toUpperCase().matchAll(/TR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}/g)].map((m) => m[0].replace(/\s/g, ""));
  // Hesap adı: "Alıcı" / "Alıcı Adı" etiketinden sonraki satır parçası
  const adM = t.match(/al[ıi]c[ıi](?:\s*(?:ad[ıi](?:\s*soyad[ıi])?|unvan[ıi]|hesap ad[ıi]))?\s*[:\-]?\s*([A-ZÇĞİÖŞÜa-zçğıöşü .]{3,60})/i);
  const tutarM = tutarBul(t);
  return {
    alici_iban: j.alici_iban || (ibanlar.length ? ibanlar.at(-1) : null),
    alici_ad: j.alici_ad || (adM ? adM[1].trim() : null),
    tutar: tutarSayi(j.tutar) || tutarM || null,
    tarih: j.tarih || metindenTarih(t),
  };
}

/**
 * Metindeki gönderilen tutar. Türk bankası dekontlarında: "İşlem Tutarı: 1.200,00 TL", "Tutar 1.200 TL",
 * "TL 1.200,00", "₺1.200", "1200.00 TRY". Bakiye / masraf / komisyon tutarları atlanır.
 */
const SAYI = String.raw`(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
export function tutarBul(metin) {
  const t = String(metin || "").replace(/\u00a0/g, " ");
  const uygun = (v) => { const n = tutarSayi(v); return n != null && n >= 50 && n <= 100000 ? n : null; };
  const kotu = /bakiye|masraf|komisyon|ücret|ucret|bsmv|vergi|limit/i;
  // 1) Anahtar kelimeden sonra gelen ilk tutar
  for (const m of t.matchAll(new RegExp(String.raw`(?:i[şs]lem\s*tutar[ıi]|g[öo]nderilen\s*tutar|havale\s*tutar[ıi]|eft\s*tutar[ıi]|fast\s*tutar[ıi]|tutar|miktar|amount)[^\d\n]{0,25}` + SAYI, "gi"))) {
    const once = t.slice(Math.max(0, m.index - 20), m.index);
    if (kotu.test(once) || kotu.test(m[0])) continue;
    const n = uygun(m[1]); if (n) return n;
  }
  // 2) Para birimiyle yan yana yazılan tutarlar (bakiye / masraf olmayan ilk uygun)
  for (const re of [new RegExp(SAYI + String.raw`\s*(?:TL|TRY|₺)`, "gi"), new RegExp(String.raw`(?:TL|TRY|₺)\s*` + SAYI, "gi")]) {
    for (const m of t.matchAll(re)) {
      if (kotu.test(t.slice(Math.max(0, m.index - 25), m.index))) continue;
      const n = uygun(m[1]); if (n) return n;
    }
  }
  return null;
}

/** Metindeki ilk tarih: 21.10.2026, 21/10/2026 ya da 2026-10-21 */
function metindenTarih(metin) {
  const m = String(metin).match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/) || String(metin).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!m) return null;
  return m[3].length === 4 ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : `${m[1]}-${m[2]}-${m[3]}`;
}
const oncekiGun = (t) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const harfler = (s) => String(s || "").toLocaleUpperCase("tr")
  .replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C").replace(/I/g, "I")
  .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ibanTemiz = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Levenshtein mesafesi (küçük metinler için) */
function duzeltmeMesafesi(a, b) {
  a = String(a); b = String(b);
  if (Math.abs(a.length - b.length) > 3) return 99;
  let onceki = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const su = [i];
    for (let j = 1; j <= b.length; j++) su[j] = Math.min(onceki[j] + 1, su[j - 1] + 1, onceki[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    onceki = su;
  }
  return onceki[b.length];
}

function tutarSayi(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.200,00" → 1200 ; "1200.00" → 1200 ; "1,200.00" → 1200
  const son = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const ondalik = son >= 0 && s.length - son - 1 === 2;
  const tam = ondalik ? s.slice(0, son) : s;
  const n = Number(tam.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function tarihNorm(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * Okunan dekontu kurallara göre değerlendirir.
 * @returns {{ onay: boolean, nedenler: string[], tutar: number|null, okunan: object }}
 */
export function dekontDegerlendir(okunan, { iban, alici, kapora, rezTarihi, bugun, tarihKontrol = true, enAzTutar = 0 }) {
  const nedenler = [];
  if (!okunan || okunan.hata) return { onay: false, nedenler: [okunan?.hata || "Dekont okunamadı."], tutar: null, okunan };
  // IBAN: modelin okuduğu ya da PDF metninde geçen
  const beklenen = ibanTemiz(iban);
  const okunanIban = ibanTemiz(okunan.alici_iban);
  const metin = ibanTemiz(okunan._metin || okunan.tum_metin || "");
  const metindeVar = metin.includes(beklenen) || metin.includes(beklenen.slice(4)) // "TR70" bazen ayrı yazılır
    || metin.includes(beklenen.slice(-10)); // hesap numarası kısmı (son 10 hane) yeterince ayırt edici
  // Görsel okumada 1–2 rakam yanlış okunabilir: okunan IBAN en fazla 2 karakter farklıysa kabul
  const yakin = okunanIban.length >= 24 && duzeltmeMesafesi(okunanIban, beklenen) <= 2;
  if (!(okunanIban === beklenen || metindeVar || yakin)) nedenler.push(`IBAN eşleşmiyor (${okunan.alici_iban || "okunamadı"}).`);
  // Alıcı adı: tüm kelimeler geçmeli (ör. AHMET + AYSU)
  const ad = harfler(okunan.alici_ad);
  const kelimeler = harfler(alici).split(" ").filter((k) => k.length > 1);
  const tumMetin = harfler(okunan._metin || okunan.tum_metin || "");
  // Her kelime adda ya da metinde geçmeli; 4+ harfli kelimelerde 1 harf okuma hatası kabul (AYSU ~ AYSO)
  const sozcukler = `${ad} ${tumMetin}`.split(" ");
  const geciyor = (k) => ad.includes(k) || tumMetin.includes(k) || (k.length >= 4 && sozcukler.some((w) => Math.abs(w.length - k.length) <= 1 && duzeltmeMesafesi(w, k) <= 1));
  if (!kelimeler.every(geciyor)) nedenler.push(`Hesap adı eşleşmiyor (${okunan.alici_ad || "okunamadı"}).`);
  // Tutar onayı engellemez (kimi maçın tamamını, kimi 500 TL öder); kaporadan azsa yöneticiye bilgi gider
  const tutar = tutarSayi(okunan.tutar);
  const eksik = tutar == null || tutar < kapora;
  // En az tutar (ör. 500 TL): altındaki ödeme kapora sayılmaz; tutar okunamazsa onay verilmez
  if (enAzTutar) {
    if (tutar == null) { /* okunamadıysa onay verilir; Müdür / Müdür Yardımcısı'na kontrol e-postası gider */ }
    else if (tutar < enAzTutar) nedenler.push(`Ödenen tutar (${tutar} TL) en az ${enAzTutar} TL olmalı.`);
  }
  const tarih = tarihNorm(okunan.tarih);
  if (!tarihKontrol) { /* tarih kontrolü kapalı (config.js → KURALLAR.dekontTarihKontrol) */ }
  else if (!tarih) { /* tarih okunamadıysa engellemez (okuma hatası); okunduysa eski / ileri tarih kontrol edilir */ }
  else if (rezTarihi && tarih < oncekiGun(rezTarihi)) nedenler.push(`Dekont tarihi (${tarih}) rezervasyondan önce.`);
  else if (bugun && tarih > bugun) nedenler.push(`Dekont tarihi (${tarih}) ileri bir tarih.`);
  return { onay: nedenler.length === 0, nedenler, tutar, eksik, tutarOkunamadi: tutar == null, okunan };
}

export async function ozet(veri) {
  const h = await crypto.subtle.digest("SHA-256", veri);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
