# Cizi Code — Masaüstü Uygulaması

Kullanıcılara verilen, Cizi Code markalı masaüstü uygulaması. Kullanıcı API key'i ile giriş yapar, kalan kullanımını görür ve kodlama araçlarını (Claude Code CLI, Codex, Cline, Roo Code, Kilo, OpenCode) **tek switch ile** Cizi Code ağ geçidine bağlar. Arka plandaki sağlayıcı/model bilgisi kullanıcıya **asla** gösterilmez.

## Özellikler
- **API key ile giriş** — anahtar OS keychain (Electron safeStorage) ile şifreli saklanır.
- **Kalan kullanım** — yüzdelik halka + kullanılan/limit. Limit dolunca Cizi Code markalı uyarı.
- **Token kullanım grafiği** — bugün / 7g / 30g / 60g.
- **Erişilebilen modeller** — yalnızca combo isimleri (provider/model gizli).
- **Araç yapılandırma switch'i** — Aç: aracı Cizi Code'a bağlar. Kapat: değişiklikten **önceki** config dosyalarını **aynen** geri yükler (tam yedek/geri-yükleme).

## Çalıştırma (geliştirme)
```bash
npm install
npm start
```

## Renderer-level CLI

The local CLI starts the desktop app when needed and attaches to its loopback
bridge. `screen`/`list` read the visible renderer UI. Mutating commands resolve
the visible DOM control and dispatch its real UI event; they do not call login,
tool, gateway, or other application services directly.

```bash
npm run cli -- screen
npm run cli -- list
npm run cli -- click update-check
npm run cli -- switch tool.claude.switch off
npm run cli -- switch tool.codex.switch on
npm run cli -- click codex-desktop.install
npm run cli -- click codex-desktop.purge
npm run cli -- select period-select 7d
```

Results are JSON. Passwords, API keys, tokens, and secrets are masked before
they reach the terminal.

When Claude Code CLI is missing, the desktop UI exposes `Download & Install`
and `Go to official site`. The installer button downloads and runs Anthropic's
official installer script, reports download and installer activity, and
re-checks the local `claude` command before enabling the configuration switch.

### Codex: ChatGPT Desktop + Codex CLI, tek switch

Windows'ta iki yerel Codex ürünü vardır ve **ikisi de aynı çekirdeği** çalıştırır:

| | Ürün | Kaynak |
|---|---|---|
| ChatGPT Desktop | `OpenAI.Codex` MSIX paketi (içindeki **Codex** bölümü) | Microsoft Store, `9PLM9XGG6VKS` |
| Codex CLI | bağımsız `codex.exe` | resmî OpenAI yükleyicisi |

Her ikisi de `%USERPROFILE%\.codex\config.toml` dosyasını okur, bu yüzden Cizi
Code **tek bir switch** ile ikisini birden bağlar. Kullanıcı model seçmez: anahtarın
Codex ile uyumlu bütün modelleri otomatik olarak `%USERPROFILE%\.codex\cizicode-models.json`
kataloğuna eklenir. `config.toml` içinde otomatik varsayılan `model`,
`model_catalog_json`, `model_provider`, `model_context_window`,
`model_auto_compact_token_limit`, `model_reasoning_effort` ve
`[model_providers.cizicode]` bloğu yazılır. Bağlam penceresi sabit değildir:
modelin gerçek penceresi yazılır ve otomatik sıkıştırma eşiği bunun altında
kalacak şekilde hesaplanır — sabit bir 1M/950k çifti, penceresi daha küçük bir
modelde hiç sıkıştırma yapılmamasına ve oturumun sağlayıcı hatasıyla düşmesine
yol açardı. Katalogdaki her model, kurulu Codex sürümünün desteklediği effort
seviyelerini ve kendi görünen adını taşır; aynı ortak config ve katalog hem
Codex CLI hem de ChatGPT Desktop tarafından okunur.
Dosyanın geri kalanı (Desktop'ın kendi `notify`, `mcp_servers`, `plugins`,
`projects` ayarları dahil) bayt bayt korunur; her yazma öncesi zaman damgalı
yedek alınır, sonrasında dosya geri okunup doğrulanır. API anahtarı doğrudan
`experimental_bearer_token` alanına yazılır — ortam değişkeni veya `.env`
kullanılmaz ve `auth.json` dosyasına dokunulmaz.

