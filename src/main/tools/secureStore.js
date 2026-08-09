const { safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Windows can briefly hold the destination open while Defender, an indexer, or
// a just-closed reader releases its handle. Retrying the final replacement is
// safe because the complete, fsynced temporary file remains in the same
// directory. We deliberately never delete the destination as a fallback: that
// would turn an atomic replacement into a data-loss window.
const RENAME_ATTEMPTS = 6;
const INITIAL_RENAME_DELAY_MS = 25;
const retryWait = typeof SharedArrayBuffer === "function" && typeof Atomics === "object" && typeof Atomics.wait === "function"
  ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  : null;

function retryableRenameError(error) {
  return ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0 || !retryWait) return;
  try {
    Atomics.wait(retryWait, 0, 0, milliseconds);
  } catch {
    // This module is used by Electron's main process, where Atomics.wait is
    // available. If an embedding disallows it, immediate bounded retries are
    // still safer than a delete-and-replace fallback.
  }
}

function replaceFileAtomically(tempPath, filePath) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableRenameError(error) || attempt === RENAME_ATTEMPTS - 1) throw error;
      sleepSync(INITIAL_RENAME_DELAY_MS * (2 ** attempt));
    }
  }
  throw lastError;
}

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  let committed = false;
  try {
    // "wx" prevents an improbable UUID collision from overwriting a temp file
    // belonging to another concurrent atomic write in this process.
    handle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(handle, data);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    replaceFileAtomically(tempPath, filePath);
    committed = true;
  } finally {
    if (handle !== undefined && handle !== null) {
      try { fs.closeSync(handle); } catch { /* preserve the original write error */ }
    }
    if (!committed) {
      try { fs.unlinkSync(tempPath); } catch { /* no temp file or cleanup delayed by Windows */ }
    }
  }
}

function writeJsonAtomic(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value, null, 2));
}

function writeSecureJson(filePath, value) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error("Windows secure storage is not available.");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
  writeJsonAtomic(filePath, { schemaVersion: 1, encrypted: true, data: encrypted });
}

function readSecureJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!raw?.encrypted || raw.schemaVersion !== 1 || typeof raw.data !== "string") {
    const error = new Error("Encrypted secure state is required.");
    error.code = "INSECURE_STATE_REJECTED";
    throw error;
  }
  const decrypted = safeStorage.decryptString(Buffer.from(raw.data, "base64"));
  return JSON.parse(decrypted);
}

module.exports = { atomicWrite, writeJsonAtomic, writeSecureJson, readSecureJson };
