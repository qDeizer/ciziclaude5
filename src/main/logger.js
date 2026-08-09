// Cizi Code desktop detailed activity logger.
// Persists timestamped entries to userData/logs/cizicode-desktop.log and keeps an
// in-memory ring buffer for diagnostics.
// NEVER log secrets (API keys, tokens); callers pass only safe metadata.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const MAX_BUFFER = 800;
const buffer = [];
let logFilePath = null;
let listeners = [];

function file() {
  if (!logFilePath) {
    const dir = path.join(app.getPath("userData"), "logs");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    logFilePath = path.join(dir, "cizicode-desktop.log");
  }
  return logFilePath;
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

// Defensive: strip anything that looks like an API key / bearer token from metadata.
function scrub(meta) {
  if (meta == null) return null;
  try {
    let s = safeJson(meta);
    s = s.replace(/sk-cizi-[A-Za-z0-9._-]+/g, "sk-cizi-***");
    s = s.replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-***");
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***");
    return JSON.parse(s);
  } catch { return null; }
}

function scrubMessage(message) {
  return String(message || "")
    .replace(/sk-cizi-[A-Za-z0-9._-]+/g, "sk-cizi-***")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***");
}

function log(level, scope, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level: String(level || "info").toLowerCase(),
    scope: scope || "app",
    message: scrubMessage(message),
    meta: scrub(meta),
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const line = `[${entry.ts}] ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}${entry.meta ? " " + safeJson(entry.meta) : ""}`;
  try { (entry.level === "error" ? console.error : console.log)(line); } catch { /* ignore */ }
  try { fs.appendFileSync(file(), line + "\n"); } catch { /* ignore */ }

  for (const fn of listeners) { try { fn(entry); } catch { /* ignore */ } }
  return entry;
}

module.exports = {
  log,
  info: (scope, msg, meta) => log("info", scope, msg, meta),
  success: (scope, msg, meta) => log("success", scope, msg, meta),
  warning: (scope, msg, meta) => log("warning", scope, msg, meta),
  // Backward-compatible alias for older call sites. New flows use the
  // documented `warning` level so persisted logs have one stable vocabulary.
  warn: (scope, msg, meta) => log("warning", scope, msg, meta),
  error: (scope, msg, meta) => log("error", scope, msg, meta),
  debug: (scope, msg, meta) => log("debug", scope, msg, meta),
  recent: (limit = 300) => buffer.slice(-Math.max(1, Math.min(limit, MAX_BUFFER))),
  clear: () => { buffer.length = 0; try { fs.writeFileSync(file(), ""); } catch { /* ignore */ } },
  filePath: () => file(),
  onEntry: (fn) => { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; },
};
