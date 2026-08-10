// Claude Desktop arayuz markalama katmani - composition root.
//
// NE YAPAR
// Kurulu resmi Claude Desktop paketinin i18n kataloglarindaki ve arayuz etiket
// haritasindaki "Gateway" gecislerini "Ag Gecidi" ile degistirir. Paket
// kimligine, imzasina ve kaydina dokunmaz; yalnizca metin iceren dosyalarin
// icerigini yamalar ve her dosyanin orijinalini yedekler.
//
// NEDEN BOYLE
// Onceki tasarim ayri bir MSIX "modification package" katmani kuruyordu. Bu
// Windows'ta calismiyor: modification package yalnizca ana paketin VFS
// klasorlerini kaplayabilir, Claude'un ana paketinde ise VFS klasoru yok - app\
// dizini paket kokunde. Bu yuzden overlay hicbir surumde arayuze etki etmiyordu.
// Bunun yerine hedefler dosya iceriginden anlamsal olarak bulunur ve cerrahi
// olarak yamalanir.
//
// NEDEN GUNCELLEMEYE DAYANIKLI
// Katalog anahtarlari kaynak metnin icerik kimligidir. Ingilizce metin
// degismediyse anahtar da degismez ve ceviri calismaya devam eder. Degistiyse
// yalnizca o string Ingilizce'ye duser - bozulma kismi ve zararsizdir. Dosya
// adlari her surumde degistigi icin ad/offset asla varsayilmaz; her seferinde
// yeniden taranir.
//
// PARCALAR
//   targetScanner   -> hedefleri icerikten bulur (ad/offset varsaymaz)
//   catalogPatcher  -> katalog metnini cerrahi degistirir, ICU dogrular
//   labelPatcher    -> arayuz etiket haritasini byte bazinda yamalar
//   buildService    -> yamayi userData altinda stage eder (canliya yazmaz)
//   applyService    -> yedekle -> yaz -> dogrula -> izni geri al, hatada rollback
//   reconcileService-> "yama yerinde olsun" durumunu idempotent saglar
//   lock            -> zamanlanmis gorev ile arayuz ayni anda yazamaz

const path = require("path");
const { app } = require("electron");
const logger = require("../logger");
const lifecycle = require("./claudeLifecycle");
const { readJson } = require("./claudeBranding/fsx");
const { createTargetScanner } = require("./claudeBranding/targetScanner");
const { createCatalogPatcher } = require("./claudeBranding/catalogPatcher");
const { createLabelPatcher } = require("./claudeBranding/labelPatcher");
const { createBuildService } = require("./claudeBranding/buildService");
const { createApplyService } = require("./claudeBranding/applyService");
const { createReconcileService } = require("./claudeBranding/reconcileService");
const { createElevation } = require("./claudeBranding/elevation");
const { createLock } = require("./claudeBranding/lock");
const desiredState = require("./claudeBranding/desiredState");

const BRAND_TERM = "Ağ Geçidi";
const DICTIONARY_DIRECTORY = path.join(__dirname, "claudeBranding", "dictionary");

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Motorun kendi log sozlugu ile Cizi Code'un log sozlugu ayni seviyelere sahip;
// tek fark scope'un tek bir isim altinda toplanmasi.
function scopedLogger(scope = "claude-branding") {
  const emit = (level) => (area, message, meta) => logger[level](scope, message, { area, ...(meta || {}) });
  return {
    debug: emit("debug"),
    info: emit("info"),
    success: emit("success"),
    warning: emit("warning"),
    error: emit("error"),
  };
}

// Motor kendi PowerShell adaptorunu bekler; projede tek bir kosucu var, o
// sarilir. Boylece zaman asimi/tampon politikasi tek yerde kalir.
function powershellAdapter(runPowerShellFn = lifecycle.runPowerShell) {
  return {
    run: (script, { timeoutMs = 60000, env = {} } = {}) => runPowerShellFn(script, {
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }),
  };
}

// Yama urunleri kullanicinin userData dizininde tutulur: uygulama guncellenince
// silinmez, yonetici olmayan surec de okuyabilir ve zamanlanmis gorev ayni yolu
// bulur. Gelistirme ortaminda app yoksa proje disina yazmamak icin repo altinda
// kalir.
function defaultWorkRoot() {
  try {
    if (app?.getPath) return path.join(app.getPath("userData"), "claude-branding");
  } catch { /* elektron disi baglam */ }
  return path.join(__dirname, "..", "..", "..", ".cizi-work", "claude-branding");
}

