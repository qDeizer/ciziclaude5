// File map for the two local Codex products on this machine.
//
// ChatGPT Desktop (the MSIX package "OpenAI.Codex") and the standalone Codex
// CLI ship the same codex-cli core and therefore read the SAME user-level
// config directory.  Removing one product must never delete files the other
// still needs, so every path is classified as desktop-only, cli-only, or
// shared, and shared paths are only ever offered for removal when the other
// product is absent.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DESKTOP_PACKAGE_NAME = "OpenAI.Codex";
const DESKTOP_FAMILY_NAME = "OpenAI.Codex_2p2nqsd0c76g0";
// Verified against `winget list` on Windows: this Store id resolves to the
// "ChatGPT" app whose version matches the installed OpenAI.Codex package.
const DESKTOP_STORE_ID = "9PLM9XGG6VKS";
const DESKTOP_APP_ACTIVATION = `${DESKTOP_FAMILY_NAME}!App`;
const DESKTOP_STORE_URL = "https://apps.microsoft.com/detail/9plm9xgg6vks";

function home() {
  return os.homedir();
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local");
}

// Codex honours CODEX_HOME; both products resolve the same directory, so the
// override has to be respected or the app would edit a config nobody reads.
function codexHome() {
  const override = String(process.env.CODEX_HOME || "").trim();
  return override ? path.resolve(override) : path.join(home(), ".codex");
}

function sharedPaths() {
  const root = codexHome();
  return {
    root,
    configFile: path.join(root, "config.toml"),
    authFile: path.join(root, "auth.json"),
    modelCatalogFile: path.join(root, "cizicode-models.json"),
  };
}

function desktopPaths() {
  const local = localAppData();
  return {
    packageName: DESKTOP_PACKAGE_NAME,
    familyName: DESKTOP_FAMILY_NAME,
    storeId: DESKTOP_STORE_ID,
    activation: DESKTOP_APP_ACTIVATION,
    storeUrl: DESKTOP_STORE_URL,
    // AppX per-user state (LocalCache, LocalState, RoamingState, Settings...).
    packageStateDir: path.join(local, "Packages", DESKTOP_FAMILY_NAME),
    // Desktop-created runtime area: its embedded codex.exe, the computer-use
    // node runtime, and the Chrome native-host manifest.
    runtimeDir: path.join(local, "OpenAI", "Codex"),
  };
}

function cliPaths() {
  const programDir = path.join(localAppData(), "Programs", "OpenAI", "Codex");
  const root = codexHome();
  return {
    programDir,
    binDir: path.join(programDir, "bin"),
    programBin: path.join(programDir, "bin", "codex.exe"),
    standaloneDir: path.join(root, "packages", "standalone"),
    // Pre-1.1 Cizi Code wrote a separate CLI profile instead of the shared
    // config; it is cleaned up so the two never disagree.
    legacyProfile: path.join(root, "cizicode.config.toml"),
  };
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function entry(pathName, reason) {
  return { path: pathName, reason, exists: exists(pathName) };
}

// Which paths a removal may touch, given whether the OTHER product stays.
// `sharedRemovable` is the single rule the UI and the CLI both surface: shared
// Codex data is only cleared when nothing else on this machine uses it.
function planRemoval({ target, otherInstalled }) {
  const desktop = desktopPaths();
  const cli = cliPaths();
  const shared = sharedPaths();
  const keepShared = otherInstalled !== false;

  const remove = [];
  const preserve = [];

  if (target === "desktop") {
    remove.push(entry(desktop.packageStateDir, "ChatGPT Desktop uygulama verisi"));
    remove.push(entry(desktop.runtimeDir, "ChatGPT Desktop yerel çalışma dosyaları"));
    if (keepShared) {
      preserve.push(entry(cli.programDir, "Codex CLI kurulumu bu bilgisayarda duruyor"));
      preserve.push(entry(cli.standaloneDir, "Codex CLI paket dosyaları"));
      preserve.push(entry(shared.root, "Codex CLI hâlâ bu klasörü kullanıyor"));
    } else {
      remove.push(entry(shared.root, "Başka Codex ürünü kalmadı"));
    }
  } else if (target === "cli") {
    remove.push(entry(cli.programDir, "Codex CLI kurulumu"));
    remove.push(entry(cli.standaloneDir, "Codex CLI paket dosyaları"));
    remove.push(entry(cli.legacyProfile, "Eski Cizi Code CLI profili"));
    if (keepShared) {
      preserve.push(entry(desktop.packageStateDir, "ChatGPT Desktop bu bilgisayarda duruyor"));
      preserve.push(entry(desktop.runtimeDir, "ChatGPT Desktop yerel çalışma dosyaları"));
      preserve.push(entry(shared.root, "ChatGPT Desktop hâlâ bu klasörü kullanıyor"));
    } else {
      remove.push(entry(shared.root, "Başka Codex ürünü kalmadı"));
    }
  } else {
    throw new Error(`Unknown removal target '${target}'.`);
  }

  return {
    target,
    otherInstalled: keepShared,
    sharedRemovable: !keepShared,
    sharedRoot: shared.root,
    remove: remove.filter((item) => item.exists),
    plannedButMissing: remove.filter((item) => !item.exists).map((item) => item.path),
    preserve: preserve.filter((item) => item.exists),
  };
}

module.exports = {
  DESKTOP_PACKAGE_NAME,
  DESKTOP_FAMILY_NAME,
  DESKTOP_STORE_ID,
  DESKTOP_APP_ACTIVATION,
  DESKTOP_STORE_URL,
  home,
  localAppData,
  codexHome,
  sharedPaths,
  desktopPaths,
  cliPaths,
  planRemoval,
  exists,
};
