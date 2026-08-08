// Exact config backup/restore for every file touched by a tool integration.
// The first apply captures the pre-Cizi state. Reverting restores that state
// exactly, or deletes files that did not exist before.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

let log;
try {
  log = require("../logger");
} catch {
  log = { info() {}, warn() {} };
}

function backupDir(toolId) {
  return path.join(app.getPath("userData"), "backups", toolId);
}

function snapshotPath(toolId) {
  return path.join(backupDir(toolId), "snapshot.json");
}

function hasSnapshot(toolId) {
  return fs.existsSync(snapshotPath(toolId));
}

function takeSnapshot(toolId, filePaths) {
  if (hasSnapshot(toolId)) {
    log.info("backup", `Snapshot for ${toolId} already exists; keeping original`);
    return;
  }
  fs.mkdirSync(backupDir(toolId), { recursive: true });
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((fp) => {
    let existed = false;
    let content = null;
    try {
      content = fs.readFileSync(fp, "utf-8");
      existed = true;
    } catch {
      existed = false;
    }
    return { path: fp, existed, content };
  });
  fs.writeFileSync(
    snapshotPath(toolId),
    JSON.stringify({ files, takenAt: new Date().toISOString() }, null, 2)
  );
  log.info("backup", `Snapshot taken for ${toolId} (${files.filter((f) => f.existed).length}/${files.length} files existed)`);
}

function restoreSnapshot(toolId) {
  if (!hasSnapshot(toolId)) return { restored: false, reason: "no-snapshot" };
  const snap = JSON.parse(fs.readFileSync(snapshotPath(toolId), "utf-8"));
  for (const f of snap.files || []) {
    if (f.existed) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.content);
    } else {
      try {
        fs.rmSync(f.path, { force: true });
      } catch {
        // Missing files are already restored to the intended state.
      }
    }
  }
  fs.rmSync(snapshotPath(toolId), { force: true });
  return { restored: true, files: (snap.files || []).map((f) => f.path) };
}

module.exports = { hasSnapshot, takeSnapshot, restoreSnapshot, snapshotPath, backupDir };
