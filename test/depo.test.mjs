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

test("Geçmiş saatler listelenmez, 4 haftadan ileri reddedilir", async () => {
  const d = demoDepo();
  const bugun = await d.musaitlik("2026-10-19");
  assert.ok(!bugun.detay.some((s) => s.saat === "09:00"));
  assert.ok(bugun.detay.some((s) => s.saat === "11:00"));
  assert.ok(!(await d.musaitlik("2026-11-15")).hata);
  assert.ok((await d.musaitlik("2026-11-16")).hata);
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

test("Müşteri sınırları: aynı numarayla aynı anda tek ödemesi bekleyen opsiyon; kaporası ödenenlerde sınır yok", async () => {
  const d = demoDepo();
  const r1 = await d.olustur({ gunTarihi: "2026-10-21", saat: "18:00", ...ALI });
  assert.ok(r1.basarili);
  assert.match((await d.olustur({ gunTarihi: "2026-10-21", saat: "19:00", ...ALI })).hata, /ödemesi beklenen/);
  await d.panelRezGuncelle({ kayitNo: r1.kayitNo, durum: "Onaylı", kapora: "1200" });
  for (const gun of ["2026-10-21", "2026-10-28", "2026-11-04", "2026-11-11", "2026-11-12"]) {
    const r = await d.olustur({ gunTarihi: gun, saat: "19:00", ...ALI });
    assert.ok(r.basarili, gun);
    await d.panelRezGuncelle({ kayitNo: r.kayitNo, durum: "Onaylı", kapora: "1200" });
  }
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "05:00", ...ALI })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Ali", telefon: "123" })).hata);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-19", saat: "09:00", ...ALI })).hata, "geçmiş saat");
});

