// Which local products a key may configure follows from the models the key can
// actually call. A key whose model list only names Claude-family models never
// gets the Codex row, and the other way round, so the screen can never offer a
// tool that would be configured with a model the gateway would refuse.
//
// Loaded as a plain script in the renderer and required directly by the tests,
// so the rule is checked where it is written rather than restated in a test.
(function installModelFamilies(root) {
  const MODEL_FAMILY_KEYWORDS = {
    "claude-code": ["opus", "sonnet", "haiku", "fable", "anthropic", "claude"],
    codex: ["gpt", "openai", "codex", "luna", "terra", "sol", "astra"],
  };
  const CLAUDE_ONLY_KEYWORDS = ["opus", "sonnet", "haiku", "fable", "anthropic", "claude"];

  function modelName(model) {
    return typeof model === "string"
      ? model
      : model && (model.name || model.id || model.slug || model.model);
  }

  function modelNames(models) {
    return (models || []).map(modelName).filter(Boolean);
  }

  // Model ids are matched word by word rather than as raw substrings, so a
  // family keyword cannot accidentally claim an unrelated id ("sol" must not
  // match "resolve"). A token that starts with the keyword still counts,
  // because the gateway also names models like "gpt5-luna".
  function modelBelongsToFamily(name, toolId) {
    const tokens = String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    // Codex and Claude share one account model response. Exclude Claude
    // families explicitly before checking broad OpenAI gateway aliases so a
    // provider-supplied id can never leak into the Codex catalog again.
    if (toolId === "codex" && tokens.some((token) => CLAUDE_ONLY_KEYWORDS
      .some((keyword) => token === keyword || token.startsWith(keyword)))) return false;
    const keywords = MODEL_FAMILY_KEYWORDS[toolId] || [];
    return tokens.some((token) => keywords.some((keyword) => token === keyword || token.startsWith(keyword)));
  }

  function modelsForTool(models, toolId) {
    return (models || []).filter((model) => modelBelongsToFamily(modelName(model), toolId));
  }

  function toolIsUnlocked(models, toolId) {
    return modelsForTool(models, toolId).length > 0;
  }

  // A tool without a family entry is not gated by models at all.
  function toolIsGated(toolId) {
    return Object.prototype.hasOwnProperty.call(MODEL_FAMILY_KEYWORDS, toolId);
  }

  const api = {
    MODEL_FAMILY_KEYWORDS,
    modelName,
    modelNames,
    modelBelongsToFamily,
    modelsForTool,
    toolIsUnlocked,
    toolIsGated,
  };

  root.ciziModelFamilies = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" && window ? window : globalThis);
