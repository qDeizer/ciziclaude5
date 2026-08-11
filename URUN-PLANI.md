# Cizi Code — Ürün Planı (14 madde)

Bu dosya, projenin 14 maddelik hedef listesine göre **ne var / ne eksik / ne yapılacak**
kaydıdır. Kod yazılırken tek referans budur; bir madde bitince buradaki durumu değişir.

Standing kısıt (madde 14): Claude Code CLI anahtarı ve Claude Desktop anahtarı
**test amaçlı açılmaz**. `~/.claude/settings.json` bu oturumun kendi yapılandırmasıdır.
İşlevsel doğrulama yalnızca Codex tarafında yapılır; Claude tarafı statik
doğrulama (syntax, modül yükleme, birim testi, kuru-çalışma) ile kanıtlanır.

---

## 1. Durum tablosu

| # | Hedef | Başlangıç | Şimdi | Nerede |
|---|-------|-----------|-------|--------|
| 1 | 4 ürünün kurulu olup olmadığının denetimi | var | **var** | dört ürün servisi; canlı çıktıda dördü de algılandı |
| 2 | Resmî site + indir-ve-kur + "sadece indir" | kısmi | **bitti** | `manualInstall.js`, üç ürüne `downloadOnly`, bölünmüş düğme |
| 3 | Switch + kategori seçmeli kökten kaldır | kısmi | **bitti** | `productRemoval.js` (6 kategori), açılır menü |
| 4 | Codex tek switch, kaldırmada ayrı | var | **var** | tek anahtar + iki ürün şeridi, her biri kendi kaldırma menüsü |
| 5 | Claude Desktop Türkçe çeviri katmanı | var | **var** | tüm dil katalogları + JS etiketleri |
| 6 | İçerik odaklı, yapı değişimine dayanıklı | kısmi | **bitti** | sayı katılığı kaldırıldı; tanınmayan içerik tahmin edilmiyor |
| 7 | Birebir yedek, kapanınca birebir geri | var | **kanıtlandı** | Codex md5 turu: `530d47f3…` → `530d47f3…` |
| 8 | Güncelleme dil dosyalarını sıfırlarsa hemen yama | var | **var** | SYSTEM görevi: olay + boot + logon + periyodik |
| 9 | Switch/gerçeklik uyuşmazlığının onarımı | var | **var** | niyet kaydı + reconcile; kullanıcı isteği hep tam denetim yapar |
| 10 | Bilgisayarı yormamak | kısmi | **bitti** | oturmuş anahtar atlanıyor (`skipped:1`); menü 2181 ms → 70 ms |
| 11 | Sunucu modellerine göre satır aktifliği | var | **var** | `modelFamilies` + `toolIsUnlocked` |
| 12 | "Opus-5" değil "Opus 5" | yok | **bitti** | `displayModelName`; yapılandırmaya yazılan ad değişmiyor |
| 13 | UI baştan + %'li geri bildirim | kısmi | **bitti** | kart tabanlı yerleşim, kart içi ilerleme, tek ilerleme kanalı |
| 14 | Claude test edilmeyecek | kural | **uygulandı** | iki Claude anahtarı da hiç açılmadı; yalnız Codex çalıştırıldı |

---

## 2. Mimarî: eklenen üç parça

Var olan katmanlar (`integrationService` → `apply/backup` → `registry`, ve
`claudeDesktopBranding` motoru) **yerinde kalıyor**. Üstlerine üç şey eklenir:

### 2.1 `src/main/productCatalog.js` — tek ürün listesi
Dört ürünü tek yerde adlandırır: `id`, `name`, `switchId`, `family`, `kind`
(`cli` | `desktop`), ve hangi yeteneklere sahip olduğu
(`canDownloadOnly`, `installsFromStore`, `officialSiteUrl`).

Neden: bugün "hangi ürünler var" sorusunun cevabı renderer'da sabitler,
main.js'te IPC adları, `modelFamilies`'te aile anahtarları olarak **üç kez**
yazılı. Yeni bir ürün eklemek üç dosyaya dokunmak demek. Katalog bunu bire indirir.

### 2.2 `src/main/productRemoval.js` — kategori bazlı kaldırma
Madde 3'ün gövdesi. Ürün başına **kategori** üretir; her kategori kendi yollarını
ve niçin silindiğini taşır:

