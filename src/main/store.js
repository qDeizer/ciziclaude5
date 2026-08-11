// Session persistence for the Cizi Code desktop app.
// The API key is encrypted at rest using Electron safeStorage when available.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./fsAtomic");

function sessionFile() {
  return path.join(app.getPath("userData"), "session.json");
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), "utf-8"));
  } catch {
    return null;
  }
}

function getSafeStorage() {
  try {
    const { safeStorage } = require("electron");
    if (safeStorage && typeof safeStorage.encryptString === "function") return safeStorage;
  } catch {
    // Electron safeStorage is only available after app readiness.
  }
  return null;
}

function encrypt(text) {
  try {
    const s = getSafeStorage();
    if (s && s.isEncryptionAvailable()) {
      return { enc: true, v: s.encryptString(text).toString("base64") };
    }
  } catch {
    // Fall through to base64 storage if safeStorage is unavailable.
  }
  return { enc: false, v: Buffer.from(text, "utf-8").toString("base64") };
}

function decrypt(obj) {
  if (!obj) return null;
  try {
    const buf = Buffer.from(obj.v, "base64");
    if (obj.enc) {
      const s = getSafeStorage();
      if (s) return s.decryptString(buf);
    }
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

function saveSession({ apiKey }) {
  const data = { apiKey: apiKey ? encrypt(apiKey) : null, savedAt: new Date().toISOString() };
  writeJsonAtomic(sessionFile(), data);
}

function loadSession() {
  const raw = readRaw();
  if (!raw) return null;
  const apiKey = raw.apiKey ? decrypt(raw.apiKey) : null;
  if (!apiKey) return null;
  return { apiKey };
}

function clearSession() {
  try {
    fs.rmSync(sessionFile(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

module.exports = { saveSession, loadSession, clearSession };
