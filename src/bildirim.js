// E-posta: yeni kayıt onayı, şifre sıfırlama, rezervasyon bildirimi.
//
// Gönderim yolu (hangisi tanımlıysa):
//   1) Gmail:  GMAIL_ADRES (ör. aysuhalisaha@gmail.com) + GMAIL_UYGULAMA_SIFRESI (Secret, 16 haneli uygulama şifresi)
//   2) Resend: RESEND_API_KEY (Secret) + GONDEREN_EPOSTA (doğrulanmış alan adından)
// Rezervasyon bildirimlerinin gideceği adres: BILDIRIM_EPOSTA (yoksa aysuhalisaha@gmail.com)
// Telegram (isteğe bağlı): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { smtpGonder } from "./smtp.js";

const VARSAYILAN_ALICI = "aysuhalisaha@gmail.com";
const VARSAYILAN_GONDEREN = "Aysu Halı Saha <onboarding@resend.dev>";

const kacis = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const epostaKurulu = (env) => Boolean((env.GMAIL_ADRES && env.GMAIL_UYGULAMA_SIFRESI) || env.RESEND_API_KEY);

/**
 * Herhangi bir alıcıya e-posta. E-posta kurulu değilse sessizce atlar (false döner).
 * dugme: { yazi, link } verilirse e-postada büyük bir düğme olarak gösterilir.
 */
export async function epostaYolla(env, { kime, konu, satirlar = [], alt = "", dugme = null }) {
  if (!epostaKurulu(env) || !kime?.length) return false;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13261b;max-width:560px">
    <h2 style="margin:0 0 12px;color:#0067a4">${kacis(konu)}</h2>
    <table style="border-collapse:collapse">${satirlar.map(([k, v]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#55645a;vertical-align:top">${kacis(k)}</td><td style="padding:4px 0"><b>${
        /^https:\/\//.test(String(v)) ? `<a href="${kacis(v)}">${kacis(v)}</a>` : kacis(v)}</b></td></tr>`).join("")}
    </table>
    ${dugme ? `<p style="margin:22px 0"><a href="${kacis(dugme.link)}" style="background:#0067a4;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">${kacis(dugme.yazi)}</a></p>
      <p style="color:#55645a;font-size:13px">Düğme çalışmazsa: ${kacis(dugme.link)}</p>` : ""}
    ${alt ? `<p style="margin-top:16px;color:#55645a;font-size:13px">${kacis(alt)}</p>` : ""}
  </div>`;
  const metin = `${konu}\n\n${satirlar.map(([k, v]) => `${k}: ${v}`).join("\n")}${dugme ? `\n\n${dugme.yazi}: ${dugme.link}` : ""}${alt ? "\n\n" + alt : ""}`;
  try {
    if (env.GMAIL_ADRES && env.GMAIL_UYGULAMA_SIFRESI) {
      await smtpGonder({
        kullanici: env.GMAIL_ADRES, sifre: String(env.GMAIL_UYGULAMA_SIFRESI).replace(/\s+/g, ""),
        kimden: env.GMAIL_ADRES, kimdenAd: "Aysu Halı Saha", kime, konu, html, metin, baglan: env.__smtpBaglan,
      });
      return true;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.GONDEREN_EPOSTA || VARSAYILAN_GONDEREN, to: kime, subject: konu, html, text: metin }),
    });
    if (!res.ok) { console.error("E-posta gönderilemedi", res.status, await res.text()); return false; }
    return true;
  } catch (e) {
    console.error("E-posta hatası", e);
    return false;
  }
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
 * İşletmeye bildirim (yeni rezervasyon, iptal).
 * @param {object} env
 * @param {{konu: string, satirlar: [string, string][]}} bildirim
 */
export async function bildir(env, bildirim) {
  const metin = `${bildirim.konu}\n${bildirim.satirlar.map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  const sonuclar = await Promise.allSettled([
    epostaYolla(env, { kime: [env.BILDIRIM_EPOSTA || VARSAYILAN_ALICI], ...bildirim, alt: "Ayrıntılar yönetim panelinde: /panel" }),
    telegramGonder(env, metin),
  ]);
  for (const s of sonuclar) if (s.status === "rejected") console.error("Bildirim hatası", s.reason);
}
