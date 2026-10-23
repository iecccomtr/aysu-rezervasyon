// E-posta: yeni kayıt onayı, şifre sıfırlama, rezervasyon bildirimi.
//
// Gönderim yolu (hangisi tanımlıysa):
//   1) Gmail:  GMAIL_ADRES (halisahaaysu@gmail.com) + GMAIL_UYGULAMA_SIFRESI (Secret, 16 haneli uygulama şifresi)
//   2) Resend: RESEND_API_KEY (Secret) + GONDEREN_EPOSTA (doğrulanmış alan adından)
// Rezervasyon bildirimlerinin gideceği adres: BILDIRIM_EPOSTA (yoksa GMAIL_ADRES = halisahaaysu@gmail.com)
// Telegram (isteğe bağlı): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { smtpGonder } from "./smtp.js";

// İşletmenin kendi Gmail adresi (gönderen adresle aynı). DİKKAT: aysuhalisaha@gmail.com başka bir hesap!
const VARSAYILAN_ALICI = "halisahaaysu@gmail.com";
const VARSAYILAN_GONDEREN = "Aysu Halı Saha <onboarding@resend.dev>";

const kacis = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ikiliB64 = (veri) => {
  let s = "";
  for (let i = 0; i < veri.length; i += 0x8000) s += String.fromCharCode(...veri.subarray(i, i + 0x8000));
  return btoa(s);
};

export const epostaKurulu = (env) => Boolean((env.GMAIL_ADRES && env.GMAIL_UYGULAMA_SIFRESI) || env.RESEND_API_KEY);

/**
 * Herhangi bir alıcıya e-posta. E-posta kurulu değilse sessizce atlar (false döner).
 * dugme: { yazi, link } verilirse e-postada büyük bir düğme olarak gösterilir.
 */
/** Son e-posta hatası (işlem kaydına yazmak için) */
export let sonEpostaHatasi = "";
export async function epostaYolla(env, { kime, konu, satirlar = [], alt = "", dugme = null, ekler = [], giris = "", bolumler = [] }) {
  if (!epostaKurulu(env)) { sonEpostaHatasi = "E-posta ayarı yok"; return false; }
  if (!kime?.length) { sonEpostaHatasi = "Alıcı yok (aktif Admin / Müdür e-postası bulunamadı)"; return false; }
  const dugmeler = (Array.isArray(dugme) ? dugme : dugme ? [dugme] : []);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#13261b;max-width:560px">
    <h2 style="margin:0 0 12px;color:#0067a4">${kacis(konu)}</h2>
    ${giris ? `<p style="margin:0 0 14px">${kacis(giris)}</p>` : ""}
    <table style="border-collapse:collapse">${satirlar.map(([k, v]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#55645a;vertical-align:top">${kacis(k)}</td><td style="padding:4px 0"><b>${
        /^https:\/\//.test(String(v)) ? `<a href="${kacis(v)}">${kacis(v)}</a>` : kacis(v)}</b></td></tr>`).join("")}
    </table>
    ${bolumler.map((b) => `<h3 style="margin:20px 0 6px;color:#062a45;font-size:16px;border-bottom:2px solid #ef7f1a;padding-bottom:4px">${kacis(b.baslik)}</h3>
      <ul style="margin:0;padding-left:20px">${b.maddeler.map((m) => `<li style="margin:3px 0">${kacis(m)}</li>`).join("")}</ul>`).join("")}
    ${dugmeler.length ? `<p style="margin:22px 0">${dugmeler.map((d) => `<a href="${kacis(d.link)}" style="background:${d.renk || "#0067a4"};color:#fff;text-decoration:none;font-weight:bold;font-size:18px;padding:14px 26px;border-radius:999px;display:inline-block;margin:0 10px 10px 0">${kacis(d.yazi)}</a>`).join("")}</p>
      ${dugmeler.length === 1 ? `<p style="color:#55645a;font-size:13px">Düğme çalışmazsa: ${kacis(dugmeler[0].link)}</p>` : ""}` : ""}
    ${alt ? `<p style="margin-top:16px;color:#55645a;font-size:13px">${kacis(alt)}</p>` : ""}
  </div>`;
  const metin = `${konu}\n\n${giris ? giris + "\n\n" : ""}${satirlar.map(([k, v]) => `${k}: ${v}`).join("\n")}${bolumler.map((b) => `\n\n${b.baslik.toLocaleUpperCase("tr")}\n${b.maddeler.map((m) => "- " + m).join("\n")}`).join("")}${dugmeler.map((d) => `\n\n${d.yazi}: ${d.link}`).join("")}${alt ? "\n\n" + alt : ""}`;
  try {
    if (env.GMAIL_ADRES && env.GMAIL_UYGULAMA_SIFRESI) {
      await smtpGonder({
        kullanici: env.GMAIL_ADRES, sifre: String(env.GMAIL_UYGULAMA_SIFRESI).replace(/\s+/g, ""),
        kimden: env.GMAIL_ADRES, kimdenAd: "Aysu Halı Saha", kime, konu, html, metin, ekler, baglan: env.__smtpBaglan,
      });
      return true;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.GONDEREN_EPOSTA || VARSAYILAN_GONDEREN, to: kime, subject: konu, html, text: metin,
        ...(ekler.length ? { attachments: ekler.map((e) => ({ filename: e.ad, content: ikiliB64(e.veri) })) } : {}),
      }),
    });
    if (!res.ok) { sonEpostaHatasi = `HTTP ${res.status}`; console.error("E-posta gönderilemedi", res.status, await res.text()); return false; }
    return true;
  } catch (e) {
    sonEpostaHatasi = String(e?.message || e).slice(0, 200);
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
  // Telegram'a ek gönderilmez, sadece metin
  const sonuclar = await Promise.allSettled([
    epostaYolla(env, {
      kime: [...new Set([env.BILDIRIM_EPOSTA || env.GMAIL_ADRES || VARSAYILAN_ALICI, ...(bildirim.ekKime || [])])],
      konu: bildirim.konu, satirlar: bildirim.satirlar, ekler: bildirim.ekler || [], alt: "Ayrıntılar yönetim panelinde: /panel",
    }),
    telegramGonder(env, metin),
  ]);
  for (const s of sonuclar) if (s.status === "rejected") console.error("Bildirim hatası", s.reason);
}
