// Kökten kaldırma, ürün başına KATEGORİ olarak modellenir.
//
// NEDEN
// Eskiden kaldırma tek bir "hepsini sil" düğmesiydi ve kullanıcı ne gittiğini
// ancak onay metninden okuyabiliyordu. Sohbet geçmişini tutup uygulamayı silmek,
// ya da uygulamayı bırakıp yalnızca giriş bilgilerini temizlemek mümkün değildi.
// Burada her ürün, adı konmuş kategorilere ayrılır; yürütme YALNIZCA seçilen
// kategorileri siler.
//
// ÜÇ KURAL
//   1) Listede yalnızca gerçekten VAR OLAN yollar görünür. Bir yol tahmini
//      yanlışsa kullanıcı onu hiç görmez - liste diskin kendisinden üretilir.
//   2) Başka bir ürünün de okuduğu ortak yol KİLİTLİ görünür: sebebi yazılır,
//      seçilemez. Codex'in ~/.codex'i iki ürün tarafından paylaşıldığı için
//      ChatGPT Desktop kuruluyken CLI kaldırması ona dokunamaz.
//   3) Bizim kurmadığımız kurulum (WinGet) DIŞ olarak bildirilir: silinmez,
//      kullanıcıya komutu söylenir. WinGet'in paket durumunu arkasından
//      silmek onu bozuk bir kayıtla bırakır.
//
// Paket kaldırma (MSIX / Squirrel) bu modülün işi değildir; ürünün kendi
// kaldırıcısı `removeApplication` olarak enjekte edilir. WinGet ile kurulu
// Claude Code CLI ise `winget uninstall` eylemi olarak `app` kategorisinde
// doğrudan kaldırılır - kullanıcıya manuel komut söylenmez.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const codexPaths = require("./codexPaths");
const claudeDesktopInstaller = require("./tools/claudeDesktopInstaller");
const {
  claudeCliRemovablePaths,
  wingetClaudeCliPaths,
  vscodeClaudeInstallations,
  VSCODE_EXTENSION_ID,
} = require("./claudeCodeCli");
const {
  vscodeCodexInstallations,
  VSCODE_EXTENSION_ID: CODEX_VSCODE_EXTENSION_ID,
} = require("./codexCli");
const { claudeConfigDirectory, claudeUserRecordCandidates } = require("./claudePaths");

const execFileAsync = promisify(execFile);

const CLAUDE_CODE = "claude-code";
const CLAUDE_DESKTOP = "claude-desktop";
const CODEX_CLI = "codex-cli";
const CODEX_DESKTOP = "codex-desktop";

// Sıra ekranda göründüğü sıradır: en somut olan (uygulama) en üstte, en soyut
// olan (kalıntı) en altta.
const CATEGORIES = Object.freeze([
  { id: "app", label: "Uygulamanın kendisi", hint: "Çalıştırılabilir dosyalar ve kurulum dizini" },
  { id: "config", label: "Yapılandırma dosyaları", hint: "Ayarlar, model listesi, sağlayıcı tanımı" },
  { id: "sessions", label: "Sohbet geçmişi ve oturum kayıtları", hint: "Geçmiş konuşmalar, projeler, komut geçmişi" },
  { id: "credentials", label: "Giriş bilgileri ve profil", hint: "Oturum anahtarları, çerezler, kimlik dosyaları" },
  { id: "cache", label: "Önbellek, günlük ve geçici dosyalar", hint: "Yeniden üretilebilen dosyalar" },
  // Yukarıdaki adlardan hiçbirine uymayan içerik. Tahmin edilip bir kategoriye
  // sokulmaz; kullanıcı bunu ayrıca seçer.
  { id: "leftovers", label: "Kategorilere girmeyen kalan dosyalar", hint: "Uygulamanın klasöründe kalan, adı tanınmayan içerik" },
  { id: "residue", label: "Derin kalıntılar", hint: "PATH girdisi, kısayollar, kayıt defteri, global paket" },
]);

const CATEGORY_IDS = Object.freeze(CATEGORIES.map((item) => item.id));

