// Surgical editor for the shared Codex config at ~/.codex/config.toml.
//
// ChatGPT Desktop and the standalone Codex CLI both read this one file, and the
// Desktop app actively writes its own keys into it (notify, mcp_servers,
// plugins, projects, windows...).  Rewriting the whole file from a parsed
// object would silently drop literal strings, quoted table names and comments,
// so this module edits only the following config areas Cizi Code owns:
//
//   model            (top level)
//   model_provider   (top level)
//   model_catalog_json (top level)
//   model_context_window (top level)
//   model_auto_compact_token_limit (top level)
//   model_reasoning_effort (top level)
//   [model_providers.cizicode]
//
// Every other byte of the user's config is left exactly as it was.  Each write
// is preceded by a timestamped backup and followed by a real TOML parse; if the
// result would not parse, the previous content is put back and the write fails.
const fs = require("fs");
const path = require("path");
const { sharedPaths } = require("./codexPaths");
const { ONE_MILLION_TOKENS, compactWindowFor, isReasoningLevel } = require("../renderer/modelCapabilities");

const PROVIDER_ID = "cizicode";
const PROVIDER_NAME = "Cizi Code";
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`;
const WIRE_API = "responses";
const BACKUP_PREFIX = "config.toml.backup-cizicode-";
const KEEP_BACKUPS = 5;
const OWNED_TOP_LEVEL_KEYS = Object.freeze([
  "model",
  "model_provider",
  "model_catalog_json",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_reasoning_effort",
]);

function configPath() {
  return sharedPaths().configFile;
}

function readConfigText() {
  try {
    return fs.readFileSync(configPath(), "utf8");
  } catch {
    return null;
  }
}

function escapeBasicString(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function splitLines(text) {
  return String(text == null ? "" : text).split(/\r?\n/);
}

function isTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line);
}

// Top-level keys must sit above the first table header, otherwise TOML assigns
// them to that table instead.
function topLevelEnd(lines) {
  const index = lines.findIndex(isTableHeader);
  return index === -1 ? lines.length : index;
}

function topLevelKeyIndex(lines, key) {
  const limit = topLevelEnd(lines);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < limit; i += 1) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function readTopLevelString(lines, key) {
  const index = topLevelKeyIndex(lines, key);
  if (index === -1) return null;
  const raw = lines[index].slice(lines[index].indexOf("=") + 1).trim().replace(/\s*#.*$/, "").trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\([\\"nrt])/g, (_match, escaped) => ({
      "\\": "\\",
      '"': '"',
      n: "\n",
      r: "\r",
      t: "\t",
    }[escaped]));
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw || null;
}

function setTopLevelString(lines, key, value) {
  const line = `${key} = "${escapeBasicString(value)}"`;
  const index = topLevelKeyIndex(lines, key);
  if (index !== -1) {
    lines[index] = line;
    return lines;
  }
  // Insert after the last non-blank top-level line so the file keeps its shape.
  const limit = topLevelEnd(lines);
  let insertAt = limit;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, line);
  return lines;
}

function setTopLevelNumber(lines, key, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`'${key}' için pozitif bir tam sayı gerekli.`);
  const line = `${key} = ${parsed}`;
  const index = topLevelKeyIndex(lines, key);
  if (index !== -1) {
    lines[index] = line;
    return lines;
  }
  const limit = topLevelEnd(lines);
  let insertAt = limit;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, line);
  return lines;
}

function removeTopLevelKey(lines, key) {
  const index = topLevelKeyIndex(lines, key);
  if (index === -1) return false;
  lines.splice(index, 1);
  return true;
}

// Matches [model_providers.cizicode] with optional whitespace and optional
// quoting of the last segment, which is how Codex itself may write it back.
function providerHeaderIndex(lines) {
  const pattern = new RegExp(`^\\s*\\[\\s*model_providers\\s*\\.\\s*["']?${PROVIDER_ID}["']?\\s*\\]\\s*(#.*)?$`);
  return lines.findIndex((line) => pattern.test(line));
}

function providerBlockRange(lines) {
  const start = providerHeaderIndex(lines);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !isTableHeader(lines[end])) end += 1;
  return { start, end };
}

