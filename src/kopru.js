// Google Apps Script köprüsü (apps-script/Kod.gs) ile konuşur.
// Gerekli değerler: SCRIPT_URL (web uygulaması adresi), SCRIPT_ANAHTAR (secret)

const SUTUN_NO = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10 };

export const kopruAktif = (env) => Boolean(env.SCRIPT_URL && env.SCRIPT_ANAHTAR);

async function cagir(env, govde) {
  const res = await fetch(env.SCRIPT_URL, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ anahtar: env.SCRIPT_ANAHTAR, ...govde }),
    redirect: "follow",
  });
  const metin = await res.text();
  let veri;
  try {
    veri = JSON.parse(metin);
  } catch {
    throw new Error(`Tablo köprüsü cevabı okunamadı (${res.status}): ${metin.slice(0, 200)}`);
  }
  if (veri.hata) throw new Error(`Tablo köprüsü: ${veri.hata}`);
  return veri;
}

/** Dönüş biçimi sheets.oku ile aynı: { haftalik: {metin, renk}[][], online: [{hucreler, satirNo}] } */
export async function oku(env) {
  const v = await cagir(env, { islem: "oku" });
  const online = v.online || [];
  return {
    haftalik: v.haftalik || [],
    online: online.slice(1).map((hucreler, i) => ({ hucreler, satirNo: i + 2 })),
  };
}

export const satirEkle = (env, hucreler) => cagir(env, { islem: "ekle", satir: hucreler });

export const hucreGuncelle = (env, satirNo, sutunHarfi, deger) =>
  cagir(env, { islem: "guncelle", satirNo, sutun: SUTUN_NO[sutunHarfi], deger });

export const eposta = (env, { konu, metin, html, alici }) =>
  cagir(env, { islem: "eposta", konu, metin, html, alici: alici || env.BILDIRIM_EPOSTA });
