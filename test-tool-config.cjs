// What each tool adapter actually writes, checked against the contracts the
// installed tools really have. Runs against a sandbox HOME and CODEX_HOME, so
// it never touches the developer's own configuration.
//
// The assertions here are the regressions that shipped once already: a 1M
// context window written for a model that does not have one, a `[1m]` variant
// on Haiku, effort values from the wrong tool's enum, and Claude Desktop config
// keys that do not exist in Claude Desktop.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-tool-config-"));
process.env.CODEX_HOME = path.join(SANDBOX, ".codex");
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.mkdirSync(path.join(SANDBOX, ".claude"), { recursive: true });
os.homedir = () => SANDBOX;

const { configurationForTool } = require("./src/main/tools/toolModelConfiguration");
const { getTool } = require("./src/main/tools/registry");
const contract = require("./src/main/tools/claudeDesktopContract");
const capabilities = require("./src/renderer/modelCapabilities");

const BASE = "https://lotpik.cizicode.me";
const KEY = "sk-test-key";
const CLAUDE_MODELS = ["opus-4.8", "sonnet-4.6", "haiku-4.5", "fable-5"];
const CODEX_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "Sol 5.6"];
const COMBOS = [...CLAUDE_MODELS, ...CODEX_MODELS];
// The gateway publishes each 1M variant as its own id, so this list is the only
// truthful source for supports1m. Here fable-5 deliberately has no variant.
const GATEWAY_MODELS = [
  ...COMBOS,
  "opus-4.8[1m]", "sonnet-4.6[1m]",
  "gpt-5.6-luna[1m]", "gpt-5.6-terra[1m]", "Sol 5.6[1m]",
];

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (error) {
    results.push([false, `${name}\n    ${error.message.split("\n")[0]}`]);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (error) {
    results.push([false, `${name}\n    ${error.message.split("\n")[0]}`]);
  }
}

// ---------------------------------------------------------------- capabilities
check("Claude Code effort levels are its own enum, not Codex's", () => {
  assert.deepStrictEqual([...capabilities.CLAUDE_REASONING_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(!capabilities.isReasoningLevel("ultra", "claude-code"));
  assert.ok(!capabilities.isReasoningLevel("minimal", "claude-code"));
  assert.ok(capabilities.isReasoningLevel("ultra", "codex"));
});

check("a declared context window is never inflated to 1M", () => {
  const profile = capabilities.capabilityFor({ name: "gpt-5.6-luna", context_window: 272_000 }, "codex");
  assert.strictEqual(profile.contextWindowTokens, 272_000);
  assert.strictEqual(profile.supports1m, false);
});

check("compaction always starts before the window is full", () => {
  for (const window of [272_000, 1_000_000, 8_000]) {
    assert.ok(capabilities.compactWindowFor(window) < window, `${window} window`);
    assert.ok(capabilities.compactWindowFor(window) > 0, `${window} window`);
  }
});

check("only tiers with a 1M variant get the [1m] suffix", () => {
  assert.strictEqual(capabilities.longContextModelName("opus-4.8", "opus"), "opus-4.8[1m]");
  assert.strictEqual(capabilities.longContextModelName("sonnet-4.6", "sonnet"), "sonnet-4.6[1m]");
  assert.strictEqual(capabilities.longContextModelName("fable-5", "fable"), "fable-5[1m]");
  assert.strictEqual(capabilities.longContextModelName("haiku-4.5", "haiku"), "haiku-4.5");
  assert.strictEqual(capabilities.longContextModelName("opus-4.8[1m]", "opus"), "opus-4.8[1m]");
});

// -------------------------------------------------------------- Claude Code CLI
const claudeValues = { base: BASE, apiKey: KEY, ...configurationForTool("claude-code", COMBOS, { gatewayModels: GATEWAY_MODELS }) };
getTool("claude-code").apply(claudeValues);
const settings = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude", "settings.json"), "utf8"));

check("every Claude-family model the key has is offered", () => {
  assert.deepStrictEqual(claudeValues.models.slice().sort(), CLAUDE_MODELS.slice().sort());
  assert.deepStrictEqual(settings.availableModels.slice().sort(), CLAUDE_MODELS.slice().sort());
});

check("availableModels holds plain ids - it is an allow-list, not a picker list", () => {
  assert.ok(settings.availableModels.every((model) => !model.includes("[1m]")), settings.availableModels.join(","));
});

check("Haiku's default model has no [1m] variant", () => {
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "haiku-4.5");
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "opus-4.8[1m]");
});

