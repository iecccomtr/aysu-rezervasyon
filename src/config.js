// ============================================================
//  AYSU HALI SAHA — AYARLAR
//  İşletme bilgileri, saatler ve fiyatlar burada.
//  ⚠️  "KONTROL ET" yazan değerleri gerçekleriyle karşılaştırın.
// ============================================================

export const ISLETME = {
  ad: "Aysu Halı Saha",
  adres: "Batıkent Mah. Ertürk Sk. No:2, Tepebaşı / Eskişehir",
  telefon: "0 555 510 26 26",
  sabitHat: "0 222 335 35 55",
  harita: "https://maps.google.com/?q=Aysu+Halısaha+Eskişehir",
  instagram: "https://www.instagram.com/aysuhalisahacom",
};

// Maç saatleri (her maç 1 saat) — haftalık tablodaki saatlerle aynı.
// Gece yarısından sonraki saatler (00:00–02:00) o günün GECESİNE aittir:
// "Pazartesi 01:00" = Salı sabahı 01:00.
export const SAATLER = [
  "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00",
  "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00",
  "00:00", "01:00", "02:00",
];

// Ücretler (TL). Tablodaki "1200/2500" = 1200 kapora + 2500 kalan = 3700 toplam.
// Saate/güne göre fiyat değişiyorsa aşağıdakileri ayrı ayrı düzenleyin.
export const FIYATLAR = {
  gunduz: 3700,       // hafta içi, akşam saatinden önce
  aksam: 3700,        // hafta içi, akşam saati ve sonrası
  haftaSonu: 3700,    // cumartesi-pazar tüm gün
  aksamBaslangic: 18, // akşam tarifesinin başladığı saat
  kapora: 1200,
};

// Kapora nasıl alınır? Asistan müşteriye bunu söyler.  KONTROL ET
export const KAPORA_ACIKLAMA =
  "Maç ücreti toplam 3700 TL. Rezervasyonun kesinleşmesi için 1200 TL kapora alınır (havale/EFT, birden fazla parça halinde de gönderilebilir), kalan tutar maç günü sahada ödenir. Kapora ödemesi görüldüğünde rezervasyon onaylanır; sorusu olan 0 555 510 26 26'yı arayabilir.";

// IBAN yazılırsa asistan müşteriye kapora için IBAN'ı verir ve açıklamaya
// kayıt numarasını yazmasını ister. Boş bırakılırsa IBAN paylaşılmaz.  KONTROL ET
export const IBAN = { no: "TR70 0015 7000 0000 0154 8342 35", alici: "Ahmet Aysu" };

// Saha olanakları — müşteri sorarsa asistan bunları söyler.  KONTROL ET
export const OLANAKLAR = [
  "Kapalı (balon) saha, her havada oynanır",
  "Soyunma odası ve duşlar",
  "Televizyonlu kafeterya / dinlenme salonu",
  "Tesis önünde otopark",
];

export const KURALLAR = {
  enFazlaGunSonra: 7,           // en fazla kaç gün sonrasına rezervasyon alınır
  kisiBasiAktifRezervasyon: 2,  // bir numara için gelecekteki en fazla rezervasyon
  iptalEnGecSaat: 3,            // maçtan en geç kaç saat önce çevrimiçi iptal edilebilir
};

// Yapay zekâ modeli. Daha zeki ama pahalı seçenek: "claude-sonnet-5-5"
export const MODEL = "claude-haiku-5-5";

// ---------- Google E-Tablo ----------
// Çalışanların kullandığı haftalık tablo (sadece OKUNUR, asla değiştirilmez)
export const HAFTALIK_SEKME = "REZERVASYON";
// Asistanın rezervasyon yazdığı sekme (yoksa otomatik oluşturulur)
export const ONLINE_SEKME = "Online Rezervasyonlar";
export const SUTUNLAR = [
  "Tarih", "Gün", "Saat", "Ad Soyad", "Telefon",
  "Durum", "Kayıt No", "Not", "Oluşturma", "Ödenen Kapora",
];
// "Ödenen Kapora" sütununu çalışanlar doldurur (ör. "1000 + 200").
// Asistan bu sütuna hiç dokunmaz; ödeme gelince Durum'u "Onaylı" yapın.
export const DURUM = {
  bekliyor: "Kapora bekleniyor",
  onayli: "Onaylı",
  iptal: "İptal",
};
