// Sitenin ve panelin API uçlarını gerçek Worker koduyla uçtan uca test eder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { saatiAyarla, saatiSifirla, demoDepo } from "./yardimci.mjs";

const gercekFetch = globalThis.fetch;
let epostalar;
after(() => { saatiSifirla(); globalThis.fetch = gercekFetch; });

async function kur(env = {}) {
  saatiAyarla("2026-10-21T23:30"); // Çarşamba gece
  epostalar = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      epostalar.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (String(url).startsWith("https://challenges.cloudflare.com/")) {
      return Response.json({ success: init.body.get("response") === "insan" });
    }
    throw new Error("Beklenmeyen dış istek: " + url);
  };
  const depo = demoDepo({ PANEL_KURULUM_KODU: "kurulum-kodu" });
  await depo.aboneKaydet({ ad: "Abone Üç", gun: 3, saat: "21:00", baslangic: "2026-10-01" }); // Perşembe 21:00
  const tamEnv = {
    PANEL_KURULUM_KODU: "kurulum-kodu",
    REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
    ASSETS: { fetch: async () => new Response("sayfa") },
    ...env,
  };
  const bekleyen = [];
  const ctx = { waitUntil: (p) => bekleyen.push(p) };
  let cerez = "";
  const istek = async (yol, govde, basliklar = {}) => {
    const h = { ...(cerez ? { cookie: cerez } : {}), ...basliklar };
    const init = govde === undefined ? { headers: h } : {
      method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(govde),
    };
    const r = await worker.fetch(new Request("https://site.test" + yol, init), tamEnv, ctx);
    await Promise.all(bekleyen.splice(0));
    const sc = r.headers.get("set-cookie");
    if (sc) cerez = sc.split(";")[0];
    return { durum: r.status, veri: await r.json().catch(() => null), r };
  };
  return { istek, depo, cerezSil: () => { cerez = ""; } };
}

const REZ = { tarih: "2026-10-22", saat: "22:00", ad: "Ali Veli", telefon: "0532 111 22 33", kvkk: true };

test("Müsaitlik: bu gecenin maçları + 4 hafta; abone dolu", async () => {
  const { istek } = await kur();
  const { durum, veri } = await istek("/api/musaitlik");
  assert.equal(durum, 200);
  assert.equal(veri.gunler[0].tarih, "2026-10-21");
  assert.deepEqual(veri.gunler[0].saatler.map((s) => s.saat), ["00:00", "01:00", "02:00"]);
  assert.equal(veri.gunler.at(-1).tarih, "2026-11-17");
  const per = veri.gunler.find((g) => g.tarih === "2026-10-22");
  assert.equal(per.saatler.find((s) => s.saat === "21:00").bos, false);
  assert.equal(veri.fiyat, 3700);
});

test("Rezervasyon: kayıt, IBAN, kalan; e-posta anahtarı varsa işletmeye e-posta", async () => {
  const { istek } = await kur({ RESEND_API_KEY: "re_test" });
  const { durum, veri } = await istek("/api/rezervasyon", REZ);
  assert.equal(durum, 200, JSON.stringify(veri));
  assert.match(veri.kayitNo, /^AY-/);
  assert.equal(veri.kalan, 2500);
  assert.match(veri.iban, /^TR70/);
  assert.equal(epostalar.length, 1);
  assert.match(epostalar[0].subject, /Yeni rezervasyon: Perşembe 22:00/);
  const m = await istek("/api/musaitlik");
  assert.equal(m.veri.gunler.find((g) => g.tarih === "2026-10-22").saatler.find((s) => s.saat === "22:00").bos, false);
});

test("Rezervasyon: dolu saat, onaysız, bot alanı, yabancı site reddedilir; e-postasız da çalışır", async () => {
  const { istek } = await kur();
  assert.equal((await istek("/api/rezervasyon", { ...REZ, saat: "21:00" })).durum, 409);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, kvkk: false })).durum, 400);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, web: "x" })).durum, 400);
  assert.equal((await istek("/api/rezervasyon", REZ, { origin: "https://kotu.site" })).durum, 403);
  assert.equal((await istek("/api/rezervasyon", REZ)).durum, 200);
  assert.equal(epostalar.length, 0);
});

