/**
 * AYSU HALI SAHA — Tablo köprüsü (Google Apps Script)
 *
 * Bu kod "REZERVASYON VE GÖREVLER" tablosunun içine yapıştırılır
 * (Uzantılar → Apps Script). Web sitesi tabloyu bu köprü üzerinden okur/yazar
 * ve işletmeye bildirim e-postalarını bununla gönderir.
 *
 * - "REZERVASYON" sekmesini SADECE OKUR (metin + yazı rengi), asla değiştirmez.
 * - "Online Rezervasyonlar" sekmesine satır ekler / Durum hücresini günceller
 *   (sekme yoksa kendisi oluşturur).
 *
 * ANAHTAR, Cloudflare'deki SCRIPT_ANAHTAR değeriyle AYNI olmalı.
 */

const ANAHTAR = "BURAYA_ANAHTAR";            // ← Claude'un verdiği anahtar
const BILDIRIM_EPOSTA = "aysuhalisaha@gmail.com";

const HAFTALIK_SEKME = "REZERVASYON";
const ONLINE_SEKME = "Online Rezervasyonlar";
const SUTUNLAR = ["Tarih", "Gün", "Saat", "Ad Soyad", "Telefon", "Durum", "Kayıt No", "Not", "Oluşturma", "Ödenen Kapora"];

function doPost(e) {
  let g;
  try {
    g = JSON.parse(e.postData.contents);
  } catch (hata) {
    return cevap({ hata: "Geçersiz istek" });
  }
  if (!g || g.anahtar !== ANAHTAR) return cevap({ hata: "Yetkisiz" });

  try {
    switch (g.islem) {
      case "oku":
        return cevap(oku());
      case "ekle":
        return cevap(ekle(g.satir));
      case "guncelle":
        onlineSekme().getRange(Number(g.satirNo), Number(g.sutun)).setValue(String(g.deger));
        return cevap({ tamam: true });
      case "eposta":
        MailApp.sendEmail({
          to: g.alici || BILDIRIM_EPOSTA,
          subject: String(g.konu).slice(0, 200),
          body: String(g.metin || ""),
          htmlBody: g.html ? String(g.html) : undefined,
          name: "Aysu Halı Saha",
        });
        return cevap({ tamam: true });
      case "test":
        return cevap({ tamam: true, tablo: SpreadsheetApp.getActive().getName() });
      default:
        return cevap({ hata: "Bilinmeyen işlem" });
    }
  } catch (hata) {
    return cevap({ hata: String(hata) });
  }
}

function doGet() {
  return cevap({ tamam: true, mesaj: "Aysu Halı Saha tablo köprüsü çalışıyor." });
}

function cevap(veri) {
  return ContentService.createTextOutput(JSON.stringify(veri)).setMimeType(ContentService.MimeType.JSON);
}

function onlineSekme() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ONLINE_SEKME);
  if (!sh) {
    sh = ss.insertSheet(ONLINE_SEKME);
    sh.getRange(1, 1, 1, SUTUNLAR.length).setValues([SUTUNLAR]).setFontWeight("bold").setBackground("#d9ead3");
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), SUTUNLAR.length).setNumberFormat("@"); // tarih/saat/telefon metin kalsın
  }
  return sh;
}

function ekle(satir) {
  const sh = onlineSekme();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, satir.length).setNumberFormat("@").setValues([satir.map(String)]);
    return { tamam: true, satirNo: r };
  } finally {
    lock.releaseLock();
  }
}

function oku() {
  const ss = SpreadsheetApp.getActive();
  const hf = ss.getSheetByName(HAFTALIK_SEKME);
  let haftalik = [];
  if (hf) {
    const aralik = hf.getRange("A1:L30");
    const metinler = aralik.getDisplayValues();
    const renkler = aralik.getFontColorObjects();
    haftalik = metinler.map((satir, i) => satir.map((metin, j) => (metin ? { metin, renk: renk(renkler[i][j]) } : "")));
  }
  const online = onlineSekme().getDataRange().getDisplayValues();
  return { haftalik, online };
}

/** Yazı rengini sitenin anladığı biçime çevirir: {rgbColor:{red,green,blue}} (0–1) veya {themeColor}. */
function renk(c) {
  try {
    if (!c) return null;
    if (c.getColorType() === SpreadsheetApp.ColorType.RGB) {
      const hex = c.asRgbColor().asHexString().replace("#", "").slice(-6);
      return {
        rgbColor: {
          red: parseInt(hex.slice(0, 2), 16) / 255,
          green: parseInt(hex.slice(2, 4), 16) / 255,
          blue: parseInt(hex.slice(4, 6), 16) / 255,
        },
      };
    }
    if (c.getColorType() === SpreadsheetApp.ColorType.THEME) {
      return { themeColor: String(c.asThemeColor().getThemeColorType()) };
    }
  } catch (hata) {
    // bilinmeyen renk türü → varsayılan (siyah) sayılır
  }
  return null;
}

/** Kurulumdan sonra bir kez çalıştırın: izinleri onaylatır ve test e-postası yollar. */
function kurulumTesti() {
  const o = oku();
  MailApp.sendEmail(BILDIRIM_EPOSTA, "Aysu Halı Saha: tablo köprüsü kuruldu",
    "Kurulum tamam. Haftalık tablodan " + o.haftalik.length + " satır okundu.");
  Logger.log("Tamam: " + o.haftalik.length + " satır okundu, test e-postası gönderildi.");
}
