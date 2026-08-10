"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw codedError("JSON_PARSE_FAILED", `JSON okunamadi: ${filePath}`, cause);
  }
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

// Ayni dizine gecici dosya yazip rename eder; yarim yazilmis dosya birakmaz.
function writeFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, data);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
}

function writeJsonAtomic(filePath, value) {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function listFiles(dirPath, extension) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (!extension || entry.name.endsWith(extension)))
    .map((entry) => path.join(dirPath, entry.name));
}

module.exports = {
  codedError,
  sha256Buffer,
  sha256File,
  readJson,
  readJsonIfExists,
  ensureDir,
  writeFileAtomic,
  writeJsonAtomic,
  listFiles,
};
