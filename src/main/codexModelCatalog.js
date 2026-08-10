// Codex needs full ModelInfo records for custom picker entries. Those records
// contain version-specific capability metadata and system instructions, so we
// derive them from the installed Codex build instead of freezing a stale copy
// in Cizi Code.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const codexPaths = require("./codexPaths");

function executableCandidates() {
  const result = [];
  const add = (value) => {
    const candidate = String(value || "").trim();
    if (candidate && !result.includes(candidate)) result.push(candidate);
  };
  add(codexPaths.cliPaths().programBin);

  const binRoot = path.join(codexPaths.desktopPaths().runtimeDir, "bin");
  try {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(binRoot, entry.name, process.platform === "win32" ? "codex.exe" : "codex"));
    }
  } catch { /* the desktop runtime is optional */ }
  add(process.platform === "win32" ? "codex.exe" : "codex");
  add("codex");
  return result;
}

function installedCatalog() {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-codex-catalog-"));
  const errors = [];
  try {
    for (const command of executableCandidates()) {
      if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
      try {
        const stdout = execFileSync(command, ["debug", "models"], {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CODEX_HOME: temporaryHome },
        });
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed?.models) && parsed.models.length) return parsed.models;
      } catch (error) {
        errors.push(`${path.basename(command)}: ${String(error?.message || error).split(/\r?\n/)[0]}`);
      }
    }
  } finally {
    // This exact directory was created above under the OS temp root.
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
  const error = new Error("Kurulu Codex sürümünün model kataloğu okunamadı. Codex CLI veya ChatGPT Desktop'ı güncelleyip tekrar deneyin.");
  error.code = "CODEX_MODEL_CATALOG_UNAVAILABLE";
  error.userMessage = error.message;
  error.details = errors.slice(0, 3);
  throw error;
}

function tokens(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function templateFor(modelId, templates) {
  const id = String(modelId).toLowerCase();
  const exact = templates.find((model) => String(model.slug || "").toLowerCase() === id);
  if (exact) return exact;
  const targetTokens = tokens(modelId);
  const scored = templates.map((model) => {
    const sourceTokens = tokens(model.slug);
    const overlap = targetTokens.filter((token) => sourceTokens.includes(token)).length;
    const familyBonus = ["sol", "terra", "luna", "mini", "codex"].some((token) => targetTokens.includes(token) && sourceTokens.includes(token)) ? 10 : 0;
    const visibleBonus = model.visibility === "list" && model.supported_in_api !== false ? 2 : 0;
    return { model, score: overlap + familyBonus + visibleBonus };
  }).sort((a, b) => b.score - a.score || Number(a.model.priority || 999) - Number(b.model.priority || 999));
  return scored[0]?.model || templates[0];
}

function reasoningEntries(source, profile) {
  const sourceEntries = Array.isArray(source?.supported_reasoning_levels)
    ? source.supported_reasoning_levels
    : [];
  const requested = new Set((profile?.reasoningLevels || []).map((level) => String(level).toLowerCase()));
  const filtered = requested.size
    ? sourceEntries.filter((entry) => requested.has(String(entry?.effort || "").toLowerCase()))
    : sourceEntries;
  return filtered.length ? filtered : sourceEntries;
}

function buildCatalog(modelIds, templates = installedCatalog(), { profiles = [] } = {}) {
  const ids = [...new Set((modelIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!ids.length) {
    const error = new Error("Codex kataloğu için en az bir model gerekli.");
    error.userMessage = error.message;
    throw error;
  }
  const profilesByName = new Map((profiles || []).map((profile) => [String(profile?.name || ""), profile]));
  return {
    models: ids.map((modelId, index) => {
      const source = templateFor(modelId, templates);
      if (!source) {
        const error = new Error("Kurulu Codex sürümünde kullanılabilir model şablonu bulunamadı.");
        error.userMessage = error.message;
        throw error;
      }
      const profile = profilesByName.get(modelId) || null;
      const supportedReasoningLevels = reasoningEntries(source, profile);
      const supportedEfforts = new Set(supportedReasoningLevels
        .map((entry) => String(entry?.effort || "").toLowerCase()));
      const requestedEffort = String(profile?.defaultReasoningLevel || "").toLowerCase();
      const defaultReasoningLevel = supportedEfforts.has(requestedEffort)
        ? requestedEffort
        : source.default_reasoning_level;
      const contextWindow = Number(profile?.contextWindowTokens) || Number(source.context_window) || 1_000_000;
      const maxContextWindow = Math.max(contextWindow, Number(profile?.maxContextWindowTokens) || 0);
      return {
        ...JSON.parse(JSON.stringify(source)),
        slug: modelId,
        display_name: modelId,
        context_window: contextWindow,
        max_context_window: maxContextWindow,
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
        description: "Cizi Code hesabınızla kullanılabilir · 1M bağlam · ayarlanabilir effort.",
        visibility: "list",
        supported_in_api: true,
        priority: index + 1,
        availability_nux: null,
        upgrade: null,
      };
    }),
  };
}

function catalogPath() {
  return codexPaths.sharedPaths().modelCatalogFile;
}

function writeCatalog(catalog) {
  const target = catalogPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, target);
  const verified = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(verified?.models) || verified.models.length !== catalog.models.length) {
    throw new Error("Codex model kataloğu doğrulanamadı.");
  }
  return { path: target, count: verified.models.length };
}

function readModelIds(target = catalogPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return (parsed?.models || []).map((model) => String(model?.slug || "").trim()).filter(Boolean);
  } catch { return []; }
}

module.exports = { executableCandidates, installedCatalog, templateFor, buildCatalog, catalogPath, writeCatalog, readModelIds };
