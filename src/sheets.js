// Google E-Tablolar bağlantısı (servis hesabı ile, ek kütüphane olmadan).
// Gerekli gizli değerler: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID

import { HAFTALIK_SEKME, ONLINE_SEKME, SUTUNLAR } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

let tokenCache = { token: null, exp: 0 };
let sekmeHazir = false;

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(pem) {
  const clean = pem.replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
}

async function erisimAnahtari(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
  }));
  const key = await importKey(env.GOOGLE_PRIVATE_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google giriş hatası: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function api(env, path, init = {}) {
  const token = await erisimAnahtari(env);
  const res = await fetch(`${API}/${env.SHEET_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Google E-Tablo hatası: ${res.status} ${await res.text()}`);
  return res.json();
}

const aralik = (sekme, a1) => encodeURIComponent(`'${sekme}'!${a1}`);

/** "Online Rezervasyonlar" sekmesi yoksa oluşturur ve başlıkları yazar. */
async function onlineSekmeHazirla(env) {
  if (sekmeHazir) return;
  const meta = await api(env, "?fields=sheets.properties.title");
  const var_mi = meta.sheets.some((s) => s.properties.title === ONLINE_SEKME);
  if (!var_mi) {
    await api(env, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: ONLINE_SEKME } } }] }),
    });
    await api(env, `/values/${aralik(ONLINE_SEKME, "A1:J1")}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [SUTUNLAR] }),
    });
  }
  sekmeHazir = true;
}

// Haftalık tablo için metinle birlikte YAZI RENGİ de okunur
// (siyah "ABONE" = abone bu hafta gelmiyor).
const HAFTALIK_ALANLAR = "sheets(data(rowData(values(formattedValue,"
  + "effectiveFormat/textFormat/foregroundColor,effectiveFormat/textFormat/foregroundColorStyle,"
  + "textFormatRuns(format/foregroundColor,format/foregroundColorStyle)))))";

function yaziRengi(hucre) {
  const run = hucre.textFormatRuns?.[0]?.format;
  const tf = hucre.effectiveFormat?.textFormat || {};
  const stil = run?.foregroundColorStyle || run?.foregroundColor
    ? { rgbColor: run.foregroundColorStyle?.rgbColor || run.foregroundColor, themeColor: run.foregroundColorStyle?.themeColor }
    : { rgbColor: tf.foregroundColorStyle?.rgbColor || tf.foregroundColor, themeColor: tf.foregroundColorStyle?.themeColor };
  return stil;
}

/**
 * Haftalık tabloyu (metin + yazı rengi) ve online rezervasyonları okur.
 * Dönüş: { haftalik: {metin, renk}[][], online: [{hucreler, satirNo}] }
 */
export async function oku(env) {
  await onlineSekmeHazirla(env);
  const [izgara, onlineVeri] = await Promise.all([
    api(env, `?ranges=${aralik(HAFTALIK_SEKME, "A1:L30")}&fields=${encodeURIComponent(HAFTALIK_ALANLAR)}`),
    api(env, `/values/${aralik(ONLINE_SEKME, "A1:J")}?valueRenderOption=FORMATTED_VALUE`),
  ]);
  const satirlar = izgara.sheets?.[0]?.data?.[0]?.rowData || [];
  const haftalik = satirlar.map((r) => (r.values || []).map((h) => ({
    metin: h.formattedValue || "",
    renk: yaziRengi(h),
  })));
  const online = onlineVeri.values || [];
  return {
    haftalik,
    online: online.slice(1).map((hucreler, i) => ({ hucreler, satirNo: i + 2 })),
  };
}

export async function satirEkle(env, hucreler) {
  await onlineSekmeHazirla(env);
  await api(env, `/values/${aralik(ONLINE_SEKME, "A1:J")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [hucreler] }),
  });
}

export async function hucreGuncelle(env, satirNo, sutunHarfi, deger) {
  await api(env, `/values/${aralik(ONLINE_SEKME, `${sutunHarfi}${satirNo}`)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: [[deger]] }),
  });
}