test("Müşteri iptali: telefon eşleşmeli, onaylı maçta son 3 saatte iptal yok, opsiyon her zaman bırakılır", async () => {
  const d = demoDepo();
  const r1 = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  await d.panelRezGuncelle({ kayitNo: r1.kayitNo, durum: "Onaylı", kapora: "1200" });
  const r2 = await d.olustur({ gunTarihi: "2026-10-19", saat: "12:00", ...ALI });
  assert.ok((await d.iptal({ kayitNo: r1.kayitNo, telefon: "05329999999" })).hata);
  await d.panelRezGuncelle({ kayitNo: r2.kayitNo, durum: "Onaylı", kapora: "1200" });
  assert.match((await d.iptal({ kayitNo: r2.kayitNo, telefon: ALI.telefon })).hata, /3 saatten az/, "onaylı maçta 3 saat kuralı");
  const r3 = await d.olustur({ gunTarihi: "2026-10-19", saat: "11:00", ...ALI });
  assert.ok((await d.iptal({ kayitNo: r3.kayitNo, telefon: ALI.telefon })).basarili, "onaylanmamış opsiyon her zaman bırakılabilir");
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

test("Panel haftası: slot türleri", async () => {
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
  assert.deepEqual(h.bekleyenler, [], "kapora bekleyenler listesi yok");
  assert.equal(sali.find((s) => s.saat === "20:00").rez.kayitNo, o.kayitNo);
  assert.ok(a.basarili);
});

test("CRM: müşteriler telefonla gruplanır; maç, iptal, abone ve not", async () => {
  const d = demoDepo();
  saatiAyarla("2026-10-12T10:00");
  const ilk = await d.olustur({ gunTarihi: "2026-10-13", saat: "21:00", ...ALI });
  await d.panelRezGuncelle({ kayitNo: ilk.kayitNo, durum: "Onaylı", kapora: "1200" });
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

test("Panel girişi: kurulum kodu ile Admin, e-posta + şifre, oturum", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "kod123" });
  assert.equal((await d.panelDurum()).kurulu, false);
  assert.ok((await d.panelGiris({ eposta: "a@b.com", sifre: "x" })).hata);
  assert.match((await d.panelKur({ kurulumKodu: "yanlis", eposta: "mudur@aysu.com", sifre: "12345678" })).hata, /Kurulum kodu/);
  assert.match((await d.panelKur({ kurulumKodu: "kod123", eposta: "mudur@aysu.com", sifre: "kisa" })).hata, /8 karakter/);
  assert.match((await d.panelKur({ kurulumKodu: "kod123", eposta: "bozuk", sifre: "aysu-2026!" })).hata, /e-posta/);
  const k = await d.panelKur({ kurulumKodu: "kod123", eposta: "Mudur@Aysu.com", ad: "Ahmet Aysu", sifre: "aysu-2026!" });
  assert.ok(k.basarili);
  assert.equal((await d.oturum(k.token)).rol, "admin");
  assert.equal((await d.panelDurum()).kurulu, true);
  assert.match((await d.panelGiris({ eposta: "mudur@aysu.com", sifre: "yanlis-sifre" })).hata, /hatalı/);
  const g = await d.panelGiris({ eposta: " MUDUR@aysu.com ", sifre: "aysu-2026!" });
  assert.equal((await d.oturum(g.token)).eposta, "mudur@aysu.com");
  assert.equal((await d.oturum(g.token)).hash, undefined, "şifre bilgisi dışarı çıkmamalı");
  await d.cikis(g.token);
  assert.equal(await d.oturum(g.token), null);
  assert.equal(await d.oturum("abc"), null);
  // Kurulum koduyla yeniden şifre: eski oturumlar kapanır
  await d.panelKur({ kurulumKodu: "kod123", eposta: "mudur@aysu.com", sifre: "yeni-sifre-1" });
  assert.equal(await d.oturum(k.token), null);
});

test("Kayıt (görev seçerek) → onay bekler → rol verilince girer; yetki hiyerarşisi; işlem kaydı", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "kod123" });
  const a = await d.panelKur({ kurulumKodu: "kod123", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" });
  const admin = await d.oturum(a.token);

  assert.match((await d.kayitOl({ eposta: "temiz@aysu.com", ad: "Ayşe Temiz", sifre: "temizlik-1" })).hata, /Görev/);
  assert.match((await d.kayitOl({ eposta: "temiz@aysu.com", ad: "Ayşe Temiz", sifre: "temizlik-1", rol: "admin" })).hata, /Görev/);
  assert.ok((await d.kayitOl({ eposta: "temiz@aysu.com", ad: "Ayşe Temiz", sifre: "temizlik-1", rol: "temizlik" })).basarili);
  assert.equal((await d.kullanicilar()).find((u) => u.eposta === "temiz@aysu.com").istenenRolAd, "Temizlik Şefi");
  assert.match((await d.kayitOl({ eposta: "temiz@aysu.com", ad: "Tekrar", sifre: "temizlik-1", rol: "personel" })).hata, /zaten/);
  assert.match((await d.panelGiris({ eposta: "temiz@aysu.com", sifre: "temizlik-1" })).hata, /onay/);
  assert.match((await d.kullaniciGuncelle({ eposta: "temiz@aysu.com", durum: "aktif" }, admin)).hata, /rol/);
  assert.ok((await d.kullaniciGuncelle({ eposta: "temiz@aysu.com", rol: "temizlik", durum: "aktif" }, admin)).basarili);
  const t = await d.panelGiris({ eposta: "temiz@aysu.com", sifre: "temizlik-1" });
  const temiz = await d.oturum(t.token);
  assert.equal(temiz.rolAd, "Temizlik Şefi");
  assert.match((await d.kullaniciGuncelle({ eposta: "temiz@aysu.com", rol: "mudur" }, temiz)).hata, /yetki/);

  // Müdür: Admin'e dokunamaz, kimseyi Admin/Müdür yapamaz; Müdür Yardımcısı'nı yönetir
  await d.kayitOl({ eposta: "mudur@aysu.com", ad: "Ahmet Müdür", sifre: "mudur-123", rol: "mudur" });
  await d.kullaniciGuncelle({ eposta: "mudur@aysu.com", rol: "mudur", durum: "aktif" }, admin);
  const mudur = await d.oturum((await d.panelGiris({ eposta: "mudur@aysu.com", sifre: "mudur-123" })).token);
  assert.match((await d.kullaniciGuncelle({ eposta: "admin@aysu.com", durum: "pasif" }, mudur)).hata, /yetki/);
  assert.match((await d.kullaniciGuncelle({ eposta: "temiz@aysu.com", rol: "admin" }, mudur)).hata, /yetki/);
  await d.kayitOl({ eposta: "yrd@aysu.com", ad: "Mehmet Yrd", sifre: "yardimci-1", rol: "mudur_yrd" });
  assert.ok((await d.kullaniciGuncelle({ eposta: "yrd@aysu.com", rol: "mudur_yrd", durum: "aktif" }, mudur)).basarili);
  const yrd = await d.oturum((await d.panelGiris({ eposta: "yrd@aysu.com", sifre: "yardimci-1" })).token);
  assert.match((await d.kullaniciGuncelle({ eposta: "mudur@aysu.com", durum: "pasif" }, yrd)).hata, /yetki/);
  assert.match((await d.kullaniciGuncelle({ eposta: "yrd@aysu.com", rol: "personel" }, yrd)).hata, /Kendi/);
  // Pasife alınan kullanıcının oturumu kapanır
  assert.ok((await d.kullaniciGuncelle({ eposta: "temiz@aysu.com", durum: "pasif" }, yrd)).basarili);
  assert.equal(await d.oturum(t.token), null);
  // Son Admin silinemez / düşürülemez
  assert.match((await d.kullaniciSil("admin@aysu.com", admin)).hata, /Kendi/);
  const liste = await d.kullanicilar();
  assert.equal(liste[0].rol, "admin");
  assert.ok(liste.every((u) => u.hash === undefined && u.tuz === undefined));
  // İşlem kaydı: girişler ve kayıtlar en yeni başta
  const islem = await d.islemler();
  assert.ok(islem.some((x) => x.islem === "Giriş yaptı" && x.kim === "Ahmet Müdür"));
  assert.ok(islem.some((x) => x.islem === "Kurulum kodu ile Admin girişi"));
});

test("Abone numarası: nottan okunur, boşsa ilk boş numara, çakışma reddedilir; tabloda numara", async () => {
  const d = demoDepo();
  await d.iceAktar({ aboneler: [{ ad: "Futbol Koleji", slotlar: [{ gun: 5, saat: "08:00" }], baslangic: "2026-10-19", not: "Abone 1" }] });
  const b = await d.aboneKaydet({ ad: "Yeni Takım", gun: 0, saat: "20:00" });
  assert.equal(b.abone.no, 2);
  assert.match((await d.aboneKaydet({ ad: "Çakışan No", gun: 1, saat: "20:00", no: 1 })).hata, /Abone 1/);
  assert.equal((await d.aboneKaydet({ ad: "Elle", gun: 1, saat: "20:00", no: 17 })).abone.no, 17);
  const h = await d.panelHafta("2026-10-19");
  assert.equal(h.gunler[5].saatler.find((x) => x.saat === "08:00").abone.no, 1);
  assert.deepEqual((await d.aboneListe()).map((a) => a.no), [1, 2, 17], "liste abone numarasına göre sıralı");
});

