import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { saatiAyarla, saatiSifirla, demoDepo, haftalikTablo } from "./yardimci.mjs";

const gercekFetch = globalThis.fetch;
beforeEach(() => saatiAyarla("2026-10-19T10:00"));
after(() => { saatiSifirla(); globalThis.fetch = gercekFetch; });

// ---------------- Google E-Tablo modu (sahte Google sunucusu) ----------------

function sahteGoogle(haftalik) {
  const online = [["Tarih", "Gün", "Saat", "Ad Soyad", "Telefon", "Durum", "Kayıt No", "Not", "Oluşturma", "Ödenen Kapora"]];
  const sekmeler = ["REZERVASYON", "GÖREVLER"];
  const istekler = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = decodeURIComponent(String(url));
    istekler.push({ u, method: init.method || "GET", body: init.body });
    const cevap = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const jwt = new URLSearchParams(init.body).get("assertion");
      assert.equal(jwt.split(".").length, 3, "JWT imzalı olmalı");
      return cevap({ access_token: "tok", expires_in: 3600 });
    }
    assert.match(init.headers.authorization, /Bearer tok/);
    if (u.includes("?fields=sheets.properties.title")) {
      return cevap({ sheets: sekmeler.map((title) => ({ properties: { title } })) });
    }
    if (u.includes(":batchUpdate")) {
      const t = JSON.parse(init.body).requests[0].addSheet.properties.title;
      sekmeler.push(t);
      return cevap({});
    }
    if (u.includes("?ranges='REZERVASYON'") && u.includes("fields=")) {
      assert.match(u, /foregroundColor/, "yazı rengi istenmeli");
      const rowData = haftalik.map((r) => ({
        values: r.map((c) => (c && typeof c === "object"
          ? { formattedValue: c.metin, effectiveFormat: { textFormat: c.renk ? { foregroundColorStyle: c.renk } : {} } }
          : c ? { formattedValue: c, effectiveFormat: { textFormat: {} } } : {})),
      }));
      return cevap({ sheets: [{ data: [{ rowData }] }] });
    }
    if (u.includes("/values/'Online Rezervasyonlar'!A1:J?")) {
      return cevap({ values: online });
    }
    if (u.includes(":append")) {
      online.push(JSON.parse(init.body).values[0]);
      return cevap({});
    }
    const m = u.match(/'Online Rezervasyonlar'!F(\d+)\?/);
    if (m && init.method === "PUT") {
      online[Number(m[1]) - 1][5] = JSON.parse(init.body).values[0][0];
      return cevap({});
    }
    if (u.includes("'Online Rezervasyonlar'!A1:J1") && init.method === "PUT") return cevap({});
    throw new Error("Beklenmeyen istek: " + u);
  };
  return { online, sekmeler, istekler };
}

test("Google E-Tablo: sekme oluşturur, haftalık tabloyu okur, satır ekler ve iptal eder", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    SHEET_ID: "test-sheet",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@proje.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n"),
  };
  const MAVI = { rgbColor: { red: 0.07, green: 0.2, blue: 0.85 } };
  const google = sahteGoogle(haftalikTablo({ "ÇARŞAMBA|21:00": { metin: "ABONE - 8", renk: MAVI } }));
  const d = demoDepo(env);

  const car = await d.musaitlik("2026-10-21");
  assert.ok(!car.bosSaatler.includes("21:00"), "tablodaki abone okunmalı");
  assert.ok(google.sekmeler.includes("Online Rezervasyonlar"), "sekme oluşturulmalı");

  const r = await d.olustur({ gunTarihi: "2026-10-21", saat: "22:00", ad: "Ali Veli", telefon: "05321112233" });
  assert.ok(r.basarili, JSON.stringify(r));
  const satir = google.online[1];
  assert.deepEqual(satir.slice(0, 7), ["2026-10-21", "Çarşamba", "22:00", "Ali Veli", "05321112233", "Kapora bekleniyor", r.kayitNo]);

  // Haftalık tabloya HİÇ yazılmamalı
  assert.ok(!google.istekler.some((i) => i.method !== "GET" && i.u.includes("'REZERVASYON'")));

  const ikinci = await d.olustur({ gunTarihi: "2026-10-21", saat: "22:00", ad: "Başka Biri", telefon: "05324445566" });
  assert.match(ikinci.hata, /dolu/);

  const iptal = await d.iptal({ kayitNo: r.kayitNo, telefon: "05321112233" });
  assert.ok(iptal.basarili);
  assert.equal(google.online[1][5], "İptal");
});

test("Google E-Tablo: SİYAH yazılmış ABONE bu hafta boş, gelecek hafta dolu", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    SHEET_ID: "test-sheet",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@proje.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const MAVI = { rgbColor: { blue: 0.8, green: 0.2 } };
  const SIYAH = { rgbColor: {} };
  sahteGoogle(haftalikTablo({
    "PAZARTESİ|21:00": { metin: "ABONE - 15", renk: SIYAH },   // bu hafta gelmiyor
    "PAZARTESİ|22:00": { metin: "ABONE - 10", renk: MAVI },    // geliyor
    "PAZARTESİ|23:00": { metin: "ABONE - 3" },                 // renk yok = varsayılan siyah
    "PAZARTESİ|20:00": { metin: "ABONE - 6", renk: { themeColor: "ACCENT1" } }, // tema rengi = renkli
  }));
  const d = demoDepo(env);
  const buPzt = await d.musaitlik("2026-10-19");
  assert.ok(buPzt.bosSaatler.includes("21:00"), "siyah abone: bu hafta boş");
  assert.ok(buPzt.bosSaatler.includes("23:00"), "renksiz (siyah) abone: bu hafta boş");
  assert.ok(!buPzt.bosSaatler.includes("22:00"), "mavi abone: dolu");
  assert.ok(!buPzt.bosSaatler.includes("20:00"), "tema renkli abone: dolu");
  const sonrakiPzt = await d.musaitlik("2026-10-26");
  assert.ok(!sonrakiPzt.bosSaatler.includes("21:00"), "siyah abone: gelecek hafta dolu");
  assert.ok(!sonrakiPzt.bosSaatler.includes("23:00"));

  const r = await d.olustur({ gunTarihi: "2026-10-19", saat: "21:00", ad: "Ali Veli", telefon: "05321112233" });
  assert.ok(r.basarili, "siyah abonenin boşalttığı saat bu hafta satılabilir");
  const r2 = await d.olustur({ gunTarihi: "2026-10-26", saat: "21:00", ad: "Ali Veli", telefon: "05321112233" });
  assert.match(r2.hata, /dolu/);
});
