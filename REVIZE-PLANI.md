# Cizi Code — Anahtar Güvenilirliği ve Arayüz Revizyonu

Bu belge, revizyondan **önce** yazıldı: ne bozuk, neden bozuk, hangi mimariyle
düzeltilecek ve arayüz hangi tasarım diline oturacak.

---

## 1. Bulgular — anahtar açma/kapama neden güvenilmez

### 1.1 Niyet kaydı yanlış sırada yazılıyor (asıl hata)

`main.js` içinde kapatma akışı şöyle:

```
claude.disconnect(...)   → başarılıysa → toolIntentStore.set("claude", false)
```

Yani **niyet, iş bittikten sonra** kaydediliyor. Kullanıcı anahtarı kapatır,
geri yükleme yarıda kesilir (uygulama kapanır, Windows kilitler, süreç ölür) →
diskte hâlâ `enabled: true` yazıyor. 5 dakika sonra periyodik denetim bu kaydı
okur ve **kullanıcının kaldırmasını istediği ayarı geri uygular.** Anahtar
kendi kendine açılmış görünür.

Açma tarafında ise ters yönde: niyet iş bitince yazıldığı için, yarıda kalan bir
açma "kapalı" sayılır ve yarım yapılandırma ortada kalır.

**Kural:** niyet her zaman eylemden **önce** yazılır. Yarıda kalan iş, niyeti
takip eden denetim tarafından tamamlanır — asla geri alınmaz.

### 1.2 `applied` ile "yedeği var" aynı şeye karıştırılmış

`claudeDesktop.getStatus()`:

```js
const applied = state?.active === true || hasBaseline;
```

Bir açma denemesi başarısız olup geri alma da tam bitmezse, yapılandırma
makineden silinir ama yedek dosyası kalır. Bu satır yüzünden durum
`applied: true` döner → koordinatör `connected` der → **arayüz "Bağlı" gösterir,
oysa hiçbir şey yapılandırılmamıştır.** Kullanıcının gördüğü "bilgiler geri
gelmiyor / anahtar yalan söylüyor" davranışı büyük ölçüde bu.

**Kural:** iki ayrı gerçek, iki ayrı alan:
- `applied` → yapılandırma gerçekten yerinde mi
- `restorable` → kullanıcının orijinal ayarları bizim yedeğimizde duruyor mu

`restorable && !applied` = "yarım kalmış kapatma", ayrı ve dürüst bir durum.

### 1.3 Uygulama sonrası doğrulama yok

`apply.js → applyTool()` yazar, doğrulamaz. Yazma başarısız olsa bile
`main.js` niyeti `true` yapar. Sonuç: anahtar açık, dosya yarım, kullanıcıya
hata gösterilmez.

**Kural:** yaz → doğrula → doğrulanmazsa **anında geri al** ve hata döndür.

### 1.4 Dosya yazmaları atomik değil

Kullanıcının kendi ayar dosyalarına ve **yedeğin kendisine** doğrudan
`writeFileSync` ile yazılıyor:

- `tools/registry.js:29,36` → `~/.claude/settings.json`, VS Code `settings.json`, `opencode.json`, Cline state/secrets
- `tools/backup.js:44` → `snapshot.json` (geri dönüşün tek dayanağı)
- `codexConfigFile.js:226,233`
- `store.js:58`

Yazma sırasında süreç ölürse dosya **kırpılmış** kalır. Yedeğin kendisi
kırpılırsa kullanıcının ayarları kalıcı olarak kaybolur. Projede zaten doğru
kalıp var (`toolIntentStore`, `secureStore`, `codexModelCatalog`: geçici dosya +
`rename`), ama en kritik üç yerde kullanılmıyor.

### 1.5 Yedek, geri yükleme doğrulanmadan siliniyor

`backup.restoreSnapshot()` dosyaları yazdıktan sonra `snapshot.json`'ı koşulsuz
siler. Geri yükleme sonucu doğrulanmadan yedek yok edilmiş olur; ikinci bir
deneme artık imkânsızdır.

