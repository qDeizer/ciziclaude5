const { STATE_SCHEMA_VERSION } = require("./claudeDesktopContract");
const policyModule = require("./claudeDesktopPolicy");
const credentialModule = require("./claudeDesktopCredential");

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The integration surface is intentionally narrow: Cizi owns only its Claude
// policy values and its two credential-helper files. The official package,
// Claude profile, conversations and Cowork data never enter this snapshot.
function createSurfaceManager({ policy, helper, configLibrary } = {}) {
  if (!policy || !helper) throw new TypeError("Claude Desktop surface adapters are required.");

  async function capture() {
    const snapshot = {
      schemaVersion: STATE_SCHEMA_VERSION,
      policy: await policy.capture(),
      ownedFiles: helper.capture(),
    };
    if (configLibrary) snapshot.configLibrary = configLibrary.capture();
    return snapshot;
  }

  async function restore(snapshot) {
    if (!snapshot?.policy || !snapshot?.ownedFiles) {
      throw codedError("BACKUP_INVALID", "Claude Desktop's original configuration backup is incomplete.");
    }
    await policy.restore(snapshot);
    if (configLibrary && snapshot.configLibrary) configLibrary.restore(snapshot);
    helper.restore(snapshot);
  }

  async function matches(snapshot) {
    if (!snapshot?.policy || !snapshot?.ownedFiles) return false;
    const currentPolicy = await policy.capture();
    const currentFiles = helper.capture();
    return policyModule.policySnapshotsEqual(snapshot, currentPolicy)
      && credentialModule.ownedFilesEqual(snapshot, currentFiles)
      && (!configLibrary || !snapshot.configLibrary || configLibrary.matches(snapshot));
  }

  async function restoreAndVerify(snapshot) {
    await restore(snapshot);
    if (!await matches(snapshot)) {
      throw codedError(
        "CLAUDE_BASELINE_RESTORE_VERIFY_FAILED",
        "Claude Desktop's original configuration could not be restored exactly.",
      );
    }
  }

  return { capture, restore, matches, restoreAndVerify };
}

module.exports = { createSurfaceManager };
