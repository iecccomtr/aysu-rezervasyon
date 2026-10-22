// "HALISAHA YÖNETİMİNE AİTTİR" — tesis kuralları ve görevler (Google E-Tablo'daki GÖREVLER sayfasından).
// Yeni çalışan hesabı onaylanınca bu metin kendisine e-postayla gider. Yazar kasa şifresi e-postaya yazılmaz.
export const TESIS_KURALLARI = [
  { baslik: "Maaş ve çalışma saatleri", maddeler: [
    "Her maç saatinden 1 saat önce gelinir, son maç bitiş saatinden yarım saat sonra çıkılır.",
    "İşe gelen herkes geldiği ve çıktığı saati panelden GELDİM / ÇIKTIM düğmeleriyle işaretler (aysuhalisaha.com/panel).",
    "Toplam çalışma süresi ortalama haftalık 30 saattir. Maaş ödemeleri her ay başı yapılır.",
  ] },
  { baslik: "Aboneler", maddeler: [
    "1 maç bedeli depozito alınır. Abone kayıt bilgileri (ad soyad, gün ve saat, telefon, ücretin alındığı) gruba yazılır. Abone iptalleri de gruba yazılır.",
    "Aboneler ilk 3 ay içinde abonelikten çıkamaz; çıkmak isterlerse içerideki depozito yanar.",
    "Aboneler her ay 1 kez, erken haber vermek koşuluyla erteleme yapabilir; aksi hâlde depozito yanar (eski abonelere istisna yapılabilir).",
    "3 ayı dolduranlar içerideki depozito karşılığında aynı gün ve saatte ücretsiz maç oynayabilir.",
    "Futbol okulları ödeme dekontunu gün sonunda iletir.",
    "Gündüz projektör yakılması (16:00 ve öncesi) saatlik 250 TL, yarım saatlik 125 TL'dir.",
  ] },
  { baslik: "Saha malzeme kullanımı", maddeler: [
    "Halı sahaya gelen ya da olan her malzemenin yeri fotoğraflanır ve nerede ne olduğu grupta paylaşılır.",
    "Malzeme yerlerini müdür onayı olmadan değiştirmeyin.",
    "Temizlik malzemeleri ortada bırakılmaz; kazan dairesine düzenli şekilde konur.",
  ] },
  { baslik: "Halı saha telefonları", maddeler: [
    "Mobil telefonda santral yönlendirmesi vardır: gelen çağrı 5 saniye çaldıktan sonra santrale, oradan mesajla WhatsApp hattına yönlenir.",
    "Santralin 0222 335 35 55 numarasından da yönlendirmesi vardır.",
    "WhatsApp'tan bilgi almak isteyen müşterilere en geç 1 saat içinde cevap verilir.",
  ] },
  { baslik: "Futbol topları", maddeler: [
    "Müşterilere her zaman bir yeni, bir eski top verilir.",
    "Her zaman 3 yeni yedek top bulundurulur.",
    "Gün sonunda sahada top bırakılmaz; maç sonunda toplar silinir.",
  ] },
  { baslik: "Kantin ve çay", maddeler: [
    "Çaylar taze demlenir (1,5 saatte bir). Çay görevi temizlik personelindedir.",
    "Eksik ürünler yönetimin alışveriş listesine yazılır; siparişler her perşembe anlaşmalı toptancıya verilir.",
    "Kantin stok sayımı her pazartesi ve cuma yapılır, sonuç e-postayla bildirilir.",
    "Kantin stoklarındaki her açık, sahadan sorumlu müdürün maaşından kesilir.",
  ] },
  { baslik: "Temizlik", maddeler: [
    "Soyunma odalarının kaba temizliği her takım çıktıktan sonra hızlıca yapılır.",
    "Her soyunma odasında eşit sayıda terlik bulunur (en az 4'er çift).",
    "Gün sonunda saha içi temizlik yapılır.",
    "Yelekler her akşam 30 derecede yıkanır.",
    "Siyah çöp poşetleri tedarikçiden 25 kg olarak alınır.",
    "Lavabolara düzenli olarak 3-4 naftalin atılır; kokular kadın WC'si, soyunma odası duş kabinleri ve pisuvarlara konur.",
    "Bütün WC'lere çamaşır suyu dökülür.",
    "Yoğun günlerde havalandırmalar çalıştırılır ve saat başı kontrol edilir.",
    "Her ayın 1'inde ve 15'inde ofis temizliği yapılır, tesisin bütün camları silinir.",
    "Yıkama alanına 5 siyah poşet demire bağlanarak konur; alanın temizliği rutin olarak yapılır (yan branda açıldığında).",
    "Panelde Görevler sayfasındaki işleri yaptıkça Yaptım düğmesine basın.",
  ] },
  { baslik: "Krampon ve eldiven", maddeler: [
    "Krampon ve eldiven ücretleri peşin alınır.",
    "Krampon ve eldiven iadesinde dezenfektan ve koku sıkılır.",
    "Tamir yalnızca bir kez yapılır; bir kez tamir edilen ürün tekrar bozulursa atılır ve yenisi için gruba yazılır.",
    "Krampon ve eldiven sorumluluğu Temizlik Şefi'ne aittir.",
  ] },
  { baslik: "Yazar kasa", maddeler: [
    "Her gün 22:30'dan önce Z raporu alınır. (Kasa şifresini müdürünüzden öğrenin.)",
  ] },
  { baslik: "Kapora", maddeler: [
    "Kaporalar rezervasyon sırasında alınır. Tanıdığımız müşterilerden kapora almak gerekmez.",
    "Kapora iadesi yapılmaz; ancak saat ya da gün ertelemesi yapılır.",
    "Kapora ücretleri grupta yazıldığı gibi alınır.",
  ] },
  { baslik: "Saha ücretleri", maddeler: [
    "Saha ücretleri grupta yazıldığı gibidir. 17:00 öncesi abone ücretidir.",
  ] },
  { baslik: "Saha kullanımı", maddeler: [
    "Saha giriş kapısı her gün asma kilitle kilitlenir.",
    "Müdürler rutin hasar kontrolü yapar ve sonucu gruba yazar (branda, saha içi ve dış çevre, file, kamera).",
    "Saha projektörleri boş yere açık bırakılmaz; maç saatinden en fazla 10 dakika önce yakılır.",
  ] },
];
