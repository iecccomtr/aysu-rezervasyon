// Rezervasyon deposu.
// Tüm okuma/yazma işlemleri tek bir Durable Object üzerinden ve SIRAYLA yapılır.
// Böylece aynı saate aynı anda gelen iki istek çift rezervasyona yol açamaz.
//
// Doluluk iki kaynaktan hesaplanır:
//   1) Haftalık tablo (REZERVASYON sekmesi, sadece okunur):
//        - "ABONE" yazan hücreler her hafta dolu sayılır; ancak yazı rengi SİYAHSA abone
//          bu hafta gelmiyor demektir → bu hafta boş, sonraki haftalar dolu.
//        - Diğer dolu hücreler (tek seferlik) sadece İÇİNDE BULUNULAN hafta için dolu sayılır,
//          çünkü hafta sonunda siliniyorlar.
//   2) Online Rezervasyonlar sekmesi: sitenin yazdığı tarihli kayıtlar.
//
// Depo türü:
//   - Google E-Tablo, Apps Script köprüsüyle: SCRIPT_URL + SCRIPT_ANAHTAR tanımlıysa (önerilen)
//   - Google E-Tablo, servis hesabıyla: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, SHEET_ID tanımlıysa
//   - Demo: yoksa her şey Durable Object hafızasında tutulur (deneme için)

import { DurableObject } from "cloudflare:workers";
import { SAATLER, KURALLAR, DURUM } from "./config.js";
import {
  simdi, gunAdi, gunEkle, macZamani, tarihNormalize, saatNormalize,
  telefonNormalize, gecerliSaat, fiyat, isletmeGunu, haftaBasi,
} from "./time.js";
import { haftalikTabloyuCoz, aboneMi, gunNo } from "./haftalik.js";
import * as sheetsApi from "./sheets.js";
import * as kopru from "./kopru.js";

const iptalMi = (durum) => String(durum || "").toLocaleLowerCase("tr").includes("iptal");

function kayitNoUret() {
  const harf = "ABCDEFGHJKLMNPRSTUVYZ23456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(5))) s += harf[b % harf.length];
  return `AY-${s}`;
}

function satirdanKayit({ hucreler, satirNo }) {
  const h = (i) => (hucreler[i] ?? "").toString().trim();
  return {
    tarih: tarihNormalize(h(0)), gun: h(1), saat: saatNormalize(h(2)), ad: h(3),
    telefon: telefonNormalize(h(4)) || h(4), durum: h(5), kayitNo: h(6), not: h(7),
    olusturma: h(8), satirNo,
  };
}

const kayittanSatir = (k) => [k.tarih, k.gun, k.saat, k.ad, k.telefon, k.durum, k.kayitNo, k.not, k.olusturma];

