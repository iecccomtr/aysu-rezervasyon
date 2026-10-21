import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { saatiAyarla, saatiSifirla, demoDepo } from "./yardimci.mjs";
import { fiyat, telefonNormalize, tarihNormalize, saatNormalize, haftaBasi } from "../src/time.js";

// "Şimdi": 19 Ekim 2026 Pazartesi 10:00 (Türkiye)
beforeEach(() => saatiAyarla("2026-10-19T10:00"));
after(saatiSifirla);

const ALI = { ad: "Ali Veli", telefon: "0532 111 22 33" };
const bos = async (d, gun, saat) => (await d.musaitlik(gun)).bosSaatler.includes(saat);
/** Müşteri penceresinin (7 gün) dışındaki günler için panel görünümünden slot türü. */
const tur = async (d, gun, saat) => (await d.panelHafta(gun)).gunler.find((g) => g.tarih === gun).saatler.find((s) => s.saat === saat).tur;

test("yardımcı biçimlendirmeler", () => {
  assert.equal(telefonNormalize("0532 642 19 46"), "05326421946");
  assert.equal(telefonNormalize("+90 (532) 642-1946"), "05326421946");
  assert.equal(telefonNormalize("0222 335 35 55"), null);
  assert.equal(tarihNormalize("24.10.2026"), "2026-10-24");
  assert.equal(saatNormalize("21"), "21:00");
  assert.equal(haftaBasi("2026-10-25"), "2026-10-19");
  assert.equal(fiyat("2026-10-23", "21:00"), 3700);
});

test("Abone her hafta dolu; 'bu hafta gelmiyor' sadece o haftayı boşaltır", async () => {
  const d = demoDepo();
  const r = await d.aboneKaydet({ ad: "Tolga Atalay", telefon: "0545 123 01 23", gun: 3, saat: "20:00" }); // Perşembe
  assert.ok(r.basarili, JSON.stringify(r));
  assert.equal(await bos(d, "2026-10-22", "20:00"), false);
  assert.equal(await tur(d, "2026-10-29", "20:00"), "abone");

  assert.ok((await d.aboneAtla({ id: r.abone.id, gun: "2026-10-22", gelmiyor: true })).basarili);
  assert.equal(await bos(d, "2026-10-22", "20:00"), true, "bu hafta boş");
  assert.equal(await tur(d, "2026-10-29", "20:00"), "abone", "gelecek hafta dolu");

  // Boşalan saate rezervasyon alınabilir; sonra 'geliyor' yapılamaz
  assert.ok((await d.olustur({ gunTarihi: "2026-10-22", saat: "20:00", ...ALI })).basarili);
  assert.match((await d.aboneAtla({ id: r.abone.id, gun: "2026-10-22", gelmiyor: false })).hata, /başka rezervasyon/);
  assert.match((await d.aboneAtla({ id: r.abone.id, gun: "2026-10-23", gelmiyor: true })).hata, /denk gelmiyor/);
});

test("Abone: aynı gün/saate ikinci abone eklenemez, silinince saat boşalır", async () => {
  const d = demoDepo();
  const a = await d.aboneKaydet({ ad: "Cihan Acar", gun: 0, saat: "22:00" });
  assert.match((await d.aboneKaydet({ ad: "Başka", gun: 0, saat: "22:00" })).hata, /zaten abone/);
  assert.equal(await bos(d, "2026-10-26", "22:00"), false);
  assert.ok((await d.aboneSil(a.abone.id)).basarili);
  assert.equal(await bos(d, "2026-10-26", "22:00"), true);
});

test("Abone başlangıç tarihinden önce dolu sayılmaz; gece abonesi doğru gece", async () => {
  const d = demoDepo();
  await d.aboneKaydet({ ad: "Golden Lig", gun: 4, saat: "00:00", baslangic: "2026-10-30" }); // Cuma gecesi
  assert.equal(await bos(d, "2026-10-23", "00:00"), true, "başlamadan önce boş");
  assert.equal(await bos(d, "2026-10-24", "00:00"), true, "cumartesi gecesi etkilenmez");
});