function existsSafe(target) {
  try { return fs.existsSync(String(target)); } catch { return false; }
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

// `lock` doluysa yol listede görünür ama silinemez; sebebi kullanıcıya yazılır.
function fileEntry(category, target, reason, lock = null) {
  return { category, path: String(target), reason, lock };
}

// Electron uygulamalarının kullanıcı verisi klasörü. Adlar Chromium'un kendi
// adlarıdır, bu yüzden hangi Electron uygulaması olduğu fark etmez; hangisinin
// var olduğuna disk karar verir.
//
// ÖNEMLİ: bu klasörün KENDİSİ hiçbir kategoriye girmez. Klasörü tek parça olarak
// "yapılandırma" saymak, kullanıcı yalnızca ayarları silmek isterken bütün sohbet
// geçmişini ve gigabaytlık önbelleği de götürür. Bu yüzden içerik adı adına
// sınıflandırılır ve kalan boşluk `prune-empty` ile toplanır.
function electronUserDataEntries(directory) {
  const at = (name) => path.join(directory, name);
  return [
    fileEntry("config", at("Preferences"), "Chromium tercihleri"),
    fileEntry("config", at("Local State"), "Uygulama durumu"),
    fileEntry("config", at("window-state.json"), "Pencere konumu"),
    fileEntry("sessions", at("Local Storage"), "Yerel depolama"),
    fileEntry("sessions", at("Session Storage"), "Oturum depolaması"),
    fileEntry("sessions", at("IndexedDB"), "Sohbet veritabanı"),
    fileEntry("sessions", at("WebStorage"), "Web depolaması"),
    fileEntry("sessions", at("Partitions"), "Oturum bölümleri"),
    fileEntry("credentials", at("Network"), "Oturum çerezleri ve ağ durumu"),
    fileEntry("credentials", at("Cookies"), "Oturum çerezleri"),
    fileEntry("credentials", at("Cookies-journal"), "Çerez günlüğü"),
    fileEntry("credentials", at("SharedStorage"), "Paylaşılan depolama"),
    fileEntry("credentials", at("SharedStorage-wal"), "Paylaşılan depolama günlüğü"),
    fileEntry("credentials", at("DIPS"), "Site etkileşim kaydı"),
    fileEntry("credentials", at("DIPS-wal"), "Site etkileşim günlüğü"),
    fileEntry("cache", at("Cache"), "Önbellek"),
    fileEntry("cache", at("Code Cache"), "Kod önbelleği"),
    fileEntry("cache", at("GPUCache"), "GPU önbelleği"),
    fileEntry("cache", at("DawnGraphiteCache"), "Grafik önbelleği"),
    fileEntry("cache", at("DawnWebGPUCache"), "Grafik önbelleği"),
    fileEntry("cache", at("blob_storage"), "Geçici blob deposu"),
    fileEntry("cache", at("Shared Dictionary"), "Paylaşılan sıkıştırma sözlüğü"),
    fileEntry("cache", at("logs"), "Günlükler"),
    fileEntry("cache", at("Crashpad"), "Çökme raporları"),
    fileEntry("cache", at("sentry"), "Hata raporu kuyruğu"),
    fileEntry("cache", at("fcache"), "Dosya önbelleği"),
  ];
}

const CHROMIUM_PROFILE_DIRECTORY = /^(Default|Profile \d+|Guest Profile|System Profile)$/i;

// Bilinen adlar sınıflandırıldıktan sonra klasörde KALAN her şey.
//
// NEDEN TAHMİN EDİLMEZ
// Chromium'un kullanıcı verisi klasöründeki bileşen klasörleri sürümle değişir
// (component_crx_cache, GrShaderCache, WasmTtsEngine...). Sabit bir isim listesi
// bir sonraki sürümde eksik kalır. Tanımadığımız bir klasörü "önbellek" saymak
// ise daha kötüsü: gelecekte oraya kullanıcı verisi konursa, kullanıcı geçmişini
// korumak isterken silmiş oluruz.
//
// Bu yüzden tanınmayan içerik kategorisi TAHMİN EDİLMEZ; adı konmuş bir kategori
// olarak, "kalan dosyalar" başlığı altında bildirilir. Kullanıcı onu ayrıca
// seçer. Böylece kaldırma hem eksiksiz olur hem hiçbir şeyi yanlış etiketlemez.
function withLeftovers(root, entries, { depth = 1 } = {}) {
  const result = [...entries];
  if (!existsSafe(root)) return result;
  const rootKey = String(root).toLowerCase();
  const claimed = new Set(entries
    .filter((entry) => path.dirname(entry.path).toLowerCase() === rootKey)
    .map((entry) => path.basename(entry.path).toLowerCase()));
  let children;
  try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
  for (const child of children) {
    if (claimed.has(child.name.toLowerCase())) continue;
    const target = path.join(root, child.name);
    // Chromium profili kendi içinde aynı adları taşır; ona bir kez inilir.
    if (depth > 0 && child.isDirectory() && CHROMIUM_PROFILE_DIRECTORY.test(child.name)) {
      result.push(...withLeftovers(target, electronUserDataEntries(target), { depth: depth - 1 }));
      continue;
    }
    result.push(fileEntry("leftovers", target, "Kategorilerin dışında kalan dosya"));
  }
  return result;
}

// MSIX paketlerinin kullanıcı durumu sabit alt klasörlerde durur.
//
// `LocalCache` BİLEREK burada yok: Windows, paketlenmiş bir uygulamanın
// %APPDATA% yazmalarını `LocalCache\Roaming\<Uygulama>` altına yönlendirir. Yani
// adı "cache" olsa da içinde sohbet geçmişi vardır. Onu tek parça "önbellek"
// saymak, kullanıcı geçmişini korumak isterken silmek olurdu; sanallaştırılmış
// klasörler çağıran tarafta ayrıca ve ad ad sınıflandırılır.
function packageStateEntries(stateDirectory) {
  return [
    fileEntry("config", path.join(stateDirectory, "Settings"), "Paket ayarları"),
    fileEntry("sessions", path.join(stateDirectory, "LocalState"), "Uygulama durumu ve geçmiş"),
    fileEntry("sessions", path.join(stateDirectory, "RoamingState"), "Eşitlenen uygulama durumu"),
    fileEntry("cache", path.join(stateDirectory, "TempState"), "Geçici paket dosyaları"),
    fileEntry("cache", path.join(stateDirectory, "AC"), "Uygulama kabı önbelleği"),
    fileEntry("cache", path.join(stateDirectory, "LocalCache", "LocalLow"), "Düşük bütünlüklü önbellek"),
  ];
}

function claudeCodeMap() {
  const home = os.homedir();
  // CLAUDE_CONFIG_DIR ayarlanmışsa Claude Code'un evi orasıdır; kaldırma da
  // gerçek konuma bakmalı, yoksa kullanıcının verisi silinmemiş olarak kalır.
  const claudeDir = claudeConfigDirectory();
  const winget = wingetClaudeCliPaths().filter(existsSafe);
  const actions = [
    { category: "residue", kind: "npm-global", target: "@anthropic-ai/claude-code", label: "npm global paketi" },
    { category: "residue", kind: "prune-empty", target: claudeDir, label: `Boşalan ${path.basename(claudeDir)} klasörü` },
  ];
  if (winget.length) {
    actions.unshift({
      category: "app",
      kind: "winget-uninstall",
      target: "Anthropic.ClaudeCode",
      label: "WinGet paketi (Anthropic.ClaudeCode)",
      reason: "WinGet üzerinden kaldırılır",
    });
  }
  const editors = vscodeClaudeInstallations();
  const externals = [];
  if (editors.length) {
    externals.push({
      label: `Kod düzenleyici eklentisi olarak kurulu (${[...new Set(editors.map((item) => item.editor))].join(", ")})`,
      reason: "Eklentiyi düzenleyici yönetiyor; klasörünü silmek onu bozuk bir uzantı kaydıyla bırakır",
      command: `code --uninstall-extension ${VSCODE_EXTENSION_ID}`,
      paths: editors.map((item) => item.directory),
    });
  }
  const external = externals.length ? { ...externals[0], all: externals } : null;
  return {
    name: "Claude Code CLI",
    entries: [
      ...claudeCliRemovablePaths().map((target) => fileEntry("app", target, "Claude Code başlatıcısı")),
      fileEntry("app", path.join(home, ".local", "share", "claude"), "Claude Code çalıştırılabilir dosyaları"),
      fileEntry("app", path.join(localAppData(), "Programs", "Claude Code"), "Kurulum dizini"),
      fileEntry("app", path.join(localAppData(), "Claude Code"), "Kurulum dizini"),
      fileEntry("config", path.join(claudeDir, "settings.json"), "Claude Code ayarları"),
      fileEntry("config", path.join(claudeDir, "settings.local.json"), "Yerel ayar geçersiz kılmaları"),
      ...claudeUserRecordCandidates().map((candidate) => fileEntry("config", candidate, "Claude Code kullanıcı kaydı")),
      fileEntry("sessions", path.join(claudeDir, "projects"), "Proje bazlı sohbet geçmişi"),
      fileEntry("sessions", path.join(claudeDir, "history.jsonl"), "Komut geçmişi"),
      fileEntry("sessions", path.join(claudeDir, "todos"), "Oturum görev listeleri"),
      fileEntry("sessions", path.join(claudeDir, "shell-snapshots"), "Kabuk anlık görüntüleri"),
      fileEntry("credentials", path.join(claudeDir, ".credentials.json"), "Kayıtlı oturum anahtarı"),
      fileEntry("cache", path.join(claudeDir, "downloads"), "İndirilen yükleyiciler"),
      fileEntry("cache", path.join(claudeDir, "statsig"), "Özellik bayrağı önbelleği"),
      fileEntry("cache", path.join(claudeDir, "logs"), "Günlükler"),
      fileEntry("cache", path.join(claudeDir, "file-history"), "Dosya değişiklik geçmişi"),
    ],
    actions,
    external,
  };
}

function externalClaudeInstallations() {
  const items = [];
  const editors = vscodeClaudeInstallations();
  if (editors.length) {
    items.push({
      label: `Kod düzenleyici eklentisi olarak kurulu (${[...new Set(editors.map((item) => item.editor))].join(", ")})`,
      reason: "Eklentiyi düzenleyici yönetiyor; klasörünü silmek onu bozuk bir uzantı kaydıyla bırakır",
      command: `code --uninstall-extension ${VSCODE_EXTENSION_ID}`,
      paths: editors.map((item) => item.directory),
    });
  }
  if (!items.length) return null;
  // Ekran tek bir dış kurulum bekliyordu; iki tanesi olabildiği için hepsi
  // taşınır, ilki geriye dönük uyumluluk için üstte tutulur.
  return { ...items[0], all: items };
}

// Claude Desktop'ın kullanıcı verisi %LOCALAPPDATA%\Claude-3p altındadır - bu
// klasör hem ayarları hem sohbet geçmişini hem de gigabaytlık indirilmiş çalışma
// zamanı paketlerini tutar. Eski/Squirrel kurulumlar %APPDATA%\Claude kullanır;
// ikisi de listelenir, hangisinin var olduğuna disk karar verir.
function claudeDesktopMap({ version } = {}) {
  const local = localAppData();
  const userData = path.join(local, "Claude-3p");
  const legacyUserData = path.join(roamingAppData(), "Claude");
  const stateDirectory = path.join(local, "Packages", claudeDesktopInstaller.CLAUDE_PACKAGE_FAMILY);
  const claudeSpecific = (directory) => [
    fileEntry("config", path.join(directory, "claude_desktop_config.json"), "Claude Desktop ayarları"),
    fileEntry("config", path.join(directory, "config.json"), "Uygulama yapılandırması"),
    fileEntry("config", path.join(directory, "configLibrary"), "Yönetilen yapılandırma kitaplığı (Cizi Code bağlantısı)"),
    fileEntry("config", path.join(directory, "cowork-enabled-cli-ops.json"), "Özellik anahtarları"),
    fileEntry("config", path.join(directory, "git-worktrees.json"), "Kayıtlı çalışma alanları"),
    fileEntry("credentials", path.join(directory, "ant-did"), "Cihaz kimliği"),
    fileEntry("sessions", path.join(directory, "claude-code-sessions"), "Gömülü Claude Code oturumları"),
    fileEntry("sessions", path.join(directory, "local-agent-mode-sessions"), "Yerel ajan oturumları"),
    fileEntry("sessions", path.join(directory, "title-gen"), "Sohbet başlığı önbelleği"),
    fileEntry("sessions", path.join(directory, "pending-uploads"), "Gönderilmemiş yüklemeler"),
    // İndirilmiş çalışma zamanı yükleri: birkaç gigabayt tutar ve uygulama
    // gerektiğinde yeniden indirir. Kullanıcının "yerden kazanmak istiyorum"
    // dediğinde bulacağı yer burasıdır.
    fileEntry("cache", path.join(directory, "vm_bundles"), "İndirilmiş sanal makine paketleri"),
    fileEntry("cache", path.join(directory, "claude-code"), "Gömülü Claude Code çalışma zamanı"),
    fileEntry("cache", path.join(directory, "claude-code-vm"), "Gömülü Claude Code sanal makine dosyaları"),
  ];
  return {
    name: "Claude Desktop",
    entries: [
      fileEntry("app", path.join(local, "Programs", "Claude"), "Kurulum dizini"),
      fileEntry("app", path.join(local, "AnthropicClaude"), "Uygulama dosyaları"),
      ...withLeftovers(userData, [...electronUserDataEntries(userData), ...claudeSpecific(userData)]),
      ...withLeftovers(legacyUserData, [...electronUserDataEntries(legacyUserData), ...claudeSpecific(legacyUserData)]),
      ...packageStateEntries(stateDirectory),
    ],
    actions: [
      {
        category: "app",
        kind: "uninstall-application",
        label: version ? `Claude Desktop paketi (${version})` : "Claude Desktop paketi",
        reason: "Anthropic'in kendi kaldırıcısı çalıştırılır",
      },
      { category: "residue", kind: "claude-desktop-residue", label: "Kayıt defteri, kısayollar ve otomatik başlatma" },
      { category: "residue", kind: "prune-empty", target: userData, label: "Boşalan Claude-3p klasörü" },
      { category: "residue", kind: "prune-empty", target: legacyUserData, label: "Boşalan Claude klasörü" },
      { category: "residue", kind: "prune-empty", target: stateDirectory, label: "Boşalan paket klasörü" },
    ],
    // Claude Code CLI'nin evi. Aynı markanın iki ayrı ürünü olduğu için burası
    // her zaman korunur; kilit kaldırılabilir bir seçenek değil.
    protected: [{
      path: path.join(os.homedir(), ".claude"),
      reason: "Claude Code CLI'ye ait — Claude Desktop kaldırması buna dokunmaz",
    }],
  };
}

// Codex tarafında paylaşım kuralı: iki ürün de ~/.codex'i okur. Bu yüzden ortak
// yolların kilidi "diğer ürün kurulu mu" sorusunun cevabıdır.
function codexSharedEntries(lock) {
  const shared = codexPaths.sharedPaths();
  const root = shared.root;
  return [
    fileEntry("config", shared.configFile, "Ortak Codex yapılandırması — kendi Codex ayarlarınız da bu dosyada", lock),
    fileEntry("config", shared.modelCatalogFile, "Cizi Code model kataloğu", lock),
    fileEntry("sessions", path.join(root, "sessions"), "Kaydedilmiş oturumlar", lock),
    fileEntry("sessions", path.join(root, "history.jsonl"), "Komut geçmişi", lock),
    fileEntry("credentials", shared.authFile, "Codex oturum anahtarı", lock),
    fileEntry("cache", path.join(root, "log"), "Günlükler", lock),
  ];
}

function codexCliMap({ otherInstalled } = {}) {
  const cli = codexPaths.cliPaths();
  const shared = codexPaths.sharedPaths();
  const lock = otherInstalled ? "ChatGPT Desktop de bu dosyaları okuyor" : null;
  return {
    name: "Codex CLI",
    entries: [
      fileEntry("app", cli.programDir, "Codex CLI kurulumu"),
      fileEntry("app", cli.standaloneDir, "Codex CLI paket dosyaları"),
      fileEntry("config", cli.legacyProfile, "Eski Cizi Code CLI profili"),
      ...codexSharedEntries(lock),
    ],
    actions: [
      { category: "residue", kind: "path-entry", target: cli.binDir, label: "PATH girdisi" },
      { category: "residue", kind: "npm-global", target: "@openai/codex", label: "npm global paketi" },
      { category: "residue", kind: "prune-empty", target: shared.root, label: "Boşalan ~/.codex klasörü", lock },
    ],
    protected: otherInstalled
      ? [{ path: shared.root, reason: "ChatGPT Desktop kurulu olduğu için ortak Codex klasörü korunur" }]
      : [],
    // Kod düzenleyici eklentisi de bir Codex CLI kopyası taşıyor; onu düzenleyici
    // yönetir, biz dokunmayız.
    external: externalCodexInstallations(),
  };
}

function externalCodexInstallations() {
  const editors = vscodeCodexInstallations();
  if (!editors.length) return null;
  const item = {
    label: `Kod düzenleyici eklentisi olarak kurulu (${[...new Set(editors.map((entry) => entry.editor))].join(", ")})`,
    reason: "Eklentiyi düzenleyici yönetiyor; klasörünü silmek onu bozuk bir uzantı kaydıyla bırakır",
    command: `code --uninstall-extension ${CODEX_VSCODE_EXTENSION_ID}`,
    paths: editors.map((entry) => entry.directory),
  };
  // Diskte kayıtlı olmayan eski sürüm klasörleri kalabiliyor; bunlar gerçek
  // birer kalıntıdır ve ayrıca söylenir.
  const stale = editors.filter((entry) => entry.active === false).map((entry) => entry.directory);
  const items = [item];
  if (stale.length) {
    items.push({
      label: "Etkin olmayan eski eklenti sürümü klasörleri",
      reason: "Düzenleyicinin kaydında bu sürüm yok; kaldırmayı da düzenleyici yapmalı",
      command: "VS Code > Uzantılar > Codex > çark > Uninstall",
      paths: stale,
    });
  }
  return { ...items[0], all: items };
}

function codexDesktopMap({ otherInstalled, version } = {}) {
  const desktop = codexPaths.desktopPaths();
  const shared = codexPaths.sharedPaths();
  const lock = otherInstalled ? "Codex CLI de bu dosyaları okuyor" : null;
  // Paketlenmiş uygulamanın gördüğü %APPDATA% ve %LOCALAPPDATA%: Windows
  // ikisini de paketin LocalCache'i altına yönlendirir. ChatGPT Desktop'ın
  // Chromium kullanıcı verisi klasörü bir kademe daha içeride (web\Codex) ve
  // profil orada `Default` altında durur - ikisi de içerikten bulunur.
  const virtualRoaming = path.join(desktop.packageStateDir, "LocalCache", "Roaming", "Codex");
  const virtualLocal = path.join(desktop.packageStateDir, "LocalCache", "Local", "Codex");
  const chromiumRoot = path.join(virtualRoaming, "web", "Codex");
  return {
    name: "ChatGPT Desktop",
    entries: [
      fileEntry("app", desktop.runtimeDir, "ChatGPT Desktop yerel çalışma dosyaları"),
      ...packageStateEntries(desktop.packageStateDir),
      ...withLeftovers(chromiumRoot, electronUserDataEntries(chromiumRoot)),
      ...withLeftovers(virtualLocal, electronUserDataEntries(virtualLocal)),
      ...codexSharedEntries(lock),
    ],
    actions: [
      { category: "residue", kind: "prune-empty", target: virtualRoaming, label: "Boşalan ChatGPT Desktop veri klasörü" },
      { category: "residue", kind: "prune-empty", target: virtualLocal, label: "Boşalan ChatGPT Desktop yerel klasörü" },
      {
        category: "app",
        kind: "uninstall-application",
        label: version ? `ChatGPT Desktop paketi (${version})` : "ChatGPT Desktop paketi",
        reason: "Windows paket kaldırma işlemi çalıştırılır",
      },
      { category: "residue", kind: "prune-empty", target: desktop.packageStateDir, label: "Boşalan paket klasörü" },
      { category: "residue", kind: "prune-empty", target: shared.root, label: "Boşalan ~/.codex klasörü", lock },
    ],
    protected: otherInstalled
      ? [{ path: shared.root, reason: "Codex CLI kurulu olduğu için ortak Codex klasörü korunur" }]
      : [],
  };
}

const MAPS = Object.freeze({
  [CLAUDE_CODE]: claudeCodeMap,
  [CLAUDE_DESKTOP]: claudeDesktopMap,
  [CODEX_CLI]: codexCliMap,
  [CODEX_DESKTOP]: codexDesktopMap,
});

// Yolun ne kadar yer tuttuğu, kullanıcının "bunu silmeye değer mi" kararını
// verebilmesi için ölçülür. Ölçüm başarısız olursa boyut bilinmez olarak
// bildirilir - kaldırmayı engellemez.
function directorySize(target, budget = { files: 4000 }) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    if (budget.files <= 0) return { bytes: total, complete: false };
    const current = stack.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    budget.files -= 1;
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let names;
      try { names = fs.readdirSync(current); } catch { continue; }
      for (const name of names) stack.push(path.join(current, name));
      continue;
    }
    total += stat.size;
  }
  return { bytes: total, complete: true };
}

