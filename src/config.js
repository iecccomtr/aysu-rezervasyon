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
  whatsapp: "905555102626", // sitedeki WhatsApp düğmesinin numarası (başında + olmadan)
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

// Rezervasyon tamamlanınca müşteriye gösterilen kapora IBAN'ı.
// Boş bırakılırsa IBAN gösterilmez, "sizi arayacağız" denir.
export const IBAN = { no: "TR70 0015 7000 0000 0154 8342 35", alici: "Ahmet Aysu" };

/** Rezervasyonda seçilebilen ek hizmetler (maç ücretine eklenir). */
export const EKSTRALAR = {
  spiker: { ad: "VIP spiker", ucret: 1600 },
  hakem: { ad: "VIP hakem", ucret: 1000 },
};

export const KURALLAR = {
  enFazlaGunSonra: 27,          // en fazla kaç gün sonrasına rezervasyon alınır (bugün + 27 gün = 4 hafta)
  // Dekont tarihi kontrolü (eski dekontla onay engeli). ŞİMDİLİK KAPALI: denemeler eski dekontla yapılıyor.
  // Canlı kullanıma geçerken true yapın.
  dekontTarihKontrol: false,
  // Aynı dekontun ikinci bir rezervasyonda kullanılmasını engelle. ŞİMDİLİK KAPALI (deneme dönemi). Canlıda true.
  dekontTekrarKontrol: false,
  personelIndirim: 0.30,        // personel kantin indirimi; indirimli birim fiyat 5 TL'nin katına yukarı yuvarlanır
  puantajYolSaat: 0.5,          // tamamlanan her iş gününe yol parası olarak eklenen saat
  puantajCikisEk: 30,           // beklenen çıkış: son maçın bitişinden bu kadar dakika sonra
  opsiyonDakika: 15,            // online rezervasyon: dekont gelmezse yer bu kadar dakika sonra kendiliğinden boşa çıkar
  iptalEnGecSaat: 3,            // maçtan en geç kaç saat önce çevrimiçi iptal edilebilir
};

// Rezervasyon durumları (panelde değiştirilir)
export const DURUM = {
  bekliyor: "Kapora bekleniyor",
  onayli: "Onaylı",
  iptal: "İptal",
};
