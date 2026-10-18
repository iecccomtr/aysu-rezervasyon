# Aysu Halı Saha — Online Rezervasyon Asistanı

Müşteri SMS'teki linke tıklar, sohbet sayfası açılır. Yapay zekâ boş saatlere bakar, rezervasyonu alır ve **Google E-Tablo'daki "Online Rezervasyonlar" sekmesine** yazar. Çalışanların kullandığı haftalık **REZERVASYON** tablosu sadece okunur, asla değiştirilmez.

## Nasıl çalışır

```
Müşteri ──SMS linki──▶ Sohbet sayfası (Cloudflare)
                              │
                              ▼
                     Cloudflare Worker ──▶ Claude (yapay zekâ)
                              │
                              ▼
                     Rezervasyon deposu (tek sıra, çift kayıt olmaz)
                              │
                              ▼
               Google E-Tablo
               ├─ REZERVASYON (haftalık)      → sadece okunur
               └─ Online Rezervasyonlar       → asistan buraya yazar
```

**Doluluk kuralı:**
- Haftalık tabloda **ABONE** yazan hücreler her hafta dolu sayılır.
  - **İstisna:** ABONE yazısı **siyahsa**, abone bu hafta gelmiyor demektir. O saat **bu hafta boş** sayılır ve satılabilir, gelecek hafta yine dolu sayılır.
  - Renk kodu: mavi, kırmızı veya başka bir renk "abone geliyor", siyah "bu hafta gelmiyor" anlamına gelir. Hiç renk verilmemiş yazı da siyah sayılır. Yani aktif aboneleri **mutlaka renkli** yazın.
- İsimli tek seferlik hücreler (ör. "EREN - 1200/2500 TL") sadece **içinde bulunulan hafta** için dolu sayılır, çünkü hafta sonunda siliniyorlar.
- "Online Rezervasyonlar" sekmesinde durumu **İptal** olmayan her satır dolu sayılır.
- Gece maçları (00:00, 01:00, 02:00) o günün gecesidir. Tablodaki "Cuma 01:00" hücresi, Cumartesi sabahı 01:00 demektir.

**Kapora akışı:**
1. Asistan rezervasyonu **"Kapora bekleniyor"** durumuyla yazar ve müşteriye IBAN'ı verir. Müşteriden havale açıklamasına kayıt numarasını (ör. `AY-K7P2M`) yazmasını ister.
2. Para gelince **"Ödenen Kapora"** sütununa tutarı yazın (ör. `1000 + 200`) ve Durum'u **Onaylı** yapın.
3. Kapora gelmezse Durum'u **İptal** yapın. Saat yeniden boşa çıkar.

> **Önemli:** Telefonla alınan rezervasyonları her zamanki gibi haftalık tabloya yazmaya devam edin. Asistan o tabloyu da okuduğu için dolu saati boş sanmaz.

---

## Kurulum (yaklaşık 30–45 dakika)

### 1. Anthropic (yapay zekâ) anahtarı
1. https://console.anthropic.com adresinden hesap açın.
2. **Billing** bölümünden kart ekleyip bakiye yükleyin. Başlangıç için 5–10 $ yeterli.
3. **API Keys → Create Key** ile anahtar oluşturun (`sk-ant-...` ile başlar). Bir yere not edin, bir daha gösterilmez.
4. İsteğe bağlı: **Limits** bölümünden aylık harcama sınırı koyun (ör. 20 $).

### 2. Google servis hesabı (tabloya erişim için)
1. https://console.cloud.google.com adresinde yeni proje açın, adı `aysu-rezervasyon` olabilir.
2. **APIs & Services → Library** bölümünde **Google Sheets API**'yi bulun ve **Enable** deyin.
3. **APIs & Services → Credentials → Create credentials → Service account** yolunu izleyin. İsim verin, rol atamanıza gerek yok.
4. Oluşan hesaba girin, **Keys → Add key → Create new key → JSON** seçin. Bir dosya iner.
5. Dosyadaki şu iki değer lazım olacak:
   - `client_email` (ör. `aysu-bot@aysu-rezervasyon.iam.gserviceaccount.com`)
   - `private_key` (`-----BEGIN PRIVATE KEY-----` ile başlayan uzun metin)

### 3. Tabloyu servis hesabıyla paylaşın
> Bu adımı **tablonun sahibi** yapmalı. Şu an tablo size sadece görüntüleme izniyle açık.

1. "REZERVASYON VE GÖREVLER" tablosunu açın, sağ üstteki **Paylaş** butonuna basın.
2. `client_email` adresini yazın ve **Düzenleyen** seçin, bildirim e-postasını kapatın.
3. Tablonun linkindeki kimliği not edin: `https://docs.google.com/spreadsheets/d/`**`16Y80fH6RpQyTD_Qqg7FFsaZEwXz6QAO6ZDXx1G_jjP8`**`/edit`

Asistan ilk çalıştığında **"Online Rezervasyonlar"** sekmesini kendisi oluşturur. Haftalık sekmenin adı `REZERVASYON` olarak kalmalı. Değişirse `src/config.js` içindeki `HAFTALIK_SEKME` ayarını güncelleyin.

