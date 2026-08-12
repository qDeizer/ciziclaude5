// Server-authoritative routing between account models and local clients.
//
// `/api/me` attaches `desktopClients` to every model profile. That field is
// the access contract: model names are deliberately never inspected here.
// The module is shared by the renderer and the main process so a hidden UI row
// cannot still be enabled through IPC or a background reconcile.
(function installToolAccess(root) {
  const TOOL_ORDER = Object.freeze(["claude-code", "claude-desktop", "codex"]);
  const KNOWN_TOOLS = new Set(TOOL_ORDER);

  function modelName(model) {
    return typeof model === "string"
      ? model.trim()
      : String(model?.name || model?.id || model?.slug || model?.model || "").trim();
  }

  function desktopClients(model) {
    if (!model || typeof model !== "object" || !Array.isArray(model.desktopClients)) return [];
    const seen = new Set();
    const clients = [];
    for (const candidate of model.desktopClients) {
      const id = String(candidate || "").trim().toLowerCase();
      if (!KNOWN_TOOLS.has(id) || seen.has(id)) continue;
      seen.add(id);
      clients.push(id);
    }
    return clients;
  }

  function modelsForTool(models, toolId) {
    const id = String(toolId || "").trim().toLowerCase();
    if (!KNOWN_TOOLS.has(id)) return [];
    return (Array.isArray(models) ? models : []).filter((model) => (
      modelName(model) && desktopClients(model).includes(id)
    ));
  }

  function accessibleToolIds(models) {
    return TOOL_ORDER.filter((toolId) => modelsForTool(models, toolId).length > 0);
  }

  // Capabilities use Claude Code's effort enum for both Claude clients. This
  // is not an access guess: access still comes from the exact desktop client.
  function capabilityToolForModel(model) {
    const clients = desktopClients(model);
    if (clients.includes("claude-code") || clients.includes("claude-desktop")) return "claude-code";
    if (clients.includes("codex")) return "codex";
    return null;
  }

  const api = {
    TOOL_ORDER,
    modelName,
    desktopClients,
    modelsForTool,
    accessibleToolIds,
    capabilityToolForModel,
  };

  root.ciziToolAccess = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" && window ? window : globalThis);