Codex CLI ve ChatGPT Desktop aynı kataloğu okuyarak tüm uygun modelleri model
seçicisinde gösterir. ChatGPT Desktop kuruluysa arayüz, değişikliğin geçerli olması
için uygulamayı yeniden başlatıp yeni bir Codex sohbeti açmayı hatırlatır. Switch
kapatıldığında Cizi Code'un eklediği satırlar ve katalog geri alınır; önceki model,
sağlayıcı ve katalog ayarları korunur.

Kurulum ve kaldırma her ürün için ayrıdır. ChatGPT Desktop resmî Microsoft Store
kaynağından kurulur (indirme ve kurulum ilerlemesi canlı gösterilir) ve
`Remove-AppxPackage` ile kaldırılır — `WindowsApps` klasörüne elle dokunulmaz.
**Kaldırmadan önce Cizi Code hangi yolların silineceğini, hangilerinin
korunacağını gösterir:** diğer Codex ürünü hâlâ kuruluysa ortak `~/.codex`
klasörüne ve ayar dosyasına dokunulmaz; yalnız o ürüne ait yollar silinir. Ortak
klasör ancak geriye başka Codex ürünü kalmadığında ve kullanıcı bunu onayladığında
temizlenir. Bu karar arayüzden değil, ana süreçte yeniden tespit edilerek verilir.

## Paketleme
```bash
npm run dist:win    # Windows .exe (NSIS)
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```
> Paketleme için `assets/icon.*` ekleyin (yoksa varsayılan Electron ikonu kullanılır).

### Claude: Claude Code CLI + Claude Desktop, tek switch

Claude tarafında da tek switch vardır, ama Codex'ten farklı çalışır: CLI ve
Desktop **aynı config dosyasını paylaşmaz**. CLI `~/.claude/settings.json` ile
bağlanır; Desktop ise kendi yönetilen yapılandırma yüzeyine (policy/config
library) ek olarak imzalı bir credential helper ve yeni sohbet başlatma
mekanizması kullanır. Claude Desktop modülü ciziClaude4'ten **olduğu gibi**
taşındı — kendi işlem/geri alma döngüsü, baseline yedeği, otomatik güncelleme
onarım görevi ve Türkçe arayüz paketi dahil.

