// Exercises codexConfigFile against a COPY of the real user config.
const fs = require("fs");
const os = require("os");
const path = require("path");

const sandbox = path.join(os.tmpdir(), "cizi-codex-config-test");
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
const real = path.join(os.homedir(), ".codex", "config.toml");
fs.copyFileSync(real, path.join(sandbox, "config.toml"));
process.env.CODEX_HOME = sandbox;

const cfg = require("./src/main/codexConfigFile.js");
const { parseTOML } = require("confbox");

const original = fs.readFileSync(path.join(sandbox, "config.toml"), "utf8");
const originalParsed = parseTOML(original);

function check(label, condition, extra) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!condition) process.exitCode = 1;
}

// --- state before ---
const before = cfg.readState("https://lotpik.cizicode.me");
check("before: not applied", before.applied === false, `model=${before.model} provider=${before.modelProvider}`);

// --- apply ---
const applied = cfg.applyCizi({ base: "https://lotpik.cizicode.me", apiKey: "sk-test-1234567890", model: "gpt-5.6-luna" });
const afterText = fs.readFileSync(path.join(sandbox, "config.toml"), "utf8");
const afterParsed = parseTOML(afterText);

check("apply: provider set", afterParsed.model_provider === "cizicode");
check("apply: model set", afterParsed.model === "gpt-5.6-luna");
check("apply: base_url", afterParsed.model_providers?.cizicode?.base_url === "https://lotpik.cizicode.me/v1");
check("apply: wire_api", afterParsed.model_providers?.cizicode?.wire_api === "responses");
check("apply: bearer token", afterParsed.model_providers?.cizicode?.experimental_bearer_token === "sk-test-1234567890");
check("apply: backup created", applied.backup && fs.existsSync(applied.backup));
check("apply: previous model recorded", applied.previous.model === originalParsed.model, `got ${applied.previous.model}`);

// every pre-existing key must survive untouched
const preserved = ["notify", "service_tier", "model_reasoning_effort", "desktop", "windows", "features", "mcp_servers", "shell_environment_policy", "marketplaces", "plugins", "projects", "tui"];
for (const key of preserved) {
  check(`apply: preserved '${key}'`, JSON.stringify(afterParsed[key]) === JSON.stringify(originalParsed[key]));
}
check("apply: state reports applied", cfg.readState("https://lotpik.cizicode.me").applied === true);
check("apply: wrong gateway reports not applied", cfg.readState("https://other.example.com").applied === false);

// --- idempotency: applying twice must not duplicate the block ---
cfg.applyCizi({ base: "https://lotpik.cizicode.me", apiKey: "sk-test-1234567890", model: "gpt-5.6-luna" });
const twice = fs.readFileSync(path.join(sandbox, "config.toml"), "utf8");
check("apply twice: single provider header", (twice.match(/\[model_providers\.cizicode\]/g) || []).length === 1);
check("apply twice: single model key", (twice.split(/\r?\n/).filter((l) => /^model\s*=/.test(l))).length === 1);

// --- model switch ---
const switched = cfg.setModel("gpt-5.6-terra");
const switchedParsed = parseTOML(fs.readFileSync(path.join(sandbox, "config.toml"), "utf8"));
check("setModel: model changed", switchedParsed.model === "gpt-5.6-terra", `changed=${switched.changed}`);
check("setModel: provider untouched", switchedParsed.model_providers?.cizicode?.experimental_bearer_token === "sk-test-1234567890");
check("setModel: provider still cizicode", switchedParsed.model_provider === "cizicode");

// --- revert ---
const prev = cfg.readPreviousFromSnapshot(original);
const reverted = cfg.revertCizi({ previousModel: prev.model, previousModelProvider: prev.modelProvider });
const revertedText = fs.readFileSync(path.join(sandbox, "config.toml"), "utf8");
const revertedParsed = parseTOML(revertedText);