test("Bot koruması (Turnstile): anahtar varsa doğrulamasız rezervasyon/kayıt reddedilir", async () => {
  const { istek } = await kur({ TURNSTILE_SECRET: "gizli", TURNSTILE_SITE_KEY: "0xSITE" });
  assert.equal((await istek("/api/musaitlik")).veri.dogrulama, "0xSITE");
  assert.equal((await istek("/api/rezervasyon", REZ)).durum, 403);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, dogrulama: "bot" })).durum, 403);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, dogrulama: "insan" })).durum, 200);
  assert.equal((await istek("/api/panel/kayit", { eposta: "x@aysu.com", ad: "Bot", sifre: "12345678", rol: "personel" })).durum, 403);
  assert.equal((await istek("/api/panel/kayit", { eposta: "x@aysu.com", ad: "İnsan", sifre: "12345678", rol: "personel", dogrulama: "insan" })).durum, 200);
});

test("İptal: doğru kayıt no + telefonla; saat yeniden boşalır", async () => {
  const { istek } = await kur();
  const { veri } = await istek("/api/rezervasyon", REZ);
  assert.equal((await istek("/api/iptal", { kayitNo: veri.kayitNo, telefon: "05329999999" })).durum, 409);
  assert.equal((await istek("/api/iptal", { kayitNo: veri.kayitNo, telefon: "0532 111 22 33" })).durum, 200);
  const m = await istek("/api/musaitlik");
  assert.equal(m.veri.gunler.find((g) => g.tarih === "2026-10-22").saatler.find((s) => s.saat === "22:00").bos, true);
});

test("Panel: girişsiz erişim yok; kurulum, giriş, çıkış", async () => {
  const { istek, cerezSil } = await kur();
  const d0 = (await istek("/api/panel/durum")).veri;
  assert.equal(d0.kurulu, false); assert.equal(d0.girisli, false);
  assert.equal((await istek("/api/panel/hafta")).durum, 401);
  assert.equal((await istek("/api/panel/kur", { kurulumKodu: "yanlis", eposta: "m@aysu.com", sifre: "12345678" })).durum, 400);
  const k = await istek("/api/panel/kur", { kurulumKodu: "kurulum-kodu", eposta: "m@aysu.com", ad: "Ahmet", sifre: "aysu-sifre-1" });
  assert.equal(k.durum, 200);
  assert.match(k.r.headers.get("set-cookie"), /aysu_panel=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await istek("/api/panel/hafta")).durum, 200);
  assert.equal((await istek("/api/panel/durum")).veri.kullanici.rol, "admin");
  await istek("/api/panel/cikis", {});
  assert.equal((await istek("/api/panel/hafta")).durum, 401);
  cerezSil();
  assert.equal((await istek("/api/panel/giris", { eposta: "m@aysu.com", sifre: "yanlis" })).durum, 401);
  assert.equal((await istek("/api/panel/giris", { eposta: "m@aysu.com", sifre: "aysu-sifre-1" })).durum, 200);
  assert.equal((await istek("/api/panel/durum")).veri.girisli, true);
  assert.equal((await istek("/api/panel/hafta", {}, { origin: "https://kotu.site" })).durum, 403);
});