**Kural:** yedeği silmek çağıranın kararı, ve yalnızca doğrulama geçtikten sonra.

### 1.6 Aynı mantık üç yerde tekrar ediyor

Aç/kapa + geri alma + doğrulama mantığı üç ayrı yerde yazılmış:

| Yer | Satır | Ne yapıyor |
|---|---|---|
| `main.js` IPC işleyicileri | ~40 | niyet + hata durumunda denetim tetikleme |
| `claudeCoordinator.connect/disconnect` | ~130 | CLI/Desktop ikilisi + kendi rollback'i |
| `integrationReconciler` | ~150 | aynı aç/kapa/doğrula mantığının kopyası |

Üçü birbirinden habersiz. `reconcileClaude` içinde koordinatörün yapmadığı özel
bir kurtarma yolu var (CLI yarısını Desktop açıkken bile geri al) — yani doğru
davranış tek bir yerde değil, ikisinin arasına dağılmış. Bunun adı bug üreten
mimaridir.

### 1.7 Eşzamanlılık koruması eksik

`integrationLock` yalnızca Claude Desktop için. `applyTool`/`revertTool` ve
periyodik denetim aynı anda çalışabilir; CLI köprüsü ile arayüz aynı anda aynı
anahtarı çevirebilir. Arayüzdeki `checkbox.disabled` bunu engellemez.

### 1.8 Arayüzde ölü kontrol

`renderer.js:1283` — `if (res.ok && !res.applied)`. `res` IPC zarfı
(`{ok, data}`), `res.applied` **her zaman** `undefined`. Yani genel araçlar için
"geri yüklendi" mesajı, geri yükleme başarısız olsa da gösteriliyor.

### 1.9 Küçük ama gerçek

- `codexConfigFile` geri alma yolu, hata anında eski metni yine atomik olmayan yolla yazıyor.
- `claudeCoordinator.stopDesktop` hatası kullanıcı diline çevrilmiyor.
- `reconcileTool`, niyet kaydı yokken mevcut durumu niyet olarak yazıyor ama model kaydı olmadığı için her turda "pending" uyarısı üretiyor.

---

## 2. Hedef mimari

Tek yön: **niyet → uzlaştırma**. Arayüz bir niyet bildirir; tek bir servis o
niyeti gerçeğe dönüştürür.

```
Arayüz (renderer)            CLI (cizi-cli → DOM)
        │                             │
        └──────────► IPC (main.js: sadece taşıma) ◄──────┘
                              │
                    integrationService          ◄── TEK SORUMLU:
                    · niyeti önce yazar             aç / kapa / uzlaştır
                    · araç başına sıraya alır        politikası
                    · uygula → doğrula → gerekirse geri al
                              │
              ┌───────────────┴───────────────┐
              │                               │
     claudeCoordinator                   toolManager (apply.js)
     (CLI + Desktop tek ünite)           (registry'deki araçlar)
              │                               │
     claudeDesktop backend            backup (anlık görüntü) + registry
     (kendi işlem/rollback motoru)            │
                                         fsAtomic (yaz-ve-değiştir)
```

SOLID karşılıkları:

- **SRP** — `integrationService` yalnız politika; `claudeCoordinator` yalnız iki
  ürünü tek ünite yapmak; `apply.js` yalnız yedek+uygula; `fsAtomic` yalnız
  güvenli yazma. Bugün üç yerde duran aç/kapa mantığı tek yere iner.
- **OCP** — yeni araç `registry.js`'e bir kayıt olarak eklenir; servis
  değişmez.
- **LSP** — `integrationService` her aracı aynı `adapter` sözleşmesiyle görür
  (`status / apply / revert / verify`); Claude ikilisi de, tek dosyalı araçlar da
  bu sözleşmeye uyar, servis ikisini ayırt etmez.
