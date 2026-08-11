// Exact config backup/restore for every file touched by a tool integration.
// The first apply captures the pre-Cizi state. Reverting restores that state
// exactly, or deletes files that did not exist before.
//
// The snapshot is the only copy of what the user's files looked like before Cizi
// Code touched them, so it is written atomically and it is never deleted as a
// side effect of restoring: `restoreSnapshot` puts the bytes back and leaves the
// snapshot in place, and the caller drops it only once it has verified the tool
// really is disconnected. A restore that fails halfway can therefore be retried.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic, writeFileAtomic } = require("../fsAtomic");

let log;
try {
  log = require("../logger");
} catch {
  log = { info() {}, warning() {}, warn() {} };
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

// Yedek BAYT olarak tutulur, metin olarak değil.
//
// NEDEN: dosyayı `readFileSync(fp, "utf-8")` ile okuyup geri yazmak, dosya
// gerçekten UTF-8 değilse baytları değiştirir. Windows'ta bir ayar dosyası
// UTF-16LE ya da ANSI (cp1254) olabilir; böyle bir dosya UTF-8 diye okunduğunda
// çözülemeyen baytlar U+FFFD'ye dönüşür ve geri yükleme kullanıcının dosyasını
// BOZAR. "Birebir yedek" sözü ancak baytla tutulursa doğrudur.
//
// Eski yedekler (`content` metin alanı) okunmaya devam eder; şema alanı
// hangi biçimde yazıldığını söyler.
const SNAPSHOT_ENCODING = "base64";

function takeSnapshot(toolId, filePaths) {
  if (hasSnapshot(toolId)) {
    log.info("backup", `${toolId} için yedek zaten var; orijinali korunuyor`, { toolId });
    return readSnapshot(toolId);
  }
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((fp) => {
    try {
      const bytes = fs.readFileSync(fp);
      return { path: fp, existed: true, encoding: SNAPSHOT_ENCODING, content: bytes.toString("base64"), bytes: bytes.length };
    } catch (error) {
      // Var olan ama okunamayan bir dosyayı "yoktu" diye kaydetmek, geri
      // yüklemede onu SİLMEK anlamına gelir. Bu yüzden okuma hatası ile
      // yokluk ayrılır ve okunamayan dosya için yedek alınmaz.
      if (error?.code !== "ENOENT") {
        throw Object.assign(
          new Error(`Mevcut ayar dosyası okunamadığı için yedek alınamadı: ${fp}`),
          { code: "BACKUP_SOURCE_UNREADABLE", cause: error, userMessage: "Mevcut ayarlarınızın yedeği alınamadı; hiçbir şey değiştirilmedi." },
        );
      }
      return { path: fp, existed: false, encoding: SNAPSHOT_ENCODING, content: null, bytes: 0 };
    }
  });
  const snapshot = { files, takenAt: new Date().toISOString() };
  writeJsonAtomic(snapshotPath(toolId), snapshot);
  log.info("backup", `${toolId} için orijinal ayarların yedeği alındı`, {
    toolId,
    existingFiles: files.filter((f) => f.existed).length,
    totalFiles: files.length,
  });
  return snapshot;
}

// Reads the captured pre-Cizi content without restoring it. Tools that revert
// surgically use this to recover the values they overwrote instead of putting
// a whole stale file back over changes the user's own app has made since.
function readSnapshot(toolId) {
  if (!hasSnapshot(toolId)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(toolId), "utf-8"));
  } catch {
    return null;
  }
}

function dropSnapshot(toolId) {
  if (!hasSnapshot(toolId)) return false;
  fs.rmSync(snapshotPath(toolId), { force: true });
  log.info("backup", `${toolId} yedeği geri yükleme doğrulandıktan sonra kaldırıldı`, { toolId });
  return true;
}

// Yedeklenmiş içeriğin baytları. Eski (metin) yedekler de okunur, böylece bu
// sürüme geçen bir kullanıcının elindeki yedek geçersiz olmaz.
function snapshotBytes(file) {
  if (!file?.existed || file.content == null) return null;
  return file.encoding === SNAPSHOT_ENCODING
    ? Buffer.from(String(file.content), "base64")
    : Buffer.from(String(file.content), "utf8");
}

// Yedeklenmiş içeriğin metni. Yalnızca cerrahi geri alma için: eski değerleri
// okumak gerektiğinde kullanılır, dosyaya yazmak için DEĞİL - yazmak baytla olur.
function snapshotText(file) {
  const bytes = snapshotBytes(file);
  return bytes == null ? null : bytes.toString("utf8");
}

// Puts every captured file back byte for byte. The snapshot survives on purpose:
// only a verified disconnect may remove the user's safety net.
function restoreSnapshot(toolId) {
  const snap = readSnapshot(toolId);
  if (!snap) return { restored: false, reason: hasSnapshot(toolId) ? "snapshot-unreadable" : "no-snapshot", files: [] };
  const failures = [];
  for (const f of snap.files || []) {
    try {
      if (f.existed) writeFileAtomic(f.path, snapshotBytes(f));
      else fs.rmSync(f.path, { force: true });
    } catch (error) {
      failures.push({ path: f.path, code: String(error?.code || "WRITE_FAILED") });
    }
  }
  if (failures.length) {
    log.error("backup", `${toolId} orijinal ayarları tamamen geri yüklenemedi; yedek korundu`, {
      toolId,
      failedFiles: failures.length,
    });
    return { restored: false, reason: "restore-incomplete", failures, files: (snap.files || []).map((f) => f.path) };
  }
  return { restored: true, files: (snap.files || []).map((f) => f.path) };
}

module.exports = {
  hasSnapshot,
  takeSnapshot,
  restoreSnapshot,
  readSnapshot,
  snapshotBytes,
  snapshotText,
  dropSnapshot,
  snapshotPath,
  backupDir,
};
