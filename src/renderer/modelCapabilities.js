// Canonical model capabilities shared by every local tool adapter.
//
// Every rule in this file was read out of the tool that consumes it, not
// guessed, because a wrong value here is written straight into the user's
// config and only shows up as a broken session later:
//
//   * Claude Code effort levels are low/medium/high/xhigh/max - the `--effort`
//     enum in the installed claude binary. "minimal" and "ultra" are Codex
//     levels and are rejected here.
//   * Claude Code exposes a 1M-context variant through the `[1m]` suffix for
//     the sonnet, opus and fable aliases only. Its alias table has no
//     `haiku[1m]`, so suffixing a Haiku model produces an id no tool resolves.
//   * Codex effort levels are per model and are read from the installed Codex
//     catalog (`codex debug models`); the list below is only the superset used
//     to reject a value before it reaches config.toml.
//   * Claude Desktop has no effort or context-window setting at all. Its 1M
//     support is expressed per model as `supports1m` / `prefer1m`.
//
// The account API returns either plain model-name strings or enriched model
// objects. Enriched values always win; a plain name falls back to the Cizi
// gateway contract (1M context, tool-default effort range).
// Loaded as a plain script in the renderer and required directly by the main
// process, so the picker and the config writers cannot drift apart.
(function installModelCapabilities(root) {
  const ONE_MILLION_TOKENS = 1_000_000;
  const CLAUDE_TOOL_ID = "claude-code";

  // Verified: `VM=["low","medium","high","xhigh","max"]` in the Claude Code CLI.
  const CLAUDE_REASONING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
  // Superset across Codex builds; the per-model subset comes from the catalog.
  const CODEX_REASONING_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const DEFAULT_REASONING_EFFORT = "high";

  // Verified: Claude Code's alias table is
  // ["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"].
  // Haiku has no 1M variant, so it must never be suffixed or asserted as 1M.
  const CLAUDE_TIERS = Object.freeze(["opus", "sonnet", "haiku", "fable", "mythos"]);
  const TIERS_WITHOUT_LONG_CONTEXT = Object.freeze(["haiku"]);

  // Claude Desktop's Chat tab decides whether to show the effort/thinking picker
  // from the model id alone: it normalizes the id (dropping bedrock ARN and
  // `<region>.anthropic.` prefixes, a `[1m]` suffix and date/version suffixes)
  // and looks it up in a built-in table. There is no managed-config key for it,
  // so a gateway id like "Opus-5" simply has no entry and the picker is hidden.
  // These are that table's keys, plus the rule it applies to fable/mythos.
  const CLAUDE_DESKTOP_EFFORT_MODELS = Object.freeze([
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
  ]);
  const CLAUDE_DESKTOP_EFFORT_FAMILY = /^(?:claude-)?(?:fable|mythos)(?:-|$)/;

  // The same normalization Claude Desktop applies before that lookup.
  function claudeDesktopModelKey(name) {
    return String(name || "").trim().toLowerCase()
      .replace(/^arn:aws[a-z-]*:bedrock:[^/]+\//, "")
      .replace(/^(?:[a-z][a-z0-9-]*\.)?anthropic\./, "")
      .replace(/\[[^\]]+\]$/, "")
      .replace(/@\d{8}$/, "")
      .replace(/-\d{8}$/, "");
  }

  function claudeDesktopShowsEffort(name) {
    const key = claudeDesktopModelKey(name);
    return CLAUDE_DESKTOP_EFFORT_MODELS.includes(key) || CLAUDE_DESKTOP_EFFORT_FAMILY.test(key);
  }

  // The id Claude Desktop would have to see for this model to get an effort
  // picker: "Opus-5" -> "claude-opus-5", "Sonnet-4.5" -> "claude-sonnet-4-5".
  // Returns null when no known model matches, so callers never invent an id.
  function claudeDesktopEffortAlias(name) {
    const key = claudeDesktopModelKey(name).replace(/[._]/g, "-");
    if (CLAUDE_DESKTOP_EFFORT_FAMILY.test(key)) return key.startsWith("claude-") ? key : `claude-${key}`;
    const canonical = key.startsWith("claude-") ? key : `claude-${key}`;
    return CLAUDE_DESKTOP_EFFORT_MODELS.includes(canonical) ? canonical : null;
  }

  function reasoningLevelsFor(toolId) {
    return toolId === CLAUDE_TOOL_ID ? CLAUDE_REASONING_LEVELS : CODEX_REASONING_LEVELS;
  }

  function modelName(candidate) {
    return typeof candidate === "string" ? candidate.trim() : String(candidate?.name || candidate?.id || "").trim();
  }

  // Tier is what lets Claude Code and Claude Desktop resolve a bare alias
  // ("opus") to a gateway model, and it is also what decides 1M eligibility, so
  // an explicit value from the account API always beats the name-based guess.
  function tierFor(candidate) {
    const declared = typeof candidate === "object" && candidate
      ? String(candidate.tier || candidate.anthropicFamilyTier || "").trim().toLowerCase()
      : "";
    if (CLAUDE_TIERS.includes(declared)) return declared;
    const name = modelName(candidate);
    return CLAUDE_TIERS.find((tier) => new RegExp(`(^|[^a-z0-9])${tier}([^a-z0-9]|$)`, "i").test(name)) || "";
  }

  function declared1m(candidate) {
    const explicit = typeof candidate === "object" && candidate
      ? candidate.supports1m ?? candidate.context?.supports1m
      : undefined;
    return typeof explicit === "boolean" ? explicit : undefined;
  }

  // A stated value is a fact (the gateway either lists `<id>[1m]` or it does
  // not); anything else is the tier rule, which only knows that Haiku has no
  // 1M variant.
  function supportsLongContext(candidate, contextWindowTokens) {
    if (contextWindowTokens < ONE_MILLION_TOKENS) return false;
    const explicit = declared1m(candidate);
    if (explicit !== undefined) return explicit;
    return !TIERS_WITHOUT_LONG_CONTEXT.includes(tierFor(candidate));
  }

  function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function declaredContext(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const values = [
      candidate.contextWindowTokens,
      candidate.context_window,
      candidate.contextWindow,
      candidate.context?.activeTokens,
      candidate.context?.maxTokens,
      candidate.context?.maximum,
    ];
    for (const value of values) {
      const parsed = positiveInteger(value);
      if (parsed) return parsed;
    }
    return null;
  }

  function declaredLevels(candidate, toolId) {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate.reasoning?.levels
      ?? candidate.reasoningLevels
      ?? candidate.supported_reasoning_levels
      ?? [];
    // A level the target tool cannot parse is worse than no level at all, so the
    // account list is intersected with the tool's own enum rather than trusted.
    const allowed = new Set(reasoningLevelsFor(toolId));
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(source) ? source : []) {
      const level = String(typeof item === "string" ? item : item?.effort || "").trim().toLowerCase();
      if (!allowed.has(level) || seen.has(level)) continue;
      seen.add(level);
      result.push(level);
    }
    return result;
  }

  // Auto-compaction has to start before the window is full, not at a fixed
  // number: a 950k trigger on a 272k model never fires and the session dies on a
  // provider error instead of compacting.
  function compactWindowFor(contextWindowTokens) {
    const window = positiveInteger(contextWindowTokens) || ONE_MILLION_TOKENS;
    const headroom = Math.max(Math.round(window * 0.05), Math.min(50_000, Math.floor(window / 2)));
    return Math.max(1, window - headroom);
  }

  function capabilityFor(candidate, toolId) {
    const name = modelName(candidate);
    const levels = declaredLevels(candidate, toolId);
    const reasoningLevels = levels.length ? levels : [...reasoningLevelsFor(toolId)];
    const requestedDefault = String(
      candidate?.reasoning?.default
        ?? candidate?.defaultReasoningLevel
        ?? candidate?.default_reasoning_level
        ?? DEFAULT_REASONING_EFFORT,
    ).trim().toLowerCase();
    const defaultReasoningLevel = reasoningLevels.includes(requestedDefault)
      ? requestedDefault
      : reasoningLevels.includes(DEFAULT_REASONING_EFFORT)
        ? DEFAULT_REASONING_EFFORT
        : reasoningLevels[0];
    // The Cizi gateway serves a 1M window, so a model the account API describes
    // only by name gets 1M. A model that declares its own window keeps it -
    // overriding a declared 272k with 1M is how the compaction bug got in.
    const contextWindowTokens = declaredContext(candidate) || ONE_MILLION_TOKENS;
    const maxContextWindowTokens = Math.max(
      contextWindowTokens,
      positiveInteger(candidate?.maxContextWindowTokens ?? candidate?.max_context_window) || contextWindowTokens,
    );

    return Object.freeze({
      name,
      tier: tierFor(candidate),
      contextWindowTokens,
      maxContextWindowTokens,
      compactWindowTokens: compactWindowFor(contextWindowTokens),
      supports1m: supportsLongContext(candidate, contextWindowTokens),
      // True when the 1M answer came from the gateway rather than the tier
      // rule, which lets callers use the verified `<id>[1m]` id as-is.
      supports1mVerified: declared1m(candidate) !== undefined,
      desktopEffortName: typeof candidate === "object" && candidate?.desktopEffortName
        ? String(candidate.desktopEffortName) : null,
      reasoningLevels: Object.freeze(reasoningLevels),
      defaultReasoningLevel,
    });
  }

  // `name[1m]` is how Claude Code and Claude Desktop name the 1M-context variant.
  // Only tiers that actually have one may be suffixed.
  function longContextModelName(name, tier) {
    const normalized = String(name || "").trim();
    if (!normalized || /\[1m\]$/i.test(normalized)) return normalized;
    const family = String(tier ?? tierFor(normalized) ?? "").toLowerCase();
    if (TIERS_WITHOUT_LONG_CONTEXT.includes(family)) return normalized;
    return `${normalized}[1m]`;
  }

  function isReasoningLevel(level, toolId) {
    return reasoningLevelsFor(toolId).includes(String(level || "").trim().toLowerCase());
  }

  // EKRANDA gorunen ad. Gateway modelleri "Opus-5" gibi tireli id'ler yayinlar;
  // tire bir okuma zorlugu, marka adi degil. Bu yuzden arayuzde bosluga cevrilir.
  //
  // YALNIZCA GORUNTU ICIN. Yapilandirmaya yazilan deger her zaman `capabilityFor`
  // ile gelen gercek `name`'dir: "Opus 5" diye bir model id'si yok, onu bir
  // config'e yazmak modeli cozulemez hale getirir.
  function displayModelName(value) {
    return String(modelName(value) || "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  }

  const api = {
    ONE_MILLION_TOKENS,
    displayModelName,
    CLAUDE_TIERS,
    TIERS_WITHOUT_LONG_CONTEXT,
    CLAUDE_DESKTOP_EFFORT_MODELS,
    claudeDesktopModelKey,
    claudeDesktopShowsEffort,
    claudeDesktopEffortAlias,
    CLAUDE_REASONING_LEVELS,
    CODEX_REASONING_LEVELS,
    DEFAULT_REASONING_EFFORT,
    reasoningLevelsFor,
    isReasoningLevel,
    modelName,
    tierFor,
    compactWindowFor,
    capabilityFor,
    longContextModelName,
  };

  root.ciziModelCapabilities = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window === "object" && window ? window : globalThis);
