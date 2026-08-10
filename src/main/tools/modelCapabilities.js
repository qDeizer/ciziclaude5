// Canonical model capabilities shared by every local tool adapter.
//
// The account API may return either legacy model-name strings or enriched
// model objects. Enriched values win; legacy Cizi models use the product
// contract requested by the desktop app (1M context plus surfaced reasoning
// controls). Keeping this normalization here prevents Claude, Codex and the UI
// from inventing slightly different capability rules.
const ONE_MILLION_TOKENS = 1_000_000;
const DEFAULT_COMPACT_TOKENS = 950_000;
const CLAUDE_REASONING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);
const CODEX_REASONING_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const DEFAULT_REASONING_EFFORT = "high";

function modelName(candidate) {
  return typeof candidate === "string" ? candidate.trim() : String(candidate?.name || candidate?.id || "").trim();
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

function declaredLevels(candidate) {
  if (!candidate || typeof candidate !== "object") return [];
  const source = candidate.reasoning?.levels
    ?? candidate.reasoningLevels
    ?? candidate.supported_reasoning_levels
    ?? [];
  const allowed = new Set([...CLAUDE_REASONING_LEVELS, ...CODEX_REASONING_LEVELS]);
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

function capabilityFor(candidate, toolId) {
  const name = modelName(candidate);
  const fallbackLevels = toolId === "claude-code" ? CLAUDE_REASONING_LEVELS : CODEX_REASONING_LEVELS;
  const levels = declaredLevels(candidate);
  const requestedDefault = String(
    candidate?.reasoning?.default
      ?? candidate?.defaultReasoningLevel
      ?? candidate?.default_reasoning_level
      ?? DEFAULT_REASONING_EFFORT,
  ).trim().toLowerCase();
  const reasoningLevels = levels.length ? levels : [...fallbackLevels];
  const defaultReasoningLevel = reasoningLevels.includes(requestedDefault)
    ? requestedDefault
    : reasoningLevels.includes(DEFAULT_REASONING_EFFORT)
      ? DEFAULT_REASONING_EFFORT
      : reasoningLevels[0];
  const contextWindowTokens = Math.max(declaredContext(candidate) || 0, ONE_MILLION_TOKENS);
  const explicit1m = candidate && typeof candidate === "object"
    ? candidate.supports1m ?? candidate.context?.supports1m
    : undefined;

  return Object.freeze({
    name,
    contextWindowTokens,
    maxContextWindowTokens: Math.max(
      contextWindowTokens,
      positiveInteger(candidate?.maxContextWindowTokens ?? candidate?.max_context_window) || contextWindowTokens,
    ),
    supports1m: explicit1m === false ? false : contextWindowTokens >= ONE_MILLION_TOKENS,
    reasoningLevels,
    defaultReasoningLevel,
  });
}

function longContextModelName(name) {
  const normalized = String(name || "").trim();
  if (!normalized || /\[1m\]$/i.test(normalized)) return normalized;
  return `${normalized}[1m]`;
}

module.exports = {
  ONE_MILLION_TOKENS,
  DEFAULT_COMPACT_TOKENS,
  CLAUDE_REASONING_LEVELS,
  CODEX_REASONING_LEVELS,
  DEFAULT_REASONING_EFFORT,
  modelName,
  capabilityFor,
  longContextModelName,
};