test("Geçmiş saatler listelenmez, 7 günden ileri reddedilir", async () => {
  const d = demoDepo();
  const bugun = await d.musaitlik("2026-10-19");
  assert.ok(!bugun.detay.some((s) => s.saat === "09:00"));
  assert.ok(bugun.detay.some((s) => s.saat === "11:00"));
  assert.ok((await d.musaitlik("2026-10-27")).hata);
});

test("Online rezervasyon: gece maçı ertesi takvim gününe yazılır, kapora bekleniyor", async () => {
  const d = demoDepo();
  const r = await d.olustur({ gunTarihi: "2026-10-23", saat: "01:00", ...ALI });
  assert.equal(r.basarili, true, JSON.stringify(r));
  assert.equal(r.tarih, "2026-10-24");
  assert.equal(r.gun, "Cuma gecesi");
  assert.equal(r.durum, "Kapora bekleniyor");
  assert.equal(r.kaynak, "Online");
  assert.match(r.kayitNo, /^AY-[A-Z0-9]{5}$/);
  assert.equal(await bos(d, "2026-10-23", "01:00"), false);
});

test("Aynı anda aynı saate iki istek: sadece biri kazanır", async () => {
  const d = demoDepo();
  const [a, b] = await Promise.all([
    d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Birinci Kişi", telefon: "05321112233" }),
    d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "İkinci Kişi", telefon: "05324445566" }),
  ]);
  assert.equal([a, b].filter((x) => x.basarili).length, 1);
});

test("Müşteri sınırları: kişi başı 2 aktif, geçersiz girdiler", async () => {
  const d = demoDepo();
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "18:00", ...ALI })).basarili);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-22", saat: "18:00", ...ALI })).basarili);
  assert.match((await d.olustur({ gunTarihi: "2026-10-23", saat: "18:00", ...ALI })).hata, /aktif rezervasyon/);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "05:00", ...ALI })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Ali", telefon: "123" })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-19", saat: "09:00", ...ALI })).hata, "geçmiş saat");
});

test("Müşteri iptali: telefon eşleşmeli, son 3 saatte iptal yok", async () => {
  const d = demoDepo();
  const r1 = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  const r2 = await d.olustur({ gunTarihi: "2026-10-19", saat: "12:00", ...ALI });
  assert.ok((await d.iptal({ kayitNo: r1.kayitNo, telefon: "05329999999" })).hata);
  assert.match((await d.iptal({ kayitNo: r2.kayitNo, telefon: ALI.telefon })).hata, /3 saatten az/);
  assert.ok((await d.iptal({ kayitNo: r1.kayitNo.toLowerCase(), telefon: ALI.telefon })).basarili);
  assert.equal(await bos(d, "2026-10-21", "21:00"), true);
});