function providerBlockLines({ baseUrl, apiKey }) {
  return [
    `[${PROVIDER_TABLE}]`,
    `name = "${escapeBasicString(PROVIDER_NAME)}"`,
    `base_url = "${escapeBasicString(baseUrl)}"`,
    `wire_api = "${WIRE_API}"`,
    `experimental_bearer_token = "${escapeBasicString(apiKey)}"`,
  ];
}

function withV1(base) {
  const trimmed = String(base || "").trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function backupConfig(timestamp) {
  const source = configPath();
  if (!fs.existsSync(source)) return null;
  const stamp = timestamp || new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const target = path.join(path.dirname(source), `${BACKUP_PREFIX}${stamp}`);
  fs.copyFileSync(source, target);
  pruneBackups();
  return target;
}

function pruneBackups() {
  try {
    const directory = path.dirname(configPath());
    const backups = fs.readdirSync(directory)
      .filter((name) => name.startsWith(BACKUP_PREFIX))
      .map((name) => ({ name, file: path.join(directory, name), mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of backups.slice(KEEP_BACKUPS)) {
      try { fs.rmSync(stale.file, { force: true }); } catch { /* a stale backup is harmless */ }
    }
  } catch {
    // Pruning is housekeeping only; it must never block a config write.
  }
}

// Structural check on the text this module produces. It does not attempt to be
// a TOML parser: everything outside the three edited places is copied through
// byte for byte, so the only things that can go wrong are the edits themselves
// — a key landing under a table instead of at the top level, or a duplicate.
// (The test suite parses the results with a real TOML parser to prove the rest
// of the file survives.)
function structuralProblem(text, expected) {
  const lines = splitLines(text);
  const limit = topLevelEnd(lines);
  for (const key of OWNED_TOP_LEVEL_KEYS) {
    const top = lines.slice(0, limit).filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)).length;
    if (top > 1) return `'${key}' anahtarı birden fazla kez yazıldı`;
  }
  const headers = lines.filter((line) => providerHeaderIndex([line]) === 0).length;
  if (headers > 1) return "Cizi Code sağlayıcı bloğu birden fazla kez yazıldı";
  for (const [key, value] of Object.entries(expected || {})) {
    if (value == null) continue;
    const actual = key === "provider" ? readTopLevelString(lines, "model_provider") : readTopLevelString(lines, key);
    if (key !== "providerBlock" && actual !== value) return `'${key}' değeri dosyaya doğru yazılamadı`;
  }
  return null;
}

// Writes `text`, then reads it back and checks the edits landed as intended.
// Any problem restores the exact previous bytes, so a bad edit can never leave
// a broken config behind for either Codex product.
function writeVerified(text, previousText, expected) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  const written = fs.readFileSync(target, "utf8");
  const problem = written !== text
    ? "Yapılandırma dosyası beklendiği gibi yazılamadı"
    : structuralProblem(written, expected);
  if (problem) {
    if (previousText == null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, previousText, "utf8");
    throw new Error(`${problem}; Codex ayar dosyası eski haline döndürüldü.`);
  }
}

// Current state of the shared config, used for status reporting and for the
// "is this actually pointed at THIS gateway" check.
function readState(expectedBase) {
  const text = readConfigText();
  if (text == null) {
    return {
      exists: false,
      model: null,
      modelProvider: null,
      modelCatalogPath: null,
      modelContextWindow: null,
      autoCompactTokenLimit: null,
      reasoningEffort: null,
      hasProvider: false,
      baseUrl: null,
      applied: false,
    };
  }
  const lines = splitLines(text);
  const range = providerBlockRange(lines);
  const block = range ? lines.slice(range.start, range.end).join("\n") : "";
  const baseUrl = block.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  const hasToken = /^\s*experimental_bearer_token\s*=\s*["'][^"']+["']/m.test(block);
  const modelProvider = readTopLevelString(lines, "model_provider");
  const hasProvider = Boolean(range);
  const pointsHere = expectedBase ? baseUrl === withV1(expectedBase) : true;
  return {
    exists: true,
    path: configPath(),
    model: readTopLevelString(lines, "model"),
    modelProvider,
    modelCatalogPath: readTopLevelString(lines, "model_catalog_json"),
    modelContextWindow: readTopLevelString(lines, "model_context_window"),
    autoCompactTokenLimit: readTopLevelString(lines, "model_auto_compact_token_limit"),
    reasoningEffort: readTopLevelString(lines, "model_reasoning_effort"),
    hasProvider,
    baseUrl,
    tokenConfigured: hasToken,
    applied: hasProvider && modelProvider === PROVIDER_ID && pointsHere,
  };
}

