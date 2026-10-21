# Aysu Halı Saha: Web Sitesi ve Online Rezervasyon

| Adres | Ne |
|---|---|
| `/` | Web sitesi: tanıtım, fiyat ve saatler, **canlı boş saatler tabelası**, tesis galerisi, konum |
| `/rezervasyon/` | Rezervasyon sayfası (santralin SMS'indeki link buraya gider) |
| `/kvkk.html` | Aydınlatma metni (taslak, hukuki kontrol önerilir) |

İki sayfada da sağ altta **WhatsApp** düğmesi var. Konuşmak isteyen müşteri doğrudan 0 555 510 26 26'ya yazar.

## Rezervasyon nasıl işler

1. Müşteri **günü** ve **boş saati** seçer, **ad soyad** ve **cep telefonu** yazar.
2. Sistem saati hemen tutar ve kaydı Google E-Tablo'daki **"Online Rezervasyonlar"** sekmesine **"Kapora bekleniyor"** durumuyla yazar.
3. Müşteriye ekranda **kayıt numarası** (ör. `AY-K7P2M`), **IBAN** ve kalan tutar gösterilir. "Dekontu WhatsApp'tan gönder" düğmesi kayıt numaralı hazır bir mesaj açar.
4. İşletmeye **e-posta** gelir: tarih, saat, ad, telefon, kayıt no.
5. Kapora gelince tabloda **"Ödenen Kapora"** sütununa tutarı yazın (ör. `1000 + 200`) ve **Durum**'u **Onaylı** yapın. Gelmezse **İptal** yazın, saat yeniden boşalır.

Müşteri kayıt numarası ve telefonuyla sayfadan kendisi iptal edebilir (maçtan en geç 3 saat önce). İptallerde de e-posta gelir.

### Doluluk kuralları
- Çalışanların kullandığı haftalık **REZERVASYON** tablosu sadece **okunur**, site oraya hiç yazmaz. Telefonla alınan rezervasyonları her zamanki gibi oraya yazın, site o saatleri dolu gösterir.
- **ABONE** hücreleri her hafta dolu sayılır. **İstisna:** ABONE yazısı **siyahsa** abone bu hafta gelmiyor demektir. O saat bu hafta boş görünür, gelecek hafta yine dolu sayılır. Aktif aboneleri **renkli** (ör. mavi) yazın; hiç renk verilmemiş yazı siyah sayılır.
- İsimli tek seferlik hücreler (ör. "EREN - 1200/2500 TL") sadece içinde bulunulan hafta için dolu sayılır.
- "Online Rezervasyonlar" sekmesinde Durum'u **İptal** olmayan her satır dolu sayılır.
- Gece maçları (00:00, 01:00, 02:00) o günün gecesidir: "Cuma 01:00" = Cumartesi sabahı 01:00.
- Aynı saate aynı anda iki kişi basarsa sadece biri kaydedilir.
- Bir telefon numarasıyla aynı anda en fazla 2 ileri tarihli rezervasyon yapılabilir.

---

## Kurulum

Site Cloudflare'de yayında: **https://aysu-rezervasyon.aysuahmt.workers.dev**. GitHub'a gönderilen her değişiklik otomatik olarak yayına alınır. Şu an **demo modunda**: tabloya bağlı değil ve her saati boş gösteriyor.

Gizli değerler Cloudflare'de **Workers & Pages → aysu-rezervasyon → Settings → Variables and Secrets → Add** yolundan **Secret** olarak girilir. Bu değerleri herkese açık bir yere yazmayın.

### 1. Tablo köprüsü (Google Apps Script): tablo bağlantısı ve e-posta tek adımda
Bu adımı **tablonun sahibi** olan Google hesabıyla yapın.

1. "REZERVASYON VE GÖREVLER" tablosunu açın, **Uzantılar → Apps Script**'e girin.
2. Açılan editördeki kodun hepsini silin, size verilen **Kod.gs** dosyasının içeriğini yapıştırın ve **Kaydet**'e (💾) basın. Dosyada anahtar hazır yazılı gelir. Depodaki `apps-script/Kod.gs` ise anahtarsız şablondur.
3. Üstteki fonksiyon listesinden **kurulumTesti**'ni seçip **Çalıştır**'a basın. Google izin isteyecek: **İzinleri incele →** hesabınızı seçin → **Gelişmiş → (güvenli değil) sayfasına git → İzin ver**. Bu uyarı, kodu Google'a değil sizin yazdığınız için çıkar. Bir dakika içinde aysuhalisaha@gmail.com'a test e-postası gelir.
4. Sağ üstte **Dağıt → Yeni dağıtım** yolunu izleyin. Dişli simgesinden **Web uygulaması**'nı seçin:
   - **Şu kullanıcı olarak yürüt:** Ben
   - **Erişimi olan:** Herkes
   - **Dağıt**'a basın ve verilen **Web uygulaması URL'sini** kopyalayın (`https://script.google.com/macros/s/.../exec`).
5. Cloudflare'de **Workers & Pages → aysu-rezervasyon → Settings → Variables and Secrets → Add** yolundan **iki Secret** ekleyin:

   | Ad | Değer |
   |---|---|
   | `SCRIPT_URL` | 4. adımdaki web uygulaması URL'si |
   | `SCRIPT_ANAHTAR` | Kod.gs'nin başındaki `ANAHTAR` değeri (tırnaklar hariç) |

6. `https://aysu-rezervasyon.aysuahmt.workers.dev/api/saglik` adresini açın. `"depo":"google-sheets (apps script)"` görünüyorsa kurulum bitti. Tabloda **"Online Rezervasyonlar"** sekmesi ilk rezervasyonda kendiliğinden açılır.

> Kod.gs'yi sonradan değiştirirseniz **Dağıt → Dağıtımları yönet → düzenle (kalem) → Sürüm: Yeni sürüm → Dağıt** yapın. Yeni dağıtım açarsanız URL değişir ve Cloudflare'deki `SCRIPT_URL`'yi güncellemeniz gerekir.

Bildirim e-postaları tablonun sahibinin Gmail'inden aysuhalisaha@gmail.com'a gider. Başka bir adrese gitsin isterseniz Cloudflare'e `BILDIRIM_EPOSTA` ekleyin.

<details><summary>Alternatif: Google servis hesabı ve Resend (ileri seviye)</summary>

Apps Script yerine Google Cloud servis hesabı da kullanılabilir: `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` ve `GOOGLE_PRIVATE_KEY` secret'larını girin ve tabloyu servis hesabıyla "Düzenleyen" olarak paylaşın. Bu durumda e-posta için resend.com'dan alınan `RESEND_API_KEY` gerekir. İki kurulum birlikte yapılırsa Apps Script köprüsü önceliklidir.
</details>

### 2. Santral SMS linki
SMS'teki WhatsApp linkini değiştirin. Örnek metin:
> Aysu Halı Saha'yı aradığınız için teşekkürler. Online rezervasyon: https://aysuhalisaha.com/rezervasyon

### 3. Alan adını yeni siteye geçirme
Önce her şeyi `workers.dev` adresinde deneyin. Hazır olunca:
1. Fotoğrafları `public/galeri/` klasörüne koyun (bkz. `BENIOKU.txt`). Şu an fotoğraflar eski siteden çekiliyor.
2. Cloudflare'de **Add a domain** ile `aysuhalisaha.com`'u ekleyin. Verilen iki nameserver'ı alan adını aldığınız firmanın panelinde güncelleyin.
3. Worker'da **Settings → Domains & Routes → Add → Custom domain** ile `aysuhalisaha.com` ve `www.aysuhalisaha.com` adreslerini ekleyin.
4. Birkaç gün sorunsuz çalıştıktan sonra Alastyr hosting'i kapatabilirsiniz. Alan adınızda e-posta (MX) kaydı varsa geçişten sonra kontrol edin.

---

## Ayarlar (`src/config.js`)

| Ayar | Ne işe yarar |
|---|---|
| `SAATLER` | Maç saatleri (08:00 – 02:00) |
| `FIYATLAR` | Maç ücreti (3700 TL) ve kapora (1200 TL). Gündüz, akşam ve hafta sonu ayrı ayarlanabilir. |
| `IBAN` | Kapora için gösterilen IBAN ve alıcı |
| `KURALLAR` | Kaç gün ileriye rezervasyon (7), kişi başı aktif rezervasyon (2), iptal için son saat (3) |
| `HAFTALIK_SEKME` | Haftalık tablonun sekme adı (`REZERVASYON`) |

GitHub'da dosyayı düzenleyip kaydedin. Cloudflare birkaç dakikada yayına alır.

## Maliyet
Cloudflare, Google E-Tablolar ve Apps Script ücretsizdir. **Aylık ücret yok.** (Gmail'den günde 100 e-postaya kadar gönderilebilir.)

## Geliştirici notları
- `npm test`: 24 test (doluluk kuralları, siyah ABONE, gece maçları, çift rezervasyon, iptal, Google bağlantısı, API uçları, e-posta).
- `node --import ./test/register.mjs test/yerel-sunucu.mjs`: yerel deneme sunucusunu demo depoyla `http://localhost:8787` adresinde açar.
- Kötüye kullanım koruması: IP başına dakikada 20 istek, görünmez bot tuzağı alanı ve başka sitelerden gelen isteklerin reddi.
