"use strict";

// Yapilandirilmis log. Kabul edilen seviyeler: debug, info, success, warning, error.
// Loglar stderr'e JSON satiri olarak yazilir; CLI sonucu stdout'ta temiz JSON kalir.

const LEVELS = ["debug", "info", "success", "warning", "error"];
const SECRET_PATTERN = /(apikey|api_key|token|secret|password|thumbprint)/i;

function maskValue(value) {
  const text = String(value);
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}***${text.slice(-2)}`;
}

function maskDetail(detail) {
  if (!detail || typeof detail !== "object") return detail;
  const output = Array.isArray(detail) ? [] : {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_PATTERN.test(key) && value != null && typeof value !== "object") {
      output[key] = maskValue(value);
    } else if (value && typeof value === "object") {
      output[key] = maskDetail(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function createLogger({ stream = process.stderr, minLevel = "info", now = () => new Date().toISOString() } = {}) {
  const threshold = Math.max(0, LEVELS.indexOf(minLevel));
  const records = [];

  function emit(level, module, message, detail) {
    const record = { at: now(), level, module, message };
    if (detail !== undefined) record.detail = maskDetail(detail);
    records.push(record);
    if (LEVELS.indexOf(level) >= threshold) stream.write(`${JSON.stringify(record)}\n`);
    return record;
  }

  const logger = { records, LEVELS };
  for (const level of LEVELS) {
    logger[level] = (module, message, detail) => emit(level, module, message, detail);
  }
  return logger;
}

module.exports = { createLogger, LEVELS, maskDetail };
