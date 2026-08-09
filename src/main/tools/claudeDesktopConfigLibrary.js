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

// Removes only what Cizi Code put in the third-party configuration list, and
// leaves every other entry in place. This is what a restore falls back to when
// the baseline predates this surface (older builds captured the policy and the
// credential files but not the configuration library), and what a status read
// uses to clear an entry that no longer has an integration behind it. Deleting
// _meta.json wholesale is never an option: another application's entries live
// in the same file.
function cleanupOwned() {
  const resolved = paths();
  const entryRemoved = fs.existsSync(resolved.entry);
  if (entryRemoved) fs.rmSync(resolved.entry, { force: true });

  let metadataChanged = false;
  if (fs.existsSync(resolved.metadata)) {
    const metadata = readMetadata(resolved.metadata);
    const entries = metadata.entries || [];
    const remaining = entries.filter((entry) => entry?.id !== CONFIGURATION_ID);
    const ownedApplied = metadata.appliedId === CONFIGURATION_ID;
    if (remaining.length !== entries.length || ownedApplied) {
      const next = { ...metadata };
      if (metadata.entries === undefined) delete next.entries;
      else next.entries = remaining;
      if (ownedApplied) delete next.appliedId;
      // A list that held nothing but Cizi's entry is removed entirely, so
      // turning the switch off does not leave behind an empty file Claude
      // never had. Any other key means the list is not ours to delete.
      const emptied = remaining.length === 0
        && Object.keys(next).every((key) => key === "entries");
      if (emptied) fs.rmSync(resolved.metadata, { force: true });
      else secureStore.atomicWrite(resolved.metadata, JSON.stringify(next));
      metadataChanged = true;
    }
  }
  try { fs.rmdirSync(resolved.root); } catch { /* non-empty or already absent */ }
  return { removed: entryRemoved || metadataChanged, entryRemoved, metadataChanged };
}

// True when nothing of Cizi Code's is left in the configuration library.
function ownedAbsent() {
  const resolved = paths();
  if (fs.existsSync(resolved.entry)) return false;
  if (!fs.existsSync(resolved.metadata)) return true;
  let metadata;
  try { metadata = readMetadata(resolved.metadata); } catch { return false; }
  return metadata.appliedId !== CONFIGURATION_ID
    && !(metadata.entries || []).some((entry) => entry?.id === CONFIGURATION_ID);
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
  cleanupOwned,
  ownedAbsent,
};