| kategori | görünen ad | içerik |
|---|---|---|
| `app` | Uygulamanın kendisi | çalıştırılabilirler, paket, kurulum dizini |
| `config` | Yapılandırma dosyaları | `config.toml`, `settings.json`, model kataloğu |
| `sessions` | Sohbet geçmişi ve oturum kayıtları | `sessions/`, `history.jsonl`, `projects/` |
| `credentials` | Giriş bilgileri ve profil | `auth.json`, `.credentials.json`, kimlik yardımcıları |
| `cache` | Önbellek, günlük ve geçici dosyalar | `LocalCache`, `logs/`, `downloads/` |
| `residue` | Derin kalıntılar | PATH girdisi, kısayollar, zamanlanmış görevler, npm global paketi |

Kurallar:
- Kategori **listelenir ama seçilmemiş olabilir**. Yürütme yalnızca seçilenleri siler.
- Başka bir ürünün ihtiyaç duyduğu ortak yol (Codex'in `~/.codex`'i) `locked`
  işaretlenir: listede görünür, sebebi yazılır, seçilemez.
- Bizim yönetmediğimiz kurulum (WinGet) `external` işaretlenir: silinmez,
  komutu söylenir.
- Var olmayan yol kategoriyi boşaltır; boş kategori listelenmez.

Yürütme mevcut ürün servislerini çağırır (npm uninstall, MSIX kaldırma, taskkill);
`productRemoval` yalnızca **hangi kümenin** silineceğine karar verir.

### 2.3 Tek ilerleme kanalı — `cizi:progress`
Madde 13'ün "%'sel geri bildirim" şartı. Bugün ilerleme yalnızca Claude Desktop
kurulumundan geliyor; switch açma/kapama, çeviri, geri yükleme ve kaldırma sessiz.

Tek olay biçimi:
```js
{ scope: "<ürün veya switch id>", phase: "...", percent: 0..100 | null, message: "...", done: false }
```
`percent: null` = ölçülemeyen adım (belirsiz çubuk). Ölçülebilen her adım gerçek
yüzde verir: indirme baytları, N dosyadan k'sı yamalandı, N kategoriden k'sı silindi.

`integrationService.enable/disable` bunu adım adım yayar:
`precheck → backup → apply → verify → done`. Beş adımın her biri yüzde taşır,
böylece anahtar çevirmek de ölçülebilir bir işlem olur.

---

## 3. Madde 6: çeviri neden hâlâ kırılgan ve nasıl düzelir

Bugün iki geçiş var:
1. **Katalog geçişi** (`catalogPatcher`) — dil JSON'larında `\bGateway\b` geçen
   *her* değeri değiştirir. Bu zaten madde 6'nın istediği şey: içerik odaklı,
   satır/id bağımsız. URL/tanımlayıcı içeren belirteçler bilinçli olarak atlanır.
2. **Etiket geçişi** (`labelPatcher` + `targetScanner.scanLabelSites`) — kataloga
   girmeyen, JS içine gömülü sağlayıcı etiketleri. Burada kural başına
   `expectedMatches` var ve **bulunan sayı beklenenden farklıysa yama üretilmiyor**
   (`AMBIGUOUS_MATCH`). Yani Claude bir sürümde aynı etiketi iki yere koyarsa
   çevirinin tamamı düşüyor.

Değişiklik: `expectedMatches` bir **eşik** değil, bir **beklenti kaydı** olur.
- Bağlam doğrulamasını geçen **her** eşleşme yamalanır (1 de olsa 5 de olsa).
- Sıfır eşleşme + katalogda da iz yok → o kural için uyarı, işlem devam eder.
- Beklenenden farklı sayı → uyarı olarak loglanır, yama yine uygulanır.
Bağlam doğrulaması (`siblingMarkers`, `minSiblings`) yerinde kalır; kaldırılan tek
şey sayı katılığı. Yanlış yere yazma riskini tutan şey komşu işaret kontrolüdür,
sayı değil.

---

## 4. Madde 10: yormamak

Ölçülebilir üç kural:
1. Periyodik reconcile **yalnızca niyeti açık olan** araçlara dokunur; kapalı
   araç için dosya okunmaz.
2. Bir tur içinde ürün algılaması (`where.exe`, PowerShell, MSIX sorgusu) en fazla
   bir kez çalışır; sonuç tur boyunca paylaşılır.
3. Pencere kapalıyken UI zamanlayıcıları (log yenileme) durur.

---

## 5. Tasarım dili (madde 13)

