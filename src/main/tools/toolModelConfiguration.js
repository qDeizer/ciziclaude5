// Turns the account's model list into the values one tool adapter needs.
//
// Every model the key can call is offered to the tool, not just one, so the
// picker inside Claude Code / Claude Desktop / Codex shows the whole list. The
// first entry is the default, because all three products treat it that way.
const { modelsForTool, modelName, toolIsGated } = require("../../renderer/modelFamilies");
const { capabilityFor, tierFor, CLAUDE_TIERS } = require("../../renderer/modelCapabilities");

const CLAUDE_TOOL_ID = "claude-code";
const CODEX_TOOL_ID = "codex";

// Tier order for picking a default: the strongest generally-available family
// first. Matching by tier rather than by a pinned id ("opus-4.8") keeps working
// when the gateway ships a new version.
const CLAUDE_DEFAULT_TIER_ORDER = Object.freeze(["opus", "fable", "sonnet", "haiku"]);
const CODEX_DEFAULT_HINTS = Object.freeze(["luna", "terra", "sol", "astra", "codex"]);

// A model id is written into TOML, JSON and a Windows registry value, so a
// control character in it corrupts the file rather than failing loudly.
function hasControlCharacter(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function uniqueModelNames(models) {
  const seen = new Set();
  const result = [];
  for (const candidate of models || []) {
    const name = String(modelName(candidate) || "").trim();
    if (!name || name.length > 256 || hasControlCharacter(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function hasToken(name, token) {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(name);
}

function preferredModel(toolId, names, currentModel) {
  const current = String(currentModel || "").trim();
  if (current && names.includes(current)) return current;
  if (toolId === CLAUDE_TOOL_ID) {
    for (const tier of CLAUDE_DEFAULT_TIER_ORDER) {
      const match = names.find((name) => tierFor(name) === tier);
      if (match) return match;
    }
    return names[0] || null;
  }
  if (toolId === CODEX_TOOL_ID) {
    for (const hint of CODEX_DEFAULT_HINTS) {
      const match = names.find((name) => hasToken(name, hint));
      if (match) return match;
    }
    return names.find((name) => /^gpt[-_.:]/i.test(name)) || names[0] || null;
  }
  return names[0] || null;
}

// Claude Code resolves the bare aliases (opus/sonnet/haiku/fable) through the
// ANTHROPIC_DEFAULT_*_MODEL variables, so each slot gets the first model of
// that tier and falls back to the default only when the account has none.
function claudeTierModel(profiles, tier, fallback) {
  return profiles.find((profile) => profile.tier === tier)?.name || fallback;
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
  // Capabilities come from the account record when it has them and from the
  // gateway contract otherwise - never from the tool's own idea of the model.
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
    for (const tier of CLAUDE_TIERS) {
      if (tier === "mythos") continue; // no ANTHROPIC_DEFAULT_MYTHOS_MODEL exists
      values[tier] = claudeTierModel(modelProfiles, tier, model);
    }
  }
  return values;
}

module.exports = {
  CLAUDE_TOOL_ID,
  CODEX_TOOL_ID,
  uniqueModelNames,
  preferredModel,
  claudeTierModel,
  configurationForTool,
};