- **DIP** — servis bağımlılıklarını `main.js`'ten (composition root) alır;
  `resolveValues`, `getSession`, `log`, saat ve zamanlayıcı enjekte edilir.

### 2.1 Anahtar durum makinesi

Her araç için üç gerçek: **niyet** (kullanıcı ne istedi), **applied**
(yapılandırma yerinde mi), **restorable** (orijinal ayarlar yedekte mi).

| niyet | applied | restorable | Görünen durum | Servisin yaptığı |
|---|---|---|---|---|
| açık | evet | evet | **Bağlı** | doğrula, dokunma |
| açık | hayır | — | **Bağlanıyor / eksik** | yeniden uygula |
| kapalı | hayır | hayır | **Kapalı** | dokunma |
| kapalı | evet/hayır | evet | **Kapatma tamamlanacak** | geri yükle |
| — | — | — | **Dikkat gerekiyor** | `blocked` / `unreadable` / süreç açık |

Açma sözleşmesi:

```
1. Ön koşullar (kurulu mu, model var mı, süreç açık mı) — hiçbir şeye dokunmadan
2. niyet := açık                       ← diske yaz
3. yedek al (yalnız ilk kez)
4. uygula
5. doğrula → başarısızsa: niyet := kapalı, geri al, hata döndür
```

Kapatma sözleşmesi:

```
1. niyet := kapalı                     ← diske yaz, HER ZAMAN, ilk adım
2. geri yükle (geri alınabilir yarı önce: Claude Code CLI)
3. doğrula → başarısızsa hata döndür; niyet kapalı kaldığı için denetim tekrar dener
4. yedek yalnız doğrulama geçtiyse silinir
```

"Claude Desktop açık" bir **hata değil, sorudur**: onay istenir, onay gelirse
kapatılır. Kapatma akışında onay beklerken CLI yarısı yine de geri yüklenir —
yarım bağlantı bekleme sebebi olmaz.

---

## 3. Dosya bazlı iş planı

**Yeni**
- `src/main/fsAtomic.js` — `writeFileAtomic`, `writeJsonAtomic`. Tek iş.
- `src/main/tools/integrationService.js` — aç/kapa/uzlaştır politikası + araç
  başına sıra. `integrationReconciler.js`'in yerini alır.

**Değişen**
- `tools/backup.js` — atomik anlık görüntü; `restoreSnapshot` artık yedeği
  silmiyor; `verifyRestore` sonrası `dropSnapshot` çağıranın kararı.
- `tools/registry.js` — kullanıcı dosyalarına atomik yazma.
- `tools/apply.js` — `applyTool`: yaz → doğrula → başarısızsa geri al.
  `revertTool`: doğrulanmadan yedek silinmez.
- `tools/claudeDesktop.js` — `applied` / `restorable` ayrımı,
  `unfinishedDisconnect`, dürüst `needsRefresh`.
- `claudeCoordinator.js` — kendi rollback'ini bırakır (telafi artık servisin
  işi), `disconnect` CLI'yi ilk sırada geri yükler, mesajlar tek yerden.
- `codexConfigFile.js`, `store.js` — atomik yazma.
- `main.js` — IPC işleyicileri inceltilir: doğrula-çağır-döndür.
- `renderer.js` — `res.data` hatası, durum etiketi (pill), yeni satır iskeleti.

**Silinen**
- `tools/integrationReconciler.js`

**Korunacak sözleşmeler:** tüm `data-cli-id` değerleri aynı kalır — CLI, DOM
üzerinden sürdüğü için arayüz/CLI eşdeğerliği kendiliğinden korunur. IPC kanal
adları değişmez.

---

## 4. Tasarım dili

Mevcut kimlik (sıcak parşömen + koyu çam yeşili + turkuaz) projenin kendi
kimliği; değiştirilmiyor, **keskinleştiriliyor.** Bugünkü sorunlar renk seçimi
değil, bilgi mimarisi: her satır aynı ağırlıkta, durum yalnız cümleyle
anlatılıyor, log renkleri koyu temadan kalmış (açık zeminde okunmuyor), kartlar
gradyan üstünde `backdrop-filter` ile bulanıklaşıyor.