### Renk — 6 belirteç, ikisi anlamsal
```
--ground   #f2ede0   sayfa zemini (sıcak kâğıt)
--surface  #fbf8ef   kart yüzeyi
--ink      #14181a   birincil metin
--ink-soft #5f665f   ikincil metin
--pine     #14403c   marka / birincil eylem
--teal     #2f8b93   vurgu / ilerleme
--good #2f7d5b   --warn #9a6a24   --bad #a4443e
```
Karanlık tema `prefers-color-scheme` ile aynı belirteçleri yeniden tanımlar;
hiçbir renk yalnızca medya sorgusu içinde tanımlanmaz.

### Tipografi — 3 rol
`title` 20/600 · `body` 14/400 · `meta` 12/500 harf aralığı .02em.
Sayısal alanlar (yüzde, sürüm, yol) tabular monospace.

### Yerleşim — yeni ana fikir
Bugünkü ekranın asıl kusuru: ilerleme kutuları listenin **altında**, ait oldukları
satırdan kopuk. Yeni yapı ürün başına **kart**:

```
┌───────────────────────────────────────────────────────────────┐
│ ▎Claude Code CLI                            [Bağlı]      ●──○ │  başlık + durum + switch
│  Kurulu · 2.1.4 · 6 model · 1M bağlam                         │  tek satır olgu
│  ─────────────────────────────────────────────────────────────│
│  [Aç]  [Kökten Kaldır ▾]                                      │  eylem sırası
│  ┌ ilerleme şeridi (yalnız iş varken) ──────────────────────┐  │
│  │ Ayarlar uygulanıyor            ▓▓▓▓▓▓▓▓░░░░░░  %62       │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```
- Sol kenarda 3px durum şeridi: bağlı / bekliyor / kapalı / dikkat.
- İlerleme kartın **içinde** doğar ve biter; sayfanın altında kutu yok.
- Kurulu değilse eylem sırası `[İndir ve Kur ▾] [Resmî site]` olur;
  `▾` → "Sadece indir (manuel kurulum)".
- `Kökten Kaldır ▾` → kategori listesi. Seçili kategori tam opak;
  tıklanınca **saydamlaşır** (0.35 opaklık + üstü çizili) = silinmeyecek.
  Kilitli kategori zaten saydam ve tıklanamaz, sebebi yanında yazar.
- Codex kartı tek switch, içinde iki ürün şeridi (CLI / ChatGPT Desktop);
  her şeridin kendi kaldır düğmesi var (madde 4).

### Hareket
Yalnız iki yerde: switch kolu (120ms) ve ilerleme dolgusu (180ms).
`prefers-reduced-motion` ikisini de kapatır.

---

## 6. Doğrulama planı (madde 14 sınırı içinde)

1. `node --check` — dokunulan her dosya.
2. Modül yükleme süpürmesi — `src/main` altındaki her modül `require` edilir.
   (Bu, daha önce sessiz kalan bir aşırı-silme hatasını yakalayan kontroldür.)
3. `node test-tool-config.cjs` — yapılandırma sözleşmesi birim testleri.
4. Kategori planı **kuru çalışma**: her ürün için plan üretilir, yolların
   varlığı ve `locked`/`external` işaretleri yazdırılır. Hiçbir şey silinmez.
5. Codex: gerçek anahtar açma/kapama, `~/.codex/config.toml`'un md5'i öncesi ve
   sonrası karşılaştırılır (geri yükleme birebir mi).
6. Claude: yalnız 1–4. Anahtar açılmaz.

### Sonuçlar

| Kontrol | Sonuç |
|---|---|
| `node --check` (65 dosya) | temiz |
| Modül yükleme süpürmesi | `src/main` tamamı yüklendi; yalnız DOM'a bağlı iki renderer dosyası beklendiği gibi düştü |
| `node test-tool-config.cjs` | 34/34 |
| Kategori kuru çalışması | 4 ürün, hiçbir şey silinmedi — **iki gerçek hata yakalandı**, aşağıda |
| Codex aç → kapa | `config.toml` md5 `530d47f3750360f3ccd7cc5d5d22fe1e` → aynı; model kataloğu silindi |
| Periyodik denetim | `skipped: 1` — oturmuş anahtar hiç okunmuyor |
| Claude anahtarları | ikisi de **kapalı**; yalnızca kaldırma menüsü okundu (salt okuma) |

### Kuru çalışmanın yakaladığı iki hata

