// Claude Desktop kisayollarini Cizi Code baslaticisina yonlendirir.
//
// NE ISE YARAR
// Kullanici Claude'u bizim uzerimizden acmadiginda da, acilmadan hemen once
// markalamanin yerinde olup olmadigi kontrol edilebilsin. Zamanlanmis onarim
// gorevi ile birlikte iki bagimsiz koruyucu olusturur.
//
// KAPSAM - ve neden bu kadar
// Yalnizca KULLANICININ yazabildigi .lnk dosyalari yonlendirilir: masaustu ve
// kullanici Baslat menusu. Kapsam disinda kalanlar ve sebepleri:
//   - MSIX Baslat girisi: .lnk DEGIL, paket manifestinden uretilen AUMID kaydi.
//     Dosya olmadigi icin yeniden yonlendirilemez.
//   - Gorev cubugu sabitlemeleri: Windows bunlari AUMID'e bagli olarak ayrica
//     onbellekler; uzerine yazmak kirilgan ve geri alinmasi guvenilmez.
// Bu yuzden yonlendirme bir GARANTI degil, ek bir koruyucudur. Guncelleme
// sonrasi asil guvence zamanlanmis gorevdir.
//
// GERI ALINABILIRLIK
// Kisayol yeniden URETILMEZ; orijinal .lnk'in BAYTLARI yedeklenir ve switch
// kapatilirken aynen geri konur. Boylece kullanicinin ikonu, calisma dizini ve
// diger ozellikleri tahmin edilerek yeniden insa edilmis olmaz.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const lifecycle = require("./claudeLifecycle");
const log = require("../logger");
const packageIdentity = require("./claudePackageIdentity");
const { ensureDir, readJsonIfExists, writeJsonAtomic, sha256Buffer } = require("./claudeBranding/fsx");

const LAUNCH_FLAG = "--cizi-claude-launch";
const MANIFEST_NAME = "shortcuts.json";
const SCHEMA_VERSION = 1;

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function backupRoot(workRoot) {
  return path.join(workRoot, "shortcuts");
}

function manifestPath(workRoot) {
  return path.join(backupRoot(workRoot), MANIFEST_NAME);
}

// Aranacak dizinler: yalnizca kullanicinin kendi alani. Program Files veya
// ProgramData altindaki ortak kisayollara dokunulmaz - onlar makine genelindedir
// ve baska kullanicilari da etkiler.
function searchDirectories() {
  const home = app.getPath("home");
  const appData = app.getPath("appData");
  return [
    app.getPath("desktop"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(home, "Desktop"),
  ].filter((directory, index, all) => directory && all.indexOf(directory) === index);
}

function listShortcutFiles(directory) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return results; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...listShortcutFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".lnk")) results.push(full);
  }
  return results;
}

// Bir .lnk'in Claude'a mi isaret ettigini ICERIGINDEN anlar.
//
// Neden dosya adina bakilmiyor: kullanici kisayolu istedigi gibi adlandirabilir.
// Neden COM/TargetPath'e bakilmiyor: MSIX kisayollari bir uygulama kimligine
// (AUMID) isaret eder ve kabuk ogesi olarak saklanir; TargetPath BOS doner.
// Bu yuzden ham baytlarda hem UTF-16LE hem ASCII olarak imza aranir.
function shortcutMentions(buffer, needles) {
  for (const needle of needles) {
    if (buffer.includes(Buffer.from(needle, "utf16le"))) return needle;
    if (buffer.includes(Buffer.from(needle, "latin1"))) return needle;
  }
  return null;
}

function classify(buffer, ciziExecutable) {
  if (shortcutMentions(buffer, [LAUNCH_FLAG])) return "cizi-launcher";
  const claudeMarkers = [
    packageIdentity.CLAUDE_MAIN_APP_ID,
    packageIdentity.CLAUDE_MAIN_PACKAGE_FAMILY,
  ];
  if (shortcutMentions(buffer, claudeMarkers)) return "claude-aumid";
  // Squirrel kurulumu: kisayol dogrudan claude.exe'yi gosterir.
  if (shortcutMentions(buffer, ["\\AnthropicClaude\\", "claude.exe"])) {
    // Cizi Code'un kendi kisayolu yanlislikla yakalanmasin.
    if (ciziExecutable && shortcutMentions(buffer, [ciziExecutable])) return "other";
    return "claude-exe";
  }
  return "other";
}

