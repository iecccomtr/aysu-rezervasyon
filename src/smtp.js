// Gmail (veya başka bir SMTP sunucusu) ile e-posta gönderimi — Cloudflare Workers TCP soketleri üzerinden.
// Gmail için: hesapta 2 Adımlı Doğrulama açık olmalı ve bir "Uygulama şifresi" oluşturulmalı.
//   GMAIL_ADRES             → ör. aysuhalisaha@gmail.com
//   GMAIL_UYGULAMA_SIFRESI  → 16 haneli uygulama şifresi (Secret)

import { connect } from "cloudflare:sockets";

const b64 = (s) => {
  const bayt = new TextEncoder().encode(s);
  let ikili = "";
  for (const b of bayt) ikili += String.fromCharCode(b);
  return btoa(ikili);
};
/** Türkçe karakterli başlıklar için RFC 2047 */
const baslik = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const ikiliB64 = (veri) => {
  let s = "";
  for (let i = 0; i < veri.length; i += 0x8000) s += String.fromCharCode(...veri.subarray(i, i + 0x8000));
  return btoa(s);
};
const satirla = (s) => s.replace(/.{1,76}/g, "$&\r\n");

/** SMTP konuşması: her komuttan sonra beklenen yanıt kodunu kontrol eder. */
class Oturum {
  constructor(soket) {
    this.soket = soket;
    this.okuyucu = soket.readable.getReader();
    this.yazici = soket.writable.getWriter();
    this.tampon = "";
    this.coz = new TextDecoder();
  }
  async yanit() {
    // Çok satırlı yanıt: "250-..." satırları "250 ..." ile biter
    for (;;) {
      const satirlar = this.tampon.split("\r\n");
      for (let i = 0; i < satirlar.length - 1; i++) {
        if (/^\d{3} /.test(satirlar[i])) {
          const metin = satirlar.slice(0, i + 1).join("\n");
          this.tampon = satirlar.slice(i + 1).join("\r\n");
          return { kod: Number(satirlar[i].slice(0, 3)), metin };
        }
      }
      const { value, done } = await this.okuyucu.read();
      if (done) throw new Error("SMTP bağlantısı kapandı: " + this.tampon);
      this.tampon += this.coz.decode(value, { stream: true });
    }
  }
  async komut(satir, beklenen) {
    if (satir !== null) await this.yazici.write(new TextEncoder().encode(satir + "\r\n"));
    const y = await this.yanit();
    if (!beklenen.includes(y.kod)) throw new Error(`SMTP hatası (${satir?.split(" ")[0] || "bağlantı"}): ${y.metin}`);
    return y;
  }
}

/**
 * @param {{host?: string, port?: number, kullanici: string, sifre: string, kimden: string, kimdenAd?: string,
 *          kime: string[], konu: string, html: string, metin: string, baglan?: Function}} p
 */
export async function smtpGonder(p) {
  const baglan = p.baglan || connect;
  const soket = baglan({ hostname: p.host || "smtp.gmail.com", port: p.port || 465 }, { secureTransport: "on", allowHalfOpen: false });
  const o = new Oturum(soket);
  try {
    await o.komut(null, [220]);
    await o.komut("EHLO aysuhalisaha.com", [250]);
    await o.komut("AUTH LOGIN", [334]);
    await o.komut(b64(p.kullanici), [334]);
    await o.komut(b64(p.sifre), [235]);
    await o.komut(`MAIL FROM:<${p.kimden}>`, [250]);
    for (const k of p.kime) await o.komut(`RCPT TO:<${k}>`, [250, 251]);
    await o.komut("DATA", [354]);
    const sinir = "aysu-" + crypto.randomUUID();
    const ekSinir = "aysu-ek-" + crypto.randomUUID();
    const ekler = p.ekler || [];
    const govde = [
      `--${sinir}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      satirla(b64(p.metin)),
      `--${sinir}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      satirla(b64(p.html)),
      `--${sinir}--`,
    ];
    const icerik = ekler.length ? [
      `Content-Type: multipart/mixed; boundary="${ekSinir}"`,
      "",
      `--${ekSinir}`,
      `Content-Type: multipart/alternative; boundary="${sinir}"`,
      "",
      ...govde,
      ...ekler.flatMap((e) => [
        `--${ekSinir}`,
        `Content-Type: ${e.tur}; name="${baslik(e.ad)}"`,
        `Content-Disposition: attachment; filename="${baslik(e.ad)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        satirla(ikiliB64(e.veri)),
      ]),
      `--${ekSinir}--`,
    ] : [`Content-Type: multipart/alternative; boundary="${sinir}"`, "", ...govde];
    const mesaj = [
      `From: ${baslik(p.kimdenAd || "Aysu Halı Saha")} <${p.kimden}>`,
      `To: ${p.kime.join(", ")}`,
      `Subject: ${baslik(p.konu)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@aysuhalisaha.com>`,
      "MIME-Version: 1.0",
      ...icerik,
      ".",
    ].join("\r\n");
    await o.komut(mesaj, [250]);
    await o.komut("QUIT", [221]).catch(() => {});
  } finally {
    try { await soket.close(); } catch {}
  }
}