export class RezervasyonDeposu extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.kuyruk = Promise.resolve();
  }

  /** Tablo bağlantısı: önce Apps Script köprüsü, yoksa Google servis hesabı, o da yoksa demo. */
  get tablo() {
    const e = this.env;
    if (kopru.kopruAktif(e)) return kopru;
    if (e.SHEET_ID && e.GOOGLE_SERVICE_ACCOUNT_EMAIL && e.GOOGLE_PRIVATE_KEY) return sheetsApi;
    return null;
  }

  get sheetsAktif() {
    return Boolean(this.tablo);
  }

  /** İşlemleri sıraya sokar: bir işlem bitmeden diğeri başlamaz. */
  kilitli(fn) {
    const p = this.kuyruk.then(fn, fn);
    this.kuyruk = p.catch(() => {});
    return p;
  }

  // ---------- Ham depo ----------

  async durumuOku() {
    if (this.sheetsAktif) {
      const { haftalik, online } = await this.tablo.oku(this.env);
      return {
        haftalik: haftalikTabloyuCoz(haftalik),
        kayitlar: online.map(satirdanKayit).filter((k) => k.tarih && k.saat),
      };
    }
    const haftalik = (await this.ctx.storage.get("demo_haftalik")) || [];
    const kayitlar = (await this.ctx.storage.get("demo_kayitlar")) || [];
    return { haftalik: haftalikTabloyuCoz(haftalik), kayitlar };
  }

  async ekle(kayit) {
    if (this.sheetsAktif) return this.tablo.satirEkle(this.env, kayittanSatir(kayit));
    const liste = (await this.ctx.storage.get("demo_kayitlar")) || [];
    liste.push(kayit);
    await this.ctx.storage.put("demo_kayitlar", liste);
  }

  async iptalEt(kayit) {
    if (this.sheetsAktif) return this.tablo.hucreGuncelle(this.env, kayit.satirNo, "F", DURUM.iptal);
    const liste = (await this.ctx.storage.get("demo_kayitlar")) || [];
    const k = liste.find((x) => x.kayitNo === kayit.kayitNo);
    if (k) k.durum = DURUM.iptal;
    await this.ctx.storage.put("demo_kayitlar", liste);
  }

  /** Sadece demo modunda: haftalık tabloyu taklit etmek için (testler kullanır). */
  async demoHaftalikAyarla(satirlar) {
    if (this.sheetsAktif) return { hata: "Demo modunda değil." };
    await this.ctx.storage.put("demo_haftalik", satirlar);
    return { basarili: true };
  }

  // ---------- Doluluk ----------

  doluMu({ haftalik, kayitlar }, tarih, saat) {
    if (kayitlar.some((k) => k.tarih === tarih && k.saat === saat && !iptalMi(k.durum))) return true;
    const ig = isletmeGunu(tarih, saat);
    const hucre = haftalik.get(`${gunNo(ig)}|${saat}`);
    if (!hucre) return false;
    const n = simdi();
    const buHafta = haftaBasi(ig) === haftaBasi(isletmeGunu(n.tarih, n.saat));
    if (aboneMi(hucre.metin)) {
      // Siyah yazılmış ABONE = abone bu hafta gelmiyor → bu hafta boş, diğer haftalar dolu.
      // (Sadece renk okunabildiğinde geçerli; demo/düz metinde renk yoktur.)
      if (hucre.renkli && hucre.siyah && buHafta) return false;
      return true;
    }
    return buHafta;
  }

  // ---------- Sitenin kullandığı işlemler (RPC) ----------

  /** Tek bir "işletme günü"nün saatleri: gündüz saatleri o tarihte, gece saatleri ertesi takvim gününde. */
  gunHesapla(durum, tarihGirdi) {
    const tarih = tarihNormalize(tarihGirdi);
    if (!tarih) return { hata: "Tarih anlaşılamadı. YYYY-AA-GG biçiminde verin." };
    const bugun = simdi().tarih;
    if (tarih < gunEkle(bugun, -1)) return { hata: "Geçmiş bir tarih için rezervasyon yapılamaz." };
    if (tarih > gunEkle(bugun, KURALLAR.enFazlaGunSonra)) {
      return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
    }
    const simdiMs = Date.now();
    const saatler = SAATLER.map((saat) => {
      const gercekTarih = Number(saat.slice(0, 2)) < 6 ? gunEkle(tarih, 1) : tarih;
      return { saat, gercekTarih };
    })
      .filter(({ gercekTarih, saat }) => macZamani(gercekTarih, saat) > simdiMs)
      .map(({ saat, gercekTarih }) => ({
        saat,
        bos: !this.doluMu(durum, gercekTarih, saat),
        ucret: fiyat(gercekTarih, saat),
        ...(gercekTarih !== tarih ? { not: `gece maçı, takvimde ${gercekTarih}` } : {}),
      }));
    return {
      tarih, gun: gunAdi(tarih),
      bosSaatler: saatler.filter((s) => s.bos).map((s) => s.saat),
      detay: saatler,
    };
  }

  async musaitlik(tarihGirdi) {
    return this.kilitli(async () => this.gunHesapla(await this.durumuOku(), tarihGirdi));
  }

  /** Birden çok günü tablodan TEK okumayla hesaplar (rezervasyon sayfası 8 günü birden ister). */
  async musaitlikCoklu(tarihler) {
    return this.kilitli(async () => {
      const durum = await this.durumuOku();
      return tarihler.map((t) => this.gunHesapla(durum, t));
    });
  }

  /** `gunTarihi`: müşterinin kastettiği gün (gece maçlarında o günün gecesi). */
  async olustur({ gunTarihi, saat: s, ad, telefon: tel, not = "" }) {
    return this.kilitli(async () => {
      const gun = tarihNormalize(gunTarihi);
      const saat = saatNormalize(s);
      const telefon = telefonNormalize(tel);
      if (!gun) return { hata: "Geçersiz tarih." };
      if (!saat || !gecerliSaat(saat)) return { hata: `Geçersiz saat. Maç saatleri: ${SAATLER.join(", ")}` };
      // Gece saatleri takvimde bir sonraki güne düşer.
      const tarih = Number(saat.slice(0, 2)) < 6 ? gunEkle(gun, 1) : gun;
      if (!telefon) return { hata: "Geçersiz telefon. 05XX XXX XX XX biçiminde bir cep telefonu gerekli." };
      if (!ad || String(ad).trim().length < 3) return { hata: "Ad soyad gerekli." };
      if (macZamani(tarih, saat) <= Date.now()) return { hata: "Bu saat geçmiş." };
      if (isletmeGunu(tarih, saat) > gunEkle(simdi().tarih, KURALLAR.enFazlaGunSonra)) {
        return { hata: `En fazla ${KURALLAR.enFazlaGunSonra} gün sonrasına rezervasyon alınıyor.` };
      }

      const durum = await this.durumuOku();
      if (this.doluMu(durum, tarih, saat)) {
        return { hata: "Bu saat dolu. Lütfen müsaitliği tekrar kontrol edip başka bir saat önerin." };
      }
      const gelecek = durum.kayitlar.filter((k) => k.telefon === telefon && !iptalMi(k.durum)
        && macZamani(k.tarih, k.saat) > Date.now());
      if (gelecek.length >= KURALLAR.kisiBasiAktifRezervasyon) {
        return { hata: `Bu numaraya ait ${gelecek.length} aktif rezervasyon var. Daha fazlası için işletmeyi arayın.` };
      }

      const kayit = {
        tarih, gun: gunAdi(isletmeGunu(tarih, saat)) + (Number(saat.slice(0, 2)) < 6 ? " gecesi" : ""),
        saat, ad: String(ad).trim().slice(0, 60), telefon,
        durum: DURUM.bekliyor, kayitNo: kayitNoUret(), not: String(not).slice(0, 200),
        olusturma: new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace("T", " "),
      };
      await this.ekle(kayit);
      return { basarili: true, kayitNo: kayit.kayitNo, tarih, gun: kayit.gun, saat, ucret: fiyat(tarih, saat), durum: kayit.durum };
    });
  }

  async bul(tel) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const { kayitlar } = await this.durumuOku();
      const liste = kayitlar
        .filter((k) => k.telefon === telefon && !iptalMi(k.durum) && macZamani(k.tarih, k.saat) > Date.now())
        // Gizlilik: isim döndürülmez, sadece maç bilgisi.
        .map((k) => ({ kayitNo: k.kayitNo, tarih: k.tarih, gun: k.gun, saat: k.saat, durum: k.durum }));
      return { rezervasyonlar: liste };
    });
  }

  async iptal({ kayitNo, telefon: tel }) {
    return this.kilitli(async () => {
      const telefon = telefonNormalize(tel);
      if (!telefon) return { hata: "Geçersiz telefon." };
      const no = String(kayitNo || "").trim().toUpperCase();
      const { kayitlar } = await this.durumuOku();
      const kayit = kayitlar.find((k) => k.kayitNo === no && k.telefon === telefon && !iptalMi(k.durum));
      if (!kayit) return { hata: "Bu numaraya ait böyle bir aktif rezervasyon bulunamadı." };
      const kalanSaat = (macZamani(kayit.tarih, kayit.saat) - Date.now()) / 3600_000;
      if (kalanSaat < KURALLAR.iptalEnGecSaat) {
        return { hata: `Maça ${KURALLAR.iptalEnGecSaat} saatten az kaldığı için çevrimiçi iptal yapılamıyor. Lütfen işletmeyi arayın.` };
      }
      await this.iptalEt(kayit);
      return { basarili: true, kayitNo: no, tarih: kayit.tarih, saat: kayit.saat };
    });
  }
}