1. **`%LOCALAPPDATA%\Claude-3p` "yapılandırma" sayılmıştı.** Oysa Claude
   Desktop'ın bütün kullanıcı verisi orada: 2,2 GB önbellek, sohbet geçmişi ve
   indirilmiş çalışma zamanı paketleri. Yalnızca "Yapılandırma dosyaları"nı seçen
   kullanıcı geçmişini de kaybederdi. Klasör artık tek parça değil, içerik adı
   adına sınıflandırılıyor (config 21 KB · sessions 8,6 MB · cache 2,2 GB).
2. **MSIX'in `LocalCache`'i "önbellek" sayılmıştı.** Windows, paketlenmiş bir
   uygulamanın `%APPDATA%` yazmalarını `LocalCache\Roaming\<Uygulama>` altına
   yönlendirir — adı "cache" olsa da içinde ChatGPT Desktop'ın Chromium profili
   var. Artık `LocalCache` tek parça silinmiyor; sanallaştırılmış klasör ayrıca
   çözülüyor.

Ayrıca: renderer betiği yüklenirken düşerse hiçbir iz bırakmıyordu ve ekran
varsayılan giriş görünümünde takılı kalıyordu — "kullanıcı giriş yapmamış"tan
ayırt edilemez. Renderer hataları artık uygulama günlüğüne yazılıyor; bu
oturumdaki `Identifier 'cizi' has already been declared` hatası da böyle bulundu.

---

## 6.5 VS Code eklentisi (Claude Code for VS Code)

**Soru:** kullanıcı Claude Code'u VS Code içinden kurduysa onu da bağlayalım mı?

**Kurulu eklenti incelendi** (`anthropic.claude-code-2.1.227-win32-x64`) ve iki
şey bulundu:

1. **Eklenti kendi Claude CLI ikilisini taşıyor:**
   `resources/native-binary/claude.exe`, 279 MB. Yani eklentiyi kuran kullanıcıda
   Claude Code VARDIR ama PATH'te `claude` YOKTUR. Bizim algılamamız yalnızca
   PATH'e ve bilinen kurulum dizinlerine bakıyordu → böyle bir kullanıcıya
   **"Kurulu değil"** diyor ve anahtarı kapalı tutuyordu. Bağlanacak bir Claude
   Code dururken bağlanamıyordu. **Asıl eksik buydu.**

2. **Ayrı bir yapılandırma deposu YOK.** Eklentinin kendi taşıdığı şema dosyası
   (`claude-code-settings.schema.json`, başlığı "Claude Code Settings") tam olarak
   bizim yazdığımız anahtarları tanıyor: `env` (object), `availableModels` (array),
   `effortLevel` (string), `model`. İkili de `CLAUDE_CONFIG_DIR || ~/.claude`
   çözümlemesini kullanıyor (`CLAUDE_CONFIG_DIR` eklenti kodunda 10 yerde).
   Üstüne eklentinin kendi ayar açıklaması şunu diyor: *"Prefer setting
   environment variables in Claude's settings.json."*

**Karar: ikinci bir yapılandırma yazılmıyor.** `claudeCode.environmentVariables`
diye bir VS Code ayarı var ve oraya da yazabilirdik; yazmıyoruz çünkü (a) eklentinin
kendi tavsiyesi settings.json, (b) aynı değerin iki kaynağı sürüklenmenin başladığı
yerdir ve VS Code'daki eski bir değer bizim yazdığımızı sessizce ezerdi, (c) VS Code'un
kendi ayar dosyasına yazmak yedeklenmesi gereken yeni bir yüzey açardı.
**Tek `~/.claude/settings.json` ikisini birlikte yapılandırıyor.**

Yapılan iş bu yüzden yapılandırma değil **algılama**:

- `vscodeClaudeInstallations()` — uzantı dizinleri taranıyor (sabit yol listesi
  değil): `.vscode`, `.vscode-insiders`, `.vscode-oss`, `.vscode-server`,
  `.cursor`, `.cursor-server`, `.windsurf`, `.trae` ve `VSCODE_PORTABLE`.
- Sürüm **klasör adından** okunuyor, ikili çalıştırılmıyor: 279 MB'lık bir süreci
  her ekran yenilemesinde başlatmak madde 10'a aykırı olurdu.
- Kaldırmada eklenti **DIŞ** olarak bildiriliyor, silinmiyor — klasörü VS Code'un
  arkasından silmek onu bozuk bir uzantı kaydıyla bırakır. Komut söyleniyor:
  `code --uninstall-extension anthropic.claude-code`.

