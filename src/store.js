// Aysu Halı Saha — kendi veritabanı (Cloudflare Durable Object).
//
// Tüm okuma/yazma işlemleri tek bir Durable Object üzerinden ve SIRAYLA yapılır,
// böylece aynı saate aynı anda gelen iki istek çift rezervasyona yol açamaz.
//
// Kayıt anahtarları:
//   r:<tarih>:<saat>:<kayitNo>   rezervasyon (tarih = maçın takvim tarihi; gece maçları ertesi gün)
//   k:<kayitNo>                  kayıt no → rezervasyon anahtarı
//   a:<id>                       abone (her hafta aynı gün/saat)
//   x:<isletmeGunu>:<saat>:<id>  abone o hafta gelmiyor ("bu hafta gelmiyor")
//   m:<telefon>                  müşteri notu / etiketi (CRM)
//   f:<dosya>                    eski siteden kopyalanan fotoğraf
//   panel:ayar, o:<token>        panel şifresi ve oturumlar

import { DurableObject } from "cloudflare:workers";
import { SAATLER, KURALLAR, DURUM } from "./config.js";
import {
  simdi, gunAdi, gunEkle, macZamani, tarihNormalize, saatNormalize,
  telefonNormalize, gecerliSaat, fiyat, isletmeGunu, haftaBasi,
} from "./time.js";

export const GUNLER = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const DURUMLAR = [DURUM.bekliyor, DURUM.onayli, DURUM.iptal];
const OTURUM_GUN = 30;

const iptalMi = (durum) => String(durum || "").toLocaleLowerCase("tr").includes("iptal");
const geceSaati = (saat) => Number(saat.slice(0, 2)) < 6;
/** İşletme günü + saat → maçın takvim tarihi */
const takvimTarihi = (gun, saat) => (geceSaati(saat) ? gunEkle(gun, 1) : gun);
/** 0 = pazartesi */
const gunNo = (tarih) => (new Date(tarih + "T00:00:00Z").getUTCDay() + 6) % 7;
const simdiYazi = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
const kirp = (s, n) => String(s ?? "").trim().slice(0, n);

function rastgele(n, harf = "ABCDEFGHJKLMNPRSTUVYZ23456789") {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(n))) s += harf[b % harf.length];
  return s;
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sifreHash(sifre, tuz) {
  const anahtar = await crypto.subtle.importKey("raw", new TextEncoder().encode(sifre), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(tuz), iterations: 100_000 }, anahtar, 256);
  return hex(bits);
}

function esitMi(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let fark = 0;
  for (let i = 0; i < a.length; i++) fark |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return fark === 0;
}

