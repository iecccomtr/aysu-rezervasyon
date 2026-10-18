import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { saatiAyarla, saatiSifirla, demoDepo, haftalikTablo } from "./yardimci.mjs";
import { fiyat, telefonNormalize, tarihNormalize, saatNormalize, haftaBasi } from "../src/time.js";

// "Şimdi": 19 Ekim 2026 Pazartesi 10:00 (Türkiye)
beforeEach(() => saatiAyarla("2026-10-19T10:00"));
after(saatiSifirla);

const TABLO = haftalikTablo({
  "CUMA|20:00": "ABONE - 6",
  "SALI|19:00": "EREN - 1200/2500 TL",            // bu haftaya ait tek seferlik
  "PAZARTESİ|21:00": "YUSUF 1200/2500",           // bu haftaya ait tek seferlik
  "PAZARTESİ|22:00": "ABONE - 4",
  "CUMARTESİ|00:00": "ABONE - 14",                // cumartesi gecesi
  "CUMA|22:00": "ABONE - 12 DEPOZİTO BEDELİNE OYNAYACAK",
});

async function hazirDepo() {
  const d = demoDepo();
  await d.demoHaftalikAyarla(TABLO);
  return d;
}

test("yardımcı biçimlendirmeler", () => {
  assert.equal(telefonNormalize("0532 642 19 46"), "05326421946");
  assert.equal(telefonNormalize("+90 (532) 642-1946"), "05326421946");
  assert.equal(telefonNormalize("5326421946"), "05326421946");
  assert.equal(telefonNormalize("0222 335 35 55"), null);
  assert.equal(tarihNormalize("24.10.2026"), "2026-10-24");
  assert.equal(tarihNormalize("2026-10-24"), "2026-10-24");
  assert.equal(saatNormalize("21"), "21:00");
  assert.equal(saatNormalize("9.00"), "09:00");
  assert.equal(haftaBasi("2026-10-25"), "2026-10-19");
  assert.equal(fiyat("2026-10-23", "21:00"), 3700);
});

test("ABONE saatleri her hafta dolu sayılır", async () => {
  const d = await hazirDepo();
  const cuma = await d.musaitlik("2026-10-23");
  assert.equal(cuma.gun, "Cuma");
  assert.ok(!cuma.bosSaatler.includes("20:00"), "Cuma 20:00 abone");
  assert.ok(!cuma.bosSaatler.includes("22:00"), "Cuma 22:00 abone (uzun not)");
  assert.ok(cuma.bosSaatler.includes("21:00"));
  // Gelecek haftanın pazartesisi: abone dolu
  const sonrakiPzt = await d.musaitlik("2026-10-26");
  assert.ok(!sonrakiPzt.bosSaatler.includes("22:00"));
});

test("Tek seferlik kayıtlar sadece bu hafta dolu sayılır", async () => {
  const d = await hazirDepo();
  const sali = await d.musaitlik("2026-10-20");
  assert.ok(!sali.bosSaatler.includes("19:00"), "bu salı 19:00 dolu");
  const bugun = await d.musaitlik("2026-10-19");
  assert.ok(!bugun.bosSaatler.includes("21:00"), "bu pazartesi 21:00 dolu");
  const sonrakiPzt = await d.musaitlik("2026-10-26");
  assert.ok(sonrakiPzt.bosSaatler.includes("21:00"), "gelecek pazartesi 21:00 boş (YUSUF bu haftaya ait)");
});

test("Geçmiş saatler listelenmez, 7 günden ileri reddedilir", async () => {
  const d = await hazirDepo();
  const bugun = await d.musaitlik("2026-10-19");
  assert.ok(!bugun.detay.some((s) => s.saat === "09:00"), "09:00 geçti");
  assert.ok(bugun.detay.some((s) => s.saat === "11:00"));
  const uzak = await d.musaitlik("2026-10-27");
  assert.ok(uzak.hata);
});