test("Panel: telefon rezervasyonu sınırsız ve onaylı; kapora/durum güncelleme; iptali geri alma", async () => {
  const d = demoDepo();
  const t = await d.panelRezEkle({ gunTarihi: "2026-11-15", saat: "21:00", ad: "Eren", telefon: "" }); // 7 günden ileri, telefonsuz
  assert.ok(t.basarili, JSON.stringify(t));
  assert.equal(t.durum, "Onaylı");
  assert.equal(t.kaynak, "Telefon");

  const o = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  const g = await d.panelRezGuncelle({ kayitNo: o.kayitNo, durum: "Onaylı", kapora: "1000 + 200" });
  assert.equal(g.rez.durum, "Onaylı");
  assert.equal(g.rez.kapora, "1000 + 200");

  assert.ok((await d.panelRezGuncelle({ kayitNo: o.kayitNo, durum: "İptal" })).basarili);
  assert.ok((await d.panelRezEkle({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Yusuf", telefon: "05330000000" })).basarili);
  assert.match((await d.panelRezGuncelle({ kayitNo: o.kayitNo, durum: "Onaylı" })).hata, /artık dolu/);
  assert.ok((await d.panelRezGuncelle({ kayitNo: o.kayitNo, durum: "Bilinmeyen" })).hata);
});

test("Panel haftası: slot türleri ve kapora bekleyenler", async () => {
  const d = demoDepo();
  const a = await d.aboneKaydet({ ad: "Arda Somer", telefon: "0532 642 19 46", gun: 1, saat: "21:00" }); // Salı
  await d.aboneKaydet({ ad: "Cihan Acar", gun: 1, saat: "22:00" });
  await d.aboneAtla({ id: (await d.aboneListe()).find((x) => x.ad === "Cihan Acar").id, gun: "2026-10-20", gelmiyor: true });
  const o = await d.olustur({ gunTarihi: "2026-10-20", saat: "20:00", ...ALI });
  const h = await d.panelHafta("2026-10-22");
  assert.equal(h.baslangic, "2026-10-19");
  const sali = h.gunler[1].saatler;
  assert.equal(sali.find((s) => s.saat === "20:00").tur, "rez");
  assert.equal(sali.find((s) => s.saat === "21:00").tur, "abone");
  assert.equal(sali.find((s) => s.saat === "21:00").abone.ad, "Arda Somer");
  assert.equal(sali.find((s) => s.saat === "22:00").tur, "abone-gelmiyor");
  assert.equal(sali.find((s) => s.saat === "23:00").tur, "bos");
  assert.deepEqual(h.bekleyenler.map((r) => r.kayitNo), [o.kayitNo]);
  assert.ok(a.basarili);
});

test("CRM: müşteriler telefonla gruplanır; maç, iptal, abone ve not", async () => {
  const d = demoDepo();
  saatiAyarla("2026-10-12T10:00");
  await d.olustur({ gunTarihi: "2026-10-13", saat: "21:00", ...ALI });
  const ip = await d.olustur({ gunTarihi: "2026-10-14", saat: "21:00", ...ALI });
  await d.iptal({ kayitNo: ip.kayitNo, telefon: ALI.telefon });
  saatiAyarla("2026-10-19T10:00");
  await d.olustur({ gunTarihi: "2026-10-22", saat: "20:00", ...ALI });
  await d.aboneKaydet({ ad: "Ali Veli", telefon: ALI.telefon, gun: 5, saat: "10:00" });
  await d.musteriNot({ telefon: ALI.telefon, not: "Kaporayı hep 2 parça atıyor", etiket: "Düzenli" });

  const liste = await d.musteriler();
  const ali = liste.find((m) => m.telefon === "05321112233");
  assert.equal(ali.mac, 1);
  assert.equal(ali.iptal, 1);
  assert.equal(ali.gelecek.tarih, "2026-10-22");
  assert.deepEqual(ali.abone, ["Cumartesi 10:00"]);
  assert.equal(ali.etiket, "Düzenli");
  const det = await d.musteriDetay("05321112233");
  assert.equal(det.rezervasyonlar.length, 3);
  assert.equal(det.not, "Kaporayı hep 2 parça atıyor");
});

test("Panel girişi: kurulum kodu, şifre, oturum", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "kod123" });
  assert.equal((await d.panelDurum()).kurulu, false);
  assert.ok((await d.panelGiris("x")).hata);
  assert.match((await d.panelKur({ kurulumKodu: "yanlis", sifre: "12345678" })).hata, /Kurulum kodu/);
  assert.match((await d.panelKur({ kurulumKodu: "kod123", sifre: "kisa" })).hata, /8 karakter/);
  const k = await d.panelKur({ kurulumKodu: "kod123", sifre: "aysu-2026!" });
  assert.ok(k.basarili && (await d.oturumGecerli(k.token)));
  assert.match((await d.panelGiris("yanlis-sifre")).hata, /hatalı/);
  const g = await d.panelGiris("aysu-2026!");
  assert.ok(await d.oturumGecerli(g.token));
  await d.cikis(g.token);
  assert.equal(await d.oturumGecerli(g.token), false);
  assert.equal(await d.oturumGecerli("abc"), false);
  // Şifre sıfırlama eski oturumları kapatır
  await d.panelKur({ kurulumKodu: "kod123", sifre: "yeni-sifre-1" });
  assert.equal(await d.oturumGecerli(k.token), false);
});

test("Çok saatli abone: tüm saatler dolu; toplu 'gelmiyor' saat / gün / hafta", async () => {
  const d = demoDepo();
  const sl = [];
  for (const gun of [5, 6]) for (const saat of ["08:00", "09:00", "10:00", "11:00"]) sl.push({ gun, saat });
  const r = await d.aboneKaydet({ ad: "Futbol Koleji", telefon: "05537048026", slotlar: sl, baslangic: "2026-10-19" });
  assert.ok(r.basarili, JSON.stringify(r));
  assert.equal(r.abone.slotlar.length, 8);
  const cmt = "2026-10-24", paz = "2026-10-25";
  assert.equal(await tur(d, cmt, "09:00"), "abone");
  assert.equal(await tur(d, paz, "11:00"), "abone");
  assert.equal(await tur(d, cmt, "12:00"), "bos");

  // Sadece bir saat
  assert.equal((await d.aboneAtla({ id: r.abone.id, gun: cmt, saat: "09:00", gelmiyor: true })).sayi, 1);
  assert.equal(await tur(d, cmt, "09:00"), "abone-gelmiyor");
  assert.equal(await tur(d, cmt, "10:00"), "abone");
  // Tüm gün
  assert.equal((await d.aboneAtla({ id: r.abone.id, gun: cmt, gelmiyor: true, kapsam: "gun" })).sayi, 4);
  assert.equal(await tur(d, cmt, "11:00"), "abone-gelmiyor");
  assert.equal(await tur(d, paz, "08:00"), "abone");
  // Tüm hafta
  assert.equal((await d.aboneAtla({ id: r.abone.id, gun: cmt, gelmiyor: true, kapsam: "hafta" })).sayi, 8);
  assert.equal(await tur(d, paz, "08:00"), "abone-gelmiyor");
  assert.equal(await tur(d, "2026-10-31", "08:00"), "abone", "gelecek hafta dolu");
  // Boşalan saate rezervasyon, sonra haftayı geri al: dolu saat atlanır
  assert.ok((await d.panelRezEkle({ gunTarihi: paz, saat: "10:00", ad: "Misafir" })).basarili);
  const geri = await d.aboneAtla({ id: r.abone.id, gun: paz, gelmiyor: false, kapsam: "hafta" });
  assert.equal(geri.sayi, 7);
  assert.equal(geri.atlanan, 1);
  assert.equal(await tur(d, cmt, "08:00"), "abone");
  assert.equal(await tur(d, paz, "10:00"), "rez");

  // Çakışma: başka abone aynı saate eklenemez
  assert.match((await d.aboneKaydet({ ad: "Diğer", slotlar: [{ gun: 6, saat: "10:00" }] })).hata, /zaten abone var: Futbol Koleji/);
  // CRM'de tüm saatler
  const m = (await d.musteriler()).find((x) => x.telefon === "05537048026");
  assert.equal(m.abone.length, 8);
});

test("İçe aktarma: aboneler, gelmiyor işaretleri ve rezervasyonlar; ikinci kez çalıştırınca tekrar etmez", async () => {
  const d = demoDepo();
  const veri = {
    aboneler: [
      { ad: "Cihan Acar", telefon: "0505 804 4791", slotlar: [{ gun: 0, saat: "22:00" }], baslangic: "2026-10-19" },
      { ad: "Golden Lig", telefon: "0545 351 9261", slotlar: [{ gun: 4, saat: "20:00" }, { gun: 4, saat: "21:00" }], baslangic: "2026-10-19" },
    ],
    gelmiyor: [{ ad: "Cihan Acar", gun: "2026-10-19", saat: "22:00" }],
    rezervasyonlar: [
      { gunTarihi: "2026-10-19", saat: "22:00", ad: "Eyüp", kapora: "1200", not: "Kalan 2500", durum: "Onaylı" },
      { gunTarihi: "2026-10-23", saat: "23:00", ad: "Emir", kapora: "1200", not: "Kalan 2500", durum: "Onaylı" },
    ],
  };
  const r = await d.iceAktar(veri);
  assert.deepEqual([r.abone, r.gelmiyor, r.rez], [2, 1, 2], JSON.stringify(r));
  assert.equal(await tur(d, "2026-10-19", "22:00"), "rez");
  assert.equal(await tur(d, "2026-10-23", "21:00"), "abone");
  const ikinci = await d.iceAktar(veri);
  assert.equal(ikinci.abone, 0);
  assert.equal(ikinci.rez, 0);
  assert.equal((await d.aboneListe()).length, 2);
});
