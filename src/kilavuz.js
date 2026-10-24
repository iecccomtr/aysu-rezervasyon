// Panel kullanım kılavuzu (göreve göre). Kullanıcı onaylanınca e-postayla PDF olarak gider.
import { Pdf } from "./pdf.js";

const ORTAK_GIRIS = { baslik: "Panele giriş", maddeler: [
  "Adres: aysuhalisaha.com/panel — e-posta adresiniz ve şifrenizle giriş yapın.",
  "Telefona uygulama gibi eklemek için: Takvim sayfasının en altındaki \"Paneli telefona uygulama olarak yükle\" düğmesi (iPhone'da Paylaş → Ana Ekrana Ekle).",
  "Şifrenizi kimseyle paylaşmayın. Unutursanız giriş ekranındaki \"Şifremi unuttum\"u kullanın.",
  "Panelde ekranlarda adınız filigran olarak yazar; ekran görüntüsü ve kopyalama kapalıdır. Bilgiler işletmeye özeldir.",
] };
const PUANTAJ = { baslik: "GELDİM / ÇIKTIM (çalışma saatiniz)", maddeler: [
  "Sahaya gelince panelde GELDİM'e basın. İş başından 2 saat önce panele girerseniz size kendiliğinden sorulur.",
  "İşten çıkarken ÇIKTIM'a basın. Günün özeti (saat ve ücret) e-postanıza gelir.",
  "Çalışma süresi yarım saate yuvarlanır ve her güne yarım saat yol eklenir.",
  "Yol hariç 8 saat ve üzeri çalıştığınız günlere 300 TL yemek ücreti eklenir.",
  "Personel kantininden aldıklarınız %40 indirimlidir ve ay sonunda maaştan düşülür.",
  "Unuttuğunuz GELDİM / ÇIKTIM'ı Müdür düzeltebilir; ona haber verin.",
] };
const GOREVLER = { baslik: "Görevler ve videolar", maddeler: [
  "Alt menüde Görevler: o günün işleri (WC, soyunma odaları, kantin, saha, çöp, krampon, yelek, otopark…).",
  "Her görevi bitirince \"Yaptım\"e basın. Görevler kişiye özeldir: aynı gün çalışan herkes kendi vardiyasında ayrı yapar.",
  "Kimin yaptığı ve kimin beklediği listede görünür; onay o günün yöneticisine e-postayla gider.",
  "Aynı sayfadaki Videolar bölümünde tesis kullanımı ve Acil durum videoları vardır. İşe başlarken mutlaka izleyin.",
] };
const TAKVIM_IZLE = { baslik: "Takvim", maddeler: [
  "Takvimde haftanın rezervasyonlarını ve abone saatlerini görürsünüz (sadece görüntüleme).",
  "Renkler: yeşil onaylı, sarı (kum saatli) opsiyon (ödeme bekleniyor), mavi abone, gri abone o hafta gelmiyor.",
] };
const YONETICI_TAKVIM = { baslik: "Takvim ve rezervasyon", maddeler: [
  "Boş saate dokunun → ad, telefon, alınan kapora → \"Rezervasyonu kaydet\". Kayıt yöneticilere e-postayla bildirilir.",
  "Aynı pencerede \"Bu saate abone kaydet\" ile her hafta aynı saat için abone açabilirsiniz (e-posta zorunlu; abone sayfası bağlantısı aboneye gider).",
  "Rezervasyona dokunup iptal ederken açıklama zorunludur; iptal sonrası müşteriye hazır WhatsApp mesajı açılır.",
  "Abone saatine dokunun: \"Sadece bu hafta gelmiyor\", günü / saati kalıcı taşıma, not, düzenleme ve \"Aboneliği sonlandır\".",
  "Yeni abonelerde ayda 1 erteleme hakkı vardır; fazlasında sistem \"depozito yanar\" diye uyarır. İlk 3 ay dolmadan sonlandırmada ücretsiz son maç verilmez.",
  "Online opsiyonlar (sarı, kum saatli) dekont yüklenince kendiliğinden kesinleşir; 15 dakikada dekont gelmezse saat boşa çıkar.",
] };
const YONETICI_KASA = { baslik: "Kasa (gün sonu)", maddeler: [
  "Maçlar takvimden kendiliğinden gelir. Takvim maçının ücreti maç başladıktan 30 dakika sonra kasaya işlenir.",
  "Maç kartında krampon / eldiven adedi, Kantin (adet seçip her ürünün altında kaçının ödendiğini − / + ile girin), İkram ve izinli abonelerde Veresiye.",
  "Abonenin art arda saatleri tek kartta toplanır; gerekirse \"Saatleri ayrı göster\". Kantin anlaşmalı abonelerde (ör. çay) fiyat kendiliğinden uygulanır.",
  "Bugün gelen kaporalar (IBAN) listelenir; yanlış olanı açıklama yazarak silebilirsiniz (Admin'e bildirilir).",
  "Personel kantini, çalışana günlük ödeme / avans, kasa girişi ve çıkışı (harcamalar) ilgili kutulara girilir.",
  "Açık veresiyeler abonenin sonraki maç gününde maç kartında \"Tahsil et\" olarak çıkar; tahsil edilen para o günün kasasına girer.",
  "Değişiklikler birkaç saniyede kendiliğinden kaydedilir. Gün sonunda kasayı sayıp \"Sayılan kasa\" ve \"Ertesi güne devir\"i yazın, sonra \"Kasayı gönder\".",
  "Kasayı gönderince: rapor Admin'e gider, açık kalan çalışanlara ÇIKTIM yazılır, haftalık takvim PDF'i gönderilir.",
] };
const YONETICI_STOK = { baslik: "Kantin ve temizlik stoğu", maddeler: [
  "Kasa sayfasında Kantin stok: ürüne dokunup gelen malı ya da sayımı girin. Sayım sistemdeki stoktan farklıysa Admin'e uyarı gider.",
  "Stoğu 5 ve altına düşen ürünler \"Azalan ürünler\"de listelenir; adet yazıp Tespo'ya WhatsApp siparişi gönderin.",
  "Temizlik ürünleri stoğu ve siparişi aynı sayfada; tedarikçi ve usta numaraları en altta WhatsApp düğmeleriyle.",
  "Filtre / Türk kahvesi stoğu bardak stoğuna bağlıdır (Türk kahvesi 2 bardak düşer).",
] };
const YONETICI_DIGER = { baslik: "Aboneler, müşteriler, kullanıcılar", maddeler: [
  "Aboneler: kayıt tarihi, depozito, e-posta, kantin anlaşması, abone sayfası (e-posta / WhatsApp ile gönder), iptal talepleri (onayla / geri çevir).",
  "Müşteriler: telefon, maç geçmişi, notlar; müşteriyi \"Abone yap\".",
  "Kullanıcılar: yeni çalışanların kaydını onaylayın (onaylanan çalışana kurallar ve bu kılavuz e-postayla gider).",
  "Bir sonraki iş gününe kadar: ÇIKTIM dedikten sonra paneliniz kapanır. Yanlışlıkla çıktıysanız Admin düzeltir.",
] };
const TEMIZLIK = { baslik: "Temizlik şefi", maddeler: [
  "Görevler sayfasında \"Temizlik ürünleri stoğu\": gelen malı ve sayımı girin, yeni ürün ekleyin.",
  "Krampon ve eldiven sorumluluğu sizdedir: iadede dezenfektan ve koku sıkılır.",
  "Çay 1,5 saatte bir taze demlenir; soyunma odaları her takımdan sonra toparlanır; yelekler her akşam yıkanır.",
] };
const MUDUR = { baslik: "Müdür'e özel", maddeler: [
  "Kantin ürünlerini düzenleyebilir, yeni alış fiyatı girebilirsiniz (satış = alış × kâr çarpanı, 5 ₺'ye yukarı yuvarlanır). Kâr çarpanını değiştirebilirsiniz.",
  "Puantajda çalışanların unuttuğu GELDİM / ÇIKTIM'ı düzeltebilirsiniz.",
  "Kullanıcılar sekmesinde memnuniyet anketi sonuçlarını görürsünüz (1–2 puanda size e-posta gelir).",
] };