test("Özel saat: panel 05:00'e maç yazar, müşteri yazamaz; haftada görünür", async () => {
  const d = demoDepo();
  assert.ok((await d.olustur({ gunTarihi: "2026-10-23", saat: "05:00", ...ALI })).hata);
  const r = await d.panelRezEkle({ gunTarihi: "2026-10-23", saat: "05:00", ad: "Sabahçılar", telefon: "" });
  assert.ok(r.basarili, JSON.stringify(r));
  assert.equal(r.tarih, "2026-10-24", "05:00 seçilen günün gecesi: ertesi takvim günü");
  const h = await d.panelHafta("2026-10-19");
  const cuma = h.gunler.find((g) => g.tarih === "2026-10-23");
  assert.deepEqual(cuma.saatler.slice(-2).map((x) => x.saat), ["02:00", "05:00"]);
  assert.equal(cuma.saatler.at(-1).tur, "rez");
  assert.equal(cuma.saatler.at(-1).ozel, true);
  assert.equal(h.gunler[0].saatler.length, cuma.saatler.length, "tüm günler aynı satırlara sahip");
  assert.match((await d.panelRezEkle({ gunTarihi: "2026-10-23", saat: "05:00", ad: "İkinci", telefon: "" })).hata, /dolu/);
  assert.ok((await d.panelRezEkle({ gunTarihi: "2026-10-23", saat: "06:00", ad: "Erkenci", telefon: "" })).basarili);
  assert.equal((await d.panelHafta("2026-10-19")).gunler[4].saatler[0].saat, "06:00");
});

test("Haftalık temizlik: eski hafta rezervasyonları ve 'gelmiyor' silinir, aboneler ve müşteri sayıları kalır", async () => {
  const d = demoDepo();
  const ab = await d.aboneKaydet({ ad: "Abone Takım", telefon: "05330000001", gun: 0, saat: "21:00", baslangic: "2026-10-19" });
  await d.panelRezEkle({ gunTarihi: "2026-10-20", saat: "20:00", ad: "Ali Veli", telefon: "0532 111 22 33" });
  await d.panelRezEkle({ gunTarihi: "2026-10-25", saat: "01:00", ad: "Pazar Gecesi", telefon: "" }); // Pazar gecesi (takvim 26'sı)
  await d.aboneAtla({ id: ab.abone.id, gun: "2026-10-19", saat: "21:00", gelmiyor: true });
  saatiAyarla("2026-10-26T03:00"); // Pazartesi 03:00
  await d.panelRezEkle({ gunTarihi: "2026-10-27", saat: "20:00", ad: "Ali Veli", telefon: "0532 111 22 33" });
  const r = await d.haftaTemizle();
  assert.equal(r.sinir, "2026-10-26");
  assert.equal(r.rezervasyon, 2);
  assert.equal(r.gelmiyor, 1);
  assert.equal((await d.panelHafta("2026-10-19")).gunler[1].saatler.find((x) => x.saat === "20:00").tur, "bos");
  assert.equal((await d.panelHafta("2026-10-26")).gunler[1].saatler.find((x) => x.saat === "20:00").tur, "rez", "bu hafta kalır");
  assert.equal((await d.panelHafta("2026-10-26")).gunler[0].saatler.find((x) => x.saat === "21:00").tur, "abone", "abone kalır");
  const ali = (await d.musteriler()).find((m) => m.telefon === "05321112233");
  assert.equal(ali.mac, 1, "silinen maç sayıda kalır");
  assert.equal(ali.gelecek.tarih, "2026-10-27");
  assert.equal((await d.musteriDetay("05321112233")).arsiv.mac, 1);
});

test("Şifremi unuttum: tek kullanımlık, 1 saatlik bağlantı", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "kod123" });
  const m = await d.panelKur({ kurulumKodu: "kod123", eposta: "mudur@aysu.com", sifre: "aysu-2026!" });
  assert.ok((await d.sifirlamaOlustur("yok@aysu.com")).yok);
  const s = await d.sifirlamaOlustur("mudur@aysu.com");
  assert.match((await d.sifreSifirla({ token: s.token, sifre: "kisa" })).hata, /8 karakter/);
  const r = await d.sifreSifirla({ token: s.token, sifre: "yepyeni-sifre" });
  assert.ok(r.basarili && r.token);
  assert.equal(await d.oturum(m.token), null, "eski oturumlar kapanır");
  assert.match((await d.sifreSifirla({ token: s.token, sifre: "baska-sifre1" })).hata, /süresi|geçersiz/i);
  assert.ok((await d.panelGiris({ eposta: "mudur@aysu.com", sifre: "yepyeni-sifre" })).basarili);
  // Süresi dolan bağlantı
  const s2 = await d.sifirlamaOlustur("mudur@aysu.com");
  saatiAyarla("2026-10-19T12:30");
  assert.match((await d.sifreSifirla({ token: s2.token, sifre: "baska-sifre1" })).hata, /süresi/);
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

