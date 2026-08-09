const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const LOCK_SCHEMA_VERSION = 1;
const MAX_LIVE_LOCK_AGE_MS = 30 * 60 * 1000;
const INVALID_LOCK_GRACE_MS = 60 * 1000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lockPath(toolId = "claude-desktop") {
  const safeId = String(toolId || "").trim();
  if (!/^[a-z0-9-]{3,40}$/.test(safeId)) throw codedError("INTEGRATION_LOCK_ID_INVALID", "The integration lock identifier is invalid.");
  return path.join(app.getPath("userData"), "locks", `${safeId}.lock`);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRecord(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value?.schemaVersion !== LOCK_SCHEMA_VERSION || !Number.isInteger(value.pid)
        || !/^[a-f0-9-]{20,80}$/i.test(String(value.nonce || ""))) return null;
    return value;
  } catch { return null; }
}

function mayRemoveStale(filePath, now = Date.now()) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return true; }
  const age = Math.max(0, now - stat.mtimeMs);
  const record = readRecord(filePath);
  if (!record) return age >= INVALID_LOCK_GRACE_MS;
  if (!processAlive(record.pid)) return true;
  return age >= MAX_LIVE_LOCK_AGE_MS;
}

function acquire(toolId = "claude-desktop", operation = "operation", options = {}) {
  const filePath = options.filePath || lockPath(toolId);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const nonce = crypto.randomUUID();
  const record = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    toolId,
    operation: String(operation || "operation").slice(0, 80),
    pid: process.pid,
    nonce,
    createdAt: new Date(now()).toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = fs.openSync(filePath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0 || !mayRemoveStale(filePath, now())) {
        throw codedError("TOOL_OPERATION_IN_PROGRESS", "Claude Desktop is already being updated by another Cizi Code process.");
      }
      fs.rmSync(filePath, { force: true });
    }
  }
  if (handle == null) throw codedError("TOOL_OPERATION_IN_PROGRESS", "Claude Desktop is already being updated by another Cizi Code process.");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }

  let released = false;
  return () => {
    if (released) return false;
    released = true;
    const current = readRecord(filePath);
    if (current?.nonce !== nonce || current?.pid !== process.pid) return false;
    fs.rmSync(filePath, { force: true });
    return true;
  };
}

module.exports = {
  LOCK_SCHEMA_VERSION,
  MAX_LIVE_LOCK_AGE_MS,
  INVALID_LOCK_GRACE_MS,
  lockPath,
  processAlive,
  readRecord,
  mayRemoveStale,
  acquire,
};
