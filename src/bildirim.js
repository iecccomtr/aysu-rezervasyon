// İşletmeye bildirim: yeni rezervasyon ve iptallerde e-posta (ve isteğe bağlı Telegram).
//
// E-posta, Apps Script köprüsü kuruluysa (SCRIPT_URL) tablonun sahibinin Gmail'inden gönderilir.
// Köprü yoksa Resend (resend.com, ücretsiz plan) kullanılır:
//   RESEND_API_KEY   → Resend'den alınan anahtar (secret)
//   BILDIRIM_EPOSTA  → bildirimlerin gideceği adres (yoksa aysuhalisaha@gmail.com)
//   GONDEREN_EPOSTA  → kendi alan adınız Resend'de doğrulanınca ör. "Aysu Halı Saha <rezervasyon@aysuhalisaha.com>"
//                      (yoksa Resend'in deneme adresi kullanılır; bu adres SADECE Resend hesabını
//                       açtığınız e-postaya gönderebilir)
//
// Telegram (isteğe bağlı): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import * as kopru from "./kopru.js";

const VARSAYILAN_ALICI = "aysuhalisaha@gmail.com";
const VARSAYILAN_GONDEREN = "Aysu Halı Saha <onboarding@resend.dev>";

const kacis = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function epostaGonder(env, { konu, satirlar }) {
  if (!env.RESEND_API_KEY && !kopru.kopruAktif(env)) return;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13261b">
    <h2 style="margin:0 0 12px;color:#14532d">${kacis(konu)}</h2>
    <table style="border-collapse:collapse">${satirlar.map(([k, v]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#55645a">${kacis(k)}</td><td style="padding:4px 0"><b>${kacis(v)}</b></td></tr>`).join("")}
    </table>
    <p style="margin-top:16px;color:#55645a;font-size:13px">Kayıt, Google E-Tablo'daki "Online Rezervasyonlar" sekmesine yazıldı.</p>
  </div>`;
  const metin = `${konu}\n\n${satirlar.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  if (kopru.kopruAktif(env)) {
    await kopru.eposta(env, { konu, metin, html, alici: env.BILDIRIM_EPOSTA || VARSAYILAN_ALICI });
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.GONDEREN_EPOSTA || VARSAYILAN_GONDEREN,
      to: [env.BILDIRIM_EPOSTA || VARSAYILAN_ALICI],
      subject: konu,
      html, text: metin,
    }),
  });
  if (!res.ok) console.error("E-posta gönderilemedi", res.status, await res.text());
}

async function telegramGonder(env, metin) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: metin }),
  });
}

/**
 * @param {object} env
 * @param {{konu: string, satirlar: [string, string][]}} bildirim
 */
export async function bildir(env, bildirim) {
  const metin = `${bildirim.konu}\n${bildirim.satirlar.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  const sonuclar = await Promise.allSettled([epostaGonder(env, bildirim), telegramGonder(env, metin)]);
  for (const s of sonuclar) if (s.status === "rejected") console.error("Bildirim hatası", s.reason);
}
