# Aysu Halı Saha: Web Sitesi, Online Rezervasyon ve Yönetim Paneli

Her şey kendi sistemimizde (Cloudflare) çalışır. Google tablosu, ek hesap ya da aylık ücret gerekmez.

| Adres | Ne |
|---|---|
| `/` | Web sitesi: tanıtım, fiyat ve saatler, canlı boş saatler tabelası, tesis galerisi, konum |
| `/rezervasyon/` | Müşterinin rezervasyon yaptığı sayfa (santral SMS'indeki link buraya gider) |
| `/panel/` | **Yönetim paneli**: takvim, telefon rezervasyonları, kapora takibi, aboneler, müşteriler (CRM) |
| `/kvkk.html` | Aydınlatma metni (taslak, hukuki kontrol önerilir) |

Canlı adres: **https://aysu-rezervasyon.aysuahmt.workers.dev**. GitHub'a gönderilen her değişiklik birkaç dakikada yayına alınır.

---

## Panel kurulumu (bir kez)

1. `/panel/` adresini açın.
2. **Kurulum kodu** olarak `wrangler.jsonc` dosyasındaki `PANEL_KURULUM_KODU` değerini girin, ardından bir **şifre** belirleyin (en az 8 karakter).
3. Bitti. Aynı şifreyle telefondan ya da bilgisayardan girebilirsiniz. Oturum 30 gün açık kalır.

**Şifreyi unutursanız:** Giriş ekranında "Şifremi unuttum"a basın, kurulum kodu ve yeni şifreyle sıfırlayın. Sıfırlama tüm açık oturumları kapatır. Kurulum kodunu kimseyle paylaşmayın; değiştirmek için `wrangler.jsonc`'deki değeri değiştirmek yeterli.

---

## Günlük kullanım

### Takvim
- Haftanın her günü ve saati tek listede görünür: **boş**, **rezervasyon** (online ya da telefon) veya **abone**.
- **Telefonla gelen rezervasyon:** Boş saate dokunun, ad ve telefonu yazıp kaydedin. Durum varsayılan olarak "Onaylı" gelir. Kapora alındıysa tutarını yazın. Site o saati anında dolu gösterir.
- **Kapora bekleyenler:** Online rezervasyonlar üstte sarı kutuda listelenir. Dokunun, **Onaylı**'yı seçin ve ödenen tutarı yazın (ör. `1000 + 200`).
- **İptal:** Rezervasyona dokunun, **İptal**'i seçip kaydedin. Saat yeniden boşa çıkar.
- Panel açıkken takvim her dakika kendini yeniler.

### Aboneler
- **+ Abone ekle** ile ad, telefon, gün ve saat girin. Abone her hafta o saatte otomatik dolu görünür.
- **Abone bu hafta gelmeyecekse:** Takvim'de abonenin saatine dokunun ve **"Bu hafta gelmiyor"**'a basın. Saat sadece o hafta boşa çıkar, sitede rezervasyona açılır, sonraki haftalar dolu kalır. Fikir değişirse boş saate dokunup **"Abone yine geliyor"**'a basın.
- Aboneliği bitirmek için abonenin üstüne dokunun ve **"Aboneliği sonlandır"**'a basın.
- 00:00–02:00 saatleri seçilen günün gecesidir: "Cuma 01:00" = Cuma'yı Cumartesi'ye bağlayan gece.

### Müşteriler (CRM)
- Online, telefon ve abone kayıtlarındaki herkes telefon numarasına göre tek kartta toplanır: maç sayısı, son maç, sıradaki maç, iptaller, abonelik, kapora bekleyen.
- İsim, telefon veya etikete göre arama yapılabilir.
- Karta dokunarak **etiket** (ör. VIP, Kurumsal, Dikkat) ve **not** ekleyebilir, tüm rezervasyon geçmişini görebilir, tek dokunuşla arayabilir ya da WhatsApp'tan yazabilirsiniz.

### Müşteri tarafı
1. Müşteri günü ve boş saati seçer, ad soyad ve cep telefonunu yazar.
2. Saat hemen tutulur ve rezervasyon panelde **Kapora bekleniyor** olarak görünür.
3. Müşteri ekranda kayıt numarasını, IBAN'ı ve kalan tutarı görür. "Dekontu WhatsApp'tan gönder" düğmesi kayıt numaralı hazır bir mesaj açar.
4. Müşteri, maçtan en geç 3 saat önce kayıt numarası ve telefonuyla sayfadan iptal edebilir.

Kurallar: en fazla 7 gün ileriye rezervasyon, bir telefonla en fazla 2 ileri tarihli rezervasyon, aynı saate aynı anda iki kişi basarsa sadece biri kaydedilir.

---

## İsteğe bağlı

### E-posta bildirimi
Yeni online rezervasyon ve iptallerde e-posta almak isterseniz resend.com'da **aysuhalisaha@gmail.com** ile ücretsiz hesap açın ve API anahtarını Cloudflare'de **Settings → Variables and Secrets** bölümüne `RESEND_API_KEY` adıyla **Secret** olarak girin. Alan adı Cloudflare'e geçince bu bildirim Resend'siz de kurulabilir.

### Santral SMS linki
> Aysu Halı Saha'yı aradığınız için teşekkürler. Online rezervasyon: https://aysuhalisaha.com/rezervasyon

### Alan adını yeni siteye geçirme
1. Fotoğrafları `public/galeri/` klasörüne koyun (bkz. `BENIOKU.txt`). Şu an fotoğraflar eski siteden çekiliyor.
2. Cloudflare'de **Add a domain** ile `aysuhalisaha.com`'u ekleyin. Verilen iki nameserver'ı alan adını aldığınız firmanın panelinde güncelleyin.
3. Worker'da **Settings → Domains & Routes → Add → Custom domain** ile `aysuhalisaha.com` ve `www.aysuhalisaha.com` adreslerini ekleyin.
4. Birkaç gün sorunsuz çalıştıktan sonra Alastyr hosting'i kapatabilirsiniz.

---

## Ayarlar (`src/config.js`)

| Ayar | Ne işe yarar |
|---|---|
| `SAATLER` | Maç saatleri (08:00 – 02:00) |
| `FIYATLAR` | Maç ücreti (3700 TL) ve kapora (1200 TL); gündüz, akşam ve hafta sonu ayrı ayarlanabilir |
| `IBAN` | Kapora için gösterilen IBAN ve alıcı |
| `KURALLAR` | Kaç gün ileriye rezervasyon (7), kişi başı aktif rezervasyon (2), iptal için son saat (3) |

## Verinin yeri ve yedek
Tüm kayıtlar Cloudflare'in **Durable Object** veritabanında tutulur. Cloudflare bu veriyi kendisi yedekler ve son 30 güne geri dönüş imkânı sunar. İleride panelden Excel'e aktarma eklenebilir.

## Geliştirici notları
- `npm test`: 20 test (abone ve "bu hafta gelmiyor", gece maçları, çift rezervasyon, iptal, panel girişi, kapora, CRM, API uçları).
- `node --import ./test/register.mjs test/yerel-sunucu.mjs`: örnek verili yerel sunucuyu `http://localhost:8787` adresinde açar (panel kurulum kodu: `yerel-kurulum`).
- Güvenlik: panel şifresi PBKDF2 ile saklanır, oturum çerezi HttpOnly + Secure + SameSite=Strict, başka sitelerden gelen POST istekleri reddedilir, IP başına dakikada 20 istek sınırı ve bot tuzağı alanı vardır.