Ölçüm — kum havuzunda "yalnızca eklenti var, PATH boş" senaryosu:
`installed: true · installation: vscode-extension · 2.1.227` → anahtar
kullanılabilir. Bu makinede (hem WinGet CLI hem eklenti var):
`Kurulu · 2.1.224 · ayrıca vscode eklentisi var — aynı ayar dosyası ikisini de yapılandırır`.

### Codex eklentisi (openai.chatgpt)

Aynı inceleme Codex eklentisine yapıldı (`openai.chatgpt-26.803.61601`). Sonuç
Claude ile aynı yapıda, ama **iki fazladan bulgu** var.

**Eklenti iki CLI ikilisi taşıyor:** `bin/windows-x86_64/codex.exe` (293 MB) ve
`bin/linux-x86_64/codex` (256 MB — WSL için). Yani yalnızca eklentiyi kuran
kullanıcıda Codex vardır; PATH'te `codex` yoktur ve ChatGPT Desktop da yoksa
**Codex anahtarı hiç açılamıyordu**. Düzeltildi.

**Yapılandırma aynı dosya.** Eklentinin kendi kodundaki çözümleme:
`process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")` + `config.toml`.
Ölçüldü: eklentinin okuyacağı yol `~\.codex\config.toml`, Cizi Code'un yazdığı yol
`~\.codex\config.toml` → **aynı**; anahtar açıkken o dosyada
`model_provider=cizicode, applied=true`. Ayrı yapılandırma yazılmıyor.

**Fazladan bulgu 1 — WSL modu.** Eklentinin bir ayarı Codex'i WSL içinde
çalıştırıyor (`chatgpt.runCodexInWindowsSubsystemForLinux`). O modda eklenti
config.toml'u WSL dağıtımının kendi ev dizininden okuyor — kendi kodunda
`bash -lc 'printf %s "${CODEX_HOME:-$HOME/.codex}"'` ile çözüp `wslpath -w` ile
Windows yoluna çeviriyor. **Bizim Windows tarafına yazdığımız dosya oraya
ulaşmaz.** Yani bu ayar açıkken anahtar "Bağlı" derken düzenleyicinin Codex'i
yapılandırılmamış olur. Artık düzenleyici ayarları okunuyor (JSONC olarak) ve bu
mod açıksa kartta turuncu uyarı çıkıyor. Bu makinede kapalı (`wslEditors: []`).

**Fazladan bulgu 2 — kayıtsız eski sürüm klasörü.** Diskte
`openai.chatgpt-26.5803.61601` klasörü duruyor ama düzenleyicinin
`extensions.json` kaydında yok. Bu yüzden sürüm klasör listesinden değil
**düzenleyicinin kendi kaydından** okunuyor (`active: true/false`), etkin olan
önce sıralanıyor ve kayıtsız klasörler kaldırma menüsünde ayrı bir kalıntı
olarak bildiriliyor.

Ortak keşif katmanı `src/main/editorExtensions.js`: uzantı dizinleri (VS Code,
Insiders, VSCodium, uzak, Cursor, Windsurf, Trae, taşınabilir), `extensions.json`
kaydı, klasör adından sürüm ve düzenleyici kullanıcı ayarlarının JSONC okunması.
İki ürün de buradan besleniyor — biri yeni bir düzenleyici öğrenip diğeri
öğrenmesin diye.

---

## 6.6 Olay: Claude Desktop bu bilgisayardan kaldırıldı

`2026-08-11T09:08:40Z` — `[ui] Claude Desktop kaldırılıyor {"categories":["app",
"config","sessions","credentials","cache","residue"]}` → 46 adım, 39 öğe silindi,
0 hata, 58 saniye. Paket kaydı kaldırıldı, `Claude-3p` (2,2 GB) gitti.

**Kod hatası değil:** altı kategori de seçiliyken kaldırma tam olarak tasarlandığı
gibi çalıştı ve onay penceresi kabul edildi.

**Koşulu ben yarattım:** bir gece önce test için `claude-desktop.purge.more`
menüsünü açtım, **kapatmadım** ve pencereyi öne getirip öyle bıraktım. Ekranda
saatlerce "Seçilenleri kaldır" düğmesi silahlı halde durdu.

**Alınan önlem** (bu olay olmasa yazılmayacak iki kural):
- Pencere odağı kaybettiğinde açılır menü kapanır (`blur` + `visibilitychange`).
  Yıkıcı bir eylem yalnızca kullanıcının o an baktığı ekranda durabilir.
