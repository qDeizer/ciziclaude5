const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const SCHEMA_VERSION = 1;

function statePath(userDataPath = app.getPath("userData")) {
  return path.join(userDataPath, "integrations", "tool-intents.json");
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, tools: {} };
}

function readState(options = {}) {
  const filePath = options.filePath || statePath(options.userDataPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !parsed.tools || Array.isArray(parsed.tools)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

function safeValues(values = {}) {
  const result = {};
  for (const key of ["model", "opus", "sonnet", "haiku", "fable"]) {
    const value = String(values?.[key] || "").trim();
    if (value) result[key] = value;
  }
  const models = Array.isArray(values?.models)
    ? values.models.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (models.length) result.models = [...new Set(models)];
  return result;
}

function writeState(value, options = {}) {
  const filePath = options.filePath || statePath(options.userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  fs.renameSync(temporaryPath, filePath);
  return filePath;
}

function get(toolId, options = {}) {
  const entry = readState(options).tools[String(toolId || "")];
  if (!entry || typeof entry.enabled !== "boolean") return null;
  return {
    enabled: entry.enabled,
    values: safeValues(entry.values),
    updatedAt: entry.updatedAt || null,
    // "The machine was last seen matching this intent." Only ever written after a
    // verified apply or a verified restore, so the periodic check can skip a
    // switch that has nothing to do instead of scanning for it every few minutes.
    settled: entry.settled === true,
  };
}

function set(toolId, enabled, values = null, options = {}) {
  const id = String(toolId || "").trim();
  if (!id) throw new TypeError("A tool id is required for the desired-state record.");
  const state = readState(options);
  const previous = state.tools[id] || {};
  const nextValues = values == null ? safeValues(previous.values) : safeValues(values);
  state.tools[id] = {
    enabled: enabled === true,
    values: nextValues,
    updatedAt: new Date().toISOString(),
    // A new intent is unsettled by definition: what the machine looks like has
    // not been proven against it yet. Anything else would let the check skip work
    // that still has to happen.
    settled: false,
  };
  writeState(state, options);
  return get(id, options);
}

// Recorded only where the outcome was actually verified. Kept separate from
// `set` so it can never be claimed as a side effect of writing an intent.
function markSettled(toolId, options = {}) {
  const id = String(toolId || "").trim();
  const state = readState(options);
  if (!id || !state.tools[id]) return null;
  state.tools[id] = { ...state.tools[id], settled: true };
  writeState(state, options);
  return get(id, options);
}

function remove(toolId, options = {}) {
  const id = String(toolId || "").trim();
  const state = readState(options);
  if (!id || !state.tools[id]) return false;
  delete state.tools[id];
  writeState(state, options);
  return true;
}

module.exports = { SCHEMA_VERSION, statePath, readState, safeValues, get, set, markSettled, remove };