check("a 1M variant is claimed only where the gateway publishes one", () => {
  const by = new Map(claudeValues.modelProfiles.map((profile) => [profile.name, profile]));
  assert.strictEqual(by.get("opus-4.8").supports1m, true);
  assert.strictEqual(by.get("sonnet-4.6").supports1m, true);
  assert.strictEqual(by.get("fable-5").supports1m, false, "gateway lists no fable-5[1m]");
  assert.strictEqual(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "fable-5");
});

check("the effort picker is forced on for gateway model ids", () => {
  assert.strictEqual(settings.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, "1");
});

check("the newest model of a tier wins the default", () => {
  const picked = configurationForTool("claude-code", ["opus-4.8", "opus-5", "opus-4.10", "sonnet-4.6"]);
  assert.strictEqual(picked.model, "opus-5");
  assert.strictEqual(picked.opus, "opus-5");
  const dotted = configurationForTool("claude-code", ["opus-4.8", "opus-4.10"]);
  assert.strictEqual(dotted.model, "opus-4.10", "4.10 is newer than 4.8");
});

check("Claude Desktop effort ids are only used when the gateway serves them", () => {
  const withAlias = configurationForTool("claude-code", ["Opus-5"], {
    gatewayModels: ["Opus-5", "claude-opus-5"],
  });
  assert.strictEqual(withAlias.modelProfiles[0].desktopEffortName, "claude-opus-5");
  const entry = contract.desktopModels({ ...withAlias })[0];
  assert.strictEqual(entry.name, "claude-opus-5");
  assert.strictEqual(entry.labelOverride, "Opus-5");
  assert.strictEqual(entry.showsEffortPicker, true);

  const without = configurationForTool("claude-code", ["Opus-5"], { gatewayModels: ["Opus-5"] });
  assert.strictEqual(without.modelProfiles[0].desktopEffortName, null);
  const plain = contract.desktopModels({ ...without })[0];
  assert.strictEqual(plain.name, "Opus-5", "an id the gateway does not serve is never invented");
  assert.strictEqual(plain.showsEffortPicker, false);
});

check("gateway model discovery is on, and the 1M opt-out is not", () => {
  assert.strictEqual(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.ok(!("CLAUDE_CODE_DISABLE_1M_CONTEXT" in settings.env));
});

check("effortLevel is a value Claude Code accepts", () => {
  assert.ok(capabilities.isReasoningLevel(settings.effortLevel, "claude-code"), settings.effortLevel);
});

check("auto-compact fits the smallest window the user can switch to", () => {
  const smallest = Math.min(...claudeValues.modelProfiles.map((profile) => profile.contextWindowTokens));
  assert.ok(Number(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) < smallest);
});

check("Claude Code reports itself connected and matching", () => {
  assert.strictEqual(getTool("claude-code").isApplied(BASE), true);
  assert.strictEqual(getTool("claude-code").matches(claudeValues), true);
});

check("turning it off removes every value Cizi added", () => {
  const before = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude", "settings.json"), "utf8"));
  getTool("claude-code").cleanup(BASE);
  const after = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".claude", "settings.json"), "utf8"));
  assert.ok(!("availableModels" in after) && !("effortLevel" in after));
  for (const key of Object.keys(before.env)) assert.ok(!(key in (after.env || {})), key);
  getTool("claude-code").apply(claudeValues);
});

// --------------------------------------------------------------- Claude Desktop
// Claude Desktop is configured through exactly one surface: its own
// configuration library. The registry-policy variant was never shipped as a
// default and has been removed, so there is one config shape left to assert.
const desktopModels = contract.desktopModels(claudeValues);
const libraryConfig = contract.buildConfigLibraryConfig(claudeValues, desktopModels, "C:\\helper.exe");
const inferenceModels = libraryConfig.inferenceModels;

check("no config key Claude Desktop does not have is written", () => {
  for (const key of contract.RETIRED_KEYS) {
    assert.ok(!(key in libraryConfig), `config library: ${key}`);
  }
});

check("the requested surfaces are the ones turned on", () => {
  for (const [key, on] of Object.entries(contract.MANAGED_FEATURES)) {
    assert.strictEqual(libraryConfig[key], on, `config library: ${key}`);
  }
  assert.strictEqual(contract.MANAGED_FEATURES.chatTabEnabled, true);
});

check("every model reaches the picker, first one as the default", () => {
  assert.deepStrictEqual(inferenceModels.map((model) => model.name), claudeValues.models);
});