function loadDictionary(directory = DICTIONARY_DIRECTORY) {
  const labelsPath = path.join(directory, "tr-TR.labels.json");
  const catalogPath = path.join(directory, "tr-TR.catalog.json");
  let labels;
  let catalog;
  try {
    labels = readJson(labelsPath);
    catalog = readJson(catalogPath);
  } catch (cause) {
    throw codedError("CLAUDE_BRANDING_DICTIONARY_UNREADABLE", "Cizi Code arayuz sozlugu okunamadi.", cause);
  }
  if (!Array.isArray(labels?.rules) || !labels.rules.length) {
    throw codedError("CLAUDE_BRANDING_DICTIONARY_INVALID", "Arayuz sozlugunde etiket kurali yok.");
  }
  return {
    labels: { rules: labels.rules, tokenRules: labels.tokenRules || [] },
    catalog: { entries: catalog?.entries || {} },
    paths: { labels: labelsPath, catalog: catalogPath },
  };
}

// Motor paket bilgisini kendi sozlugunde bekler; Cizi Code'un kimlik nesnesi
// buna cevrilir. Kimlik dogrulamasi zaten claudePackageIdentity'nin isi.
function toPackageInfo(main) {
  if (!main?.installLocation || !main?.version || !main?.packageFullName) {
    throw codedError("CLAUDE_BRANDING_PACKAGE_INVALID", "Claude Desktop paket bilgisi markalama icin yetersiz.");
  }
  return {
    version: main.version,
    packageFullName: main.packageFullName,
    publisher: main.publisher,
    installLocation: main.installLocation,
    installKind: main.installKind || "msix",
  };
}

function createBrandingEngine({
  runPowerShellFn = lifecycle.runPowerShell,
  workRoot = defaultWorkRoot(),
  dictionaryDirectory = DICTIONARY_DIRECTORY,
  scope = "claude-branding",
  claudeProcess: injectedProcess = null,
} = {}) {
  const engineLogger = scopedLogger(scope);
  const powershell = powershellAdapter(runPowerShellFn);
  const dictionary = loadDictionary(dictionaryDirectory);
  const claudeProcess = injectedProcess
    || require("./claudeBranding/claudeProcess").createClaudeProcess({ powershell, logger: engineLogger });

  const scanner = createTargetScanner({ logger: engineLogger });
  const catalogPatcher = createCatalogPatcher({ logger: engineLogger });
  const labelPatcher = createLabelPatcher({ logger: engineLogger });
  const buildService = createBuildService({
    logger: engineLogger,
    scanner,
    catalogPatcher,
    labelPatcher,
    workRoot,
    dictionaryPaths: dictionary.paths,
    generatedBy: "cizi-code-claude-branding/1",
  });
  const elevation = createElevation({ powershell });
  const lock = createLock({ logger: engineLogger, workRoot, name: "claude-branding" });
  const applyService = createApplyService({
    logger: engineLogger, powershell, elevation, claudeProcess, lock, workRoot,
  });
  const reconcileService = createReconcileService({ logger: engineLogger, buildService, applyService });

  return {
    workRoot,
    dictionary,
    scanner,
    buildService,
    applyService,
    reconcileService,
    elevation,
    claudeProcess,
    lock,
  };
}

let shared = null;
function engine() {
  if (!shared) shared = createBrandingEngine();
  return shared;
}

// --- claudeDesktop.js'in kullandigi sozlesme -------------------------------
//
// Eski overlay adaptoru ile ayni sekil dondurulur; boylece switch'in islem
// mantigi (yedek al, uygula, dogrula, hatada geri al) degismeden kalir.
// Fark: artik ayri bir paket kurulmuyor, dosya icerigi yamalaniyor.

function activeResult(verification, packageInfo, changed) {
  return {
    status: "active",
    installed: true,
    mode: "file-branding",
    changed: !!changed,
    package: {
      packageFullName: packageInfo.packageFullName,
      version: packageInfo.version,
      publisher: packageInfo.publisher,
      installKind: packageInfo.installKind,
    },
    files: verification.files.length,
    message: `Claude arayuzunde ${BRAND_TERM} etiketi etkin (${verification.files.length} dosya, tum diller).`,
  };
}

