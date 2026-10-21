// Gmail SMTP gönderimi: sahte bir SMTP sunucusuyla uçtan uca konuşma testi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpGonder } from "../src/smtp.js";

/** Cloudflare soket arayüzünü (readable/writable) taklit eden sahte SMTP sunucusu. */
function sahteSunucu({ sifreDogru = "abcdabcdabcdabcd" } = {}) {
  const gelen = [];
  let veriModu = false, veri = "", denetleyici;
  const yaz = (s) => denetleyici.enqueue(new TextEncoder().encode(s));
  const readable = new ReadableStream({ start(c) { denetleyici = c; yaz("220 smtp.gmail.com ESMTP\r\n"); } });
  let tampon = "", adim = 0;
  const writable = new WritableStream({
    write(parca) {
      tampon += new TextDecoder().decode(parca);
      let i;
      while ((i = tampon.indexOf("\r\n")) >= 0) {
        const satir = tampon.slice(0, i); tampon = tampon.slice(i + 2);
        if (veriModu) {
          if (satir === ".") { veriModu = false; gelen.push({ veri }); yaz("250 2.0.0 OK\r\n"); } else veri += satir + "\r\n";
          continue;
        }
        gelen.push(satir);
        if (satir.startsWith("EHLO")) yaz("250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n");
        else if (satir === "AUTH LOGIN") { adim = 1; yaz("334 VXNlcm5hbWU6\r\n"); }
        else if (adim === 1) { adim = 2; yaz("334 UGFzc3dvcmQ6\r\n"); }
        else if (adim === 2) { adim = 0; yaz(atob(satir) === sifreDogru ? "235 2.7.0 Accepted\r\n" : "535 5.7.8 Username and Password not accepted\r\n"); }
        else if (satir.startsWith("MAIL FROM") || satir.startsWith("RCPT TO")) yaz("250 OK\r\n");
        else if (satir === "DATA") { veriModu = true; yaz("354 Go ahead\r\n"); }
        else if (satir === "QUIT") yaz("221 bye\r\n");
      }
    },
  });
  let secenek;
  const baglan = (adres, s) => { secenek = { adres, s }; return { readable, writable, close: async () => {} }; };
  return { baglan, gelen, secenek: () => secenek };
}

const MESAJ = { kullanici: "aysuhalisaha@gmail.com", kimden: "aysuhalisaha@gmail.com", kime: ["mudur@aysu.com"],
  konu: "Onay bekliyor: Ayşe Çelik", html: "<b>Merhaba</b>", metin: "Merhaba şğüöçı" };

test("SMTP: Gmail'e TLS ile bağlanır, giriş yapar, Türkçe konu ve gövdeyi doğru kodlar", async () => {
  const s = sahteSunucu();
  await smtpGonder({ ...MESAJ, sifre: "abcdabcdabcdabcd", baglan: s.baglan });
  assert.deepEqual(s.secenek().adres, { hostname: "smtp.gmail.com", port: 465 });
  assert.equal(s.secenek().s.secureTransport, "on");
  assert.ok(s.gelen.includes("MAIL FROM:<aysuhalisaha@gmail.com>"));
  assert.ok(s.gelen.includes("RCPT TO:<mudur@aysu.com>"));
  const veri = s.gelen.find((x) => x.veri).veri;
  const konu = veri.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m)[1];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(konu), (c) => c.charCodeAt(0))), "Onay bekliyor: Ayşe Çelik");
  const govde = veri.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(govde), (c) => c.charCodeAt(0))), "Merhaba şğüöçı");
  assert.ok(s.gelen.includes("QUIT"));
});

test("SMTP: yanlış uygulama şifresi anlaşılır bir hata verir", async () => {
  const s = sahteSunucu();
  await assert.rejects(smtpGonder({ ...MESAJ, sifre: "yanlis", baglan: s.baglan }), /Username and Password not accepted/);
});
