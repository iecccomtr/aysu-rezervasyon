// Dekont otomatik kontrolü (Cloudflare Workers AI).
//
// Müşterinin yüklediği dekonttan (fotoğraf ya da PDF) alıcı IBAN'ı, alıcı adı, tutar ve tarih okunur.
// Hepsi doğruysa rezervasyon kendiliğinden "Onaylı" olur; bir şey eksik/şüpheliyse "Kapora bekleniyor"
// kalır ve panelde neden yazılır. Sahte dekont ihtimaline karşı:
//   - aynı dosya ikinci bir rezervasyon için kullanılamaz (dosya özeti saklanır),
//   - dekont tarihi rezervasyondan eski olamaz,
//   - tutar kaporadan az ise otomatik onay yok.
// Yine de banka hesabını gün sonunda kontrol etmek önerilir.

const METIN_MODELI = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GORSEL_MODELLER = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct"];

const TALIMAT = `Bu bir Türk bankası havale/EFT/FAST dekontu. SADECE şu JSON'u döndür, başka hiçbir şey yazma:
{"alici_iban": "...", "alici_ad": "...", "tutar": 0, "tarih": "YYYY-AA-GG", "aciklama": "...", "gonderen": "..."}
- alici_iban: paranın GÖNDERİLDİĞİ (alıcı) IBAN, boşluksuz. Gönderen IBAN'ı değil.
- alici_ad: alıcı adı soyadı / unvanı.
- tutar: gönderilen tutar, TL, sayı olarak (ör. 1.200,00 TL → 1200).
- tarih: işlem tarihi. Bulamadığın alan için null yaz.`;

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
    let sonHata;
    for (const model of GORSEL_MODELLER) {
      try {
        const y = await env.AI.run(model, {
          messages: [{ role: "user", content: [{ type: "text", text: TALIMAT }, { type: "image_url", image_url: { url: resim } }] }],
          max_tokens: 400,
        });
        const j = jsonAl(y);
        if (j) return j;
        sonHata = "Modelden JSON alınamadı";
      } catch (e) {
        sonHata = String(e?.message || e);
      }
    }
    return { hata: "Dekont okunamadı: " + sonHata };
  } catch (e) {
    return { hata: "Dekont okunamadı: " + String(e?.message || e) };
  }
}

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
  const metindeVar = okunan._metin && ibanTemiz(okunan._metin).includes(beklenen);
  if (!(okunanIban === beklenen || metindeVar)) nedenler.push(`IBAN eşleşmiyor (${okunan.alici_iban || "okunamadı"}).`);
  // Alıcı adı: tüm kelimeler geçmeli (ör. AHMET + AYSU)
  const ad = harfler(okunan.alici_ad);
  const kelimeler = harfler(alici).split(" ").filter((k) => k.length > 1);
  if (!kelimeler.every((k) => ad.includes(k))) nedenler.push(`Hesap adı eşleşmiyor (${okunan.alici_ad || "okunamadı"}).`);
  const tutar = tutarSayi(okunan.tutar);
  if (tutar == null) nedenler.push("Tutar okunamadı.");
  else if (tutar < kapora) nedenler.push(`Tutar kaporadan az: ${tutar} TL (kapora ${kapora} TL).`);
  const tarih = tarihNorm(okunan.tarih);
  if (!tarih) nedenler.push("Dekont tarihi okunamadı.");
  else if (rezTarihi && tarih < rezTarihi) nedenler.push(`Dekont tarihi (${tarih}) rezervasyondan önce.`);
  else if (bugun && tarih > bugun) nedenler.push(`Dekont tarihi (${tarih}) ileri bir tarih.`);
  return { onay: nedenler.length === 0, nedenler, tutar, okunan };
}

export async function ozet(veri) {
  const h = await crypto.subtle.digest("SHA-256", veri);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