// Yamanin yerinde olmasini saglar. Idempotent: zaten yamaliysa dosyaya
// dokunmaz, yalnizca dogrular.
async function ensureForMain(main, options = {}) {
  const parts = options.engine || engine();
  const packageInfo = toPackageInfo(main);
  let outcome;
  try {
    outcome = await parts.reconcileService.ensurePatched(packageInfo, parts.dictionary, { confirm: true });
  } catch (error) {
    // Dosyalar zaten markali ama uretim kaydi yok: switch'i bloklamak yerine
    // durumu oldugu gibi bildir. Hash dogrulamasi yapilamadigi acikca soylenir,
    // cunku "dogrulandi" demek yanlis guven verirdi.
    if (error?.code !== "ALREADY_BRANDED_WITHOUT_RECORD") throw error;
    logger.warning("claude-branding", "Claude arayuzu zaten markali; uretim kaydi olmadigi icin hash ile dogrulanamiyor", {
      version: packageInfo.version,
    });
    return {
      status: "active",
      installed: true,
      mode: "file-branding",
      changed: false,
      verification: "content-only",
      package: {
        packageFullName: packageInfo.packageFullName,
        version: packageInfo.version,
        publisher: packageInfo.publisher,
        installKind: packageInfo.installKind,
      },
      files: 0,
      message: `Claude arayuzu ${BRAND_TERM} etiketiyle zaten markali (Cizi Code'un uretim kaydi yok).`,
    };
  }
  if (!outcome.verification?.allPatched) {
    throw codedError("CLAUDE_BRANDING_VERIFY_FAILED", "Claude arayuz markalamasi dogrulanamadi.");
  }
  return activeResult(outcome.verification, packageInfo, outcome.changed);
}

// Switch kapanirken orijinal dosyalari geri koyar. Yedek yoksa bu bir hata
// degildir - geri alinacak bir sey yok demektir.
async function removeForState(state, options = {}) {
  const parts = options.engine || engine();
  const main = state?.mainPackage;
  if (!main?.installLocation || !main?.version) {
    return { removed: false, reason: "NO_PACKAGE_RECORD" };
  }
  const result = await parts.applyService.restore(toPackageInfo(main), { confirm: true });
  return { removed: !!result.restored, reason: result.reason || null, files: result.files || [] };
}

// Durum sorgusu: dosyalar gercekten yamali mi? Karar hash'e gore verilir,
// "kurmustum" kaydina gore degil.
async function inspect(main, options = {}) {
  const parts = options.engine || engine();
  const packageInfo = toPackageInfo(main);
  let build = null;
  try { build = parts.buildService.loadStaged(packageInfo.version); } catch { build = null; }
  if (!build) return { known: false, allPatched: false, files: [] };
  const verification = parts.applyService.verifyLive(packageInfo, build.provenance);
  return { known: true, allPatched: verification.allPatched, files: verification.files };
}

// Onarim gorevi SYSTEM olarak calisir ve switch'in sifreli durum kaydini
// cozemez; niyeti buradan duz metin olarak ogrenir. Sir icermez.
function setDesired(enabled, main = null, options = {}) {
  const parts = options.engine || engine();
  return desiredState.write(parts.workRoot, {
    enabled,
    version: main?.version || null,
  });
}

function readDesired(options = {}) {
  const parts = options.engine || engine();
  return desiredState.read(parts.workRoot);
}

function workRoot(options = {}) {
  return (options.engine || engine()).workRoot;
}

async function removeOwnedOrphanForMain(main, options = {}) {
  const parts = options.engine || engine();
  const packageInfo = toPackageInfo(main);
  const state = await inspect(main, { engine: parts });
  if (!state.known || !state.files.some((file) => file.state === "patched")) {
    return { removed: false, reason: "NOTHING_TO_REMOVE" };
  }
  const result = await parts.applyService.restore(packageInfo, { confirm: true });
  return { removed: !!result.restored, reason: result.reason || null };
}

module.exports = {
  BRAND_TERM,
  createBrandingEngine,
  loadDictionary,
  defaultWorkRoot,
  toPackageInfo,
  ensureForMain,
  removeForState,
  removeOwnedOrphanForMain,
  inspect,
  setDesired,
  readDesired,
  workRoot,
};
