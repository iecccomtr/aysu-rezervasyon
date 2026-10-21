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

test("Müşteri sınırları: kişi başı 4 aktif (ayda haftada bir), geçersiz girdiler", async () => {
  const d = demoDepo();
  assert.ok((await d.olustur({ gunTarihi: "2026-10-21", saat: "18:00", ...ALI })).basarili);
  assert.ok((await d.olustur({ gunTarihi: "2026-10-28", saat: "18:00", ...ALI })).basarili);
  assert.ok((await d.olustur({ gunTarihi: "2026-11-04", saat: "18:00", ...ALI })).basarili);
  assert.ok((await d.olustur({ gunTarihi: "2026-11-11", saat: "18:00", ...ALI })).basarili);
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
  assert.deepEqual((await d.aboneListe()).map((a) => a.no).sort((x, y) => x - y), [1, 2, 17]);
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

test("Mesai planı: ilk maçtan 1 saat önce başlama; alıcılar sadece Personel / Temizlik Şefi", async () => {
  const d = demoDepo({ PANEL_KURULUM_KODU: "kod123" });
  const m = await d.panelKur({ kurulumKodu: "kod123", eposta: "mudur@aysu.com", sifre: "aysu-2026!" });
  const mudur = await d.oturum(m.token);
  await d.kayitOl({ eposta: "p@aysu.com", ad: "Personel Bir", sifre: "personel-1", rol: "personel" });
  await d.kullaniciGuncelle({ eposta: "p@aysu.com", rol: "personel", durum: "aktif" }, mudur);
  await d.kayitOl({ eposta: "bekleyen@aysu.com", ad: "Onaysız", sifre: "personel-1", rol: "personel" });
  await d.panelRezEkle({ gunTarihi: "2026-10-23", saat: "19:00", ad: "Fevzi", telefon: "" });
  await d.panelRezEkle({ gunTarihi: "2026-10-23", saat: "01:00", ad: "Gece", telefon: "" });
  const p = await d.mesaiPlani("2026-10-23");
  assert.equal(p.ilk, "19:00");
  assert.equal(p.baslama, "18:00");
  assert.equal(p.son, "01:00");
  assert.equal(p.bitis, "02:00");
  assert.deepEqual(p.alicilar.map((a) => a.eposta), ["p@aysu.com"]);
  assert.equal((await d.mesaiPlani("2026-10-28")).maclar.length >= 0, true);
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