function planRemoval(productId, context = {}) {
  const build = MAPS[productId];
  if (!build) throw new Error(`Bilinmeyen ürün: ${productId}`);
  const map = build(context);

  const buckets = new Map(CATEGORIES.map((item) => [item.id, { paths: [], actions: [] }]));
  // Aynı yol iki kategoride görünürse, kullanıcı birini seçmese bile diğeriyle
  // silinir - yani "seçmediğin gitmez" sözü bozulur. Bu yüzden ilk kategori
  // sahiplenir, sonrakiler atlanır.
  const claimedPaths = new Set();
  // Boyut ölçümü kullanıcıya karar verdirmek için var, kaldırmanın doğruluğu için
  // değil. Bu yüzden bütün ağacı yürümeye izin verilmez: bütçe dolduğunda ölçüm
  // yaklaşık olarak işaretlenir. Claude Desktop'ın 2 GB'lık klasörünü tam saymak
  // menüyü saniyelerce bekletiyordu (madde 10).
  // 2000 dosya, bir virüs koruması filtresi arkasında yarım saniyenin altında
  // kalıyor; 8000'i denemek menüyü iki saniye bekletti.
  const budget = { files: 2000 };
  for (const entry of map.entries) {
    if (!existsSafe(entry.path)) continue;
    const key = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (claimedPaths.has(key)) continue;
    claimedPaths.add(key);
    const size = directorySize(entry.path, budget);
    buckets.get(entry.category).paths.push({
      path: entry.path,
      reason: entry.reason,
      locked: Boolean(entry.lock),
      lockReason: entry.lock || null,
      bytes: size.bytes,
      bytesComplete: size.complete,
    });
  }
  for (const action of map.actions || []) {
    // Var olmayan bir klasörü "boşalırsa sil" diye listelemek gürültüdür.
    if (action.kind === "prune-empty" && !existsSafe(action.target)) continue;
    buckets.get(action.category).actions.push({
      kind: action.kind,
      target: action.target || null,
      label: action.label,
      reason: action.reason || null,
      locked: Boolean(action.lock),
      lockReason: action.lock || null,
    });
  }

  const categories = [];
  for (const definition of CATEGORIES) {
    const bucket = buckets.get(definition.id);
    if (!bucket.paths.length && !bucket.actions.length) continue;
    const free = [...bucket.paths, ...bucket.actions].filter((item) => !item.locked);
    const locked = free.length === 0;
    categories.push({
      ...definition,
      paths: bucket.paths,
      actions: bucket.actions,
      locked,
      lockReason: locked ? (bucket.paths.find((item) => item.lockReason)?.lockReason
        || bucket.actions.find((item) => item.lockReason)?.lockReason || null) : null,
      // Kilitli olmayan her kategori varsayılan olarak seçilidir: "kökten
      // kaldır" düğmesinin adı buna söz veriyor. Kullanıcı tıklayıp saydamlaştırarak
      // vazgeçer.
      selectedByDefault: !locked,
      bytes: bucket.paths.reduce((sum, item) => sum + (item.locked ? 0 : item.bytes), 0),
      // Ölçüm bütçesi dolduysa gösterilen boyut alt sınırdır; ekran bunu "≈" ile
      // söyler, kesin bir sayı gibi sunmaz.
      bytesApproximate: bucket.paths.some((item) => !item.locked && item.bytesComplete === false),
    });
  }

  return {
    productId,
    productName: map.name,
    categories,
    protected: (map.protected || []).filter((item) => existsSafe(item.path)),
    external: map.external || null,
  };
}