- Onay metni ilk satırda en ağır sonucu söylüyor: uygulamanın kendisi gidiyorsa
  büyük harfle, toplam silinecek veri boyutuyla ve "sohbet geçmişi kurtarılamaz"
  uyarısıyla. Yalnızca kategori adı listelemek işin büyüklüğünü görünmez bırakıyordu.

**Kurtarma:** Claude Desktop kartındaki "İndir ve Kur" ile geri kurulabilir
(imza doğrulanmış resmî paket). Uygulamanın kendi verisi (sohbet geçmişi) geri
getirilemez — Cizi Code'un yedeği yalnızca *kendi değiştirdiği* entegrasyon
ayarlarını kapsar. Claude Desktop anahtarı hiç açılmamış olduğu için Cizi Code'a
ait kaybedilen bir yedek yok.

---

## 7. Odaklı arka uç incelemesi — bulunan altı hata

Bunlar 14 maddenin "farklı ortam/senaryo" kısmına bakılırken çıktı. Hepsi
gerçek: her biri için düzeltmeden ÖNCEKİ sürümle test çalıştırıldı.

### 7.1 `config.toml` satır sonlarını sessizce LF'e çeviriyordu
`split(/\r?\n/)` + `join("\n")` dosyayı satır satır yeniden yazıyordu. Windows'ta
Not Defteri ile düzenlenmiş bir config CRLF'tir; anahtar açılınca **dosyanın her
satırı** değişiyordu ve kapatıldığında **birebir eski haline dönmüyordu** (madde 7
ihlali). BOM'lu dosyada ise ilk anahtar hiç eşleşmediği için ikinci kez yazılıyordu.

Ölçüm — eski sürüm: `satirsonu=LFe CEVRILDI  geri=FARKLI` (CRLF ve CRLF+BOM).
Yeni sürüm: üç durumda da `satirsonu=korundu bom=korundu geri=BIREBIR ayni`.
Artık dosyanın kendi biçimi (satır sonu + BOM) okunup korunuyor.