Bu bir **panel**, okunacak bir belge değil: özet önce, ayrıntı sonra; durum
sayıyla değil **biçimle** de kodlanır.

### Renk — 6 jeton

| Jeton | Değer | İş |
|---|---|---|
| `--ground` | `#efe9d6` | parşömen zemin (düz, gradyan yok) |
| `--surface` | `#fbf8ec` | kart yüzeyi, opak |
| `--ink` | `#141a17` | metin (yeşile çalan siyah, nötr gri değil) |
| `--ink-soft` | `#5b6259` | ikincil metin |
| `--pine` | `#17413d` | marka: birincil eylem, kullanım halkası |
| `--teal` | `#2f8b93` | yalnız etkileşim göstergesi (odak, bağlantı) |

Anlam renkleri aksandan ayrı ve parşömene göre doygunluğu düşürülmüş:
`--good #2f7d5b`, `--warn #9c6b26`, `--bad #a3453f`.
Çizgi: `--line rgba(20,26,23,.14)`.

### Tipografi — 3 rol

- **Başlık/UI:** `Segoe UI Variable Display`, `Segoe UI` (Windows'ta yerleşik,
  CDN yok, sessiz fallback riski yok). Başlıklar 600–700.
- **Metin:** `Segoe UI Variable Text` / `Segoe UI`, satır yüksekliği 1.45.
- **Veri:** `Cascadia Mono`, `Consolas` — sürüm, yol, log, yüzde.
  `font-variant-numeric: tabular-nums` (rakamlar zıplamasın).

Ölçek: `11 · 12 · 13 · 15 · 19 · 24`. Etiketler (`Bağlı`, `KAPALI`) büyük harf +
`letter-spacing: .06em`.

### Yerleşim

Üstte tek satır **özet şeridi** (kalan kullanım + trend), altında tek kolon
**entegrasyon kartları**. Kart yapısı:

```
┌─┬──────────────────────────────────────────────────────────────┐
│▌│ Claude (Code CLI + Desktop)      [BAĞLI]   4 model · 1M   (•)│  ← durum + anahtar
│▌│ Tek anahtar iki ürünü birlikte yönetir                       │
│▌├──────────────────────────────────────────────────────────────┤
│▌│ Claude Code CLI      Kurulu · 2.1.4          [Aç] [Kaldır]   │  ← ürün satırları
│▌│ Claude Desktop       Kurulu · 1.0.9          [Aç] [Onar]     │     (sakin iç panel)
│▌├──────────────────────────────────────────────────────────────┤
│▌│ ▸ Ayarlar uygulanıyor  ▓▓▓▓▓▓▓░░░  %72                       │  ← yalnız işlem varken
└─┴──────────────────────────────────────────────────────────────┘
 └ soldaki şerit durumu renkle kodlar (yeşil/sarı/kırmızı/nötr)
```

- **Durum etiketi (pill)** her kartta: `BAĞLI` / `KAPALI` / `KAPATMA
  TAMAMLANACAK` / `DİKKAT` / `İŞLEM SÜRÜYOR`. Sol şerit aynı bilgiyi renkle
  tekrarlar — tarayan göz için.
- Boşluk `gap` ile, eleman başına `margin` ile değil (çakışan/katlanan boşluklar
  bugünkü satırların dağınık görünme sebebi).
- Odak her etkileşimli öğede görünür: `outline: 2px solid var(--teal)`.
- `prefers-reduced-motion` altında canlı nabız ve geçişler kapanır.
- Log satırları: koyu temadan kalan `#8fe5c5` gibi renkler gider; seviye
  rozetleri parşömen üstünde okunur hâle gelir, hata/uyarı satırları soluk zemin
  şeridi alır.
- Tek tema: bu masaüstü uygulaması kendi kimliğine bağlı kalır; her renk açıkça
  boyanır, hiçbir renk yalnız bir medya sorgusunun içinde tanımlanmaz.