Model seçimi kullanıcıdan istenmez. Claude Code CLI'de model listesini
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` doldurur; `availableModels` bunun
üzerine bir **izin listesidir**, yani anahtarın çağıramayacağı bir model
seçilemez. Opus, Sonnet, Haiku ve Fable varsayılanları uygun aile modellerine
eşlenir. 1M bağlam varyantı `[1m]` sonekiyle yalnız sonnet/opus/fable için
yazılır — Claude Code'un alias tablosunda `haiku[1m]` yoktur, yazılsa hiçbir
yerde çözülemeyen bir kimlik olurdu. Otomatik sıkıştırma eşiği, kullanıcının
geçebileceği en küçük pencereye göre hesaplanır. Effort varsayılanı Claude
Code'un kendi kümesinden (`low`/`medium`/`high`/`xhigh`/`max`) seçilir.

Claude Desktop aynı modellerin tamamını `inferenceModels` listesine yazar; ilk
kayıt varsayılandır, `supports1m` yalnız gerçekten 1M varyantı olan modellere,
`prefer1m` ise yalnız varsayılan kayda konur. Açılan yüzeyler: Chat, gelişmiş
dosya analizi, Cowork, Claude Code sekmesi ve masaüstü uzantıları. `toolSearch`
ve `autoMode` bilerek açılmaz — ilki gateway'in kabul etmediği deneysel
`anthropic-beta` başlıkları gönderttiği için istekleri HTTP 400'e düşürebilir,
ikincisi sınıflandırıcı desteği olan bir model ister. Thinking seviyeleri ve
sohbet bağlam doluluğu Claude Desktop'ın kendi model/seans arayüzünde görünür.

Koordinatör katmanı iki ürünü tek anahtar altında birleştirir:
- **Bağlarken** önce CLI bağlanır; Desktop işlemi başarısız olursa CLI ayarı
  geri alınır, böylece yarım bağlantı oluşmaz.
- **Kapatırken** önce Desktop geri alınır; başarısız olursa CLI yine geri
  alınır — iki taraf birbirinden habersiz bağlı kalamaz.
- Desktop güncellemeleri ayarları ezebildiği için arayüzde **Onar** eylemi
  vardır; tek tıkla Cizi Code ayarları yeniden uygulanır.

Yardımcı dosyalar da taşındı: `src/main/bin/` içindeki
`CiziClaudeCredentialHelper.exe` ve C# kaynak kodu.

## Mimari
- `src/main/` — Electron ana süreç. `apiClient.js` yalnızca holder-scoped uçları çağırır (`/api/me`, `/api/usage/me`, `/api/cli-tools/templates`). Backend'e erişim yoktur.
- `src/main/tools/registry.js` — her araç için yerel config şekli (gateway'in kendi cli-tools mantığından port edildi; kullanıcının makinesine yazar).
- `src/main/tools/backup.js` — config dosyalarının tam yedeği; geri alımda **aynen** geri yükler. Ortak Codex config'i gibi, bağlıyken sahibi tarafından yazılmaya devam eden dosyalarda yedek geri yükleme yerine yalnız kendi anahtarlarını geri alan cerrahi yol kullanılır.
- `src/main/codexPaths.js` — Desktop'a, CLI'ye ve ikisine birden ait yolların haritası; kaldırma planı buradan üretilir.
- `src/main/codexConfigFile.js` — ortak `~/.codex/config.toml` üzerinde cerrahi düzenleme, yedekleme ve yazma sonrası doğrulama.
- `src/main/codexModelCatalog.js` — kurulu Codex sürümünün model sözleşmesinden Cizi Code hesabına özel çoklu model kataloğu üretir.
- `src/main/tools/toolModelConfiguration.js` — hesap modellerini araç ailesine göre süzer ve otomatik varsayılan/aile eşlemelerini tek yerde belirler.
- `src/renderer/modelCapabilities.js` — bağlam penceresi, auto-compact eşiği, 1M varyant kuralı ve araç bazlı thinking/effort seviyelerinin ortak sözleşmesi. Ana süreç ve arayüz aynı dosyayı kullanır, böylece ekranda yazan ile dosyaya yazılan ayrışamaz.
- `src/main/codexDesktop.js` — ChatGPT Desktop tespiti, Microsoft Store kurulumu ve `Remove-AppxPackage` ile kaldırma.
- `src/main/claudeCoordinator.js` — Claude Code CLI + Claude Desktop tek switch koordinatörü (sıralı bağlama, başarısızlıkta geri alma).
- `src/main/tools/claude*.js` — Claude Desktop motoru: yaşam döngüsü, kurulum, kimlik doğrulama yardımcısı, politika/config library yüzeyi, dosya-tabanlı Türkçe markalama ve onarım görevi.
- `src/renderer/` — Cizi Code temalı arayüz (vanilla JS, framework yok).

## Güvenlik
- Renderer izole (`contextIsolation: true`, `nodeIntegration: false`); tüm yetenekler preload köprüsü üzerinden.
- Uygulama backend'e değil, yalnızca kendi dashboard'una erişir.