### 7.2 Yedek, dosyayı UTF-8 **metin** olarak tutuyordu
`readFileSync(fp,"utf-8")` → geri yazma. Dosya gerçekten UTF-8 değilse
(UTF-16LE = Not Defteri'nin eski varsayılanı, ya da ANSI/cp1254) çözülemeyen
baytlar U+FFFD'ye dönüşüyor ve geri yükleme kullanıcının dosyasını **bozuyordu**.

Ölçüm — eski: UTF-16LE `BOZULDU`, ANSI cp1254 `BOZULDU`, UTF-8 birebir.
Yeni: üçü de `BIREBIR geri geldi`. Yedek artık base64 bayt olarak tutuluyor;
eski (metin) yedekler de okunmaya devam ediyor.

### 7.3 Okunamayan dosya "yoktu" diye kaydediliyordu
Yedek alınırken her okuma hatası `existed:false` oluyordu. Geri yükleme
`existed:false` için dosyayı **siliyor**. Yani anahtar açılırken kilitli/erişilemez
olan bir ayar dosyası, kapatıldığında silinmiş olacaktı — üstelik işlem
`restored: true` diyordu.

Ölçüm — eski: `sessiz gecti · kayitta existed=false · geri yukleme={"restored":true}`.
Yeni: `HATA verdi -> BACKUP_SOURCE_UNREADABLE`, hiçbir şey yazılmıyor.
(Testte okunamazlık dizin ile taklit edildi; tek dosyada silinmeye giden yol
`rmSync`'in kendisidir.)

### 7.4 Aynı sorun `config.toml` yazma yolunda: okunamayan dosyanın üzerine yazıyordu
`readConfigText` her hatada `null` dönüyordu; `applyCizi` bunu "dosya yok" diye
okuyup **sıfırdan** bir config yazıyordu. Var olan ama o an okunamayan bir
config.toml'un bütün içeriği bu yolla gidiyordu. Artık `null` yalnızca ENOENT
demek; okunamayan dosyada hata veriliyor ve hiçbir şey yazılmıyor.

### 7.5 `CLAUDE_CONFIG_DIR` yok sayılıyordu
Claude Code bu değişkeni okuyor (kurulu ikilide 31 geçiş). Cizi Code ise
`~/.claude/settings.json`'u sabit yazmıştı. Bu değişkeni ayarlamış bir kullanıcıda
Cizi Code, Claude Code'un **hiç okumadığı** bir dosyaya yazıp sonra kendi yazdığı
dosyayı geri okuyarak "Bağlı" diyordu — hiçbir denetimin yakalayamayacağı bir
yalan, çünkü yazan ve doğrulayan aynı yanlış yola bakıyor. Codex tarafında aynı
kural (`CODEX_HOME`) zaten vardı; Claude tarafı eksikti. `src/main/claudePaths.js`
eklendi, beş sabit yol oradan çözülüyor.

Ölçüm: `CLAUDE_CONFIG_DIR` kum havuzuna ayarlandığında yazılan dosya
`<kum>/my-claude-config/settings.json`, `isApplied` true, gerçek `~/.claude`'a
dokunulmuyor.

### 7.6 Madde 10'daki atlama en sık durumu kaçırıyordu
"Oturmuş" işareti yalnızca kullanıcı bir anahtarı kapattığında yazılıyordu. Hiç
dokunulmamış bir kurulumda hiçbir kayıt oturmuş olmadığı için Claude Desktop'ın
süreç taraması beş dakikada bir boşuna çalışıyordu. Artık "kapalı + uygulanmamış +
geri yüklenecek şey yok" da doğrulanmış bir gözlem olarak kaydediliyor.

### Ayrıca: kaldırmaya yapısal güvence
Seçilmemiş ya da kilitli bir yolun **üst klasörü** silinmek üzere seçilmişse o adım
çalıştırılmıyor ve `blocked` olarak bildiriliyor. Bugünkü haritalarda böyle bir iç
içe geçme yok; amaç "seçmediğiniz kategori silinmez" sözünü bir harita
değişikliğinin sessizce bozamaması. Aynı yolun iki kategoride görünmesi de
engellendi, `prune-empty` adımları en derinden başlıyor.

Kum havuzunda gerçek silme ile doğrulandı:

| Senaryo | Sonuç |
|---|---|
| ChatGPT Desktop kurulu, Codex CLI kaldırılıyor | `config.toml`, `auth.json`, `sessions/` **duruyor**; yalnız uygulama silindi |
| Tek başına, kullanıcı "sohbet geçmişi"ni koruyor | `config.toml` + `auth.json` silindi, `sessions/` **duruyor** |
| Tek başına, hepsi seçili | hepsi silindi, `~/.codex` boşalınca kaldırıldı |
| Üç senaryonun hiçbirinde | yanlış yere engelleme (`blocked: 0`) |

---

## 7.5 İkinci inceleme turu — üç düzeltme

Bu tur, ilk turda bakılmamış iki yere odaklandı: Claude Desktop'ın dil dosyalarını
yamalayan yükseltilmiş yazma yolu ve günlük altyapısı.

### 7.5.1 Günlük dosyası sınırsız büyüyordu (madde 10)
`appendFileSync` vardı, döndürme yoktu. Dosya yalnızca kullanıcı elle temizlerse
küçülüyordu; periyodik denetim ise her turda satır yazıyor. Sürekli açık bir
makinede bu, aylar içinde onlarca megabaytlık bir dosya demek. 2 MB'ta döndürme
eklendi, iki dosya tutuluyor (güncel + `.1`) → **en fazla 4 MB**. Boyut her satırda
`stat` ile sorulmuyor, bir kez okunup bellekte sayılıyor.

Ölçüm: 2,8 MB yazıldı → güncel dosya 0,70 MB, `.1` oluştu, toplam 2,70 MB.

### 7.5.2 Bozulmuş bir dil dosyası çıkmaz sokaktı
Canlı dosyaya yazma **atomik değil** — geçici dosya + rename yapmak, dizin
üzerinde de yetki almayı gerektirir ve paketin sertleştirmesini gereksiz yere
daha geniş açardı. Bunun bedeli: süreç tam yazma anında ölürse dosya yarım kalır.
Böyle bir dosya eskiden `LIVE_FILE_DRIFTED` ile reddediliyordu — ne yamalanabiliyor
ne kendiliğinden düzeliyordu, çünkü hiçbir yol onu yedekten geri koymuyordu.

Artık **yalnızca gerçekten bozuk** dosya (boş ya da JSON olması gerekirken
ayrıştırılamıyor) kendi yedeğimizden geri getiriliyor; hem de ancak yedeğin bu
build'in kaynağı olduğu hash ile kanıtlanırsa. **Geçerli ama değişmiş** bir dosyaya
dokunulmuyor: o Anthropic'in kendi değişikliği olabilir ve üzerine yazmak bir
güncellemeyi geri almak olurdu.

Ölçüm — uçtan uca:

| Durum | Sonuç |
|---|---|
| Dosya yarım yazılmış | yedekten geri getirildi, sonra yamalandı |
| Dosya değişmiş ama geçerli | `LIVE_FILE_DRIFTED` ile reddedildi, dosyaya dokunulmadı |

### 7.5.3 Geri yükleme paket kimliğini doğrulamıyordu
`restore()` yedek manifestindeki `packageFullName`'i okuyor ama karşılaştırmıyordu.
Sürüm dizesi aynı kalırken paket değişebilir (yeniden kurulum, farklı mimari);
başka bir paketin baytlarını geri yazmak düzeltmek istediğimiz şeyi bozmak olurdu.
Artık uyuşmazlıkta `BACKUP_PACKAGE_MISMATCH` dönüyor ve hiçbir şey yazılmıyor.

Ayrıca "kullanımda mı" kontrolü **kilidin içine** alındı: dışarıdayken kontrol ile
yazma arasında Claude başlayabiliyordu.

### İncelenip sorun bulunmayanlar
- `secureStore.js` — fsync, `wx` ile geçici dosya, sınırlı yeniden deneme, hedefi
  asla silmeyen atomik değiştirme. Doğru yazılmış.
- `enable` akışında ağ hatası: `resolveValues` niyet kaydından ÖNCE çalışıyor, yani
  gateway erişilemezken anahtar kaydı hiç değişmiyor.
- Yedek üzerine yazma: `createBackup`'tan önce ön koşullar canlı dosyanın orijinal
  olduğunu kanıtlıyor, o yüzden yedeğin yamalı içerikle ezilmesi mümkün değil.

### Bulunan ama düzeltilmeyen (bilinçli)
- **Yedek kaybolurken dosyalar yamalı kalırsa.** Cizi Code'un userData'sı silinir
  ya da uygulama yeniden kurulursa, Claude'un dosyaları yamalı kalır ve geri
  yükleyecek yedek yoktur — kalıcı olarak yamalı kalır. Çözümü içerik bazlı ters
  çeviri (Ağ Geçidi → Gateway) olurdu; yükseltilmiş yazma yolunda ayrı bir özellik
  ve ayrı bir doğrulama gerektirir, bu turda yapılmadı.

### Açıkta kalan

- **Kaldırma sonrası boş olmayan üst klasör.** Kullanıcı bir kategoriyi
  korumayı seçtiğinde üst klasör silinmez (`prune-empty` yalnızca gerçekten boş
  klasörü siler). Doğruluk lehine bilinçli bir seçim: kullanıcının korumak
  istediğini üst klasörle birlikte silmek yerine, kalan öğeler `stillExists`
  olarak bildirilir.
- **Markalama ve yönetici izni.** Claude Desktop anahtarı, MSIX paketini
  yamaladığı için yönetici onayı istiyor. Karar hâlâ kullanıcıda: (1) markalamayı
  bloklamayan hâle getirmek, (2) gerçek UAC istemi, (3) SYSTEM görevi üzerinden
  ilk kurulum. Önerim (1).
- **Beş ayrı süreç kilidi.** Aynı kavramın beş implementasyonu var ve davranışları
  farklı: kayıt biçimi, bayat kilidi devralma (yok / 10 dk / 30 dk + 60 sn),
  eşzamanlı bekleme (var / yok) ve bırakırken sahiplik kontrolü (var / yok).
  Üçünde yaş kuralı olmadığı için asılmış bir süreç kilidi süresiz elinde tutar.
  Tek `processLock` modülüne indirilmeli.
- **VS Code konum varsayımı.** Kilo/Roo `%APPDATA%\Code\User\settings.json`
  varsayıyor; Insiders, VSCodium ve taşınabilir kurulumda bu dosya yanlış yerdir.
  `CLAUDE_CONFIG_DIR` ile aynı sınıf hata, ama bu iki araç ilk sürümde ekranda
  görünmediği için uykuda.
- **Yedek dosyası şifrelenmiyor.** `backups/<araç>/snapshot.json` kullanıcının
  kendi anahtarlarını (örn. Cline `secrets.json`) düz metin tutar. Orijinal dosya
  da aynı profilde düz metin olduğu için ek bir açığa çıkma yok; yine de oturum
  kaydının `safeStorage` ile şifrelendiği bir uygulamada tutarsız.
- **Blok arası boş satır normalizasyonu.** `config.toml` yazılırken 3+ boş satır
  2'ye indiriliyor. Kozmetik ve TOML'u etkilemiyor, ama "dokunmadığımız her byte
  aynı kalır" sözünün tek istisnası.