function scan({ ciziExecutable = process.execPath } = {}) {
  const found = [];
  for (const directory of searchDirectories()) {
    for (const filePath of listShortcutFiles(directory)) {
      let buffer;
      try { buffer = fs.readFileSync(filePath); } catch { continue; }
      const kind = classify(buffer, ciziExecutable);
      if (kind === "other") continue;
      found.push({ path: filePath, kind, sha256: sha256Buffer(buffer), bytes: buffer.length });
    }
  }
  return found;
}

function readManifest(workRoot) {
  const value = readJsonIfExists(manifestPath(workRoot), null);
  if (!value || Number(value.schemaVersion) !== SCHEMA_VERSION || !Array.isArray(value.entries)) {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }
  return value;
}

// Baslatici kisayolunu uretir. Ikon orijinalden devralinamaz (yeni bir dosya
// yaziyoruz), bu yuzden Claude'un kendi ikonu varsa o kullanilir; yoksa ikon
// belirtilmez ve Windows Cizi Code'un ikonunu gosterir.
function createLauncherShortcutScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$target=[string]$env:CIZI_SHORTCUT_PATH",
    "$exe=[string]$env:CIZI_SHORTCUT_EXE",
    "$flag=[string]$env:CIZI_SHORTCUT_FLAG",
    "$icon=[string]$env:CIZI_SHORTCUT_ICON",
    "$name=[string]$env:CIZI_SHORTCUT_NAME",
    "$shell=New-Object -ComObject WScript.Shell",
    "$link=$shell.CreateShortcut($target)",
    "$link.TargetPath=$exe",
    "$link.Arguments=$flag",
    "$link.WorkingDirectory=[IO.Path]::GetDirectoryName($exe)",
    "$link.Description=$name",
    "if($icon){$link.IconLocation=$icon}",
    "$link.Save()",
    "if(!(Test-Path -LiteralPath $target -PathType Leaf)){throw 'CIZI_SHORTCUT_WRITE_FAILED'}",
    "'ok'",
  ].join("\n");
}

function claudeIconLocation(main) {
  if (!main?.installLocation) return "";
  const candidates = main.installKind === "squirrel"
    ? [main.executable, path.join(main.installLocation, "claude.exe")]
    : [path.join(main.installLocation, "claude.exe"), path.join(main.installLocation, "app", "claude.exe")];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return `${candidate},0`;
  }
  return "";
}

