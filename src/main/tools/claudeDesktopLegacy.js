const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const secureStore = require("./secureStore");

const LEGACY_SHORTCUT_NAME = "Claude - Cizi Code.lnk";

function legacyDataRoot() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "CiziCodeData",
    "ClaudeDesktop",
  );
}

function legacyPaths({ dataRoot = legacyDataRoot(), desktop = app.getPath("desktop") } = {}) {
  return Object.freeze({
    dataRoot: path.resolve(dataRoot),
    versions: path.resolve(dataRoot, "versions"),
    current: path.resolve(dataRoot, "current.json"),
    shortcut: path.resolve(desktop, LEGACY_SHORTCUT_NAME),
  });
}

function samePath(left, right) {
  return !!left && !!right && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function assertOwnedPaths(paths) {
  if (path.dirname(paths.versions).toLowerCase() !== paths.dataRoot.toLowerCase()
      || path.dirname(paths.current).toLowerCase() !== paths.dataRoot.toLowerCase()
      || path.basename(paths.versions).toLowerCase() !== "versions"
      || path.basename(paths.current).toLowerCase() !== "current.json"
      || path.basename(paths.shortcut).toLowerCase() !== LEGACY_SHORTCUT_NAME.toLowerCase()) {
    const error = new Error("Legacy Claude Desktop cleanup paths failed their ownership check.");
    error.code = "CLAUDE_LEGACY_PATH_INVALID";
    throw error;
  }
}

function restoreLegacyShortcut(shortcutPath, baselineShortcut) {
  if (baselineShortcut?.path && !samePath(baselineShortcut.path, shortcutPath)) {
    const error = new Error("The legacy Claude shortcut backup points to an unexpected path.");
    error.code = "CLAUDE_LEGACY_SHORTCUT_INVALID";
    throw error;
  }
  if (baselineShortcut?.existed) {
    if (typeof baselineShortcut.content !== "string") {
      const error = new Error("The legacy Claude shortcut backup is incomplete.");
      error.code = "CLAUDE_LEGACY_SHORTCUT_BACKUP_INVALID";
      throw error;
    }
    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    secureStore.atomicWrite(shortcutPath, Buffer.from(baselineShortcut.content, "base64"));
    return "restored";
  }
  fs.rmSync(shortcutPath, { force: true });
  return "removed";
}

function cleanupLegacy({ baseline, paths = legacyPaths() } = {}) {
  assertOwnedPaths(paths);
  const result = {
    versionsRemoved: fs.existsSync(paths.versions),
    pointerRemoved: fs.existsSync(paths.current),
    shortcut: fs.existsSync(paths.shortcut) || baseline?.shortcut ? "pending" : "absent",
  };
  // The old copy and pointer are exclusively Cizi-owned. The normal Anthropic
  // AppX package lives under WindowsApps and can never resolve under this root.
  fs.rmSync(paths.versions, { recursive: true, force: true });
  fs.rmSync(paths.current, { force: true });
  if (fs.existsSync(paths.shortcut) || baseline?.shortcut) {
    result.shortcut = restoreLegacyShortcut(paths.shortcut, baseline?.shortcut);
  }
  return result;
}

module.exports = {
  LEGACY_SHORTCUT_NAME,
  legacyDataRoot,
  legacyPaths,
  assertOwnedPaths,
  restoreLegacyShortcut,
  cleanupLegacy,
};