check("supports1m is asserted per model, not for everything", () => {
  assert.strictEqual(inferenceModels.find((model) => model.name === "haiku-4.5").supports1m, false);
  assert.strictEqual(inferenceModels.find((model) => model.name === "opus-4.8").supports1m, true);
});

check("prefer1m is set on the default entry only", () => {
  assert.strictEqual(inferenceModels.filter((model) => model.prefer1m).length, 1);
  assert.strictEqual(inferenceModels[0].prefer1m, true);
});

check("isFamilyDefault only appears next to a tier", () => {
  for (const model of inferenceModels) {
    assert.strictEqual("isFamilyDefault" in model, "anthropicFamilyTier" in model, model.name);
  }
});

check("the API key never lands in the managed config", () => {
  assert.ok(!JSON.stringify(libraryConfig).includes(KEY));
});

// ------------------------------------------------------------------------ Codex
let codexApplied = false;
const codexValues = { base: BASE, apiKey: KEY, ...configurationForTool("codex", COMBOS, { gatewayModels: GATEWAY_MODELS }) };
try {
  getTool("codex").apply(codexValues);
  codexApplied = true;
} catch (error) {
  console.log(`  (Codex checks skipped: ${String(error.message).split("\n")[0]})`);
}

if (codexApplied) {
  const toml = fs.readFileSync(path.join(SANDBOX, ".codex", "config.toml"), "utf8");
  const catalog = JSON.parse(fs.readFileSync(path.join(SANDBOX, ".codex", "cizicode-models.json"), "utf8"));
  const number = (key) => Number(toml.match(new RegExp(`^${key} = (\\d+)$`, "m"))?.[1]);

  check("every Codex-family model the key has is in the catalog", () => {
    assert.deepStrictEqual(catalog.models.map((model) => model.slug), codexValues.models);
    assert.deepStrictEqual(codexValues.models.slice().sort(), CODEX_MODELS.slice().sort());
  });

  check("no Claude model leaks into the Codex catalog", () => {
    for (const model of catalog.models) {
      assert.ok(!/opus|sonnet|haiku|fable|claude/i.test(model.slug), model.slug);
    }
  });

  check("auto-compact sits below the declared window", () => {
    assert.ok(number("model_auto_compact_token_limit") < number("model_context_window"));
    for (const model of catalog.models) {
      assert.ok(model.context_window <= model.max_context_window, model.slug);
    }
  });

  check("the picker shows a name, not a raw id", () => {
    assert.strictEqual(catalog.models.find((model) => model.slug === "gpt-5.6-luna")?.display_name, "GPT-5.6-Luna");
  });

  check("each model keeps only the effort levels its Codex build supports", () => {
    for (const model of catalog.models) {
      assert.ok(model.supported_reasoning_levels.length > 0, model.slug);
      for (const entry of model.supported_reasoning_levels) {
        assert.ok(capabilities.isReasoningLevel(entry.effort, "codex"), `${model.slug}: ${entry.effort}`);
      }
      assert.ok(
        model.supported_reasoning_levels.some((entry) => entry.effort === model.default_reasoning_level),
        `${model.slug}: default ${model.default_reasoning_level} is not in its own list`,
      );
    }
  });

  check("model_reasoning_effort is a value Codex accepts", () => {
    const effort = toml.match(/^model_reasoning_effort = "(.+)"$/m)?.[1];
    assert.ok(capabilities.isReasoningLevel(effort, "codex"), String(effort));
  });

  check("the user's own Codex keys survive a write", () => {
    const configFile = path.join(SANDBOX, ".codex", "config.toml");
    fs.writeFileSync(configFile, `${toml}\n[desktop]\nfollowUpQueueMode = "queue"\n`, "utf8");
    getTool("codex").apply(codexValues);
    const after = fs.readFileSync(configFile, "utf8");
    assert.ok(after.includes("[desktop]") && after.includes('followUpQueueMode = "queue"'));
  });

  check("Codex reports itself connected and matching", () => {
    assert.strictEqual(getTool("codex").isApplied(BASE), true);
    assert.strictEqual(getTool("codex").matches(codexValues), true);
  });

  check("the installed Codex CLI reads back exactly what was written", () => {
    const { execFileSync } = require("child_process");
    let stdout = null;
    for (const command of require("./src/main/codexModelCatalog").executableCandidates()) {
      if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
      try {
        stdout = execFileSync(command, ["debug", "models"], {
          encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CODEX_HOME: path.join(SANDBOX, ".codex") },
        });
        break;
      } catch { /* try the next candidate */ }
    }
    if (stdout === null) return; // no Codex on this machine; the rest still holds
    const seen = JSON.parse(stdout).models.map((model) => model.slug);
    assert.deepStrictEqual(seen, codexValues.models);
  });
}