function removePath(target) {
  try {
    if (!existsSafe(target)) return { path: target, removed: false, reason: "not-found" };
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    return { path: target, removed: !existsSafe(target) };
  } catch (error) {
    return { path: target, removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

// Yalnızca gerçekten boşsa siler. "Seçmediğim kategori duruyor ama üst klasör
// gitti" durumunu imkânsız kılan şey bu kontrol.
function pruneEmptyDirectory(target) {
  try {
    if (!existsSafe(target)) return { path: target, removed: false, reason: "not-found" };
    if (fs.readdirSync(target).length) return { path: target, removed: false, reason: "not-empty" };
    fs.rmdirSync(target);
    return { path: target, removed: true };
  } catch (error) {
    return { path: target, removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

async function wingetUninstall(packageId) {
  if (process.platform !== "win32") return { removed: false, reason: "not-windows" };
  try {
    await execFileAsync("winget", ["uninstall", "--id", String(packageId), "--silent", "--disable-interactivity"], {
      timeout: 120000, windowsHide: true, maxBuffer: 256 * 1024,
    });
    return { removed: true };
  } catch (error) {
    const message = String(error?.message || error);
    if (/No installed package found|No package found/i.test(message)) return { removed: false, reason: "not-installed" };
    return { removed: false, error: message.slice(0, 300) };
  }
}

// npm ve PATH işlemleri ürüne özgü değil, işletim sistemine özgüdür; bu yüzden
// enjekte edilmez, burada tek kez yazılır. Ürüne özgü olan (MSIX kaldırma,
// kayıt defteri) hâlâ dışarıdan gelir.
async function npmUninstallGlobal(packageName) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(npm, ["uninstall", "-g", packageName], {
      timeout: 60000, windowsHide: true, maxBuffer: 256 * 1024,
    });
    return { removed: true };
  } catch (error) {
    const message = String(error?.message || error);
    // Kurulu olmayan bir paketi kaldırmaya çalışmak hata değildir.
    if (/not installed|not found|ENOENT/i.test(message)) return { removed: false, reason: "not-installed" };
    return { removed: false, error: message.slice(0, 300) };
  }
}

async function removeUserPathEntry(directory) {
  if (process.platform !== "win32") return { removed: false, reason: "not-windows" };
  const normalise = (value) => String(value).replace(/[\\/]+$/, "").toLowerCase();
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')",
    ], { timeout: 15000, windowsHide: true, maxBuffer: 256 * 1024 });
    const parts = String(stdout || "").trim().split(";").filter(Boolean);
    const next = parts.filter((part) => normalise(part) !== normalise(directory));
    if (next.length === parts.length) return { removed: false, reason: "not-found" };
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-Command",
      `[Environment]::SetEnvironmentVariable('Path','${next.join(";").replace(/'/g, "''")}','User')`,
    ], { timeout: 15000, windowsHide: true });
    return { removed: true };
  } catch (error) {
    return { removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

// Yürütme. Seçilen kategorilerin kilitli olmayan her yolu ve her eylemi bir
// ADIM'dır; ilerleme adım sayısından hesaplanır, böylece ekrandaki yüzde
// tahmin değil ölçüm olur.
async function executeRemoval(productId, {
  selection = null,
  context = {},
  removeApplication = null,
  removeResidue = null,
  npmUninstall = npmUninstallGlobal,
  removePathEntry = removeUserPathEntry,
  onProgress = null,
  log = null,
} = {}) {
  const plan = planRemoval(productId, context);
  const chosen = new Set(Array.isArray(selection) && selection.length
    ? selection.filter((id) => CATEGORY_IDS.includes(id))
    : plan.categories.filter((item) => item.selectedByDefault).map((item) => item.id));

  // KORUNACAKLAR: kullanıcının seçmediği ya da kilitli olan her yol. Bir adımın
  // hedefi bunlardan birinin ÜST KLASÖRÜ ise o adım çalıştırılmaz.
  //
  // Bu yapısal bir güvence: bugün haritalarda böyle bir iç içe geçme yok, ama
  // "seçmediğiniz kategori silinmez" sözünü bir harita değişikliğinin sessizce
  // bozmasına izin vermemek gerekir. Kullanıcı verisi söz konusu olduğunda söz,
  // koda dayanmalı - dikkate değil.
  const preserved = [];
  for (const category of plan.categories) {
    const keep = category.locked || !chosen.has(category.id);
    for (const item of category.paths) {
      if (keep || item.locked) preserved.push(item.path);
    }
  }
  for (const item of plan.protected || []) preserved.push(item.path);

  const withSeparator = (value) => (String(value).endsWith(path.sep) ? String(value) : `${value}${path.sep}`);
  const isAncestorOfPreserved = (target) => {
    const prefix = withSeparator(target).toLowerCase();
    return preserved.some((kept) => String(kept).toLowerCase().startsWith(prefix));
  };

  const steps = [];
  const blocked = [];
  for (const category of plan.categories) {
    if (category.locked || !chosen.has(category.id)) continue;
    for (const item of category.paths) {
      if (item.locked) continue;
      if (isAncestorOfPreserved(item.path)) {
        blocked.push({ category: category.id, path: item.path, reason: "contains-preserved" });
        continue;
      }
      steps.push({ category: category.id, kind: "path", target: item.path, label: item.path });
    }
    for (const action of category.actions) {
      if (action.locked) continue;
      steps.push({ category: category.id, kind: action.kind, target: action.target, label: action.label });
    }
  }
  // "Boşalırsa sil" adımları en sonda ve EN DERİNDEN başlayarak çalışır: iç
  // klasör boşalmadan üst klasör boşalmış olamaz.
  const depth = (value) => String(value || "").split(/[\\/]/).length;
  steps.sort((a, b) => {
    const pruneA = a.kind === "prune-empty";
    const pruneB = b.kind === "prune-empty";
    if (pruneA !== pruneB) return Number(pruneA) - Number(pruneB);
    return pruneA ? depth(b.target) - depth(a.target) : 0;
  });
  if (blocked.length) {
    log?.warning(productId, "Bazı yollar korunan içerik barındırdığı için silinmedi", {
      count: blocked.length,
      paths: blocked.map((item) => item.path).slice(0, 5),
    });
  }

  const report = (index, message) => {
    if (!onProgress) return;
    const total = steps.length || 1;
    onProgress({
      phase: "removing",
      percent: Math.round((index / total) * 100),
      message,
      done: index >= total,
    });
  };

  const results = [];
  let index = 0;
  report(0, `${plan.productName} kaldırılıyor...`);
  for (const step of steps) {
    index += 1;
    report(index - 1, step.label ? `Kaldırılıyor: ${step.label}` : `${plan.productName} kaldırılıyor...`);
    try {
      if (step.kind === "path") {
        results.push({ ...step, ...removePath(step.target) });
      } else if (step.kind === "prune-empty") {
        results.push({ ...step, ...pruneEmptyDirectory(step.target) });
      } else if (step.kind === "uninstall-application") {
        const outcome = removeApplication ? await removeApplication() : { removed: false, reason: "not-supported" };
        results.push({ ...step, removed: outcome?.removed !== false, detail: outcome });
      } else if (step.kind === "claude-desktop-residue") {
        const outcome = removeResidue ? await removeResidue() : { removed: false, reason: "not-supported" };
        results.push({ ...step, removed: outcome?.removed !== false, detail: outcome });
      } else if (step.kind === "winget-uninstall") {
        const outcome = await wingetUninstall(step.target);
        results.push({ ...step, removed: outcome?.removed === true, detail: outcome });
      } else if (step.kind === "npm-global") {
        const outcome = npmUninstall ? await npmUninstall(step.target) : { removed: false, reason: "not-supported" };
        results.push({ ...step, removed: outcome?.removed === true, detail: outcome });
      } else if (step.kind === "path-entry") {
        const outcome = removePathEntry ? await removePathEntry(step.target) : { removed: false, reason: "not-supported" };
        results.push({ ...step, removed: outcome?.removed === true, detail: outcome });
      }
    } catch (error) {
      results.push({ ...step, removed: false, error: String(error?.message || error).slice(0, 300) });
    }
  }
  report(steps.length, `${plan.productName} kaldırma tamamlandı.`);

  const failed = results.filter((item) => item.error);
  const stillExists = results
    .filter((item) => item.kind === "path")
    .map((item) => item.target)
    .filter(existsSafe);
  const after = planRemoval(productId, context);

  log?.info(productId, `${plan.productName} kaldırma tamamlandı`, {
    categories: [...chosen],
    steps: steps.length,
    removed: results.filter((item) => item.removed).length,
    failed: failed.length,
    remaining: stillExists.length,
  });

  return {
    ok: failed.length === 0 && stillExists.length === 0,
    productId,
    productName: plan.productName,
    categories: [...chosen],
    steps: steps.length,
    removed: results.filter((item) => item.removed).map((item) => item.label || item.target),
    failed,
    // Korunan içerik barındırdığı için atlanan yollar. Sessizce atlamak
    // "kaldırma tamamlandı" izlenimi verirdi.
    blocked,
    stillExists,
    // Kaldırmadan sonra hâlâ listelenen kategoriler: kullanıcı bunları
    // bilinçli olarak korumuş ya da silinemeyen bir şey var.
    remainingCategories: after.categories.map((item) => item.id),
    externalNote: plan.external,
  };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  CLAUDE_CODE,
  CLAUDE_DESKTOP,
  CODEX_CLI,
  CODEX_DESKTOP,
  planRemoval,
  executeRemoval,
  directorySize,
  npmUninstallGlobal,
  removeUserPathEntry,
  wingetUninstall,
};