async function redirect(main, {
  workRoot,
  ciziExecutable = process.execPath,
  runPowerShellFn = lifecycle.runPowerShell,
} = {}) {
  if (!workRoot) throw codedError("CLAUDE_SHORTCUT_WORKROOT_MISSING", "Kisayol yedegi icin calisma dizini gerekiyor.");
  const targets = scan({ ciziExecutable }).filter((entry) => entry.kind !== "cizi-launcher");
  if (!targets.length) {
    log.info("claude-shortcuts", "Yonlendirilecek Claude kisayolu bulunamadi", {
      searched: searchDirectories().length,
      note: "MSIX Baslat girisi bir .lnk dosyasi degildir; yonlendirilemez.",
    });
    return { redirected: 0, entries: [] };
  }

  const root = backupRoot(workRoot);
  ensureDir(root);
  const manifest = readManifest(workRoot);
  const entries = [...manifest.entries];
  const icon = claudeIconLocation(main);
  let redirected = 0;

  for (const target of targets) {
    // Ayni kisayol daha once yedeklendiyse yedek EZILMEZ: ikinci kez yedeklemek
    // bizim kendi kisayolumuzu "orijinal" olarak kaydeder ve kullanicinin gercek
    // kisayolunu kalici olarak kaybettirir.
    const already = entries.find((entry) => entry.path.toLowerCase() === target.path.toLowerCase());
    if (!already) {
      const backupPath = path.join(root, `${sha256Buffer(Buffer.from(target.path.toLowerCase(), "utf8")).slice(0, 16)}.lnk`);
      fs.copyFileSync(target.path, backupPath);
      entries.push({
        path: target.path,
        backupPath,
        originalSha256: target.sha256,
        kind: target.kind,
        at: new Date().toISOString(),
      });
    }
    try {
      await runPowerShellFn(createLauncherShortcutScript(), {
        env: {
          CIZI_SHORTCUT_PATH: target.path,
          CIZI_SHORTCUT_EXE: path.resolve(ciziExecutable),
          CIZI_SHORTCUT_FLAG: LAUNCH_FLAG,
          CIZI_SHORTCUT_ICON: icon,
          CIZI_SHORTCUT_NAME: "Claude",
        },
        timeout: 30000,
        maxBuffer: 64 * 1024,
      });
      redirected += 1;
    } catch (cause) {
      log.warning("claude-shortcuts", "Kisayol yonlendirilemedi; orijinali yerinde birakildi", {
        shortcut: path.basename(target.path),
        error: String(cause?.message || cause),
      });
    }
  }

  writeJsonAtomic(manifestPath(workRoot), { schemaVersion: SCHEMA_VERSION, entries });
  log.success("claude-shortcuts", "Claude kisayollari Cizi Code baslaticisina yonlendirildi", {
    redirected,
    backedUp: entries.length,
  });
  return { redirected, entries };
}

// Switch kapatilirken orijinal .lnk baytlari aynen geri konur. Yedek dosyasi
// kayipsa bizim kisayolumuz SILINIR: yanlis bir kisayol birakmak, hic kisayol
// birakmamaktan daha kotudur.
function restore({ workRoot } = {}) {
  if (!workRoot) return { restored: 0, removed: 0 };
  const manifest = readManifest(workRoot);
  if (!manifest.entries.length) return { restored: 0, removed: 0 };

  let restored = 0;
  let removed = 0;
  const failed = [];
  for (const entry of manifest.entries) {
    try {
      if (fs.existsSync(entry.backupPath)) {
        fs.copyFileSync(entry.backupPath, entry.path);
        const liveSha = sha256Buffer(fs.readFileSync(entry.path));
        if (liveSha !== entry.originalSha256) throw new Error("geri yuklenen kisayol hash uyusmadi");
        restored += 1;
      } else if (fs.existsSync(entry.path)) {
        const current = fs.readFileSync(entry.path);
        if (classify(current, null) === "cizi-launcher") { fs.rmSync(entry.path, { force: true }); removed += 1; }
      }
    } catch (cause) {
      failed.push({ shortcut: path.basename(entry.path), error: String(cause?.message || cause) });
    }
  }

  if (failed.length) {
    log.error("claude-shortcuts", "Bazi kisayollar geri yuklenemedi", { restored, removed, failed });
  } else {
    log.success("claude-shortcuts", "Claude kisayollari orijinal haline dondu", { restored, removed });
    fs.rmSync(manifestPath(workRoot), { force: true });
    fs.rmSync(backupRoot(workRoot), { recursive: true, force: true });
  }
  return { restored, removed, failed };
}

// Durum: yonlendirme hala yerinde mi? Karar dosya iceriginden verilir.
function getStatus({ workRoot, ciziExecutable = process.execPath } = {}) {
  const manifest = workRoot ? readManifest(workRoot) : { entries: [] };
  const current = scan({ ciziExecutable });
  return {
    managed: manifest.entries.length,
    redirected: current.filter((entry) => entry.kind === "cizi-launcher").length,
    unredirected: current.filter((entry) => entry.kind !== "cizi-launcher").length,
  };
}

module.exports = {
  LAUNCH_FLAG,
  scan,
  redirect,
  restore,
  getStatus,
  searchDirectories,
  classify,
  backupRoot,
  manifestPath,
};