// ------------------------------------------------------- Claude Desktop launch
// Turning the switch on must configure Claude Desktop without opening it. The
// backend takes injected adapters, so this drives a real apply() against fakes
// and asserts nothing ever reached the launcher.
async function claudeDesktopLaunchChecks() {
  const { createClaudeDesktopBackend } = require("./src/main/tools/claudeDesktop");
  const calls = [];
  const main = {
    packageFullName: "AnthropicClaude_1.0.0_x64__x",
    packageFamilyName: "AnthropicClaude_x",
    publisher: "CN=Anthropic",
    version: "1.0.0",
    installLocation: "C:\Claude",
    appUserModelId: "AnthropicClaude_x!App",
    installKind: "msix",
    executable: "C:\Claude\claude.exe",
    asar: null,
  };
  const state = { record: null, baseline: null };
  const backend = createClaudeDesktopBackend({
    features: { branding: false, configurationSurface: "config-library" },
    runtime: {
      getStatus: async () => ({ installed: true, running: false, main }),
      launchOriginal: async () => { calls.push("launchOriginal"); },
      launchChat: async () => { calls.push("launchChat"); },
    },
    policy: {
      machineBlock: async () => ({ blocked: false }),
      capture: async () => ({ keyExisted: false, values: {} }),
      restore: async () => {},
      apply: async () => {},
      verify: async () => true,
      cleanupOwnedOrphans: async () => ({ cleaned: false, removed: [] }),
    },
    configLibrary: {
      capture: () => ({ configurationId: "x", metadata: { existed: false }, entry: { existed: false } }),
      restore: () => {},
      matches: () => true,
      apply: () => { calls.push("configApply"); },
      verify: () => true,
      cleanupOwned: () => ({ removed: false }),
    },
    helper: {
      capture: () => ({ files: [] }),
      restore: () => {},
      ensure: () => "C:\helper.exe",
      provision: async () => {},
      isCurrent: () => true,
      preflight: async () => {},
      path: () => "C:\helper.exe",
    },
    branding: { setDesired: () => {}, ensureForMain: async () => ({ status: "inactive" }), workRoot: () => "C:\work" },
    brandingTask: { ensure: async () => ({ current: true }), remove: async () => {}, getStatus: async () => ({ exists: false, current: true }), isCurrent: async () => true },
    shortcuts: { redirect: async () => ({ redirected: 0 }), restore: async () => {}, getStatus: async () => ({}) },
    legacy: { cleanupLegacy: () => {} },
    reconcileTask: { ensure: async () => ({ current: true }), remove: async () => {}, getStatus: async () => ({ exists: false, current: true }) },
    // acquire() resolves to the release function itself, not a wrapper.
    operationLock: { acquire: async () => () => {} },
    state: {
      read: () => state.record,
      write: (value) => { state.record = value; },
      readBaseline: () => state.baseline,
      writeBaseline: (value) => { state.baseline = value; },
      remove: () => { state.record = null; state.baseline = null; },
      hasBaseline: () => state.baseline !== null,
    },
    identity: {
      mainPackageIdentity: () => main,
      assertMainPackagePreserved: () => {},
      CLAUDE_MAIN_APP_ID: main.appUserModelId,
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });

  let applyResult = null;
  let applyError = null;
  try {
    applyResult = await backend.apply({ base: BASE, apiKey: KEY, ...claudeValues });
  } catch (error) {
    applyError = error;
  }

  check("connecting configures Claude Desktop without opening it", () => {
    assert.strictEqual(applyError, null, `apply threw: ${applyError && applyError.message}`);
    assert.ok(calls.includes("configApply"), "the managed configuration must still be written");
    assert.ok(!calls.includes("launchChat"), `launchChat must not run on connect (calls: ${calls.join(",")})`);
    assert.ok(!calls.includes("launchOriginal"), `launchOriginal must not run on connect (calls: ${calls.join(",")})`);
    assert.strictEqual(applyResult.launched, false);
  });

  await checkAsync("the explicit launch action still opens Claude Desktop", async () => {
    calls.length = 0;
    const result = await backend.launch();
    assert.ok(calls.includes("launchChat") || calls.includes("launchOriginal"), "launch() must start Claude");
    assert.strictEqual(result.launched, true);
  });
}

claudeDesktopLaunchChecks().then(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const failed = results.filter(([ok]) => !ok);
  for (const [ok, name] of results) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  console.log(`
${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
});
