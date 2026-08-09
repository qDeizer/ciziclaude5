// Per-tool local config registry for the Cizi Code desktop app.
// Faithfully ports the gateway's own cli-tools config shapes, but writes to the
// END USER's machine. Revert is handled by exact full-file snapshot restore
// (see backup.js), so each tool only needs: file list, apply(write), isApplied(detect).
const os = require("os");
const fs = require("fs");
const path = require("path");
// Minimal TOML helpers. Only handles Codex's flat key = val and [section]
// shapes, which is enough for config.toml round-tripping here.
function parseSimpleToml(text) {
  const out = {};
  let current = out;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sec = t.match(/^\[(.+?)\]$/);
    if (sec) {
      const parts = sec[1].split(".");
      let obj = out;
      for (const p of parts) obj = obj[p] = obj[p] || {};
      current = obj;
      continue;
    }
    const kv = t.match(/^(\S+)\s*=\s*(.+)$/);
    if (kv) {
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      current[kv[1]] = v;
    }
  }
  return out;
}
function stringifySimpleToml(obj) {
  const lines = [];
  emitTomlObject(lines, "", obj || {});
  return lines.join("\n") + "\n";
}
function emitTomlObject(lines, prefix, obj) {
  const tables = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) tables.push([k, v]);
    else lines.push(`${k} = ${formatTomlVal(v)}`);
  }
  for (const [k, inner] of tables) {
    const section = prefix ? `${prefix}.${k}` : k;
    lines.push(`[${section}]`);
    emitTomlObject(lines, section, inner);
  }
}
function formatTomlVal(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(formatTomlVal).join(", ")}]`;
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

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

// Tool definitions. values = { base, apiKey, model, opus, sonnet, haiku, models }
//   base    - gateway origin (no /v1)
//   model   - chosen model name for this tool
//   opus/sonnet/haiku - model per Claude slot (Claude Code CLI only)
//   models  - model names available for multi-model tools
const TOOLS = {
  "claude-code": {
    id: "claude-code", name: "Claude Code CLI", apiType: "anthropic",
    files: () => [path.join(home(), ".claude", "settings.json")],
    apply(v) {
      const file = path.join(home(), ".claude", "settings.json");
      const cur = readJson(file) || {};
      const next = {
        ...cur,
        hasCompletedOnboarding: true,
        env: {
          ...(cur.env || {}),
          ANTHROPIC_BASE_URL: withV1(v.base),
          ANTHROPIC_AUTH_TOKEN: v.apiKey,
          ANTHROPIC_DEFAULT_OPUS_MODEL: v.opus || v.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: v.sonnet || v.model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: v.haiku || v.model,
        },
      };
      writeJson(file, next);
    },
    // "applied" = configured to use THIS Cizi gateway. When expectedBase is given we
    // require the URL to match it, so a tool pointed at a *different* endpoint (e.g. the
    // user's own/local gateway) is correctly reported as "not connected".
    isApplied(expectedBase) {
      const cfg = readJson(path.join(home(), ".claude", "settings.json"));
      const url = cfg?.env?.ANTHROPIC_BASE_URL;
      if (!url) return false;
      return expectedBase ? url === withV1(expectedBase) : true;
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

      const next = { ...cfg };
      if (Object.keys(nextEnv).length > 0) next.env = nextEnv;
      else delete next.env;
      writeJson(file, next);
      return { changed: true, file };
    },
  },

  codex: {
    id: "codex", name: "Codex CLI", apiType: "openai",
    files: () => [path.join(home(), ".codex", "cizicode.config.toml")],
    apply(v) {
      const cfgFile = path.join(home(), ".codex", "cizicode.config.toml");
      const config = {
        model: v.model,
        model_provider: "cizicode",
        model_providers: {
          cizicode: {
            name: "Cizi Code",
            base_url: withV1(v.base),
            wire_api: "responses",
            experimental_bearer_token: v.apiKey,
          },
        },
      };
      writeText(cfgFile, stringifySimpleToml(config));
    },
    isApplied(expectedBase) {
      const txt = readText(path.join(home(), ".codex", "cizicode.config.toml")) || "";
      const isCizi = txt.includes('model_provider = "cizicode"') || txt.includes("[model_providers.cizicode]");
      if (!isCizi) return false;
      return expectedBase ? txt.includes(`base_url = "${withV1(expectedBase)}"`) : true;
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
      if (!(s?.actModeApiProvider === "openai" && s?.openAiBaseUrl)) return false;
      return expectedBase ? s.openAiBaseUrl === withoutV1(expectedBase) : true;
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
      if (!oc) return false;
      return expectedBase ? oc.baseUrl === withV1(expectedBase) : true;
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
      if (!(vs?.["roo-cline.apiProvider"] === "openai" && vs?.["roo-cline.openAiBaseUrl"])) return false;
      return expectedBase ? vs["roo-cline.openAiBaseUrl"] === withV1(expectedBase) : true;
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
      if (!cfg?.provider?.cizicode) return false;
      return expectedBase ? cfg.provider.cizicode?.options?.baseURL === withV1(expectedBase) : true;
    },
  },
};

function listToolIds() { return Object.keys(TOOLS); }
function getTool(id) { return TOOLS[id] || null; }

module.exports = { TOOLS, listToolIds, getTool };