### Metin dili

Kontrol ne yapacağını söyler, sonuç ne olduğunu söyler. Hata ne olduğunu **ve
ne yapılacağını** söyler: "Claude Desktop açık. Ayarların uygulanabilmesi için
kapatılması gerekiyor." — özür yok, belirsizlik yok.

---

## 5. Doğrulama

`AGENTS.md` gereği npm testi son söz değil; sıralama:

1. `node test-tool-config.cjs` — model/yapılandırma sözleşmeleri bozulmadı mı.
2. Uygulamayı başlat, `cizi-cli screen` ile ekranı oku.
3. `cizi-cli switch tool.claude.switch on` → `off` → `on`, her adımda
   `~/.claude/settings.json` ve yedek klasörünün gerçek içeriğini kontrol et.
4. Kapatma sırasında yarıda kesme senaryosu: niyet dosyasının `enabled: false`
   yazdığını ve yeniden başlatmada denetimin geri yüklemeyi **tamamladığını**
   (yeniden uygulamadığını) doğrula.
5. Günlükte her akış için `info/success/warning/error` satırı ve geri alma
   sonucu görünüyor mu.

Sınır: Claude Desktop'ın MSIX kurulumu, yönetici onayı ve WMI süreç taraması
bu ortamda uçtan uca çalıştırılamaz; o yollar kod incelemesi + enjekte edilmiş
sahte bağımlılıklarla doğrulanır.

---

## 6. Uygulandı — doğrulama sonuçları

Plan uygulandı. Gerçek makinede, gerçek dosyalarla doğrulananlar:

| Senaryo | Sonuç |
|---|---|
| `node test-tool-config.cjs` | 34/34 geçti |
| Codex anahtarı aç | `config.toml` yazıldı, iki katmanda doğrulandı, günlüğe `SUCCESS` düştü |
| Codex anahtarı kapat | `config.toml` **birebir** eski md5'e döndü, yedek yalnız doğrulamadan sonra silindi |
| **Yarıda kesilmiş kapatma** (niyet "kapalı", ayar hâlâ uygulanmış) | Denetim geri yüklemeyi **tamamladı** — eski davranışta yeniden uyguluyordu |
| Bağlantı açıkken ayar dosyası elle bozuldu | Denetim yeniden uyguladı (1 düzeltildi) |
| Niyet sırası (sahte bağımlılıklarla) | `intent=true → connect`, `intent=false → disconnect` |
| Açma başarısız olursa | `intent=false` + telafi olarak `disconnect` çağrıldı |
| "Claude Desktop açık" sorusu | Niyet dosyasına **hiç dokunulmadı**, geri alma tetiklenmedi |

Doğrulanmayan sınırlar:

- **Claude anahtarı açılmadı.** Bu anahtar `~/.claude/settings.json`'ı ve kurulu
  Claude Desktop paketini değiştirir; bu oturum Claude üzerinden çalıştığı için
  o dosyaya dokunulmadı. Claude yolu kod incelemesi ve enjekte edilmiş sahte
  bağımlılıklarla doğrulandı (koordinatör + servis sözleşmesi).
- Claude Desktop'ın MSIX kurulumu, yönetici onayı ve WMI süreç taraması bu
  ortamda uçtan uca çalıştırılamaz.
- Test sırasında kullanılan makine, başlangıçtaki durumuna geri bırakıldı:
  iki anahtar kapalı, `config.toml` ve `settings.json` orijinal md5'leriyle,
  yedek klasörleri boş.

---

## 7. Claude tek anahtardan iki anahtara

**Karar:** Markalama olduğu gibi kalıyor — bütün dillerde gateway etiketi, `tr-TR`
eklenmiyor. Claude Code CLI ile Claude Desktop ise **ayrı anahtarlar** oldu.

**Neden mümkün:** İki ürün hiçbir ayar dosyasını paylaşmıyor.

