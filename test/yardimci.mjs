// Test yardımcıları: sahte saat, sahte depolama, örnek haftalık tablo.
import { RezervasyonDeposu } from "../src/store.js";

const gercekNow = Date.now;

/** Türkiye saatiyle sabit bir "şimdi" ayarlar. ör. saatiAyarla("2026-10-19T10:00") */
export function saatiAyarla(trSaati) {
  const ms = Date.parse(trSaati + ":00+03:00");
  Date.now = () => ms;
}
export function saatiSifirla() { Date.now = gercekNow; }

export function demoDepo(env = {}) {
  const veri = new Map();
  const ctx = {
    storage: {
      get: async (k) => structuredClone(veri.get(k)),
      put: async (k, v) => { veri.set(k, structuredClone(v)); },
    },
  };
  return new RezervasyonDeposu(ctx, env);
}

/** Çalışanların tablosuna benzeyen haftalık tablo. hucreler: {"CUMA|20:00": "ABONE - 6"} */
export function haftalikTablo(hucreler = {}) {
  const gunler = ["PAZARTESİ", "SALI", "ÇARŞAMBA", "PERŞEMBE", "CUMA", "CUMARTESİ", "PAZAR"];
  // Gerçek tablodaki gibi: A boş, B SAAT, C-E Pzt-Çrş, F SAAT, G-J Prş-Pazar, K SAAT
  const baslik = ["", "SAAT", "PAZARTESİ", "SALI", "ÇARŞAMBA", "SAAT", "PERŞEMBE", "CUMA", "CUMARTESİ", "PAZAR", "SAAT"];
  const sutun = { PAZARTESİ: 2, SALI: 3, ÇARŞAMBA: 4, PERŞEMBE: 6, CUMA: 7, CUMARTESİ: 8, PAZAR: 9 };
  const saatler = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00",
    "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "00:00", "01:00", "02:00"];
  const satirlar = [[""], baslik];
  for (const s of saatler) {
    const r = ["", s, "", "", "", s, "", "", "", "", s];
    for (const g of gunler) {
      const v = hucreler[`${g}|${s}`];
      if (v) r[sutun[g]] = v;
    }
    satirlar.push(r);
  }
  satirlar.push(baslik); // alt başlık satırı
  satirlar.push([""], ["", "ABONE KAYIT LİSTESİ"], ["", "İSİM SOYİSİM", "TELEFON", "GÜN", "SAAT"]);
  return satirlar;
}
