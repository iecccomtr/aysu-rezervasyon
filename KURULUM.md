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

Gizli değerler Cloudflare'de **Workers & Pages → aysu-rezervasyon → Settings → Variables and Secrets → Add** yolundan **Secret** olarak girilir. Bu değerleri kimseyle paylaşmayın, bir yere yazmayın.

### 1. Google servis hesabı (tabloya erişim)
1. https://console.cloud.google.com adresinde yeni proje açın (ad: `aysu-rezervasyon`).
2. **APIs & Services → Library** bölümünde **Google Sheets API**'yi bulup **Enable** deyin.
3. **APIs & Services → Credentials → Create credentials → Service account** yolunu izleyin. İsim verin, rol atamayın.
4. Oluşan hesaba girin, **Keys → Add key → Create new key → JSON** seçin. Bir dosya iner. İçindeki iki değer lazım:
   - `client_email` (ör. `aysu-bot@aysu-rezervasyon.iam.gserviceaccount.com`)
   - `private_key` (`-----BEGIN PRIVATE KEY-----` ile başlayan uzun metin)
5. **Tablonun sahibi**, "REZERVASYON VE GÖREVLER" tablosunu **Paylaş** düğmesinden `client_email` adresiyle **Düzenleyen** olarak paylaşsın.
6. Cloudflare'e şu üç secret'ı girin:

   | Ad | Değer |
   |---|---|
   | `SHEET_ID` | `16Y80fH6RpQyTD_Qqg7FFsaZEwXz6QAO6ZDXx1G_jjP8` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` |
   | `GOOGLE_PRIVATE_KEY` | `private_key`'in tamamı (BEGIN/END satırları dahil) |

7. Kontrol için `.../api/saglik` adresini açın. `"depo":"google-sheets"` görünüyorsa bağlantı tamamdır. Site ilk okumada **"Online Rezervasyonlar"** sekmesini kendisi oluşturur.

### 2. E-posta bildirimi (Resend, ücretsiz)
1. https://resend.com adresinde **aysuhalisaha@gmail.com** ile hesap açın.
2. **API Keys → Create API Key** ile anahtar oluşturun (`re_...` ile başlar).
3. Cloudflare'e `RESEND_API_KEY` secret'ını girin.

Bildirimler aysuhalisaha@gmail.com'a gelir. Başka bir adrese gitsin isterseniz `BILDIRIM_EPOSTA` ekleyin. Not: Kendi alan adınızı Resend'de doğrulamadan önce Resend sadece hesabı açtığınız e-postaya gönderim yapar, o yüzden hesabı bu adresle açın.

### 3. Santral SMS linki
SMS'teki WhatsApp linkini değiştirin. Örnek metin:
> Aysu Halı Saha'yı aradığınız için teşekkürler. Online rezervasyon: https://aysuhalisaha.com/rezervasyon

### 4. Alan adını yeni siteye geçirme
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
Cloudflare, Google E-Tablolar ve Resend'in ücretsiz planları bu iş için yeterli. **Aylık ücret yok.**

## Geliştirici notları
- `npm test`: 20 test (doluluk kuralları, siyah ABONE, gece maçları, çift rezervasyon, iptal, Google bağlantısı, API uçları, e-posta).
- `node --import ./test/register.mjs test/yerel-sunucu.mjs`: yerel deneme sunucusunu demo depoyla `http://localhost:8787` adresinde açar.
- Kötüye kullanım koruması: IP başına dakikada 20 istek, görünmez bot tuzağı alanı ve başka sitelerden gelen isteklerin reddi.