test("Gece maçı: Cumartesi 00:00 abone, takvimde pazar", async () => {
  const d = await hazirDepo();
  const cmt = await d.musaitlik("2026-10-24");
  assert.ok(!cmt.bosSaatler.includes("00:00"));
  assert.ok(cmt.bosSaatler.includes("01:00"));
  const s = cmt.detay.find((x) => x.saat === "01:00");
  assert.match(s.not, /2026-10-25/);
});

test("Rezervasyon oluşturur, saat dolar, gece maçı doğru tarihe yazılır", async () => {
  const d = await hazirDepo();
  const r = await d.olustur({ gunTarihi: "2026-10-23", saat: "01:00", ad: "Ali Veli", telefon: "0532 111 22 33" });
  assert.equal(r.basarili, true, JSON.stringify(r));
  assert.equal(r.tarih, "2026-10-24");
  assert.equal(r.gun, "Cuma gecesi");
  assert.match(r.kayitNo, /^AY-[A-Z0-9]{5}$/);
  assert.equal(r.durum, "Kapora bekleniyor");
  const cuma = await d.musaitlik("2026-10-23");
  assert.ok(!cuma.bosSaatler.includes("01:00"));
});

test("Aynı anda aynı saate iki istek: sadece biri kazanır", async () => {
  const d = await hazirDepo();
  const [a, b] = await Promise.all([
    d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Birinci Kişi", telefon: "05321112233" }),
    d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "İkinci Kişi", telefon: "05324445566" }),
  ]);
  const basarili = [a, b].filter((x) => x.basarili).length;
  assert.equal(basarili, 1, JSON.stringify([a, b]));
  assert.match([a, b].find((x) => !x.basarili).hata, /dolu/);
});

test("Dolu (abone) saate rezervasyon yapılamaz", async () => {
  const d = await hazirDepo();
  const r = await d.olustur({ gunTarihi: "2026-10-23", saat: "20:00", ad: "Ali Veli", telefon: "05321112233" });
  assert.match(r.hata, /dolu/);
});

test("Kişi başı aktif rezervasyon sınırı", async () => {
  const d = await hazirDepo();
  const tel = "05321112233";
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "18:00", ad: "Ali Veli", telefon: tel })).basarili);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-22", saat: "18:00", ad: "Ali Veli", telefon: tel })).basarili);
  const ucuncu = await d.olustur({ gunTarihi: "2026-10-23", saat: "18:00", ad: "Ali Veli", telefon: tel });
  assert.match(ucuncu.hata, /aktif rezervasyon/);
});

test("Geçersiz girdiler reddedilir", async () => {
  const d = await hazirDepo();
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "05:00", ad: "Ali Veli", telefon: "05321112233" })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Ali Veli", telefon: "123" })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "", telefon: "05321112233" })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-19", saat: "09:00", ad: "Ali Veli", telefon: "05321112233" })).hata, "geçmiş saat");
});

test("Bulma ve iptal: telefon eşleşmeli, son 3 saatte iptal yok", async () => {
  const d = await hazirDepo();
  const r1 = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Ali Veli", telefon: "05321112233" });
  const r2 = await d.olustur({ gunTarihi: "2026-10-19", saat: "12:00", ad: "Ali Veli", telefon: "05321112233" });
  const liste = await d.bul("0532 111 22 33");
  assert.equal(liste.rezervasyonlar.length, 2);
  assert.ok(!("ad" in liste.rezervasyonlar[0]), "isim döndürülmez");

  assert.ok((await d.iptal({ kayitNo: r1.kayitNo, telefon: "05329999999" })).hata, "başka telefon iptal edemez");
  assert.match((await d.iptal({ kayitNo: r2.kayitNo, telefon: "05321112233" })).hata, /3 saatten az/);
  assert.ok((await d.iptal({ kayitNo: r1.kayitNo.toLowerCase(), telefon: "05321112233" })).basarili);
  assert.equal((await d.bul("05321112233")).rezervasyonlar.length, 1);
  const car = await d.musaitlik("2026-10-21");
  assert.ok(car.bosSaatler.includes("21:00"), "iptal edilen saat yeniden boş");
});
