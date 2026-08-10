const { modelsForTool, modelName, toolIsGated } = require("../../renderer/modelFamilies");
const { capabilityFor } = require("./modelCapabilities");

const CLAUDE_TOOL_ID = "claude-code";
const CODEX_TOOL_ID = "codex";

function uniqueModelNames(models) {
  const seen = new Set();
  const result = [];
  for (const candidate of models || []) {
    const name = String(modelName(candidate) || "").trim();
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function preferredModel(toolId, names, currentModel) {
  const current = String(currentModel || "").trim();
  if (current && names.includes(current)) return current;
  if (toolId === CLAUDE_TOOL_ID) {
    return names.find((name) => name.toLowerCase() === "opus-4.8")
      || names.find((name) => /(^|[^a-z0-9])opus([^a-z0-9]|$)/i.test(name))
      || names[0]
      || null;
  }
  if (toolId === CODEX_TOOL_ID) {
    return names.find((name) => name.toLowerCase() === "gpt-5.6-luna")
      || names.find((name) => /(^|[^a-z0-9])luna([^a-z0-9]|$)/i.test(name))
      || names.find((name) => /^gpt[-_.:]/i.test(name))
      || names[0]
      || null;
  }
  return names[0] || null;
}

function claudeTierModel(names, tier, fallback) {
  return names.find((name) => new RegExp(`(^|[^a-z0-9])${tier}([^a-z0-9]|$)`, "i").test(name)) || fallback;
}

function configurationForTool(toolId, accountModels, { currentModel } = {}) {
  const candidates = toolIsGated(toolId) ? modelsForTool(accountModels, toolId) : accountModels;
  const compatible = uniqueModelNames(candidates);
  if (!compatible.length) {
    const error = new Error("Bu anahtar için bu araçla uyumlu model bulunamadı.");
    error.code = "NO_COMPATIBLE_MODELS";
    throw error;
  }

  const model = preferredModel(toolId, compatible, currentModel);
  const models = [model, ...compatible.filter((name) => name !== model)];
  const firstByName = new Map();
  for (const candidate of candidates || []) {
    const name = String(modelName(candidate) || "").trim();
    if (name && !firstByName.has(name)) firstByName.set(name, candidate);
  }
  const modelProfiles = models.map((name) => capabilityFor(firstByName.get(name) || name, toolId));
  const activeProfile = modelProfiles.find((profile) => profile.name === model) || modelProfiles[0];
  const values = {
    model,
    models,
    modelProfiles,
    contextWindowTokens: activeProfile.contextWindowTokens,
    reasoningEffort: activeProfile.defaultReasoningLevel,
  };
  if (toolId === CLAUDE_TOOL_ID) {
    values.opus = claudeTierModel(models, "opus", model);
    values.sonnet = claudeTierModel(models, "sonnet", model);
    values.haiku = claudeTierModel(models, "haiku", model);
    values.fable = claudeTierModel(models, "fable", model);
  }
  return values;
}

module.exports = {
  CLAUDE_TOOL_ID,
  CODEX_TOOL_ID,
  uniqueModelNames,
  preferredModel,
  configurationForTool,
};