| | Claude Code CLI | Claude Desktop |
|---|---|---|
| Ayar | `~/.claude/settings.json` | `%LOCALAPPDATA%\Claude-3p\configLibrary\<guid>.json` |
| Kimlik | dosyadaki `ANTHROPIC_AUTH_TOKEN` | ayrı credential helper `.exe` |
| Yedek | `backups\claude-code\snapshot.json` | `integrations\claude-desktop\baseline.secure.json` |

Codex tam tersi: iki ürünü de tek `~/.codex/config.toml` besliyor, bu yüzden o
tek anahtar kalmaya devam ediyor. Kodun kendisi de bu ayrımı zaten varsayıyordu
(`claudeDesktopInstaller.js` → `preservedDirectories()`: *"different product with
its own switch"*).

**Kazanç:** Claude Desktop tarafı çalışmazsa (yönetici izni yok, paket kilitli,
politika engeli) Claude Code CLI bağlı kalmaya devam eder. Eskiden Desktop'ın
başarısızlığı bütün işlemi geri alıyordu.

**Değişenler**
- `claudeCoordinator` artık iki ürünü tek işlemde birleştirmiyor; Claude Desktop
  cephesi oldu (`applyDesktop` / `revertDesktop` / durum + kurulum/onarım/başlatma).
  401 → 315 satır.
- `integrationService` iki anahtar tanıyor: `claude-code` (registry aracı) ve
  `claude-desktop` (yeni bağdaştırıcı). `connect`/`disconnect` IPC kanalları
  kaldırıldı; ikisi de genel `applyTool`/`revertTool` üzerinden geçiyor.
- **Göç:** eski tek `claude` niyet kaydı, ilk açılışta aynı `enabled` ve model
  değerleriyle `claude-code` + `claude-desktop` olarak ikiye bölünüp siliniyor.
- Arayüzde iki ayrı satır, kendi durum etiketi ve eylemleriyle. CLI kimlikleri:
  `tool.claude-code.switch`, `tool.claude-desktop.switch`.

**Bilinmesi gereken tek temas noktası:** Claude Desktop'ın içindeki "Claude Code"
sekmesi aynı çekirdek olduğu için `~/.claude/settings.json`'ı okuyor. Desktop açık
+ CLI kapalı iken o sekme kullanıcının kendi hesabına düşer. Engellenmiyor, ama
Claude Desktop satırında yazıyor: *"içindeki Claude Code sekmesi için CLI
anahtarını da açın"*.

### Doğrulama

| Senaryo | Sonuç |
|---|---|
| Niyet göçü | `claude` kaydı silindi, iki kayda `enabled=false` + `model=Opus-4.8` olarak taşındı |
| Üç anahtar ekranda | `tool.claude-code.switch`, `tool.claude-desktop.switch`, `tool.codex.switch` |
| CLI anahtarı tek başına aç | `settings.json` yazıldı ve doğrulandı; Claude Desktop'a **hiç dokunulmadı** (niyet `false`, configLibrary yok) |
| CLI anahtarı kapat | `settings.json` **birebir** orijinal md5'e döndü, yedek düşürüldü |
| `node test-tool-config.cjs` | 34/34 |
| Ölü kod taraması | 0 bulgu |

Sınır: **Claude Desktop anahtarı açılmadı.** Açmak kurulu paketi yamalar ve
yönetici onayı ister; bu oturum Claude üzerinden çalıştığı için o yola
girilmedi. Desktop yolu kod incelemesi ve sahte bağımlılıklarla doğrulandı.

---

## 8. Spagetti izleri — yapısal temizlik

Ölü isim taraması sıfır dönmeye başladıktan sonra farklı sınıf sorunlara bakıldı:
kopyala-yapıştır blokları, şişmiş dosyalar, yanlış yere yerleşmiş sorumluluklar.

### Yapılan: Claude Code CLI servisi `main.js`'ten çıkarıldı

`main.js` composition root olmasına rağmen **komple bir Claude Code CLI servisi**
taşıyordu: 21 fonksiyon, ~500 satır — tespit, resmî betikle kurulum, ilerleme
izleme, kurulum kilidi, açma. Yanı başında zaten doğru desen vardı
(`createCodexCliService`), ama Claude tarafı o desene hiç taşınmamıştı.

- **Yeni:** `src/main/claudeCodeCli.js` — `createClaudeCodeCliService({ userDataPath, log, onInstallState })`, `detect/install/open` yüzeyi. Codex servisiyle aynı sözleşme.
- **Yeni:** `src/main/httpsUrl.js` — `assertHttpsUrl`, iki tüketicisi olduğu için (güncelleyici + Claude kurulumu) tek yerde.
- `main.js`: **1093 → 592 satır.**

### Bu sırada çıkan gerçek hata: WinGet kurulumları

CLI'nın nerede kurulu olabileceği listesi **iki yerde** yazılıydı (tespit için
`main.js`, kaldırma için `claudeUninstall.js`) ve ikisi de WinGet'i bilmiyordu.
Bu makinede CLI tam olarak WinGet ile kurulu: listedeki 7 yolun hiçbiri yok,
tespit yalnızca `where.exe` sayesinde çalışıyordu. Yani **"Kökten Kaldır" gerçek
kurulumu hiç görmüyordu.**

