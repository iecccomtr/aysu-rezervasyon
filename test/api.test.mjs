// Sitenin API uçlarını gerçek Worker koduyla uçtan uca test eder (demo depo ile).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { saatiAyarla, saatiSifirla, demoDepo, haftalikTablo } from "./yardimci.mjs";

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
    throw new Error("Beklenmeyen dış istek: " + url);
  };
  const depo = demoDepo();
  await depo.demoHaftalikAyarla(haftalikTablo({ "PERŞEMBE|21:00": "ABONE - 3" }));
  const tamEnv = {
    REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
    ASSETS: { fetch: async () => new Response("sayfa") },
    ...env,
  };
  const bekleyenler = [];
  const ctx = { waitUntil: (p) => bekleyenler.push(p) };
  const istek = async (yol, govde, basliklar = {}) => {
    const r = await worker.fetch(new Request("https://site.test" + yol, govde === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", ...basliklar }, body: JSON.stringify(govde),
    }), tamEnv, ctx);
    await Promise.all(bekleyenler.splice(0));
    return { durum: r.status, veri: await r.json().catch(() => null), r };
  };
  return { istek, depo };
}

const REZ = { tarih: "2026-10-22", saat: "22:00", ad: "Ali Veli", telefon: "0532 111 22 33", kvkk: true };

test("Müsaitlik: gece yarısından önce bugünün gece maçları ve 7 gün sonrası listelenir", async () => {
  const { istek } = await kur();
  const { durum, veri } = await istek("/api/musaitlik");
  assert.equal(durum, 200);
  assert.equal(veri.gunler[0].tarih, "2026-10-21");
  assert.deepEqual(veri.gunler[0].saatler.map((s) => s.saat), ["00:00", "01:00", "02:00"]);
  assert.equal(veri.gunler.at(-1).tarih, "2026-10-28");
  const persembe = veri.gunler.find((g) => g.tarih === "2026-10-22");
  assert.equal(persembe.saatler.find((s) => s.saat === "21:00").bos, false, "abone dolu");
  assert.equal(veri.fiyat, 3700);
  assert.equal(veri.kapora, 1200);
});

test("Rezervasyon: kayıt, IBAN ve kalan tutar döner; işletmeye e-posta gider", async () => {
  const { istek } = await kur({ RESEND_API_KEY: "re_test" });
  const { durum, veri } = await istek("/api/rezervasyon", REZ);
  assert.equal(durum, 200, JSON.stringify(veri));
  assert.match(veri.kayitNo, /^AY-/);
  assert.equal(veri.kalan, 2500);
  assert.match(veri.iban, /^TR70/);
  assert.equal(epostalar.length, 1);
  assert.deepEqual(epostalar[0].to, ["aysuhalisaha@gmail.com"]);
  assert.match(epostalar[0].subject, /Yeni rezervasyon: Perşembe 22:00/);
  assert.match(epostalar[0].html, /Ali Veli/);

  const tekrar = await istek("/api/musaitlik");
  const s = tekrar.veri.gunler.find((g) => g.tarih === "2026-10-22").saatler.find((x) => x.saat === "22:00");
  assert.equal(s.bos, false, "ayrılan saat artık dolu");
});

test("Rezervasyon: e-posta anahtarı yoksa sorunsuz devam eder", async () => {
  const { istek } = await kur();
  const { durum } = await istek("/api/rezervasyon", REZ);
  assert.equal(durum, 200);
  assert.equal(epostalar.length, 0);
});

test("Rezervasyon: dolu saat, eksik onay, bot alanı ve yabancı site reddedilir", async () => {
  const { istek } = await kur();
  assert.equal((await istek("/api/rezervasyon", { ...REZ, saat: "21:00" })).durum, 409);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, kvkk: false })).durum, 400);
  assert.equal((await istek("/api/rezervasyon", { ...REZ, web: "http://spam" })).durum, 400);
  assert.equal((await istek("/api/rezervasyon", REZ, { origin: "https://kotu.site" })).durum, 403);
  const r = await worker.fetch(new Request("https://site.test/api/rezervasyon", { method: "POST", body: "{bozuk" }),
    { REZERVASYON_DEPOSU: { idFromName: () => "x", get: () => ({}) } }, { waitUntil() {} });
  assert.equal(r.status, 400);
});

test("Gece maçı: Perşembe gecesi 01:00 takvimde Cuma'ya yazılır", async () => {
  const { istek, depo } = await kur();
  const { veri } = await istek("/api/rezervasyon", { ...REZ, saat: "01:00" });
  assert.equal(veri.tarih, "2026-10-23");
  assert.equal(veri.gun, "Perşembe gecesi");
  assert.equal((await depo.bul("05321112233")).rezervasyonlar[0].tarih, "2026-10-23");
});

test("İptal: doğru kayıt no + telefonla yapılır, saat yeniden boşalır", async () => {
  const { istek } = await kur({ RESEND_API_KEY: "re_test" });
  const { veri } = await istek("/api/rezervasyon", REZ);
  assert.equal((await istek("/api/iptal", { kayitNo: veri.kayitNo, telefon: "05329999999" })).durum, 409);
  const iptal = await istek("/api/iptal", { kayitNo: veri.kayitNo, telefon: "0532 111 22 33" });
  assert.equal(iptal.durum, 200);
  assert.match(epostalar.at(-1).subject, /^İptal/);
  const m = await istek("/api/musaitlik");
  assert.equal(m.veri.gunler.find((g) => g.tarih === "2026-10-22").saatler.find((x) => x.saat === "22:00").bos, true);
});

test("Ana sayfa tabelası ve sağlık kontrolü", async () => {
  const { istek } = await kur();
  const t = await istek("/api/bos-saatler");
  assert.equal(t.veri.bugun.tarih, "2026-10-21");
  assert.equal(t.veri.yarin.tarih, "2026-10-22");
  assert.deepEqual((await istek("/api/saglik")).veri, { tamam: true, depo: "demo" });
  assert.equal((await istek("/api/sohbet", {})).durum, 404, "sohbet kaldırıldı");
});