test("Dekont değerlendirme kuralları", async () => {
  const { dekontDegerlendir } = await import("../src/dekont-kontrol.js");
  const k = { iban: "TR70 0015 7000 0000 0154 8342 35", alici: "Ahmet Aysu", kapora: 1200, rezTarihi: "2026-10-21", bugun: "2026-10-22" };
  const iyi = { alici_iban: "TR700015700000000154834235", alici_ad: "AHMET AYSU", tutar: 1200, tarih: "21.10.2026" };
  assert.equal(dekontDegerlendir(iyi, k).onay, true);
  assert.equal(dekontDegerlendir({ ...iyi, alici_ad: "Ahmet Aysu" }, k).onay, true, "büyük/küçük harf fark etmez");
  const az = dekontDegerlendir({ ...iyi, tutar: "500,00" }, k);
  assert.equal(az.onay, true, "tutar onayı engellemez"); assert.equal(az.eksik, true); assert.equal(az.tutar, 500);
  assert.equal(dekontDegerlendir({ ...iyi, tutar: 3700 }, k).eksik, false);
  assert.match(dekontDegerlendir({ ...iyi, alici_ad: "MEHMET YILMAZ" }, k).nedenler.join(), /Hesap adı/);
  assert.match(dekontDegerlendir({ ...iyi, tarih: "2026-09-01" }, k).nedenler.join(), /önce/);
  assert.equal(dekontDegerlendir({ hata: "okunamadı" }, k).onay, false);
});

test("Opsiyon: online rezervasyon 15 dk yer tutar; dekont gelmezse yer boşa çıkar, telefon kaydı düşmez", async () => {
  const d = demoDepo();
  const r = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  const t = await d.panelRezEkle({ gunTarihi: "2026-10-21", saat: "22:00", ad: "Telefonla", telefon: "", durum: "Kapora bekleniyor" });
  assert.equal(await bos(d, "2026-10-21", "21:00"), false, "15 dk boyunca kimse alamaz");
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Başkası", telefon: "05330000009" })).hata);
  saatiAyarla("2026-10-19T10:16");
  assert.equal(await bos(d, "2026-10-21", "21:00"), true, "süre dolunca boşa çıkar");
  assert.equal(await bos(d, "2026-10-21", "22:00"), false, "telefonla girilen kayıt düşmez");
  const dusen = await d.opsiyonlariDusur();
  assert.deepEqual(dusen.map((x) => x.kayitNo), [r.kayitNo]);
  assert.equal((await d.kayitBul(r.kayitNo)).kayit.durum, "İptal");
  assert.ok(t.basarili);
  // Geç gelen dekont: yer hâlâ boşsa rezervasyon geri gelir
  const geri = await d.dekontYukle({ kayitNo: r.kayitNo, telefon: ALI.telefon, tur: "image/jpeg", ad: "d.jpg", veri: new Uint8Array(200) });
  assert.ok(geri.basarili, JSON.stringify(geri));
  assert.equal(await bos(d, "2026-10-21", "21:00"), false);
  // Geç dekont 5 dk ek süre alır; doğrulanmazsa (kapora gelmeden rezervasyon yok) yine düşer
  saatiAyarla("2026-10-19T12:00");
  assert.equal((await d.opsiyonlariDusur()).length, 1);
});

test("Opsiyon: süre dolup yer başkasına verildiyse geç dekont kabul edilmez", async () => {
  const d = demoDepo();
  const r = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  saatiAyarla("2026-10-19T10:20");
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Yeni Kişi", telefon: "05330000009" })).basarili);
  const geri = await d.dekontYukle({ kayitNo: r.kayitNo, telefon: ALI.telefon, tur: "image/jpeg", ad: "d.jpg", veri: new Uint8Array(200) });
  assert.match(geri.hata, /başka birine verildi/);
});

test("Müşteri silme: aktif rezervasyon/abonelik varsa engellenir, yoksa tüm kayıtlar silinir", async () => {
  const d = demoDepo();
  const r = await d.panelRezEkle({ gunTarihi: "2026-10-21", saat: "20:00", ad: "Ali Veli", telefon: "0532 111 22 33" });
  await d.musteriNot({ telefon: "05321112233", not: "not", etiket: "VIP" });
  assert.match((await d.musteriSil("05321112233")).hata, /aktif rezervasyon/);
  saatiAyarla("2026-10-22T10:00"); // maç geçti
  const s = await d.musteriSil("0532 111 22 33");
  assert.ok(s.basarili); assert.equal(s.silinen, 1);
  assert.equal(await d.kayitBul(r.kayitNo), null);
  assert.equal((await d.musteriler()).some((m) => m.telefon === "05321112233"), false);
  await d.aboneKaydet({ ad: "Abone", telefon: "05330000001", gun: 0, saat: "21:00" });
  assert.match((await d.musteriSil("05330000001")).hata, /abone/);
});

test("Opsiyonlu yer: başkası denerse 'x dakika sonra tekrar deneyin' uyarısı; müsaitlikte işaretli", async () => {
  const d = demoDepo();
  await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ...ALI });
  saatiAyarla("2026-10-19T10:05");
  const r = await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Başkası", telefon: "05330000009" });
  assert.match(r.hata, /10 dakika sonra/);
  const s = (await d.musaitlik("2026-10-21")).detay.find((x) => x.saat === "21:00");
  assert.deepEqual(s.opsiyon, { dk: 10 });
});

