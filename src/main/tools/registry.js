// Per-tool local config registry for the Cizi Code desktop app.
// Faithfully ports the gateway's own cli-tools config shapes, but writes to the
// END USER's machine. Revert is handled by exact full-file snapshot restore
// (see backup.js), so each tool only needs: file list, apply(write), isApplied(detect).
const os = require("os");
const fs = require("fs");
const path = require("path");
const codexConfig = require("../codexConfigFile");
const codexModelCatalog = require("../codexModelCatalog");
const log = require("../logger");
const {
  DEFAULT_REASONING_EFFORT,
  capabilityFor,
  compactWindowFor,
  isReasoningLevel,
  longContextModelName,
} = require("../../renderer/modelCapabilities");
// TOML is handled by codexConfigFile, which edits the shared Codex config in
// place. A naive stringifier used to live here; it could not round-trip the
// literal strings, arrays and quoted table names the Desktop app writes, so
// the whole file is no longer regenerated from a parsed object.
const home = () => os.homedir();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readText(file) {
  try { return fs.readFileSync(file, "utf-8"); } catch { return null; }
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// VS Code user-settings path (per-OS) for extension-based tools (Kilo / Roo).
function vscodeSettingsPath() {
  const platform = os.platform();
  if (platform === "win32") return path.join(process.env.APPDATA || path.join(home(), "AppData", "Roaming"), "Code", "User", "settings.json");
  if (platform === "darwin") return path.join(home(), "Library", "Application Support", "Code", "User", "settings.json");
  return path.join(home(), ".config", "Code", "User", "settings.json");
}

function withV1(base) {
  const b = String(base).replace(/\/+$/, "");
  return b.endsWith("/v1") ? b : `${b}/v1`;
}
function withoutV1(base) {
  const b = String(base).replace(/\/+$/, "");
  return b.endsWith("/v1") ? b.slice(0, -3) : b;
}

function profileMap(values, toolId) {
  const profiles = Array.isArray(values?.modelProfiles) && values.modelProfiles.length
    ? values.modelProfiles
    : (values?.models || [values?.model]).filter(Boolean).map((model) => capabilityFor(model, toolId));
  return new Map(profiles.map((profile) => [profile.name, profile]));
}

// Claude Code names the 1M-context variant `<model>[1m]`, but only sonnet,
// opus and fable have one - its alias table has no `haiku[1m]`, so suffixing a
// Haiku model yields an id nothing resolves. When the gateway has told us it
// publishes `<model>[1m]` the answer is a fact and that exact id is used;
// otherwise `longContextModelName` applies the tier rule.
function configuredClaudeModel(name, profiles) {
  const profile = profiles.get(name) || capabilityFor(name, "claude-code");
  if (!profile.supports1m) return name;
  return profile.supports1mVerified ? `${name}[1m]` : longContextModelName(name, profile.tier);
}

// `availableModels` is an allow-list, not the picker's source list: Claude Code
// matches family names, version prefixes and full ids against it, comparing
// with the `[1m]` suffix stripped. So it gets the plain gateway ids, and both
// context variants of each model stay reachable.
function claudeAvailableModels(v) {
  return [...new Set((v.models || [v.model]).filter(Boolean).map((model) => String(model).trim()))];
}

// One session-wide number, so it has to hold for every model the user can
// switch to: the smallest window wins.
function claudeCompactWindow(v, profiles) {
  const windows = (v.models || [v.model]).filter(Boolean)
    .map((model) => (profiles.get(model) || capabilityFor(model, "claude-code")).contextWindowTokens);
  return compactWindowFor(windows.length ? Math.min(...windows) : undefined);
}

function claudeEffortLevel(v) {
  const requested = String(v.reasoningEffort || "").trim().toLowerCase();
  return isReasoningLevel(requested, "claude-code") ? requested : DEFAULT_REASONING_EFFORT;
}

// Tool definitions. values = { base, apiKey, model, opus, sonnet, haiku, fable, models }
//   base    - gateway origin (no /v1)
//   model   - automatic default model for this tool
//   opus/sonnet/haiku/fable - model per Claude slot (Claude Code CLI only)
//   models  - model names available for multi-model tools
const TOOLS = {
  "claude-code": {
    id: "claude-code", name: "Claude Code CLI", apiType: "anthropic",
    files: () => [path.join(home(), ".claude", "settings.json")],
    apply(v) {
      const file = path.join(home(), ".claude", "settings.json");
      const cur = readJson(file) || {};
      const profiles = profileMap(v, "claude-code");
      const nextEnv = {
        ...(cur.env || {}),
        ANTHROPIC_BASE_URL: withV1(v.base),
        ANTHROPIC_AUTH_TOKEN: v.apiKey,
        ANTHROPIC_DEFAULT_OPUS_MODEL: configuredClaudeModel(v.opus || v.model, profiles),
        ANTHROPIC_DEFAULT_SONNET_MODEL: configuredClaudeModel(v.sonnet || v.model, profiles),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: configuredClaudeModel(v.haiku || v.model, profiles),
        ANTHROPIC_DEFAULT_FABLE_MODEL: configuredClaudeModel(v.fable || v.model, profiles),
        // Without this the CLI logs "Skipped gateway /v1/models" and the picker
        // only ever offers the four alias defaults above.
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(claudeCompactWindow(v, profiles)),
        // Claude Code decides whether to offer the effort picker from a table of
        // model ids it knows. A gateway id ("Opus-5") is not in it, so /effort
        // and the picker disappear even though the model supports effort. This
        // is the CLI's own override for exactly that case.
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
      };
      // A pre-existing user opt-out would hide every [1m] variant. The full
      // original settings file is restored from the application backup when
      // the integration is turned off.
      delete nextEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      const next = {
        ...cur,
        hasCompletedOnboarding: true,
        availableModels: claudeAvailableModels(v),
        effortLevel: claudeEffortLevel(v),
        env: nextEnv,
      };
      writeJson(file, next);
    },
    // "applied" = configured to use THIS Cizi gateway. When expectedBase is given we
    // require the URL to match it, so a tool pointed at a *different* endpoint (e.g. the
    // user's own/local gateway) is correctly reported as "not connected".
    isApplied(expectedBase) {
      const cfg = readJson(path.join(home(), ".claude", "settings.json"));
      const url = cfg?.env?.ANTHROPIC_BASE_URL;
      const complete = Boolean(url
        && cfg?.env?.ANTHROPIC_AUTH_TOKEN
        && Array.isArray(cfg?.availableModels)
        && cfg.availableModels.length > 0
        && cfg?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL
        && cfg?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL
        && cfg?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL
        && cfg?.env?.ANTHROPIC_DEFAULT_FABLE_MODEL
        && cfg?.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
        && cfg?.env?.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1"
        && Number(cfg?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW) > 0
        && cfg?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT !== "1");
      if (!complete) return false;
      return expectedBase ? url === withV1(expectedBase) : true;
    },
    matches(v) {
      const cfg = readJson(path.join(home(), ".claude", "settings.json"));
      const env = cfg?.env || {};
      const profiles = profileMap(v, "claude-code");
      const expectedModels = claudeAvailableModels(v);
      return env.ANTHROPIC_BASE_URL === withV1(v.base)
        && env.ANTHROPIC_AUTH_TOKEN === v.apiKey
        && env.ANTHROPIC_DEFAULT_OPUS_MODEL === configuredClaudeModel(v.opus || v.model, profiles)
        && env.ANTHROPIC_DEFAULT_SONNET_MODEL === configuredClaudeModel(v.sonnet || v.model, profiles)
        && env.ANTHROPIC_DEFAULT_HAIKU_MODEL === configuredClaudeModel(v.haiku || v.model, profiles)
        && env.ANTHROPIC_DEFAULT_FABLE_MODEL === configuredClaudeModel(v.fable || v.model, profiles)
        && env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
        && env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT === "1"
        && env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === String(claudeCompactWindow(v, profiles))
        && env.CLAUDE_CODE_DISABLE_1M_CONTEXT !== "1"
        && cfg?.effortLevel === claudeEffortLevel(v)
        && Array.isArray(cfg?.availableModels)
        && cfg.availableModels.length === expectedModels.length
        && expectedModels.every((model) => cfg.availableModels.includes(model));
    },
    cleanup(expectedBase) {
      const file = path.join(home(), ".claude", "settings.json");
      const cfg = readJson(file);
      if (!cfg?.env) return { changed: false, reason: "missing-env" };

      const url = cfg.env.ANTHROPIC_BASE_URL;
      if (expectedBase && url && url !== withV1(expectedBase)) {
        return { changed: false, reason: "different-endpoint" };
      }

      const nextEnv = { ...cfg.env };
      delete nextEnv.ANTHROPIC_BASE_URL;
      delete nextEnv.ANTHROPIC_AUTH_TOKEN;
      delete nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete nextEnv.ANTHROPIC_DEFAULT_FABLE_MODEL;
      delete nextEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
      delete nextEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT;
      delete nextEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

      const next = { ...cfg };
      delete next.availableModels;
      delete next.effortLevel;
      if (Object.keys(nextEnv).length > 0) next.env = nextEnv;
      else delete next.env;
      writeJson(file, next);
      return { changed: true, file };
    },
  },

  // One switch for both local Codex products. ChatGPT Desktop and the
  // standalone Codex CLI ship the same codex-cli core and read the same
  // user-level config.toml, so configuring that one file connects both. The
  // file is edited surgically because the Desktop app writes its own keys into
  // it while running.
  codex: {
    id: "codex", name: "Codex (CLI + ChatGPT Desktop)", apiType: "openai",
    files: () => [codexConfig.configPath(), codexModelCatalog.catalogPath()],
    surgicalRevert: true,
    apply(v) {
      const catalogPath = codexModelCatalog.catalogPath();
      let previousCatalog = null;
      let catalogExisted = false;
      try {
        previousCatalog = fs.readFileSync(catalogPath, "utf8");
        catalogExisted = true;
      } catch { /* first Cizi catalog */ }
      try {
        const catalog = codexModelCatalog.buildCatalog(v.models, undefined, { profiles: v.modelProfiles });
        const written = codexModelCatalog.writeCatalog(catalog);
        codexConfig.applyCizi({
          base: v.base,
          apiKey: v.apiKey,
          model: v.model,
          modelCatalogPath: written.path,
          contextWindowTokens: v.contextWindowTokens,
          reasoningEffort: v.reasoningEffort,
        });
        log.success("codex", "Codex/ChatGPT model kataloğu, 1M context ve effort ayarları uygulandı", {
          modelCount: written.count,
          defaultModel: v.model,
          contextWindowTokens: v.contextWindowTokens,
          reasoningEffort: v.reasoningEffort,
        });
      } catch (error) {
        try {
          if (catalogExisted) fs.writeFileSync(catalogPath, previousCatalog, "utf8");
          else fs.rmSync(catalogPath, { force: true });
          log.warning("codex", "Codex yapılandırması tamamlanamadı; model kataloğu geri alındı", { rollback: true, modelCount: v.models?.length || 0 });
        } catch (rollbackError) {
          log.error("codex", "Codex model kataloğu geri alınamadı", { rollback: false, code: rollbackError?.code || null });
        }
        if (!error.userMessage) error.userMessage = "Codex model listesi uygulanamadı; önceki ayarlar geri yüklendi.";
        throw error;
      }
      // Pre-1.1 builds wrote a separate CLI profile. Leaving it behind would
      // let the two disagree about which gateway Codex should use.
      try { fs.rmSync(path.join(home(), ".codex", "cizicode.config.toml"), { force: true }); } catch { /* nothing to clean up */ }
    },
    isApplied(expectedBase) {
      const state = codexConfig.readState(expectedBase);
      return state.applied
        && state.tokenConfigured
        && Boolean(state.model)
        && state.modelCatalogPath === codexModelCatalog.catalogPath()
        // The window is a per-model fact, so "connected" only requires a
        // coherent pair: compaction has to start before the window is full.
        && Number(state.modelContextWindow) > 0
        && Number(state.autoCompactTokenLimit) > 0
        && Number(state.autoCompactTokenLimit) < Number(state.modelContextWindow)
        && isReasoningLevel(state.reasoningEffort, "codex");
    },
    matches(v) {
      const state = codexConfig.readState(v.base);
      const actualModels = codexModelCatalog.readModelIds(state.modelCatalogPath);
      const expectedModels = [...new Set((v.models || []).map((model) => String(model || "").trim()).filter(Boolean))];
      return state.applied && state.tokenConfigured && state.model === v.model
        && state.modelCatalogPath === codexModelCatalog.catalogPath()
        && Number(state.modelContextWindow) === Number(profileMap(v, "codex").get(v.model)?.contextWindowTokens
          || capabilityFor(v.model, "codex").contextWindowTokens)
        && Number(state.autoCompactTokenLimit) > 0
        && Number(state.autoCompactTokenLimit) < Number(state.modelContextWindow)
        && isReasoningLevel(state.reasoningEffort, "codex")
        && actualModels.length === expectedModels.length
        && expectedModels.every((model) => actualModels.includes(model));
    },
    cleanup(expectedBase, { snapshot } = {}) {
      const state = codexConfig.readState();
      if (!state.exists) return { changed: false, reason: "not-found" };
      if (!state.hasProvider && state.modelProvider !== codexConfig.PROVIDER_ID) {
        return { changed: false, reason: "not-present" };
      }
      // A provider block pointing somewhere else was not written by this app.
      if (expectedBase && state.baseUrl && state.baseUrl !== codexConfig.withV1(expectedBase)) {
        return { changed: false, reason: "different-endpoint" };
      }
      const previousContent = (snapshot?.files || []).find((f) => f.path === codexConfig.configPath() && f.existed)?.content;
      const previous = codexConfig.readPreviousFromSnapshot(previousContent);
      const result = codexConfig.revertCizi({
        previousModel: previous.model,
        previousModelProvider: previous.modelProvider,
        previousModelCatalogPath: previous.modelCatalogPath,
        previousModelContextWindow: previous.modelContextWindow,
        previousAutoCompactTokenLimit: previous.autoCompactTokenLimit,
        previousReasoningEffort: previous.reasoningEffort,
      });
      const catalogSnapshot = (snapshot?.files || []).find((f) => f.path === codexModelCatalog.catalogPath());
      if (catalogSnapshot?.existed) {
        fs.mkdirSync(path.dirname(codexModelCatalog.catalogPath()), { recursive: true });
        fs.writeFileSync(codexModelCatalog.catalogPath(), catalogSnapshot.content, "utf8");
      } else {
        fs.rmSync(codexModelCatalog.catalogPath(), { force: true });
      }
      log.info("codex", "Codex ayarları ve model kataloğu geri alındı", { restoredCatalog: catalogSnapshot?.existed === true });
      return { ...result, catalogRestored: catalogSnapshot?.existed === true };
    },
  },

  cline: {
    id: "cline", name: "Cline", apiType: "openai",
    files: () => [path.join(home(), ".cline", "data", "globalState.json"), path.join(home(), ".cline", "data", "secrets.json")],
    apply(v) {
      const stateFile = path.join(home(), ".cline", "data", "globalState.json");
      const secretsFile = path.join(home(), ".cline", "data", "secrets.json");
      const state = readJson(stateFile) || {};
      state.actModeApiProvider = "openai";
      state.planModeApiProvider = "openai";
      state.openAiBaseUrl = withoutV1(v.base); // Cline expects base WITHOUT /v1
      state.openAiModelId = v.model;
      state.planModeOpenAiModelId = v.model;
      writeJson(stateFile, state);
      const secrets = readJson(secretsFile) || {};
      secrets.openAiApiKey = v.apiKey;
      writeJson(secretsFile, secrets);
    },
    isApplied(expectedBase) {
      const s = readJson(path.join(home(), ".cline", "data", "globalState.json"));
      const secrets = readJson(path.join(home(), ".cline", "data", "secrets.json"));
      if (!(s?.actModeApiProvider === "openai" && s?.openAiBaseUrl && s?.openAiModelId && secrets?.openAiApiKey)) return false;
      return expectedBase ? s.openAiBaseUrl === withoutV1(expectedBase) : true;
    },
    matches(v) {
      const s = readJson(path.join(home(), ".cline", "data", "globalState.json"));
      const secrets = readJson(path.join(home(), ".cline", "data", "secrets.json"));
      return s?.actModeApiProvider === "openai"
        && s?.planModeApiProvider === "openai"
        && s?.openAiBaseUrl === withoutV1(v.base)
        && s?.openAiModelId === v.model
        && s?.planModeOpenAiModelId === v.model
        && secrets?.openAiApiKey === v.apiKey;
    },
    cleanup(expectedBase) {
      const stateFile = path.join(home(), ".cline", "data", "globalState.json");
      const secretsFile = path.join(home(), ".cline", "data", "secrets.json");
      const state = readJson(stateFile);
      if (!state || (expectedBase && state.openAiBaseUrl !== withoutV1(expectedBase))) return { changed: false, reason: "different-endpoint" };
      const next = { ...state };
      for (const key of ["actModeApiProvider", "planModeApiProvider", "openAiBaseUrl", "openAiModelId", "planModeOpenAiModelId"]) delete next[key];
      writeJson(stateFile, next);
      const secrets = readJson(secretsFile);
      if (secrets) {
        const nextSecrets = { ...secrets };
        delete nextSecrets.openAiApiKey;
        writeJson(secretsFile, nextSecrets);
      }
      return { changed: true, files: [stateFile, secretsFile] };
    },
  },

  kilo: {
    id: "kilo", name: "Kilo Code", apiType: "openai",
    files: () => [path.join(home(), ".local", "share", "kilo", "auth.json"), vscodeSettingsPath()],
    apply(v) {
      const authFile = path.join(home(), ".local", "share", "kilo", "auth.json");
      const auth = readJson(authFile) || {};
      auth["openai-compatible"] = { type: "api-key", apiKey: v.apiKey, baseUrl: withV1(v.base), model: v.model };
      writeJson(authFile, auth);
      // Best-effort VS Code settings
      try {
        const vsFile = vscodeSettingsPath();
        const vs = readJson(vsFile) || {};
        vs["kilocode.customProvider"] = { name: "Cizi Code", baseURL: withV1(v.base), apiKey: v.apiKey };
        vs["kilocode.defaultModel"] = v.model;
        writeJson(vsFile, vs);
      } catch { /* ignore */ }
    },
    isApplied(expectedBase) {
      const a = readJson(path.join(home(), ".local", "share", "kilo", "auth.json"));
      const oc = a && (a["openai-compatible"] || a["cizicode"] || a["9router"]);
      if (!oc?.apiKey || !oc?.model) return false;
      return expectedBase ? oc.baseUrl === withV1(expectedBase) : true;
    },
    matches(v) {
      const a = readJson(path.join(home(), ".local", "share", "kilo", "auth.json"));
      const oc = a?.["openai-compatible"];
      return oc?.baseUrl === withV1(v.base) && oc?.apiKey === v.apiKey && oc?.model === v.model;
    },
    cleanup(expectedBase) {
      const authFile = path.join(home(), ".local", "share", "kilo", "auth.json");
      const auth = readJson(authFile);
      const provider = auth?.["openai-compatible"];
      if (!provider || (expectedBase && provider.baseUrl !== withV1(expectedBase))) return { changed: false, reason: "different-endpoint" };
      const nextAuth = { ...auth };
      delete nextAuth["openai-compatible"];
      writeJson(authFile, nextAuth);
      const vsFile = vscodeSettingsPath();
      const vs = readJson(vsFile);
      if (vs?.["kilocode.customProvider"]?.baseURL === withV1(expectedBase)) {
        const nextVs = { ...vs };
        delete nextVs["kilocode.customProvider"];
        delete nextVs["kilocode.defaultModel"];
        writeJson(vsFile, nextVs);
      }
      return { changed: true, files: [authFile, vsFile] };
    },
  },

  roocode: {
    // Roo Code is a VS Code extension (Cline fork). Configured via VS Code user settings.
    id: "roocode", name: "Roo Code", apiType: "openai",
    files: () => [vscodeSettingsPath()],
    apply(v) {
      const vsFile = vscodeSettingsPath();
      const vs = readJson(vsFile) || {};
      vs["roo-cline.apiProvider"] = "openai";
      vs["roo-cline.openAiBaseUrl"] = withV1(v.base);
      vs["roo-cline.openAiApiKey"] = v.apiKey;
      vs["roo-cline.openAiModelId"] = v.model;
      writeJson(vsFile, vs);
    },
    isApplied(expectedBase) {
      const vs = readJson(vscodeSettingsPath());
      if (!(vs?.["roo-cline.apiProvider"] === "openai"
        && vs?.["roo-cline.openAiBaseUrl"]
        && vs?.["roo-cline.openAiApiKey"]
        && vs?.["roo-cline.openAiModelId"])) return false;
      return expectedBase ? vs["roo-cline.openAiBaseUrl"] === withV1(expectedBase) : true;
    },
    matches(v) {
      const vs = readJson(vscodeSettingsPath());
      return vs?.["roo-cline.apiProvider"] === "openai"
        && vs?.["roo-cline.openAiBaseUrl"] === withV1(v.base)
        && vs?.["roo-cline.openAiApiKey"] === v.apiKey
        && vs?.["roo-cline.openAiModelId"] === v.model;
    },
    cleanup(expectedBase) {
      const file = vscodeSettingsPath();
      const vs = readJson(file);
      if (!vs || (expectedBase && vs["roo-cline.openAiBaseUrl"] !== withV1(expectedBase))) return { changed: false, reason: "different-endpoint" };
      const next = { ...vs };
      for (const key of ["roo-cline.apiProvider", "roo-cline.openAiBaseUrl", "roo-cline.openAiApiKey", "roo-cline.openAiModelId"]) delete next[key];
      writeJson(file, next);
      return { changed: true, file };
    },
  },

  opencode: {
    id: "opencode", name: "OpenCode", apiType: "openai",
    files: () => [path.join(home(), ".config", "opencode", "opencode.json")],
    apply(v) {
      const file = path.join(home(), ".config", "opencode", "opencode.json");
      const cfg = readJson(file) || {};
      const models = (Array.isArray(v.models) && v.models.length ? v.models : [v.model]).filter(Boolean);
      const modelsMap = {};
      for (const m of models) modelsMap[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
      cfg.provider = {
        ...(cfg.provider || {}),
        cizicode: {
          npm: "@ai-sdk/openai-compatible",
          options: { ...((cfg.provider?.cizicode || {}).options || {}), baseURL: withV1(v.base), apiKey: v.apiKey || "sk_cizicode" },
          models: modelsMap,
        },
      };
      cfg.model = `cizicode/${v.model || models[0]}`;
      cfg.agent = { ...(cfg.agent || {}), explorer: { description: "Fast explorer subagent", mode: "subagent", model: `cizicode/${v.model || models[0]}` } };
      writeJson(file, cfg);
    },
    isApplied(expectedBase) {
      const cfg = readJson(path.join(home(), ".config", "opencode", "opencode.json"));
      if (!cfg?.provider?.cizicode?.options?.apiKey || !cfg?.model?.startsWith("cizicode/")) return false;
      return expectedBase ? cfg.provider.cizicode?.options?.baseURL === withV1(expectedBase) : true;
    },
    matches(v) {
      const cfg = readJson(path.join(home(), ".config", "opencode", "opencode.json"));
      return cfg?.provider?.cizicode?.options?.baseURL === withV1(v.base)
        && cfg?.provider?.cizicode?.options?.apiKey === v.apiKey
        && cfg?.model === `cizicode/${v.model}`;
    },
    cleanup(expectedBase) {
      const file = path.join(home(), ".config", "opencode", "opencode.json");
      const cfg = readJson(file);
      const provider = cfg?.provider?.cizicode;
      if (!provider || (expectedBase && provider.options?.baseURL !== withV1(expectedBase))) return { changed: false, reason: "different-endpoint" };
      const next = { ...cfg, provider: { ...(cfg.provider || {}) } };
      delete next.provider.cizicode;
      if (Object.keys(next.provider).length === 0) delete next.provider;
      if (String(next.model || "").startsWith("cizicode/")) delete next.model;
      if (next.agent?.explorer?.model?.startsWith("cizicode/")) {
        next.agent = { ...next.agent };
        delete next.agent.explorer;
        if (Object.keys(next.agent).length === 0) delete next.agent;
      }
      writeJson(file, next);
      return { changed: true, file };
    },
  },
};

function listToolIds() { return Object.keys(TOOLS); }
function getTool(id) { return TOOLS[id] || null; }

module.exports = { TOOLS, listToolIds, getTool };
