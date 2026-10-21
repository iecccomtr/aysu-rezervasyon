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

## Panel kurulumu ve kullanıcılar

### İlk kurulum (Admin hesabı, bir kez)
1. `/panel/` adresini açın. Panel henüz kurulmadıysa **Panel kurulumu** ekranı gelir.
2. **Kurulum kodu** (`wrangler.jsonc` → `PANEL_KURULUM_KODU`), adınız, e-postanız ve şifrenizi (en az 8 karakter) girin.
3. Bu hesap **Admin** olur (her şeyi kontrol eder, işlem kaydını görür). Sonraki girişler normal e-posta + şifre ekranından yapılır. Oturum 30 gün açık kalır.

### Personel nasıl eklenir?
1. Personel `/panel/` → **Kayıt ol** ile ad, e-posta, **görevini** ve şifresini girer.
2. Hesap **onay bekliyor** durumunda kalır; Müdür onaylamadan giriş yapılamaz.
3. Admin / Müdür / Müdür Yardımcısı **Panel → Kullanıcılar**'da kişiye dokunur (seçtiği görev hazır gelir) ve **Onayla ve hesabı aç**'a basar. Herkes sadece kendinden alt görevleri onaylayabilir.

| Rol | Yetki |
|---|---|
| Admin | Her şey; tüm hesapları yönetir; **İşlem kaydı**nı (kim, ne zaman, ne yaptı) görür |
| Müdür | Her şey; Müdür Yardımcısı, Temizlik Şefi ve Personel'i yönetir |
| Müdür Yardımcısı | Her şey; Temizlik Şefi ve Personel'i yönetir |
| Temizlik Şefi | Sadece haftalık rezervasyon tablosunu görür (telefon, kapora görünmez), değişiklik yapamaz |
| Personel | Temizlik Şefi ile aynı |

Hesabı kapatılan kullanıcının açık oturumu hemen kapanır. En az bir aktif Admin her zaman kalır.

Takvim tablosunda aboneler adla değil **numarayla** görünür ("Abone 3"). Numara abone formundan değiştirilebilir; boş bırakılırsa ilk boş numara verilir.

### Şifremi unuttum
- Giriş ekranında **Şifremi unuttum** → e-posta yazılır → 1 saat geçerli, tek kullanımlık yenileme bağlantısı e-postaya gider (e-posta kurulumu gerekir, aşağıda).
- E-posta kurulu değilse: Müdür, **Kullanıcılar → kişi → Şifre yenileme bağlantısı al** ile bağlantıyı alıp WhatsApp'tan iletir.
- Admin şifresini unutursa: **Şifremi unuttum → Admin: kurulum koduyla sıfırla** (kurulum kodu + e-posta + yeni şifre).

---

## Günlük kullanım

### Takvim
- Haftanın her günü ve saati tek listede görünür: **boş**, **rezervasyon** (online ya da telefon) veya **abone**.
- **Telefonla gelen rezervasyon:** Boş saate dokunun, ad ve telefonu yazıp kaydedin. Durum varsayılan olarak "Onaylı" gelir. Kapora alındıysa tutarını yazın. Site o saati anında dolu gösterir.
- **Kapora bekleyenler:** Online rezervasyonlar üstte sarı kutuda listelenir. Dokunun, **Onaylı**'yı seçin ve ödenen tutarı yazın (ör. `1000 + 200`).
- **İptal:** Rezervasyona dokunun, **İptal**'i seçip kaydedin. Saat yeniden boşa çıkar.
- Panel açıkken takvim her dakika kendini yeniler. Başka bir haftaya geçip 2 dakika dokunmazsanız bu haftaya döner.
- **Özel saat:** Standart saatler dışında maç gelirse (ör. sabah 05:00) **+ Özel saat** → gün ve saat seçin → normal rezervasyon formu. Bu saat o hafta tabloda turuncu "özel" satır olarak görünür, sitede müşteriye açılmaz. 03:00–05:00 seçilen günün gecesidir.
- **Haftalık temizlik:** Her Pazar gecesi bitince (Pazartesi 03:00) geçen haftanın rezervasyonları ve "gelmiyor" işaretleri silinir; aboneler kalır. Müşteri kartlarındaki maç/iptal sayıları özet olarak korunur. Temizlik İşlem kaydına yazılır.

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
3. Müşteri ekranda "yeriniz kapora gönderimi için 15 dakika adınıza opsiyonlandı" mesajını, kayıt numarasını, IBAN'ı ve kalan tutarı görür. "Dekontu WhatsApp'tan gönder" düğmesi kayıt numaralı hazır bir mesaj açar.
4. Müşteri, maçtan en geç 3 saat önce kayıt numarası ve telefonuyla sayfadan iptal edebilir.

Kurallar: en fazla 4 hafta ileriye rezervasyon (sayfada haftalar ‹ › oklarıyla geçilir), bir telefonla aynı anda en fazla 4 ileri tarihli rezervasyon (ayda her hafta bir maç), aynı saate aynı anda iki kişi basarsa sadece biri kaydedilir.

---

## İsteğe bağlı

### E-posta (Gmail) — kayıt onayı, şifre sıfırlama, rezervasyon bildirimi
E-postalar işletmenin Gmail hesabından gider:
1. O Gmail hesabında myaccount.google.com → **Güvenlik** → **2 Adımlı Doğrulama**'yı açın.
2. Arama kutusuna **Uygulama şifreleri** yazın → ad "Aysu site" → **Oluştur**. 16 haneli şifreyi kopyalayın.
3. Cloudflare → Workers → aysu-rezervasyon → **Settings → Variables and Secrets**:
   - `GMAIL_ADRES` → **Text**: Gmail adresi
   - `GMAIL_UYGULAMA_SIFRESI` → **Secret**: 16 haneli uygulama şifresi

Bundan sonra:
- **Yeni kayıt** olunca Admin'e ve (görev Müdür'den alt ise) Müdür'e **"…kullanıcısını onayla"** düğmeli e-posta gider. Düğme açılan sayfada **Onayla** / **Reddet** sorar (e-posta programları bağlantıyı önceden açsa bile kimse kendiliğinden onaylanmaz). Bağlantı 7 gün geçerli, tek kullanımlıktır; biri onaylayınca diğerlerinin bağlantısı geçersiz olur. Onay İşlem kaydına yazılır.
- **Şifremi unuttum** e-postası gider.
- Online rezervasyon / iptal bildirimi `BILDIRIM_EPOSTA` adresine (yoksa aysuhalisaha@gmail.com) gider.

Gmail şifresi değişirse uygulama şifresi iptal olur; yenisini oluşturup Cloudflare'de güncelleyin. (Alternatif: Resend — `RESEND_API_KEY` + `GONDEREN_EPOSTA`.)

### Bot koruması (Cloudflare Turnstile) — önerilir
Hız sınırı (IP başına dakikada 20 istek), gizli bot tuzağı ve aynı-site kontrolü zaten açık. Ek olarak "ben robot değilim" doğrulaması için:
1. Cloudflare → **Turnstile → Add widget**: ad `Aysu`, hostname `aysuhalisaha.com`, mod **Managed**.
2. Verilen **Site Key**'i `TURNSTILE_SITE_KEY` (**Text**), **Secret Key**'i `TURNSTILE_SECRET` (**Secret**) olarak Workers → aysu-rezervasyon → Settings → Variables and Secrets'a girin.
3. Bundan sonra rezervasyon, panel kaydı ve şifremi unuttum doğrulamasız çalışmaz. Gerçek kullanıcılar çoğu zaman hiçbir şey görmez; şüpheli durumda tek tıklık kutu çıkar.

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