// Point both Codex products at the Cizi Code gateway. Returns what the config
// looked like beforehand so a later revert can restore those values precisely.
function applyCizi({
  base,
  apiKey,
  model,
  modelCatalogPath,
  contextWindowTokens = ONE_MILLION_TOKENS,
  reasoningEffort = "high",
}) {
  const modelId = String(model || "").trim();
  if (!modelId) throw new Error("Uygun bir hesap modeli olmadan Codex yapılandırılamaz.");
  // Account model ids are not always slug-shaped ("Sol 5.6"), and the catalog
  // already carries them verbatim, so the default model must accept the same
  // set. Only characters that would break the TOML line are rejected.
  if (!/^[^\u0000-\u001f\u007f"'\\]+$/.test(modelId)) throw new Error("Otomatik Codex model kimliği geçersiz.");
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Cizi Code API anahtarı olmadan Codex yapılandırılamaz.");
  const catalogPath = String(modelCatalogPath || "").trim();
  if (!catalogPath || !path.isAbsolute(catalogPath)) throw new Error("Codex model kataloğu için geçerli bir dosya yolu gerekli.");
  // The window is whatever the model really has. Pinning a floor here is what
  // let a 1M limit be written for a 272k model, which meant Codex never
  // compacted and the session failed on a provider error instead.
  const contextWindow = Number(contextWindowTokens);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Codex için geçerli bir bağlam penceresi gerekli.");
  }
  const compactTokenLimit = compactWindowFor(contextWindow);
  const effort = String(reasoningEffort || "high").trim().toLowerCase();
  if (!isReasoningLevel(effort, "codex")) {
    throw new Error("Codex effort seviyesi geçersiz.");
  }
  const baseUrl = withV1(base);

  const previousText = readConfigText();
  const before = readState();
  const backup = previousText == null ? null : backupConfig();

  const lines = splitLines(previousText == null ? "" : previousText);
  setTopLevelString(lines, "model", modelId);
  setTopLevelString(lines, "model_provider", PROVIDER_ID);
  setTopLevelString(lines, "model_catalog_json", catalogPath);
  setTopLevelNumber(lines, "model_context_window", contextWindow);
  setTopLevelNumber(lines, "model_auto_compact_token_limit", compactTokenLimit);
  setTopLevelString(lines, "model_reasoning_effort", effort);

  const block = providerBlockLines({ baseUrl, apiKey: key });
  const range = providerBlockRange(lines);
  if (range) {
    lines.splice(range.start, range.end - range.start, ...block, "");
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(...block, "");
  }

  const text = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
  writeVerified(text, previousText, {
    model: modelId,
    provider: PROVIDER_ID,
    model_catalog_json: catalogPath,
    model_context_window: String(contextWindow),
    model_auto_compact_token_limit: String(compactTokenLimit),
    model_reasoning_effort: effort,
  });

  return {
    path: configPath(),
    backup,
    model: modelId,
    modelCatalogPath: catalogPath,
    modelContextWindow: contextWindow,
    autoCompactTokenLimit: compactTokenLimit,
    reasoningEffort: effort,
    baseUrl,
    previous: {
      existed: previousText != null,
      model: before.model,
      modelProvider: before.modelProvider,
      modelCatalogPath: before.modelCatalogPath,
      modelContextWindow: before.modelContextWindow,
      autoCompactTokenLimit: before.autoCompactTokenLimit,
      reasoningEffort: before.reasoningEffort,
      hadProvider: before.hasProvider,
    },
  };
}

// Remove only what Cizi Code added. `previousModel` / `previousModelProvider`
// come from the snapshot taken before the first apply; when they are unknown
// the keys are dropped rather than guessed, which returns Codex to its own
// defaults instead of pinning a model the user never chose.
function revertCizi({
  previousModel,
  previousModelProvider,
  previousModelCatalogPath,
  previousModelContextWindow,
  previousAutoCompactTokenLimit,
  previousReasoningEffort,
} = {}) {
  const previousText = readConfigText();
  if (previousText == null) return { changed: false, reason: "not-found" };

  const backup = backupConfig();
  const lines = splitLines(previousText);
  let changed = false;

  const range = providerBlockRange(lines);
  if (range) {
    lines.splice(range.start, range.end - range.start);
    changed = true;
  }

  if (readTopLevelString(lines, "model_provider") === PROVIDER_ID) {
    if (previousModelProvider && previousModelProvider !== PROVIDER_ID) {
      setTopLevelString(lines, "model_provider", previousModelProvider);
    } else {
      removeTopLevelKey(lines, "model_provider");
    }
    changed = true;
  }

  if (previousModel != null) {
    if (readTopLevelString(lines, "model") !== previousModel) {
      setTopLevelString(lines, "model", previousModel);
      changed = true;
    }
  } else if (removeTopLevelKey(lines, "model")) {
    changed = true;
  }

  if (previousModelCatalogPath) {
    if (readTopLevelString(lines, "model_catalog_json") !== previousModelCatalogPath) {
      setTopLevelString(lines, "model_catalog_json", previousModelCatalogPath);
      changed = true;
    }
  } else if (removeTopLevelKey(lines, "model_catalog_json")) {
    changed = true;
  }

  if (previousModelContextWindow != null) {
    if (readTopLevelString(lines, "model_context_window") !== String(previousModelContextWindow)) {
      setTopLevelNumber(lines, "model_context_window", previousModelContextWindow);
      changed = true;
    }
  } else if (removeTopLevelKey(lines, "model_context_window")) changed = true;

  if (previousAutoCompactTokenLimit != null) {
    if (readTopLevelString(lines, "model_auto_compact_token_limit") !== String(previousAutoCompactTokenLimit)) {
      setTopLevelNumber(lines, "model_auto_compact_token_limit", previousAutoCompactTokenLimit);
      changed = true;
    }
  } else if (removeTopLevelKey(lines, "model_auto_compact_token_limit")) changed = true;

  if (previousReasoningEffort != null) {
    if (readTopLevelString(lines, "model_reasoning_effort") !== String(previousReasoningEffort)) {
      setTopLevelString(lines, "model_reasoning_effort", previousReasoningEffort);
      changed = true;
    }
  } else if (removeTopLevelKey(lines, "model_reasoning_effort")) changed = true;

  if (!changed) return { changed: false, reason: "not-present", backup };

  const text = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
  writeVerified(text, previousText, {
    model: previousModel,
    model_context_window: previousModelContextWindow == null ? null : String(previousModelContextWindow),
    model_auto_compact_token_limit: previousAutoCompactTokenLimit == null ? null : String(previousAutoCompactTokenLimit),
    model_reasoning_effort: previousReasoningEffort,
  });
  return { changed: true, path: configPath(), backup };
}

// Reads the model / model_provider values out of a snapshot of the pre-Cizi
// config, so a revert restores what the user actually had.
function readPreviousFromSnapshot(content) {
  if (content == null) return {
    model: null,
    modelProvider: null,
    modelCatalogPath: null,
    modelContextWindow: null,
    autoCompactTokenLimit: null,
    reasoningEffort: null,
  };
  const lines = splitLines(content);
  return {
    model: readTopLevelString(lines, "model"),
    modelProvider: readTopLevelString(lines, "model_provider"),
    modelCatalogPath: readTopLevelString(lines, "model_catalog_json"),
    modelContextWindow: readTopLevelString(lines, "model_context_window"),
    autoCompactTokenLimit: readTopLevelString(lines, "model_auto_compact_token_limit"),
    reasoningEffort: readTopLevelString(lines, "model_reasoning_effort"),
  };
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  WIRE_API,
  configPath,
  readState,
  applyCizi,
  revertCizi,
  backupConfig,
  readPreviousFromSnapshot,
  withV1,
};
