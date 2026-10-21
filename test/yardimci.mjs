// Test yardımcıları: sahte saat ve Durable Object depolamasının bellek içi taklidi.
import { RezervasyonDeposu } from "../src/store.js";

const gercekNow = Date.now;

/** Türkiye saatiyle sabit bir "şimdi" ayarlar. ör. saatiAyarla("2026-10-19T10:00") */
export function saatiAyarla(trSaati) {
  const ms = Date.parse(trSaati + ":00+03:00");
  Date.now = () => ms;
}
export function saatiSifirla() { Date.now = gercekNow; }

/** Durable Object storage API'sinin (get/put/delete/list) bellek içi taklidi. */
export function bellekDeposu() {
  const veri = new Map();
  const kopya = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    veri,
    async get(k) {
      if (Array.isArray(k)) return new Map(k.filter((x) => veri.has(x)).map((x) => [x, kopya(veri.get(x))]));
      return kopya(veri.get(k));
    },
    async put(k, v) {
      if (typeof k === "object") for (const [a, b] of Object.entries(k)) veri.set(a, kopya(b));
      else veri.set(k, kopya(v));
    },
    async delete(k) {
      if (Array.isArray(k)) { let n = 0; for (const x of k) n += veri.delete(x) ? 1 : 0; return n; }
      return veri.delete(k);
    },
    async list({ prefix, start, end, reverse, limit } = {}) {
      let anahtarlar = [...veri.keys()].sort()
        .filter((k) => (!prefix || k.startsWith(prefix)) && (!start || k >= start) && (!end || k < end));
      if (reverse) anahtarlar.reverse();
      if (limit) anahtarlar = anahtarlar.slice(0, limit);
      return new Map(anahtarlar.map((k) => [k, kopya(veri.get(k))]));
    },
  };
}

export function demoDepo(env = {}) {
  return new RezervasyonDeposu({ storage: bellekDeposu() }, env);
}