### 4. Cloudflare'e yükleme (GitHub üzerinden, bilgisayara bir şey kurmadan)
1. https://dash.cloudflare.com adresinden ücretsiz hesap açın.
2. **Workers & Pages → Create → Import a repository** ile GitHub hesabınızı bağlayın ve `aysu-rezervasyon` reposunu seçin.
3. Ayarlarda **Deploy command** `npx wrangler deploy` olarak kalsın, **Deploy** deyin.
4. Yükleme bitince Worker'ın **Settings → Variables and Secrets** bölümüne şunları **Secret** olarak ekleyin:

   | Ad | Değer |
   |---|---|
   | `ANTHROPIC_API_KEY` | 1. adımdaki `sk-ant-...` anahtarı |
   | `SHEET_ID` | 3. adımdaki tablo kimliği |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` |
   | `GOOGLE_PRIVATE_KEY` | `private_key`'in tamamı (BEGIN/END satırları dahil) |

5. Size verilen adresi açın: `https://aysu-rezervasyon.<hesap>.workers.dev/api/saglik`
   - `"depo":"google-sheets"` görüyorsanız bağlantı tamam.
   - `"depo":"demo"` görüyorsanız secret'lar eksik demektir.
6. `https://aysu-rezervasyon.<hesap>.workers.dev/rezervasyon/` adresinden deneme rezervasyonu yapın. Tabloda yeni sekmede satırı görün, sonra Durum'u **İptal** yapın.

Bundan sonra GitHub'a gönderilen her değişiklik otomatik olarak yayına alınır.

### 5. Santral SMS linki
Santralin gönderdiği SMS'teki WhatsApp linkini yeni adresle değiştirin. Örnek metin:

> Aysu Halı Saha'yı aradığınız için teşekkürler. Online rezervasyon için: https://aysuhalisaha.com/rezervasyon

### 6. Kendi alan adınız (isteğe bağlı, sonra da yapılabilir)
- **Hızlı yol:** Bir süre `workers.dev` adresini kullanın.
- **Kalıcı yol:** `aysuhalisaha.com` alan adını Cloudflare'e ekleyin (**Add a domain**). Cloudflare'in verdiği iki nameserver'ı alan adını aldığınız firmanın panelinde güncelleyin. Ardından Worker → **Settings → Domains & Routes → Add route** ile `aysuhalisaha.com/rezervasyon*` ve `aysuhalisaha.com/api/*` yollarını bu Worker'a bağlayın. Eski site yeni site hazır olana kadar yerinde kalabilir.
  - Alan adınızda e-posta kayıtları (MX) varsa Cloudflare onları otomatik kopyalar. Yine de geçişten sonra kontrol edin.

### 7. Telegram bildirimi (isteğe bağlı)
Her yeni rezervasyon, iptal ve "yetkiliyle görüşmek istiyorum" talebi telefonunuza mesaj olarak gelir.
1. Telegram'da **@BotFather**'a `/newbot` yazın ve bot oluşturun. Verdiği **token**'ı alın.
2. Botunuza bir mesaj atın. Sonra tarayıcıda `https://api.telegram.org/bot<TOKEN>/getUpdates` adresini açın ve `"chat":{"id": ...}` değerini alın.
3. Cloudflare'e `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` secret'larını ekleyin.

---

## Ayarları değiştirme
Tüm işletme bilgileri `src/config.js` dosyasında:

| Ayar | Ne işe yarar |
|---|---|
| `SAATLER` | Maç saatleri (şu an 08:00 – 02:00) |
| `FIYATLAR` | Ücret (şu an her saat 3700 TL) ve kapora (1200 TL). Gündüz, akşam ve hafta sonu ayrı ayarlanabilir. |
| `KAPORA_ACIKLAMA`, `IBAN` | Asistanın kapora için söyledikleri |
| `OLANAKLAR` | Müşteri sorarsa söylenen olanaklar. **Kontrol edin.** |
| `KURALLAR` | En fazla kaç gün ileriye (7), kişi başı aktif rezervasyon (2), iptal için son saat (3) |
| `MODEL` | `claude-haiku-5-5` (ekonomik) veya `claude-sonnet-5-5` (daha zeki) |

GitHub'da dosyayı düzenleyip kaydedin. Cloudflare birkaç dakika içinde yeni hali yayına alır.

## Maliyet
- **Cloudflare:** Ücretsiz plan yeterli.
- **Google E-Tablolar:** Ücretsiz.
- **Claude Haiku 5.5:** Konuşma başına yaklaşık 1 sentin altında, ayda 1.000 konuşma için yaklaşık 6 $.

## Geliştirici notları
- `npm test` komutu 16 testi çalıştırır: doluluk kuralları, gece maçları, çift rezervasyon, iptal, Google bağlantısı ve asistan döngüsü.
- `node --import ./test/register.mjs test/yerel-sunucu.mjs` komutu, API anahtarı olmadan senaryolu bir yapay zekâ taklidiyle `http://localhost:8787/rezervasyon/` adresinde yerel deneme sunucusu açar.
- Kötüye kullanım sınırı: IP başına dakikada 20 mesaj (`wrangler.jsonc → ratelimits`).
