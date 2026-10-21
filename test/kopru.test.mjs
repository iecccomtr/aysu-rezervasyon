// Apps Script köprüsü modu: Worker ↔ Kod.gs sözleşmesi (sahte köprü sunucusuyla).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { saatiAyarla, saatiSifirla, demoDepo, haftalikTablo } from "./yardimci.mjs";

const gercekFetch = globalThis.fetch;
after(() => { saatiSifirla(); globalThis.fetch = gercekFetch; });

const MAVI = { rgbColor: { red: 0.07, green: 0.2, blue: 0.85 } };
const SIYAH = { rgbColor: { red: 0, green: 0, blue: 0 } };

function sahteKopru() {
  // Kod.gs'nin döndürdüğü biçim: dolu hücre {metin, renk}, boş hücre ""
  const ham = haftalikTablo({
    "PERŞEMBE|21:00": { metin: "ABONE - 8", renk: MAVI },
    "PERŞEMBE|22:00": { metin: "ABONE - 9", renk: SIYAH },
  }).map((r) => r.map((h) => (h && typeof h === "object" ? h : h ? { metin: h, renk: null } : "")));
  const online = [["Tarih", "Gün", "Saat", "Ad Soyad", "Telefon", "Durum", "Kayıt No", "Not", "Oluşturma", "Ödenen Kapora"]];
  const istekler = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://script.google.com/macros/s/TEST/exec");
    const g = JSON.parse(init.body);
    istekler.push(g);
    const c = (v) => new Response(JSON.stringify(v));
    if (g.anahtar !== "gizli") return c({ hata: "Yetkisiz" });
    if (g.islem === "oku") return c({ haftalik: ham, online });
    if (g.islem === "ekle") { online.push(g.satir.map(String)); return c({ tamam: true, satirNo: online.length }); }
    if (g.islem === "guncelle") { online[g.satirNo - 1][g.sutun - 1] = g.deger; return c({ tamam: true }); }
    if (g.islem === "eposta") return c({ tamam: true });
    return c({ hata: "Bilinmeyen işlem" });
  };
  return { online, istekler };
}

async function kur(anahtar = "gizli") {
  saatiAyarla("2026-10-21T23:30");
  const kopru = sahteKopru();
  const depo = demoDepo({ SCRIPT_URL: "https://script.google.com/macros/s/TEST/exec", SCRIPT_ANAHTAR: anahtar });
  const env = {
    SCRIPT_URL: "https://script.google.com/macros/s/TEST/exec", SCRIPT_ANAHTAR: anahtar,
    REZERVASYON_DEPOSU: { idFromName: () => "aysu", get: () => depo },
    ASSETS: { fetch: async () => new Response("sayfa") },
  };
  const bekleyen = [];
  const ctx = { waitUntil: (p) => bekleyen.push(p) };
  const istek = async (yol, govde) => {
    const r = await worker.fetch(new Request("https://site.test" + yol, govde === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(govde),
    }), env, ctx);
    await Promise.all(bekleyen.splice(0));
    return { durum: r.status, veri: await r.json() };
  };
  return { ...kopru, istek };
}

test("Köprü: sağlık kontrolü köprü modunu gösterir", async () => {
  const { istek } = await kur();
  assert.equal((await istek("/api/saglik")).veri.depo, "google-sheets (apps script)");
});

test("Köprü: renkli abone dolu, siyah abone bu hafta boş", async () => {
  const { istek } = await kur();
  const { veri } = await istek("/api/musaitlik");
  const per = veri.gunler.find((g) => g.tarih === "2026-10-22").saatler;
  assert.equal(per.find((s) => s.saat === "21:00").bos, false);
  assert.equal(per.find((s) => s.saat === "22:00").bos, true);
});

test("Köprü: rezervasyon satırı eklenir, e-posta köprüden gider, iptal Durum sütununu (F=6) günceller", async () => {
  const { istek, online, istekler } = await kur();
  const r = await istek("/api/rezervasyon", { tarih: "2026-10-22", saat: "22:00", ad: "Ali Veli", telefon: "05321112233", kvkk: true });
  assert.equal(r.durum, 200, JSON.stringify(r.veri));
  assert.deepEqual(online[1].slice(0, 7), ["2026-10-22", "Perşembe", "22:00", "Ali Veli", "05321112233", "Kapora bekleniyor", r.veri.kayitNo]);
  const ep = istekler.find((g) => g.islem === "eposta");
  assert.ok(ep, "e-posta köprüden gönderilmeli");
  assert.equal(ep.alici, "aysuhalisaha@gmail.com");
  assert.match(ep.konu, /Yeni rezervasyon/);

  const tekrar = await istek("/api/rezervasyon", { tarih: "2026-10-22", saat: "22:00", ad: "Başka Biri", telefon: "05324445566", kvkk: true });
  assert.equal(tekrar.durum, 409);

  const iptal = await istek("/api/iptal", { kayitNo: r.veri.kayitNo, telefon: "05321112233" });
  assert.equal(iptal.durum, 200);
  assert.equal(online[1][5], "İptal");
  const g = istekler.find((x) => x.islem === "guncelle");
  assert.equal(g.sutun, 6);
  assert.equal(g.satirNo, 2);
});

test("Köprü: yanlış anahtar sitede anlaşılır bir hata verir", async () => {
  const { istek } = await kur("yanlis");
  const { durum, veri } = await istek("/api/musaitlik");
  assert.equal(durum, 503);
  assert.match(veri.hata, /okunamıyor/);
});