test("PDF dekont: model çalışmasa da düz metindeki IBAN, hesap adı ve tarihle doğrulanır", async () => {
  const { dekontOku, dekontDegerlendir } = await import("../src/dekont-kontrol.js");
  const env = { AI: {
    toMarkdown: async () => [{ data: "FAST İşlem Dekontu\nİşlem Tarihi: 21.10.2026 14:05\nAlıcı: AHMET AYSU\nAlıcı IBAN: TR70 0015 7000 0000 0154 8342 35\nTutar: 1.200,00 TL" }],
    run: async () => { throw new Error("model yok"); },
  } };
  const o = await dekontOku(env, { tur: "application/pdf", veri: new Uint8Array(300) });
  assert.equal(o.tarih, "2026-10-21");
  assert.equal(o.alici_iban, "TR700015700000000154834235");
  assert.match(o.alici_ad, /^AHMET AYSU/);
  assert.equal(o.tutar, "1.200,00");
  const d = dekontDegerlendir(o, { iban: "TR70 0015 7000 0000 0154 8342 35", alici: "Ahmet Aysu", kapora: 1200, rezTarihi: "2026-10-21", bugun: "2026-10-22" });
  assert.equal(d.onay, true, d.nedenler.join());
});

test("Dekont tarih kontrolü kapatılabilir (deneme dönemi)", async () => {
  const { dekontDegerlendir } = await import("../src/dekont-kontrol.js");
  const k = { iban: "TR70 0015 7000 0000 0154 8342 35", alici: "Ahmet Aysu", kapora: 1200, rezTarihi: "2026-10-21", bugun: "2026-10-22" };
  const eski = { alici_iban: "TR700015700000000154834235", alici_ad: "AHMET AYSU", tutar: 1200, tarih: "2025-01-05" };
  assert.equal(dekontDegerlendir(eski, k).onay, false);
  assert.equal(dekontDegerlendir(eski, { ...k, tarihKontrol: false }).onay, true);
});

test("Telefon kuralı: gerçek GSM öneki, uydurma numaralar reddedilir", async () => {
  const { telefonGercekci } = await import("../src/time.js");
  for (const t of ["05321112233", "05058044791", "05453519261", "05537048026", "05612345670"]) assert.ok(telefonGercekci(t), t);
  for (const t of ["05555555555", "05121112233", "05991112233", "05321234567", "0532111223"]) assert.equal(telefonGercekci(t), false, t);
  const d = demoDepo();
  assert.match((await d.olustur({ gunTarihi: "2026-10-21", saat: "21:00", ad: "Uydurma", telefon: "0555 555 55 55" })).hata, /geçerli görünmüyor/);
});

test("Abone 'gelmiyor': aynı saat bu haftanın bütün günlerinde (Cmt + Paz 08:00)", async () => {
  const d = demoDepo();
  const a = (await d.aboneKaydet({ ad: "Futbol Koleji", slotlar: [{ gun: 5, saat: "08:00" }, { gun: 5, saat: "09:00" }, { gun: 6, saat: "08:00" }, { gun: 6, saat: "09:00" }], baslangic: "2026-10-19" })).abone;
  const r = await d.aboneAtla({ id: a.id, gun: "2026-10-24", saat: "08:00", gelmiyor: true, kapsam: "ayni-saat" });
  assert.equal(r.sayi, 2);
  const h = await d.panelHafta("2026-10-19");
  assert.equal(h.gunler[5].saatler.find((x) => x.saat === "08:00").tur, "abone-gelmiyor");
  assert.equal(h.gunler[6].saatler.find((x) => x.saat === "08:00").tur, "abone-gelmiyor");
  assert.equal(h.gunler[6].saatler.find((x) => x.saat === "09:00").tur, "abone");
});

test("Puantaj: beklenen giriş ilk maçtan 1 saat önce; giriş/çıkış, gece yarısı çıkış, aylık ücret, düzeltme", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const a = await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" });
  const admin = await d.oturum(a.token);
  await d.kayitOl({ eposta: "p@aysu.com", ad: "Personel Bir", sifre: "personel-1", rol: "personel" });
  await d.kullaniciGuncelle({ eposta: "p@aysu.com", rol: "personel", durum: "aktif", saatlikUcret: "150" }, admin);
  const p = await d.oturum((await d.panelGiris({ eposta: "p@aysu.com", sifre: "personel-1" })).token);
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "19:00", ad: "Maç", telefon: "" });
  saatiAyarla("2026-10-19T17:55");
  const b = await d.puantajBugun(p);
  assert.equal(b.ilkMac, "19:00"); assert.equal(b.baslama, "18:00");
  assert.ok((await d.puantajGiris(p)).basarili);
  assert.match((await d.puantajGiris(p)).hata, /zaten/);
  saatiAyarla("2026-10-20T01:25"); // gece yarısından sonra çıkış → aynı işletme günü
  const c = await d.puantajCikis(p);
  assert.ok(c.basarili, JSON.stringify(c)); assert.equal(c.gun, "2026-10-19");
  const ay = await d.puantajAy("2026-10");
  assert.equal(ay.kisiler[0].saat, 8, "7,5 saat + yarım saat yol"); assert.equal(ay.kisiler[0].ucret, 1200);
  assert.match((await d.puantajDuzelt({ eposta: "p@aysu.com", gun: "2026-10-19", giris: "18:00", cikis: "02:00" }, p)).hata, /Admin ve Müdür/);
  assert.ok((await d.puantajDuzelt({ eposta: "p@aysu.com", gun: "2026-10-19", giris: "18:00", cikis: "02:00" }, admin)).basarili);
  assert.equal((await d.puantajAy("2026-10")).kisiler[0].saat, 8.5);
  assert.match((await d.kullaniciGuncelle({ eposta: "p@aysu.com", saatlikUcret: 999 }, p)).hata, /yetki|Admin/);
});

