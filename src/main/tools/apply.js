// Per-tool config transaction: back up once, write, verify, and undo exactly.
//
// This module owns one thing - the safe write/undo cycle for a single tool. It
// decides nothing about whether a tool *should* be on or off; that is the
// integration service's job.
const backup = require("./backup");
const log = require("../logger");
const { getTool } = require("./registry");

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  return error;
}

function requireTool(toolId) {
  const tool = getTool(toolId);
  if (!tool) throw codedError("TOOL_UNKNOWN", `Tanınmayan araç: ${toolId}`);
  return tool;
}

// base (optional): the gateway the user is logged into - used to decide whether a
// tool's existing config actually points at THIS Cizi gateway (vs. somewhere else).
function safeApplied(tool, base) {
  try { return tool.isApplied(base); } catch { return false; }
}

function safeMatches(tool, values) {
  try {
    return typeof tool.matches === "function" ? tool.matches(values) : tool.isApplied(values?.base);
  } catch {
    return false;
  }
}

// Writes the tool's configuration and proves it landed. A write that cannot be
// verified is undone immediately: leaving a half-configured file behind while
// reporting success is what made a failed switch look like a working one.
function applyTool(toolId, values) {
  const tool = requireTool(toolId);
  const files = tool.files();
  backup.takeSnapshot(toolId, files);   // capture pre-Cizi state once
  try {
    tool.apply(values);
  } catch (error) {
    undoFailedApply(toolId, tool, values?.base, error?.code || "TOOL_APPLY_FAILED");
    throw error;
  }
  if (!safeMatches(tool, values)) {
    undoFailedApply(toolId, tool, values?.base, "TOOL_APPLY_VERIFY_FAILED");
    throw codedError(
      "TOOL_APPLY_VERIFY_FAILED",
      `${tool.name} ayarları yazıldı ama doğrulanamadı; önceki ayarlarınız geri yüklendi.`,
    );
  }
  log.success("tools", `${tool.name} yapılandırıldı ve doğrulandı`, { toolId, files: files.length });
  return { ok: true, applied: true, hasBackup: backup.hasSnapshot(toolId), files };
}

// Compensating action for a failed apply. Best effort by design: the caller is
// already throwing, and the outcome of the undo is what the log has to be clear
// about so a stranded machine is visible instead of silent.
function undoFailedApply(toolId, tool, base, reason) {
  try {
    const result = revertTool(toolId, base);
    log.warning("tools", `${tool.name} uygulanamadı; önceki ayarlar geri yüklendi`, {
      toolId,
      reason,
      rollback: result.applied === true ? "failed" : "verified",
    });
  } catch (undoError) {
    log.error("tools", `${tool.name} uygulanamadı ve geri alma da başarısız oldu`, {
      toolId,
      reason,
      rollback: "failed",
      code: String(undoError?.code || "ROLLBACK_FAILED"),
    });
  }
}

function revertTool(toolId, base) {
  const tool = requireTool(toolId);

  // Some config files are actively written by the app that owns them while
  // Cizi Code is connected (the shared Codex config is). Restoring a whole
  // snapshot over such a file would discard everything that app has changed
  // since, so those tools undo only their own keys and the snapshot is used
  // purely as the record of what those keys were.
  if (tool.surgicalRevert) {
    const cleanup = tool.cleanup(base, { snapshot: backup.readSnapshot(toolId) });
    const applied = safeApplied(tool, base);
    if (!applied) backup.dropSnapshot(toolId);
    return { ok: true, restored: false, surgical: true, cleanup, applied, files: tool.files() };
  }

  const restore = backup.restoreSnapshot(toolId);
  let applied = safeApplied(tool, base);
  let cleanup = null;

  // Either there was nothing to put back, or putting it back was not enough:
  // sweep our own keys out of whatever is on disk now.
  if ((!restore.restored || applied) && typeof tool.cleanup === "function") {
    cleanup = tool.cleanup(base);
    applied = safeApplied(tool, base);
  }

  // The user's safety net is only given up once the tool really is disconnected.
  // A snapshot that outlives a failed revert is what lets the next attempt - or
  // the background reconcile - finish the job.
  const droppedBackup = applied ? false : backup.dropSnapshot(toolId);

  return {
    ok: true,
    restored: restore.restored === true,
    cleanup,
    applied,
    hasBackup: backup.hasSnapshot(toolId),
    droppedBackup,
  };
}

function verifyTool(toolId, values) {
  const tool = getTool(toolId);
  return tool ? safeMatches(tool, values) : false;
}

function getToolStatus(toolId, base) {
  const tool = getTool(toolId);
  if (!tool) return null;
  const applied = safeApplied(tool, base);
  const restorable = backup.hasSnapshot(toolId);
  return {
    id: tool.id,
    name: tool.name,
    apiType: tool.apiType,
    applied,
    // The user's original settings are parked in our backup, so there is
    // something the switch has to be able to put back even if the tool's own
    // files no longer look configured.
    restorable,
    hasBackup: restorable,
  };
}

module.exports = { applyTool, revertTool, verifyTool, getToolStatus };