check("revert: changed", reverted.changed === true);
check("revert: provider block gone", !revertedParsed.model_providers?.cizicode);
check("revert: model_provider gone", revertedParsed.model_provider === undefined, `got ${revertedParsed.model_provider}`);
check("revert: model restored", revertedParsed.model === originalParsed.model, `got ${revertedParsed.model} want ${originalParsed.model}`);
check("revert: no cizicode text left", !revertedText.includes("cizicode"));
check("revert: no token left", !revertedText.includes("sk-test-1234567890"));
for (const key of preserved) {
  check(`revert: preserved '${key}'`, JSON.stringify(revertedParsed[key]) === JSON.stringify(originalParsed[key]));
}
check("revert: full parse equals original semantics", JSON.stringify(revertedParsed) === JSON.stringify(originalParsed));

// --- fresh machine: no config file at all ---
fs.rmSync(path.join(sandbox, "config.toml"), { force: true });
const fresh = cfg.applyCizi({ base: "https://lotpik.cizicode.me", apiKey: "sk-fresh", model: "gpt-5.6-luna" });
const freshParsed = parseTOML(fs.readFileSync(path.join(sandbox, "config.toml"), "utf8"));
check("fresh: created", freshParsed.model_provider === "cizicode" && freshParsed.model === "gpt-5.6-luna");
check("fresh: no backup expected", fresh.backup === null);
const freshRevert = cfg.revertCizi({ previousModel: null, previousModelProvider: null });
const freshAfter = parseTOML(fs.readFileSync(path.join(sandbox, "config.toml"), "utf8"));
check("fresh revert: empty-ish", freshAfter.model_provider === undefined && !freshAfter.model_providers, `changed=${freshRevert.changed}`);

console.log("\n--- reverted file (first 12 lines) ---");
console.log(revertedText.split(/\r?\n/).slice(0, 12).join("\n"));

// --- removal planning: the shared folder is only ever offered for deletion
// when no other Codex product is left to use it ---
console.log("\n--- removal plans ---");
const codexPaths = require("./src/main/codexPaths.js");
fs.mkdirSync(sandbox, { recursive: true });
const sharedRoot = codexPaths.sharedPaths().root;
const inPlan = (list, target) => (list || []).some((item) => item.path === target);

for (const target of ["desktop", "cli"]) {
  const other = target === "desktop" ? "Codex CLI" : "ChatGPT Desktop";

  const kept = codexPaths.planRemoval({ target, otherInstalled: true });
  check(`${target}: shared folder not deletable while ${other} is installed`, kept.sharedRemovable === false);
  check(`${target}: shared folder not in remove list`, !inPlan(kept.remove, sharedRoot));
  check(`${target}: shared folder listed as preserved`, inPlan(kept.preserve, sharedRoot));

  const alone = codexPaths.planRemoval({ target, otherInstalled: false });
  check(`${target}: shared folder deletable when ${other} is absent`, alone.sharedRemovable === true);
  check(`${target}: shared folder in remove list`, inPlan(alone.remove, sharedRoot));
  check(`${target}: nothing preserved when alone`, (alone.preserve || []).length === 0);
}

// Each product's own paths must never appear in the other's removal plan.
const desktopPlan = codexPaths.planRemoval({ target: "desktop", otherInstalled: true });
const cliPlan = codexPaths.planRemoval({ target: "cli", otherInstalled: true });
const cli = codexPaths.cliPaths();
const desktop = codexPaths.desktopPaths();
check("desktop removal never touches the CLI install", !inPlan(desktopPlan.remove, cli.programDir) && !inPlan(desktopPlan.remove, cli.standaloneDir));
check("CLI removal never touches Desktop state", !inPlan(cliPlan.remove, desktop.packageStateDir) && !inPlan(cliPlan.remove, desktop.runtimeDir));
check("desktop plan rejects unknown targets", (() => {
  try { codexPaths.planRemoval({ target: "nope", otherInstalled: true }); return false; } catch { return true; }
})());