export class RezervasyonDeposu extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.kuyruk = Promise.resolve();
  }

  /** İşlemleri sıraya sokar: bir işlem bitmeden diğeri başlamaz. */
  kilitli(fn) {
    const p = this.kuyruk.then(fn, fn);
    this.kuyruk = p.catch(() => {});
    return p;
  }

  get st() { return this.ctx.storage; }

  // ================= Okuma yardımcıları =================

  /** [ilk, son] takvim tarihleri arasındaki rezervasyonlar (iptaller dahil). */
  async rezervasyonlar(ilk, son) {
    const m = await this.st.list({ start: `r:${ilk}`, end: `r:${son}~` });
    return [...m.values()];
  }

  async aboneler() {
    return [...(await this.st.list({ prefix: "a:" })).values()];
  }

  async atlananlar(ilkGun, sonGun) {
    const m = await this.st.list({ start: `x:${ilkGun}`, end: `x:${sonGun}~` });
    return new Set([...m.keys()]);
  }

  /** Belirli bir aralık için doluluk bilgisini tek seferde yükler. */
  async durumYukle(ilkGun, sonGun) {
    const [rez, abone, atla] = await Promise.all([
      this.rezervasyonlar(ilkGun, gunEkle(sonGun, 1)),
      this.aboneler(),
      this.atlananlar(ilkGun, sonGun),
    ]);
    const rezMap = new Map();
    for (const r of rez) if (!iptalMi(r.durum)) rezMap.set(`${r.tarih}|${r.saat}`, r);
    return { rezMap, abone, atla };
  }

  /** İşletme günü + saat için slotun durumu. */
  slot(durum, gun, saat) {
    const tarih = takvimTarihi(gun, saat);
    const rez = durum.rezMap.get(`${tarih}|${saat}`);
    if (rez) return { tur: "rez", rez };
    const a = durum.abone.find((x) => x.gun === gunNo(gun) && x.saat === saat
      && x.baslangic <= gun && (!x.bitis || gun <= x.bitis));
    if (a) {
      const gelmiyor = durum.atla.has(`x:${gun}:${saat}:${a.id}`);
      return { tur: gelmiyor ? "abone-gelmiyor" : "abone", abone: a };
    }
    return { tur: "bos" };
  }

  // ================= Site (müşteri) işlemleri =================

  gunHesapla(durum, gunGirdi) {
    const tarih = tarihNormalize(gunGirdi);
    if (!tarih) return { hata: "Tarih anlaşılamadı." };
    const bugun = simdi().tarih;
    if (tarih < gunEkle(bugun, -1)) return { hata: "Geçmiş bir tarih için rezervasyon yapılamaz." };
    if (tarih > gunEkle(bugun, KURALLAR.enFazlaGunSonra)) {
      return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
    }
    const simdiMs = Date.now();
    const detay = SAATLER
      .filter((saat) => macZamani(takvimTarihi(tarih, saat), saat) > simdiMs)
      .map((saat) => {
        const s = this.slot(durum, tarih, saat);
        return { saat, bos: s.tur === "bos" || s.tur === "abone-gelmiyor", ucret: fiyat(takvimTarihi(tarih, saat), saat) };
      });
    return { tarih, gun: gunAdi(tarih), bosSaatler: detay.filter((s) => s.bos).map((s) => s.saat), detay };
  }

  async musaitlik(gun) {
    return (await this.musaitlikCoklu([gun]))[0];
  }

  async musaitlikCoklu(gunler) {
    return this.kilitli(async () => {
      const sirali = [...gunler].sort();
      const durum = await this.durumYukle(sirali[0], sirali.at(-1));
      return gunler.map((g) => this.gunHesapla(durum, g));
    });
  }

  /** Ortak kayıt oluşturma. `panel` true ise müşteri sınırları uygulanmaz. */
  async rezervasyonYaz({ gunTarihi, saat: s, ad, telefon: tel, not = "", durum, kaynak, kapora = "" }, panel) {
    const gun = tarihNormalize(gunTarihi);
    const saat = saatNormalize(s);
    const telefon = telefonNormalize(tel);
    if (!gun) return { hata: "Geçersiz tarih." };
    if (!saat || !gecerliSaat(saat)) return { hata: `Geçersiz saat. Maç saatleri: ${SAATLER.join(", ")}` };
    if (!kirp(ad, 60) || kirp(ad, 60).length < (panel ? 2 : 3)) return { hata: "Ad soyad gerekli." };
    if (!telefon && !(panel && !kirp(tel, 20))) {
      return { hata: "Geçersiz telefon. 05XX XXX XX XX biçiminde bir cep telefonu gerekli." };
    }
    const tarih = takvimTarihi(gun, saat);
    if (!panel) {
      if (macZamani(tarih, saat) <= Date.now()) return { hata: "Bu saat geçmiş." };
      if (gun > gunEkle(simdi().tarih, KURALLAR.enFazlaGunSonra)) {
        return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
      }
    }
    const d = await this.durumYukle(gun, gun);
    const sl = this.slot(d, gun, saat);
    if (sl.tur === "rez" || sl.tur === "abone") {
      return { hata: "Bu saat dolu. Lütfen başka bir saat seçin." };
    }
    if (!panel) {
      const gelecek = (await this.rezervasyonlar(simdi().tarih, gunEkle(simdi().tarih, 60)))
        .filter((r) => r.telefon === telefon && !iptalMi(r.durum) && macZamani(r.tarih, r.saat) > Date.now());
      if (gelecek.length >= KURALLAR.kisiBasiAktifRezervasyon) {
        return { hata: `Bu numaraya ait ${gelecek.length} aktif rezervasyon var. Daha fazlası için işletmeyi arayın.` };
      }
    }
    const kayit = {
      tarih, saat,
      gun: gunAdi(gun) + (geceSaati(saat) ? " gecesi" : ""),
      isletmeGunu: gun,
      ad: kirp(ad, 60), telefon: telefon || "",
      durum: DURUMLAR.includes(durum) ? durum : DURUM.bekliyor,
      kayitNo: `AY-${rastgele(5)}`, not: kirp(not, 200), kapora: kirp(kapora, 60),
      kaynak: kaynak || "Online", olusturma: simdiYazi(),
    };
    const anahtar = `r:${tarih}:${saat}:${kayit.kayitNo}`;
    await this.st.put({ [anahtar]: kayit, [`k:${kayit.kayitNo}`]: anahtar });
    return { basarili: true, ...kayit, ucret: fiyat(tarih, saat) };
  }

  async olustur(girdi) {
    return this.kilitli(() => this.rezervasyonYaz({ ...girdi, durum: DURUM.bekliyor, kaynak: "Online", kapora: "" }, false));
  }

  async kayitBul(kayitNo) {
    const anahtar = await this.st.get(`k:${String(kayitNo || "").trim().toUpperCase()}`);
    if (!anahtar) return null;
    const kayit = await this.st.get(anahtar);
    return kayit ? { anahtar, kayit } : null;
  }

  async bul(tel) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const liste = (await this.rezervasyonlar(simdi().tarih, gunEkle(simdi().tarih, 60)))
        .filter((r) => r.telefon === telefon && !iptalMi(r.durum) && macZamani(r.tarih, r.saat) > Date.now())
        .map((r) => ({ kayitNo: r.kayitNo, tarih: r.tarih, gun: r.gun, saat: r.saat, durum: r.durum }));
      return { rezervasyonlar: liste };
    });
  }

  async iptal({ kayitNo, telefon: tel }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const b = await this.kayitBul(kayitNo);
      if (!b || b.kayit.telefon !== telefon || iptalMi(b.kayit.durum)) {
        return { hata: "Bu numaraya ait böyle bir aktif rezervasyon bulunamadı." };
      }
      const kalanSaat = (macZamani(b.kayit.tarih, b.kayit.saat) - Date.now()) / 3600_000;
      if (kalanSaat < KURALLAR.iptalEnGecSaat) {
        return { hata: `Maça ${KURALLAR.iptalEnGecSaat} saatten az kaldığı için çevrimiçi iptal yapılamıyor. Lütfen işletmeyi arayın.` };
      }
      await this.st.put(b.anahtar, { ...b.kayit, durum: DURUM.iptal, iptalEden: "Müşteri" });
      return { basarili: true, kayitNo: b.kayit.kayitNo, tarih: b.kayit.tarih, saat: b.kayit.saat };
    });
  }

  // ================= Panel: giriş =================

  async panelDurum() {
    return { kurulu: Boolean(await this.st.get("panel:ayar")) };
  }

  /** İlk kurulum veya şifre sıfırlama: PANEL_KURULUM_KODU ile. */
  async panelKur({ kurulumKodu, sifre }) {
    return this.kilitli(async () => {
      const kod = this.env.PANEL_KURULUM_KODU;
      if (!kod || !esitMi(String(kurulumKodu || ""), kod)) return { hata: "Kurulum kodu hatalı." };
      if (typeof sifre !== "string" || sifre.length < 8) return { hata: "Şifre en az 8 karakter olmalı." };
      const tuz = rastgele(16);
      await this.st.put("panel:ayar", { hash: await sifreHash(sifre, tuz), tuz });
      // Eski oturumları kapat
      const eski = await this.st.list({ prefix: "o:" });
      if (eski.size) await this.st.delete([...eski.keys()]);
      return this.oturumAc();
    });
  }

  async panelGiris(sifre) {
    return this.kilitli(async () => {
      const ayar = await this.st.get("panel:ayar");
      if (!ayar) return { hata: "Panel henüz kurulmamış." };
      if (!esitMi(await sifreHash(String(sifre || ""), ayar.tuz), ayar.hash)) return { hata: "Şifre hatalı." };
      return this.oturumAc();
    });
  }

  async oturumAc() {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const bitis = Date.now() + OTURUM_GUN * 86400_000;
    await this.st.put(`o:${token}`, { bitis });
    return { basarili: true, token, bitis };
  }

  async oturumGecerli(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const o = await this.st.get(`o:${token}`);
    if (!o) return false;
    if (o.bitis < Date.now()) { await this.st.delete(`o:${token}`); return false; }
    return true;
  }

  async cikis(token) {
    if (token) await this.st.delete(`o:${token}`);
    return { basarili: true };
  }

  // ================= Panel: takvim =================

  /** Pazartesiden başlayan 7 işletme günü; her saatin tam durumu + kapora bekleyenler. */
  async panelHafta(baslangicGirdi) {
    return this.kilitli(async () => {
      const n = simdi();
      const bas = haftaBasi(tarihNormalize(baslangicGirdi) || isletmeGunu(n.tarih, n.saat));
      const son = gunEkle(bas, 6);
      const d = await this.durumYukle(bas, son);
      const gunler = [];
      for (let i = 0; i < 7; i++) {
        const gun = gunEkle(bas, i);
        gunler.push({
          tarih: gun, gun: gunAdi(gun),
          saatler: SAATLER.map((saat) => {
            const s = this.slot(d, gun, saat);
            const tarih = takvimTarihi(gun, saat);
            return {
              saat, tarih, gecmis: macZamani(tarih, saat) < Date.now() - 3600_000, tur: s.tur,
              ...(s.rez ? { rez: s.rez } : {}),
              ...(s.abone ? { abone: { id: s.abone.id, ad: s.abone.ad, telefon: s.abone.telefon, not: s.abone.not } } : {}),
            };
          }),
        });
      }
      const bekleyenler = (await this.rezervasyonlar(gunEkle(n.tarih, -1), gunEkle(n.tarih, 30)))
        .filter((r) => r.durum === DURUM.bekliyor && macZamani(r.tarih, r.saat) > Date.now() - 3600_000)
        .sort((a, b) => (a.tarih + a.saat).localeCompare(b.tarih + b.saat));
      return { baslangic: bas, gunler, bekleyenler, bugun: isletmeGunu(n.tarih, n.saat) };
    });
  }

  async panelRezEkle(girdi) {
    return this.kilitli(() => this.rezervasyonYaz({
      ...girdi, kaynak: girdi.kaynak || "Telefon", durum: girdi.durum || DURUM.onayli,
    }, true));
  }

  async panelRezGuncelle({ kayitNo, durum, kapora, not, ad, telefon }) {
    return this.kilitli(async () => {
      const b = await this.kayitBul(kayitNo);
      if (!b) return { hata: "Kayıt bulunamadı." };
      const k = { ...b.kayit };
      if (durum !== undefined) {
        if (!DURUMLAR.includes(durum)) return { hata: "Geçersiz durum." };
        if (iptalMi(k.durum) && !iptalMi(durum)) {
          // İptalden geri alma: saat hâlâ boş mu?
          const d = await this.durumYukle(k.isletmeGunu || k.tarih, k.isletmeGunu || k.tarih);
          const sl = this.slot(d, k.isletmeGunu || k.tarih, k.saat);
          if (sl.tur === "rez" || sl.tur === "abone") return { hata: "Bu saat artık dolu, iptal geri alınamaz." };
        }
        k.durum = durum;
        if (iptalMi(durum)) k.iptalEden = "Panel";
      }
      if (kapora !== undefined) k.kapora = kirp(kapora, 60);
      if (not !== undefined) k.not = kirp(not, 200);
      if (ad !== undefined && kirp(ad, 60)) k.ad = kirp(ad, 60);
      if (telefon !== undefined) {
        const t = telefonNormalize(telefon);
        if (telefon && !t) return { hata: "Geçersiz telefon." };
        k.telefon = t || "";
      }
      k.guncelleme = simdiYazi();
      await this.st.put(b.anahtar, k);
      return { basarili: true, rez: k };
    });
  }

  // ================= Panel: aboneler =================

  async aboneListe() {
    const liste = await this.aboneler();
    return liste.sort((a, b) => a.gun - b.gun || a.saat.localeCompare(b.saat) || a.ad.localeCompare(b.ad, "tr"));
  }

  async aboneKaydet({ id, ad, telefon, gun, saat: s, baslangic, not = "", ucret = "" }) {
    return this.kilitli(async () => {
      const saat = saatNormalize(s);
      const g = Number(gun);
      if (!kirp(ad, 60)) return { hata: "Abone adı gerekli." };
      if (!(g >= 0 && g <= 6)) return { hata: "Gün seçin." };
      if (!saat || !gecerliSaat(saat)) return { hata: "Saat seçin." };
      const tel = telefon ? telefonNormalize(telefon) : "";
      if (telefon && !tel) return { hata: "Geçersiz telefon." };
      const n = simdi();
      const bas = tarihNormalize(baslangic) || isletmeGunu(n.tarih, n.saat);
      const liste = await this.aboneler();
      const cakisan = liste.find((a) => a.id !== id && a.gun === g && a.saat === saat && !a.bitis);
      if (cakisan) return { hata: `Bu gün ve saatte zaten abone var: ${cakisan.ad}.` };
      const eski = id ? await this.st.get(`a:${id}`) : null;
      const abone = {
        id: eski?.id || rastgele(8, "abcdefghjkmnpqrstuvwxyz23456789"),
        ad: kirp(ad, 60), telefon: tel, gun: g, saat, baslangic: bas, bitis: null,
        not: kirp(not, 200), ucret: kirp(ucret, 40), olusturma: eski?.olusturma || simdiYazi(),
      };
      await this.st.put(`a:${abone.id}`, abone);
      // Uyarı: bu saatte ileri tarihli aktif rezervasyonlar
      const cakisanRez = (await this.rezervasyonlar(n.tarih, gunEkle(n.tarih, 60)))
        .filter((r) => !iptalMi(r.durum) && r.saat === saat && gunNo(r.isletmeGunu || r.tarih) === g && (r.isletmeGunu || r.tarih) >= bas);
      return { basarili: true, abone, uyari: cakisanRez.length ? `${cakisanRez.length} ileri tarihli rezervasyon bu abonenin saatine denk geliyor, kontrol edin.` : null };
    });
  }

  async aboneSil(id) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      if (!a) return { hata: "Abone bulunamadı." };
      await this.st.delete(`a:${id}`);
      const atla = await this.st.list({ prefix: "x:" });
      const sil = [...atla.keys()].filter((k) => k.endsWith(`:${id}`));
      if (sil.length) await this.st.delete(sil);
      return { basarili: true };
    });
  }

  /** Abone o hafta gelmiyor (gelmiyor=true) / yine geliyor (false). `gun` işletme günü. */
  async aboneAtla({ id, gun, gelmiyor }) {
    return this.kilitli(async () => {
      const a = await this.st.get(`a:${id}`);
      const g = tarihNormalize(gun);
      if (!a || !g) return { hata: "Abone veya tarih bulunamadı." };
      if (gunNo(g) !== a.gun) return { hata: "Bu tarih abonenin gününe denk gelmiyor." };
      const anahtar = `x:${g}:${a.saat}:${a.id}`;
      if (gelmiyor) {
        await this.st.put(anahtar, { olusturma: simdiYazi() });
      } else {
        // Geri alırken o saate bu arada rezervasyon alınmış mı?
        const d = await this.durumYukle(g, g);
        if (d.rezMap.get(`${takvimTarihi(g, a.saat)}|${a.saat}`)) {
          return { hata: "Bu saate bu hafta başka rezervasyon alınmış. Önce onu iptal edin." };
        }
        await this.st.delete(anahtar);
      }
      return { basarili: true };
    });
  }

  // ================= Fotoğraflar (eski siteden bir kez kopyalanır) =================

  /** `f:<ad>` altında saklı fotoğrafı döndürür; yoksa `kaynak` adresinden indirip saklar. */
  async foto(ad, kaynak) {
    const kayit = await this.st.get(`f:${ad}`);
    if (kayit) return kayit;
    if (!kaynak) return null;
    const res = await fetch(kaynak);
    const tur = res.headers.get("content-type") || "";
    if (!res.ok || !tur.startsWith("image/")) return null;
    const veri = new Uint8Array(await res.arrayBuffer());
    if (veri.byteLength > 1_900_000) return null; // depolama sınırı (2 MB)
    const yeni = { tur, veri, alindi: simdiYazi() };
    await this.st.put(`f:${ad}`, yeni);
    return yeni;
  }

  // ================= Panel: müşteriler (CRM) =================

  async musteriler() {
    return this.kilitli(async () => {
      const [rezMap, aboneler, notlar] = await Promise.all([
        this.st.list({ prefix: "r:" }), this.aboneler(), this.st.list({ prefix: "m:" }),
      ]);
      const kisiler = new Map();
      const kisi = (telefon, ad) => {
        if (!kisiler.has(telefon)) {
          kisiler.set(telefon, { telefon, ad, mac: 0, iptal: 0, bekleyen: 0, ilk: null, son: null, gelecek: null, abone: [], not: "", etiket: "" });
        }
        const k = kisiler.get(telefon);
        if (ad && !k.ad) k.ad = ad;
        return k;
      };
      const simdiMs = Date.now();
      for (const r of [...rezMap.values()].sort((a, b) => (a.tarih + a.saat).localeCompare(b.tarih + b.saat))) {
        if (!r.telefon) continue;
        const k = kisi(r.telefon, r.ad);
        k.ad = r.ad || k.ad; // en güncel isim
        if (iptalMi(r.durum)) { k.iptal++; continue; }
        const zaman = macZamani(r.tarih, r.saat);
        if (zaman <= simdiMs) {
          k.mac++;
          k.ilk = k.ilk || r.tarih;
          k.son = r.tarih;
        } else if (!k.gelecek) {
          k.gelecek = { tarih: r.tarih, saat: r.saat, gun: r.gun };
        }
        if (r.durum === DURUM.bekliyor && zaman > simdiMs) k.bekleyen++;
      }
      for (const a of aboneler) {
        if (!a.telefon) continue;
        kisi(a.telefon, a.ad).abone.push(`${GUNLER[a.gun]} ${a.saat}`);
      }
      for (const [anahtar, v] of notlar) {
        const k = kisi(anahtar.slice(2), v.ad || "");
        k.not = v.not || "";
        k.etiket = v.etiket || "";
      }
      return [...kisiler.values()].sort((a, b) =>
        (b.son || b.gelecek?.tarih || "").localeCompare(a.son || a.gelecek?.tarih || "") || a.ad.localeCompare(b.ad, "tr"));
    });
  }

  async musteriDetay(tel) {
    const telefon = telefonNormalize(tel);
    if (!telefon) return { hata: "Geçersiz telefon." };
    const tum = [...(await this.st.list({ prefix: "r:" })).values()]
      .filter((r) => r.telefon === telefon)
      .sort((a, b) => (b.tarih + b.saat).localeCompare(a.tarih + a.saat));
    const m = (await this.st.get(`m:${telefon}`)) || {};
    const abone = (await this.aboneler()).filter((a) => a.telefon === telefon);
    return { telefon, ad: tum[0]?.ad || abone[0]?.ad || m.ad || "", not: m.not || "", etiket: m.etiket || "", rezervasyonlar: tum.slice(0, 100), abone };
  }

  async musteriNot({ telefon: tel, not, etiket, ad }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const eski = (await this.st.get(`m:${telefon}`)) || {};
      await this.st.put(`m:${telefon}`, {
        ...eski,
        ...(not !== undefined ? { not: kirp(not, 1000) } : {}),
        ...(etiket !== undefined ? { etiket: kirp(etiket, 40) } : {}),
        ...(ad ? { ad: kirp(ad, 60) } : {}),
      });
      return { basarili: true };
    });
  }
}