test("Kasa defteri: takvimden maçlar, kantin/krampon cirosu, stok farkı, yetki, devir", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const a = await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" });
  const admin = await d.oturum(a.token);
  await d.kayitOl({ eposta: "m@aysu.com", ad: "Müdür Bir", sifre: "mudur-123", rol: "mudur" });
  await d.kullaniciGuncelle({ eposta: "m@aysu.com", rol: "mudur", durum: "aktif" }, admin);
  const mudur = await d.oturum((await d.panelGiris({ eposta: "m@aysu.com", sifre: "mudur-123" })).token);
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "23:00", ad: "Berat", telefon: "", kapora: "1200" });
  await d.aboneKaydet({ ad: "Ekip", telefon: "0545 123 01 23", gun: 0, saat: "21:00", no: 13 });

  const k = await d.kasaGetir("2026-10-19", mudur);
  assert.equal(k.kayitli, false);
  // Berat'ın kaporası maç günü alındı: düşülmez, maç toplamına dahil
  assert.deepEqual(k.kayit.maclar.map((x) => [x.saat, x.tur, x.ad, x.ucret, x.onOdeme]), [["21:00", "abone", "Abone 13", 3200, 0], ["23:00", "normal", "Berat", 3700, 0]]);
  const su = k.urunler.find((u) => u.ad === "SU 0,50"), cay = k.urunler.find((u) => u.ad.startsWith("ÇAY"));
  assert.equal(su.stok, 305);

  const g = { ...k.kayit, devir: 500, sayilan: null, birakilan: 500 };
  g.maclar[1] = { ...g.maclar[1], krampon: 1, eldiven: 0, kantin: { [su.id]: 11, [cay.id]: 1 } };
  g.girisler = [{ aciklama: "Fevzi kapora", tutar: "960" }];
  g.cikislar = [{ aciklama: "Maaş", tutar: 1120 }];
  g.ikram = { "Müdür": { [cay.id]: 2 } };
  const r = await d.kasaKaydet(g, mudur);
  assert.ok(r.basarili, JSON.stringify(r));
  const o = r.kayit.ozet;
  assert.equal(o.maclar[1].toplam, 3700 + 100 + 11 * 25 + 25); // 4100 (Excel'deki gibi)
  assert.equal(o.ciro, 3200 + 4100);
  assert.equal(o.gelenKapora, 0, "aynı gün kapora ayrıca listelenmez");
  assert.equal(o.olmasiGereken, 7300 + 960 - 1120, "devir toplama katılmaz");
  assert.equal((await d.urunler()).find((u) => u.id === su.id).stok, 294);
  // Aynı günü tekrar kaydetmek stoğu iki kez düşmez; adet azalınca stok geri gelir
  g.maclar[1].kantin[su.id] = 9;
  assert.ok((await d.kasaKaydet(g, mudur)).basarili);
  assert.equal((await d.urunler()).find((u) => u.id === su.id).stok, 296);
  assert.equal((await d.urunler()).find((u) => u.id === cay.id).stok, 904 - 3);

  // Ertesi gün devir önceki günün bırakılanı
  saatiAyarla("2026-10-20T12:00");
  assert.equal((await d.kasaGetir("2026-10-20", mudur)).kayit.devir, 500);
  // Müdür 2 gün önceyi göremez, Admin görür
  saatiAyarla("2026-10-22T12:00");
  assert.match((await d.kasaGetir("2026-10-19", mudur)).hata, /Admin/);
  assert.ok((await d.kasaGetir("2026-10-19", admin)).kayitli);
  assert.equal((await d.kasaAy("2026-10")).toplam.ciro, 3200 + 3700 + 100 + 9 * 25 + 25);
  // Ürün: sadece Admin/Müdür; gelen mal stoğa eklenir
  assert.ok((await d.urunKaydet({ id: su.id, stokEkle: 100 }, mudur)).basarili);
  assert.equal((await d.urunler()).find((u) => u.id === su.id).stok, 396);
});

test("Kasa: kayıtlı gün rezervasyon eklenince / iptal edilince kendiliğinden güncellenir", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  const r1 = await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "20:00", ad: "Yusuf", telefon: "" });
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "22:00", ad: "Kantinli", telefon: "" });
  const k = await d.kasaGetir("2026-10-19", admin);
  const su = k.urunler[22].id;
  k.kayit.maclar[1].kantin = { [su]: 2 };
  assert.ok((await d.kasaKaydet({ ...k.kayit }, admin)).basarili);
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "23:00", ad: "Berat", telefon: "" });
  await d.panelRezGuncelle({ kayitNo: r1.kayitNo, durum: "İptal" });
  const k2 = await d.kasaGetir("2026-10-19", admin);
  assert.deepEqual(k2.kayit.maclar.map((m) => m.saat), ["22:00", "23:00"]);
  assert.equal(k2.kayit.maclar[0].kantin[su], 2, "girilmiş veri korunur");
  assert.ok((await d.islemler()).some((x) => x.islem === "Kasa takvimden güncellendi"));
});

