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
  { model: "@cf/google/gemma-3-12b-it", bicim: "openai" },
  { model: "@cf/meta/llama-3.2-11b-vision-instruct", bicim: "bayt", onay: true },
];
const DENEME_SURESI = 15_000; // model başına en fazla 15 sn
const TOPLAM_SURE = 35_000;   // müşteri en fazla ~35 sn bekler
const zamanAsimi = (p, ms) => Promise.race([p, new Promise((_, red) => setTimeout(() => red(new Error("zaman aşımı")), ms))]);

const TALIMAT = `Bu bir Türk bankası havale/EFT/FAST dekontu. SADECE şu JSON'u döndür, başka hiçbir şey yazma:
{"alici_iban": "...", "alici_ad": "...", "tutar": 0, "tarih": "YYYY-AA-GG", "aciklama": "...", "gonderen": "...", "tum_metin": "..."}
- alici_iban: paranın GÖNDERİLDİĞİ (alıcı) IBAN, boşluksuz. Gönderen IBAN'ı değil.
- alici_ad: alıcı adı soyadı / unvanı.
- tutar: gönderilen tutar, TL, sayı olarak (ör. 1.200,00 TL → 1200).
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

/** Dekontu okur. Dönen: { alici_iban, alici_ad, tutar, tarih, aciklama, gonderen } ya da { hata } */
export async function dekontOku(env, { tur, veri }) {
  if (!env.AI) return { hata: "Otomatik kontrol kapalı (Workers AI bağlı değil)." };
  try {
    if (tur === "application/pdf") {
      // PDF → metin → alanlar
      const [md] = await env.AI.toMarkdown([{ name: "dekont.pdf", blob: new Blob([veri], { type: tur }) }]);
      const metin = String(md?.data || "").slice(0, 12000);
      if (!metin.trim()) return { hata: "PDF'ten yazı okunamadı." };
      // Önce düz metinde IBAN ara (model hatasına karşı yedek)
      const y = await env.AI.run(METIN_MODELI, { messages: [{ role: "system", content: TALIMAT }, { role: "user", content: metin }], max_tokens: 400 });
      const j = jsonAl(y) || {};
      return { ...j, _metin: metin };
    }
    const resim = `data:${tur};base64,${b64(veri)}`;
    const hatalar = [];
    const basla = Date.now();
    for (const d of GORSEL_DENEMELER) {
      const kalan = TOPLAM_SURE - (Date.now() - basla);
      if (kalan < 3000) { hatalar.push("süre doldu"); break; }
      try {
        let girdi;
        if (d.bicim === "openai") {
          girdi = { messages: [{ role: "user", content: [{ type: "text", text: TALIMAT }, { type: "image_url", image_url: { url: resim } }] }], max_tokens: 900 };
        } else {
          if (d.onay) await zamanAsimi(env.AI.run(d.model, { prompt: "agree" }), 5000).catch(() => {}); // Meta lisans onayı (ilk kullanım)
          girdi = { messages: [{ role: "user", content: TALIMAT }], image: Array.from(veri), max_tokens: 900 };
        }
        const y = await zamanAsimi(env.AI.run(d.model, girdi), Math.min(DENEME_SURESI, kalan));
        const j = jsonAl(y);
        if (j) return { ...j, _model: d.model, _metin: j.tum_metin || "" };
        hatalar.push(`${d.model.split("/").pop()}: JSON yok (${String(y?.response ?? "").slice(0, 80)})`);
      } catch (e) {
        hatalar.push(`${d.model.split("/").pop()}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    return { hata: "Dekont okunamadı — " + hatalar.join(" | ") };
  } catch (e) {
    return { hata: "Dekont okunamadı: " + String(e?.message || e) };
  }
}

const oncekiGun = (t) => { const d = new Date(t + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const harfler = (s) => String(s || "").toLocaleUpperCase("tr")
  .replace(/İ/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C").replace(/I/g, "I")
  .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ibanTemiz = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

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
export function dekontDegerlendir(okunan, { iban, alici, kapora, rezTarihi, bugun }) {
  const nedenler = [];
  if (!okunan || okunan.hata) return { onay: false, nedenler: [okunan?.hata || "Dekont okunamadı."], tutar: null, okunan };
  // IBAN: modelin okuduğu ya da PDF metninde geçen
  const beklenen = ibanTemiz(iban);
  const okunanIban = ibanTemiz(okunan.alici_iban);
  const metin = ibanTemiz(okunan._metin || okunan.tum_metin || "");
  const metindeVar = metin.includes(beklenen) || metin.includes(beklenen.slice(4)); // "TR70" bazen ayrı yazılır
  if (!(okunanIban === beklenen || metindeVar)) nedenler.push(`IBAN eşleşmiyor (${okunan.alici_iban || "okunamadı"}).`);
  // Alıcı adı: tüm kelimeler geçmeli (ör. AHMET + AYSU)
  const ad = harfler(okunan.alici_ad);
  const kelimeler = harfler(alici).split(" ").filter((k) => k.length > 1);
  const tumMetin = harfler(okunan._metin || okunan.tum_metin || "");
  if (!kelimeler.every((k) => ad.includes(k) || tumMetin.includes(k))) nedenler.push(`Hesap adı eşleşmiyor (${okunan.alici_ad || "okunamadı"}).`);
  // Tutar onayı engellemez (kimi maçın tamamını, kimi 500 TL öder); kaporadan azsa yöneticiye bilgi gider
  const tutar = tutarSayi(okunan.tutar);
  const eksik = tutar == null || tutar < kapora;
  const tarih = tarihNorm(okunan.tarih);
  if (!tarih) nedenler.push("Dekont tarihi okunamadı.");
  else if (rezTarihi && tarih < oncekiGun(rezTarihi)) nedenler.push(`Dekont tarihi (${tarih}) rezervasyondan önce.`);
  else if (bugun && tarih > bugun) nedenler.push(`Dekont tarihi (${tarih}) ileri bir tarih.`);
  return { onay: nedenler.length === 0, nedenler, tutar, eksik, okunan };
}

export async function ozet(veri) {
  const h = await crypto.subtle.digest("SHA-256", veri);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