test("Panel: kayıt, onay, Temizlik Şefi sadece haftayı telefonsuz görür; şifre sıfırlama e-postası", async () => {
  const { istek, cerezSil } = await kur({ RESEND_API_KEY: "re_test" });
  await istek("/api/panel/kur", { kurulumKodu: "kurulum-kodu", eposta: "m@aysu.com", sifre: "aysu-sifre-1" });
  await istek("/api/panel/rez", { gun: "2026-10-23", saat: "20:00", ad: "Eren", telefon: "0533 000 00 00", kapora: "1200" });
  cerezSil();
  assert.equal((await istek("/api/panel/kayit", { eposta: "t@aysu.com", ad: "Ayşe Temiz", sifre: "temizlik-1", rol: "personel" })).durum, 200);
  // Onay e-postası Admin'e gider; bağlantıdaki sayfa bilgi gösterir, onay POST ile olur
  const onayEp = epostalar.at(-1);
  assert.deepEqual(onayEp.to, ["m@aysu.com"]);
  assert.match(onayEp.subject, /^Onay bekliyor: Ayşe Temiz \(Personel\)/);
  const onayToken = onayEp.text.match(/#onay=([0-9a-f]{64})/)[1];
  assert.match((await istek("/api/panel/giris", { eposta: "t@aysu.com", sifre: "temizlik-1" })).veri.hata, /onay/);
  await istek("/api/panel/giris", { eposta: "m@aysu.com", sifre: "aysu-sifre-1" });
  const liste = (await istek("/api/panel/kullanicilar")).veri;
  assert.equal(liste[0].durum, "bekliyor");
  // Admin işlem kaydını görür
  await istek("/api/panel/kullanici", { eposta: "t@aysu.com", rol: "personel" });
  const islem = (await istek("/api/panel/islemler")).veri;
  assert.equal(islem[0].islem, "Kullanıcı güncelledi");
  cerezSil();
  const bilgi = (await istek(`/api/panel/onay?t=${onayToken}`)).veri;
  assert.equal(bilgi.ad, "Ayşe Temiz"); assert.equal(bilgi.rolAd, "Personel");
  assert.equal((await istek(`/api/panel/onay?t=${onayToken}`)).veri.ad, "Ayşe Temiz", "GET onaylamaz");
  const onay = await istek("/api/panel/onay", { token: onayToken, karar: "onayla" });
  assert.equal(onay.durum, 200, JSON.stringify(onay.veri));
  assert.equal((await istek("/api/panel/onay", { token: onayToken, karar: "onayla" })).durum, 400, "tek kullanımlık");
  await istek("/api/panel/giris", { eposta: "m@aysu.com", sifre: "aysu-sifre-1" });
  assert.equal((await istek("/api/panel/kullanici", { eposta: "t@aysu.com", rol: "temizlik" })).durum, 200);
  cerezSil();
  await istek("/api/panel/giris", { eposta: "t@aysu.com", sifre: "temizlik-1" });
  const h = (await istek("/api/panel/hafta?bas=2026-10-19")).veri;
  const s = h.gunler.find((g) => g.tarih === "2026-10-23").saatler.find((x) => x.saat === "20:00");
  assert.equal(s.rez.ad, "Eren");
  assert.equal(s.rez.telefon, undefined);
  assert.equal(s.rez.kapora, undefined);
  const ab = h.gunler.find((g) => g.tarih === "2026-10-22").saatler.find((x) => x.saat === "21:00").abone;
  assert.deepEqual(ab, { no: 1 }, "salt-okur rol abonenin adını değil numarasını görür");
  for (const [yol, govde] of [["aboneler"], ["musteriler"], ["kullanicilar"], ["rez", { gun: "2026-10-24", saat: "10:00", ad: "X" }], ["abone-atla", {}]]) {
    assert.equal((await istek("/api/panel/" + yol, govde)).durum, 403, yol);
  }
  cerezSil();
  const n = epostalar.length;
  assert.deepEqual((await istek("/api/panel/sifre-unuttum", { eposta: "yok@aysu.com" })).veri, { basarili: true, eposta: true });
  assert.equal(epostalar.length, n);
  await istek("/api/panel/sifre-unuttum", { eposta: "t@aysu.com" });
  assert.equal(epostalar.length, n + 1);
  assert.deepEqual(epostalar.at(-1).to, ["t@aysu.com"]);
  const token = epostalar.at(-1).text.match(/#sifirla=([0-9a-f]{64})/)[1];
  assert.equal((await istek("/api/panel/sifre-sifirla", { token, sifre: "yeni-temizlik" })).durum, 200);
  assert.equal((await istek("/api/panel/hafta")).durum, 200);
});

test("Panel: telefon rezervasyonu, kapora onayı, abone 'gelmiyor', CRM", async () => {  const { istek, depo } = await kur();
  await istek("/api/panel/kur", { kurulumKodu: "kurulum-kodu", eposta: "m@aysu.com", sifre: "aysu-sifre-1" });

  const t = await istek("/api/panel/rez", { gun: "2026-10-23", saat: "20:00", ad: "Eren", telefon: "0533 000 00 00", kapora: "1200" });
  assert.equal(t.durum, 200, JSON.stringify(t.veri));
  assert.equal(t.veri.durum, "Onaylı");
  const online = await istek("/api/rezervasyon", REZ);

  let h = await istek("/api/panel/hafta?bas=2026-10-19");
  assert.deepEqual(h.veri.bekleyenler.map((r) => r.kayitNo), [online.veri.kayitNo]);
  const g = await istek("/api/panel/rez-guncelle", { kayitNo: online.veri.kayitNo, durum: "Onaylı", kapora: "1000 + 200" });
  assert.equal(g.veri.rez.kapora, "1000 + 200");
  h = await istek("/api/panel/hafta?bas=2026-10-19");
  assert.equal(h.veri.bekleyenler.length, 0);

  const aboneler = (await istek("/api/panel/aboneler")).veri;
  assert.equal(aboneler[0].ad, "Abone Üç");
  assert.equal((await istek("/api/panel/abone-atla", { id: aboneler[0].id, gun: "2026-10-22", gelmiyor: true })).durum, 200);
  const m = await istek("/api/musaitlik");
  assert.equal(m.veri.gunler.find((x) => x.tarih === "2026-10-22").saatler.find((s) => s.saat === "21:00").bos, true);

  const yeni = await istek("/api/panel/abone", { ad: "Futbol Koleji", telefon: "0553 704 80 26", gun: 5, saat: "08:00" });
  assert.equal(yeni.durum, 200);
  assert.equal((await istek("/api/panel/abone", { ad: "Çakışan", gun: 5, saat: "08:00" })).durum, 400);

  await istek("/api/panel/musteri-not", { telefon: "0532 111 22 33", not: "İyi müşteri", etiket: "VIP" });
  const ml = (await istek("/api/panel/musteriler")).veri;
  const ali = ml.find((x) => x.telefon === "05321112233");
  assert.equal(ali.etiket, "VIP");
  assert.equal(ali.gelecek.tarih, "2026-10-22");
  const det = (await istek("/api/panel/musteri?tel=05321112233")).veri;
  assert.equal(det.rezervasyonlar[0].kayitNo, online.veri.kayitNo);
  assert.ok(depo);
});

test("Ana sayfa tabelası, sağlık, eski uçlar kaldırıldı", async () => {
  const { istek } = await kur();
  const t = await istek("/api/bos-saatler");
  assert.equal(t.veri.bugun.tarih, "2026-10-21");
  assert.equal(t.veri.yarin.tarih, "2026-10-22");
  assert.deepEqual((await istek("/api/saglik")).veri, { tamam: true, depo: "cloudflare" });
  assert.equal((await istek("/api/sohbet", {})).durum, 404);
});

test("Fotoğraf: statik dosya yoksa eski siteden bir kez indirilip saklanır; eski adresler yönlenir", async () => {
  const { depo } = await kur();
  let indirme = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /aysuhalisaha\.com\/app\/dn_content\/5d873c9ebd44f\.jpg$/);
    indirme++;
    return new Response(new Uint8Array([255, 216, 255, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  };
  const env = {
    REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
    ASSETS: { fetch: async () => new Response("yok", { status: 404 }) },
  };
  const ctx = { waitUntil() {} };
  for (let i = 0; i < 2; i++) {
    const r = await worker.fetch(new Request("https://site.test/galeri/saha.jpg"), env, ctx);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal((await r.arrayBuffer()).byteLength, 6);
  }
  assert.equal(indirme, 1, "ikinci istekte veritabanından gelmeli");
  assert.equal((await worker.fetch(new Request("https://site.test/galeri/bilinmeyen.jpg"), env, ctx)).status, 404);
  const y = await worker.fetch(new Request("https://site.test/hakkimizda.php"), env, ctx);
  assert.equal(y.status, 301);
  assert.equal(y.headers.get("location"), "https://site.test/#konum");
  assert.equal((await worker.fetch(new Request("https://site.test/blog/6/kapali-hali-saha-hizmeti"), env, ctx)).headers.get("location"), "https://site.test/");
});