test("Kasa: alınan kapora otomatik gelir, sonradan girilen kapora da güncellenir, '500 + 700' toplanır", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  const r = await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "20:00", ad: "Yusuf", telefon: "" });
  const k = await d.kasaGetir("2026-10-19", admin);
  assert.equal(k.kayit.maclar[0].onOdeme, 0);
  assert.ok((await d.kasaKaydet({ ...k.kayit }, admin)).basarili);
  saatiAyarla("2026-10-18T15:00"); // kapora maçtan önceki gün alındı
  await d.panelRezGuncelle({ kayitNo: r.kayitNo, kapora: "500 + 700" });
  saatiAyarla("2026-10-19T10:00");
  const k2 = await d.kasaGetir("2026-10-19", admin);
  assert.equal(k2.kayit.maclar[0].onOdeme, 1200);
  assert.equal(k2.kayit.ozet.olmasiGereken, 3700 - 1200);
  saatiAyarla("2026-10-18T12:00"); // ertesi haftanın maçına bugün kapora
  const r2 = await d.panelRezEkle({ gunTarihi: "2026-10-25", saat: "21:00", ad: "Fevzi", telefon: "", kapora: "960" });
  assert.ok(r2.basarili);
  assert.deepEqual((await d.kasaGetir("2026-10-18", admin)).kayit.gelenKaporalar.map((x) => [x.ad, x.tutar]), [["Yusuf", 1200], ["Fevzi", 960]]);
});


test("Kasa: maçtaki veresiye kantin stoktan düşer, ciroya girmez (sadece izinli abone: varsayılan Abone 1 ve 2)", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  await d.aboneKaydet({ ad: "Ekip", telefon: "0545 123 01 23", gun: 0, saat: "20:00", no: 1, ucret: "3700" });
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "22:00", ad: "Yusuf", telefon: "" });
  const k = await d.kasaGetir("2026-10-19", admin);
  const su = k.urunler[22];
  k.kayit.maclar[0].kantin = { [su.id]: 2 };
  k.kayit.maclar[0].veresiyeKantin = { [su.id]: 3 }; k.kayit.maclar[0].veresiyeKim = "Yusuf";
  k.kayit.maclar[1].veresiyeKantin = { [su.id]: 4 }; // normal müşteriye veresiye yok
  assert.equal(k.kayit.maclar[0].veresiyeAcik, true); assert.ok(!k.kayit.maclar[1].veresiyeAcik);
  const r = await d.kasaKaydet({ ...k.kayit }, admin);
  assert.deepEqual(r.kayit.maclar[1].veresiyeKantin, {});
  assert.equal(r.kayit.ozet.kantin, 2 * su.satis);
  assert.equal(r.kayit.ozet.veresiyeKantin, 3 * su.satis);
  assert.equal(r.kayit.ozet.ciro, 3700 + 3700 + 2 * su.satis);
  assert.equal((await d.urunler()).find((u) => u.id === su.id).stok, su.stok - 5);
});

test("Kasa PDF: Türkçe karakterli geçerli PDF üretir", async () => {
  const { kasaPdf } = await import("../src/kasa-pdf.js");
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  await d.panelRezEkle({ gunTarihi: "2026-10-19", saat: "20:00", ad: "Şükrü Işık", telefon: "" });
  const k = await d.kasaGetir("2026-10-19", admin);
  const r = await d.kasaKaydet({ ...k.kayit, not: "ğüşıöç" }, admin);
  const b = kasaPdf(r.kayit);
  assert.equal(new TextDecoder().decode(b.slice(0, 8)), "%PDF-1.4");
  assert.match(new TextDecoder("latin1").decode(b.slice(-40)), /%%EOF/);
  assert.ok(r.ilkKayit);
});

test("Veresiye: abonenin sonraki maçında o gün GELDİM diyen yöneticiye hatırlatma; ödenince durur", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  for (const [e, rol] of [["m@aysu.com", "mudur"], ["y@aysu.com", "mudur_yrd"]]) {
    await d.kayitOl({ eposta: e, ad: rol, sifre: "sifre-1234", rol });
    await d.kullaniciGuncelle({ eposta: e, rol, durum: "aktif" }, admin);
  }
  const yrd = await d.oturum((await d.panelGiris({ eposta: "y@aysu.com", sifre: "sifre-1234" })).token);
  await d.aboneKaydet({ ad: "Ekip", telefon: "0545 123 01 23", gun: 0, saat: "21:00", no: 2 });
  const k = await d.kasaGetir("2026-10-19", admin);
  k.kayit.maclar[0].veresiyeKantin = { [k.urunler[22].id]: 2 }; k.kayit.maclar[0].veresiyeKim = "Kaptan";
  assert.ok((await d.kasaKaydet({ ...k.kayit, otomatik: true }, admin)).otomatik);
  assert.equal((await d.acikVeresiyeler()).length, 1);
  saatiAyarla("2026-10-26T19:30");
  assert.equal((await d.veresiyeHatirlatmalari()).length, 0, "maçtan 1 saat önce değil");
  saatiAyarla("2026-10-26T18:00"); await d.puantajGiris(yrd);
  saatiAyarla("2026-10-26T20:05");
  const h = await d.veresiyeHatirlatmalari();
  assert.deepEqual(h[0].kime, ["y@aysu.com"], "o gün gelen yönetici");
  assert.equal(h[0].liste[0].kim, "Kaptan");
  assert.equal((await d.veresiyeHatirlatmalari()).length, 0, "aynı gün bir kez");
  assert.ok((await d.veresiyeOde({ gun: "2026-10-19", saat: "21:00" }, admin)).basarili);
  saatiAyarla("2026-11-02T20:05");
  assert.equal((await d.veresiyeHatirlatmalari()).length, 0, "ödendi");
});