export const KILAVUZ = {
  personel: { ad: "Personel", bolumler: [ORTAK_GIRIS, PUANTAJ, GOREVLER, TAKVIM_IZLE] },
  temizlik: { ad: "Temizlik Şefi", bolumler: [ORTAK_GIRIS, PUANTAJ, GOREVLER, TEMIZLIK, TAKVIM_IZLE] },
  mudur_yrd: { ad: "Müdür Yardımcısı", bolumler: [ORTAK_GIRIS, PUANTAJ, YONETICI_TAKVIM, YONETICI_KASA, YONETICI_STOK, YONETICI_DIGER, GOREVLER] },
  mudur: { ad: "Müdür", bolumler: [ORTAK_GIRIS, PUANTAJ, YONETICI_TAKVIM, YONETICI_KASA, YONETICI_STOK, YONETICI_DIGER, MUDUR, GOREVLER] },
  admin: { ad: "Admin", bolumler: [ORTAK_GIRIS, YONETICI_TAKVIM, YONETICI_KASA, YONETICI_STOK, YONETICI_DIGER, MUDUR, GOREVLER] },
};

/** Göreve göre kılavuz PDF'i */
export function kilavuzPdf(rol, ad = "") {
  const k = KILAVUZ[rol] || KILAVUZ.personel;
  const pdf = new Pdf();
  const SOL = 44, SAG = pdf.genislik - 44, EN = SAG - SOL, ALT = pdf.yukseklik - 50;
  let y = 0, sayfa = 1;
  const ust = () => {
    pdf.kutu(0, 0, pdf.genislik, 70, [0.02, 0.16, 0.27]);
    pdf.yazi(SOL, 32, "AYSU HALI SAHA", { boyut: 16, kalin: true, renk: [1, 1, 1] });
    pdf.yazi(SOL, 52, `Panel kullanım kılavuzu · ${k.ad}`, { boyut: 11, renk: [0.72, 0.83, 0.91] });
    if (ad) pdf.yazi(SAG, 42, ad, { boyut: 11, kalin: true, renk: [1, 1, 1], hiza: "sag" });
    pdf.yazi(pdf.genislik / 2, pdf.yukseklik - 22, `aysuhalisaha.com/panel · Sayfa ${sayfa}`, { boyut: 8, renk: [0.36, 0.42, 0.47], hiza: "orta" });
    y = 100;
  };
  const yer = (h) => { if (y + h > ALT) { pdf.yeniSayfa(); sayfa++; ust(); } };
  // Kelime kelime satırlara böler
  const satirla = (metin, en, boyut) => {
    const s = []; let cur = "";
    for (const w of String(metin).split(" ")) {
      const dene = cur ? `${cur} ${w}` : w;
      if (pdf.olc(dene, boyut) > en && cur) { s.push(cur); cur = w; } else cur = dene;
    }
    if (cur) s.push(cur);
    return s;
  };
  ust();
  for (const b of k.bolumler) {
    yer(50);
    y += 6;
    pdf.yazi(SOL, y, b.baslik, { boyut: 14, kalin: true, renk: [0, 0.4, 0.64] });
    y += 6; pdf.cizgi(SOL, y, SAG, y, { kalinlik: 1.2, renk: [0.94, 0.5, 0.1] }); y += 16;
    for (const m of b.maddeler) {
      const l = satirla(m, EN - 16, 10.5);
      yer(l.length * 14 + 6);
      pdf.yazi(SOL + 2, y, "•", { boyut: 11, kalin: true, renk: [0.94, 0.5, 0.1] });
      for (const s of l) { pdf.yazi(SOL + 16, y, s, { boyut: 10.5 }); y += 14; }
      y += 4;
    }
    y += 6;
  }
  yer(30);
  pdf.yazi(SOL, y + 10, "Sorunuz olursa Müdürünüze danışın. İyi çalışmalar!", { boyut: 10, kalin: true, renk: [0.36, 0.42, 0.47] });
  return pdf.bayt();
}
