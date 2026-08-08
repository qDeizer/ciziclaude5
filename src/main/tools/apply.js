// Orchestrates tool config: backup (once) → apply, and exact revert via snapshot.
const backup = require("./backup");
const { getTool, listToolIds } = require("./registry");

function applyTool(toolId, values) {
  const tool = getTool(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  const files = tool.files();
  backup.takeSnapshot(toolId, files);   // capture pre-Cizi state once
  tool.apply(values);
  return { ok: true, applied: safeApplied(tool, values.base), hasBackup: backup.hasSnapshot(toolId), files };
}

function revertTool(toolId, base) {
  const tool = getTool(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  const res = backup.restoreSnapshot(toolId);
  let cleanup = null;
  let applied = safeApplied(tool, base);

  if ((!res.restored || applied) && typeof tool.cleanup === "function") {
    cleanup = tool.cleanup(base);
    applied = safeApplied(tool, base);
  }

  return { ok: true, ...res, cleanup, applied };
}

// base (optional): the gateway the user is logged into — used to decide whether a
// tool's existing config actually points at THIS Cizi gateway (vs. somewhere else).
function safeApplied(tool, base) {
  try { return tool.isApplied(base); } catch { return false; }
}

function getToolStatus(toolId, base) {
  const tool = getTool(toolId);
  if (!tool) return null;
  return {
    id: tool.id,
    name: tool.name,
    apiType: tool.apiType,
    applied: safeApplied(tool, base),
    hasBackup: backup.hasSnapshot(toolId),
  };
}

function listToolStatuses(base) {
  return listToolIds().map((id) => getToolStatus(id, base));
}

module.exports = { applyTool, revertTool, getToolStatus, listToolStatuses };