test("Abone maçını bu hafta başka gün/saate taşır: asıl saat boşalır, yeni saate abone ücretiyle rezervasyon", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  const a = await d.aboneKaydet({ ad: "Ekip", telefon: "0545 123 01 23", gun: 3, saat: "20:00", no: 13, ucret: "3200" });
  const r = await d.aboneTasi({ id: a.abone.id, gun: "2026-10-22", saat: "20:00", yeniGun: "2026-10-23", yeniSaat: "22:00" });
  assert.ok(r.basarili, JSON.stringify(r));
  assert.equal(await tur(d, "2026-10-22", "20:00"), "abone-gelmiyor");
  assert.equal(await tur(d, "2026-10-23", "22:00"), "rez");
  assert.equal(await tur(d, "2026-10-29", "20:00"), "abone", "sonraki hafta değişmez");
  saatiAyarla("2026-10-23T12:00");
  const k = await d.kasaGetir("2026-10-23", admin);
  assert.deepEqual(k.kayit.maclar.map((m) => [m.saat, m.tur, m.ad, m.ucret]), [["22:00", "abone", "Abone 13 · Ekip", 3200]]);
  assert.match((await d.aboneTasi({ id: a.abone.id, gun: "2026-10-29", saat: "20:00", yeniGun: "2026-10-23", yeniSaat: "22:00" })).hata, /dolu/);
});

test("Personel kantini ücretinden düşülür; stok bitince satış durur", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  await d.kayitOl({ eposta: "p@aysu.com", ad: "Personel Bir", sifre: "personel-1", rol: "personel" });
  await d.kullaniciGuncelle({ eposta: "p@aysu.com", rol: "personel", durum: "aktif", saatlikUcret: "150" }, admin);
  const p = await d.oturum((await d.panelGiris({ eposta: "p@aysu.com", sifre: "personel-1" })).token);
  saatiAyarla("2026-10-19T18:00"); await d.puantajGiris(p);
  saatiAyarla("2026-10-19T23:30"); await d.puantajCikis(p); // 5,5 + 0,5 = 6 saat → 900 TL
  const k = await d.kasaGetir("2026-10-19", admin);
  const su = k.urunler[22], biskrem = k.urunler[0];
  assert.equal(biskrem.stok, 0);
  const r = await d.kasaKaydet({ ...k.kayit, ikram: { "p:p@aysu.com": { [su.id]: 2 } } }, admin);
  assert.ok(r.basarili, JSON.stringify(r));
  assert.equal(r.kayit.ozet.personelKantin, 2 * su.satis);
  const ay = await d.puantajAy("2026-10");
  assert.equal(ay.kisiler[0].brut, 900); assert.equal(ay.kisiler[0].kesinti, 50); assert.equal(ay.kisiler[0].ucret, 850);
  assert.equal((await d.kasaGetir("2026-10-19", admin)).calisanlar[0].ucret, 850);
  assert.match((await d.kasaKaydet({ ...r.kayit, ikram: { "VIP / ücretsiz ikram": { [biskrem.id]: 1 } } }, admin)).hata, /stokta yok/);
});

test("Puantaj: süre yarım saate yuvarlanır; çalışmadığı gün aldığı kantin çalıştığı ilk günden düşülür", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "k" });
  const admin = await d.oturum((await d.panelKur({ kurulumKodu: "k", eposta: "admin@aysu.com", ad: "Admin", sifre: "aysu-2026!" })).token);
  await d.kayitOl({ eposta: "p@aysu.com", ad: "Personel Bir", sifre: "personel-1", rol: "personel" });
  await d.kullaniciGuncelle({ eposta: "p@aysu.com", rol: "personel", durum: "aktif", saatlikUcret: "100" }, admin);
  const p = await d.oturum((await d.panelGiris({ eposta: "p@aysu.com", sifre: "personel-1" })).token);
  // 19 Ekim: çalışmıyor, ziyarete gelip kantinden aldı
  const k = await d.kasaGetir("2026-10-19", admin);
  assert.ok(k.personel.some((x) => x.eposta === "p@aysu.com" && !x.calisiyor));
  const su = k.urunler[22];
  assert.ok((await d.kasaKaydet({ ...k.kayit, ikram: { "p:p@aysu.com": { [su.id]: 2 } } }, admin)).basarili);
  assert.equal((await d.puantajAy("2026-10")).kisiler.length, 0);
  // 21 Ekim çalıştı: 18:00–23:20 → 5 sa 20 dk → 5,5 + 0,5 yol = 6 saat
  saatiAyarla("2026-10-21T18:00"); await d.puantajGiris(p);
  saatiAyarla("2026-10-21T23:20"); await d.puantajCikis(p);
  const kisi = (await d.puantajAy("2026-10")).kisiler[0];
  assert.equal(kisi.saat, 6);
  assert.equal(kisi.gunler[0].kesinti, 2 * su.satis, "ziyaret günündeki kantin ilk iş gününden düşülür");
  assert.equal(kisi.ucret, 600 - 2 * su.satis);
});