İlginç not: bu bilgi, ölü olduğu için sildiğim `claudeLifecycle` katmanında
duruyordu. Kod erişilemezdi ama içindeki bilgi doğruydu.

Çözüm — bilerek iki ayrı liste, çünkü amaçları farklı:

| Fonksiyon | Ne için | WinGet dahil mi |
|---|---|---|
| `claudeCliPaths()` | tespit | **evet** |
| `claudeCliRemovablePaths()` | dosya silme | hayır |

WinGet dosyaları silinmiyor: onlar WinGet'in paket durumu, arkasından silmek
WinGet'e "hâlâ kurulu" dedirtir. Bunun yerine plan bunları ayrı bildiriyor ve
kullanıcıya `winget uninstall --id Anthropic.ClaudeCode` söylüyor.

### Bir dead gate daha, silmek yerine bağlandı

`planClaudeCodeUninstall` IPC + preload boyunca bağlıydı ama arayüzden çağıran
yoktu. Silmek yerine kullanıldı: "Kökten Kaldır" artık ne silineceğini **listeyle**
soruyor. Bu aynı zamanda önceden hiç gösterilmeyen bir şeyi ortaya çıkardı —
purge `~/.claude` klasörünü de siliyor. Davranış değişmedi, ama artık onaydan
önce yazıyor.

### Rapor edilen, yapılmayanlar

Bunlar gerçek ama ayrı birer iş; tek turda karıştırmak riskli:

| Bulgu | Yer | Öneri |
|---|---|---|
| 4 ayrı kilit implementasyonu | `integrationLock`, `claudeBranding/lock`, `codexCli` ve `codexDesktop` içinde satır içi | tek `processLock` modülü |
| 2 zamanlanmış görev modülü ~5 fonksiyonu birebir paylaşıyor | `claudeBrandingTask` ↔ `claudeReconcileTask` (`taskPayload`, `payloadPreamble`, `parseResult`, `ensure`, `isCurrent`) | ortak modül + iki yapılandırma (SYSTEM/Highest ve kullanıcı/Limited) |
| `codedError` 15 dosyada ayrı ayrı tanımlı | her yerde | tek yardımcı |
| `withV1` 3 dosyada | `codexConfigFile`, `claudeDesktopContract`, `registry` | tek yardımcı |
| atomik yazma 3 yerde | `fsAtomic`, `claudeBranding/fsx`, `secureStore` | `fsAtomic` üzerinde birleştir |
| `renderer.js` 1605 satır, `renderCodexRow` 221 satır | arayüz | satır kurucularını ayrı dosyalara böl |
