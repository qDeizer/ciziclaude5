const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const secureStore = require("./secureStore");

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function integrationPaths(userDataPath = app.getPath("userData")) {
  const root = path.join(userDataPath, "integrations", "claude-desktop");
  return Object.freeze({
    root,
    state: path.join(root, "state.json"),
    baseline: path.join(root, "baseline.secure.json"),
  });
}

// An absent record means the integration is off. A record that exists but
// cannot be decrypted or parsed means the opposite is unknown, and answering
// "off" there would strand a configured machine with a switch that refuses to
// undo anything. The baseline reader has always made that distinction; this one
// now makes it too.
function readState() {
  const filePath = integrationPaths().state;
  if (!fs.existsSync(filePath)) return null;
  try { return secureStore.readSecureJson(filePath); }
  catch (cause) {
    throw codedError("CLAUDE_STATE_UNREADABLE", "Claude Desktop's integration record could not be read.", cause);
  }
}
function writeState(value) { secureStore.writeSecureJson(integrationPaths().state, value); }
function readBaseline() {
  const filePath = integrationPaths().baseline;
  if (!fs.existsSync(filePath)) return null;
  try { return secureStore.readSecureJson(filePath); }
  catch (cause) {
    throw codedError("BACKUP_INVALID", "Claude Desktop's original configuration backup is invalid.", cause);
  }
}
function writeBaseline(value) { secureStore.writeSecureJson(integrationPaths().baseline, value); }
function remove() {
  const paths = integrationPaths();
  fs.rmSync(paths.state, { force: true });
  fs.rmSync(paths.baseline, { force: true });
  try {
    if (fs.existsSync(paths.root) && fs.readdirSync(paths.root).length === 0) fs.rmdirSync(paths.root);
  } catch { /* the directory is not empty; the files themselves are gone */ }
}
function hasBaseline() { return fs.existsSync(integrationPaths().baseline); }

module.exports = {
  integrationPaths,
  readState,
  writeState,
  readBaseline,
  writeBaseline,
  remove,
  hasBaseline,
};
