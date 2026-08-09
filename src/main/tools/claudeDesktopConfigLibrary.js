"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const secureStore = require("./secureStore");

const CONFIGURATION_ID = "72f63843-6d61-4d73-9d31-ff4ca40a6f70";
const CONFIGURATION_NAME = "Cizi Code";

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function paths(localAppData = process.env.LOCALAPPDATA
  || path.join(os.homedir(), "AppData", "Local")) {
  const root = path.join(localAppData, "Claude-3p", "configLibrary");
  return {
    root,
    metadata: path.join(root, "_meta.json"),
    entry: path.join(root, `${CONFIGURATION_ID}.json`),
  };
}

function captureFile(filePath) {
  try {
    return { existed: true, content: fs.readFileSync(filePath).toString("base64") };
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false };
    throw error;
  }
}

function capture() {
  const resolved = paths();
  return {
    configurationId: CONFIGURATION_ID,
    metadata: captureFile(resolved.metadata),
    entry: captureFile(resolved.entry),
  };
}

function restoreFile(filePath, prior) {
  if (prior?.existed) {
    if (typeof prior.content !== "string") {
      throw codedError("BACKUP_INVALID", "Claude config-library backup is incomplete.");
    }
    secureStore.atomicWrite(filePath, Buffer.from(prior.content, "base64"));
  } else {
    fs.rmSync(filePath, { force: true });
  }
}

function restore(snapshot) {
  const prior = snapshot?.configLibrary || snapshot;
  if (!prior?.metadata || !prior?.entry || prior.configurationId !== CONFIGURATION_ID) {
    throw codedError("BACKUP_INVALID", "Claude config-library backup is incomplete.");
  }
  const resolved = paths();
  restoreFile(resolved.entry, prior.entry);
  restoreFile(resolved.metadata, prior.metadata);
  try { fs.rmdirSync(resolved.root); } catch { /* non-empty or already absent */ }
}

function filesEqual(left, right) {
  return !!left?.existed === !!right?.existed
    && (!left?.existed || left.content === right.content);
}

function matches(snapshot) {
  const expected = snapshot?.configLibrary || snapshot;
  if (!expected?.metadata || !expected?.entry || expected.configurationId !== CONFIGURATION_ID) return false;
  const current = capture();
  return filesEqual(expected.metadata, current.metadata)
    && filesEqual(expected.entry, current.entry);
}

function readMetadata(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    if (value.entries !== undefined && !Array.isArray(value.entries)) throw new Error("entries is not an array");
    return value;
  } catch (cause) {
    throw codedError(
      "CLAUDE_CONFIG_LIBRARY_INVALID",
      "Claude's third-party configuration list is invalid; Cizi Code did not overwrite it.",
      cause,
    );
  }
}

function apply(config) {
  const resolved = paths();
  const metadata = readMetadata(resolved.metadata);
  const entries = (metadata.entries || []).filter((entry) => entry?.id !== CONFIGURATION_ID);
  entries.push({ id: CONFIGURATION_ID, name: CONFIGURATION_NAME });
  const nextMetadata = { ...metadata, appliedId: CONFIGURATION_ID, entries };
  secureStore.atomicWrite(resolved.entry, JSON.stringify(config));
  secureStore.atomicWrite(resolved.metadata, JSON.stringify(nextMetadata));
  return { configurationId: CONFIGURATION_ID, name: CONFIGURATION_NAME };
}

function verify(config) {
  const resolved = paths();
  try {
    const metadata = readMetadata(resolved.metadata);
    if (metadata.appliedId !== CONFIGURATION_ID
        || !(metadata.entries || []).some((entry) => entry?.id === CONFIGURATION_ID)) return false;
    const actual = JSON.parse(fs.readFileSync(resolved.entry, "utf8"));
    return JSON.stringify(actual) === JSON.stringify(config);
  } catch {
    return false;
  }
}

module.exports = {
  CONFIGURATION_ID,
  CONFIGURATION_NAME,
  paths,
  capture,
  restore,
  matches,
  apply,
  verify,
};
