// Smoke test for the per-tool config writer + exact backup/restore.
// Mocks Electron's app.getPath and points HOME at a temp dir, then for each tool:
//   1. seeds a pre-existing config, 2. snapshots + applies, 3. asserts Cizi config written,
//   4. reverts, 5. asserts the ORIGINAL bytes are restored exactly.
const os = require("os");
const fs = require("fs");
const path = require("path");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-home-"));
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-ud-"));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;
process.env.APPDATA = path.join(tmpHome, "AppData", "Roaming");

// Mock electron module (backup.js uses app.getPath).
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => tmpUserData } };
  return origLoad.call(this, request, parent, isMain);
};

const { getTool, listToolIds } = require("./src/main/tools/registry");
const { applyTool, revertTool, getToolStatus } = require("./src/main/tools/apply");

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };

const values = { base: "https://interface.cizicode.me", apiKey: "sk-cizi-TEST", model: "Opus-4.8", opus: "Opus-4.8", sonnet: "Sonnet-4.5", haiku: "Sonnet-4.5", models: ["Opus-4.8", "Sonnet-4.5"] };

// Codex writes into the shared ~/.codex/config.toml that ChatGPT Desktop also
// owns, so its seed is real TOML and its revert is surgical rather than a
// whole-file restore.
const CODEX_SEED = [
  '# kept by the user',
  'model = "gpt-5.6-sol"',
  'model_reasoning_effort = "high"',
  '',
  '[desktop]',
  'followUpQueueMode = "queue"',
  '',
  '[projects.\'c:\\users\\emre\']',
  'trust_level = "trusted"',
  '',
].join("\n");

for (const id of listToolIds()) {
  const tool = getTool(id);
  console.log(`\n[${id}]`);
  // Seed a pre-existing config in the FIRST file so we can verify restore.
  const files = tool.files();
  const original = id === "codex" ? CODEX_SEED : JSON.stringify({ existingUserKey: "keep-me", note: id }, null, 2);
  fs.mkdirSync(path.dirname(files[0]), { recursive: true });
  fs.writeFileSync(files[0], original);

  assert(!tool.isApplied(), "should not be applied before");
  const a = applyTool(id, values);
  assert(a.applied, "isApplied true after apply");
  assert(a.hasBackup, "backup taken on apply");
  // Cizi config present (base url string appears somewhere in the written files)
  const blob = files.map((f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } }).join("\n");
  assert(/interface\.cizicode\.me/.test(blob), "gateway base url written");
  assert(/sk-cizi-TEST/.test(blob), "api key written");
  if (id === "codex") {
    assert(/experimental_bearer_token\s*=\s*"sk-cizi-TEST"/.test(blob), "Codex token is written directly to its provider config");
    assert(!/env_key\s*=/.test(blob), "Codex config does not depend on an environment variable");
    assert(files[0].endsWith(".codex" + path.sep + "config.toml"), "Codex uses the config file both products share");
    assert(/\[desktop\]/.test(blob) && /followUpQueueMode/.test(blob), "the Desktop app's own settings survive apply");
    assert(/trust_level = "trusted"/.test(blob), "project trust settings survive apply");
    assert(/# kept by the user/.test(blob), "user comments survive apply");
  }

  const r = revertTool(id);
  assert(id === "codex" ? r.surgical : r.restored, "revert undid the change");
  assert(!tool.isApplied(), "not applied after revert");
  const after = fs.readFileSync(files[0], "utf-8");
  if (id === "codex") {
    // Only Cizi Code's own keys go away; everything the user or the Desktop app
    // put in the file stays exactly where it was.
    assert(!/cizicode/.test(after), "no Cizi Code provider left after revert");
    assert(!/sk-cizi-TEST/.test(after), "no API key left after revert");
    assert(/model = "gpt-5.6-sol"/.test(after), "the user's own model is restored");
    assert(/# kept by the user/.test(after), "user comments survive revert");
    assert(/\[desktop\]\r?\nfollowUpQueueMode = "queue"/.test(after), "the Desktop app's own settings survive revert");
    assert(/\[projects\.'c:\\users\\emre'\]/.test(after), "quoted table names survive revert");
    assert(/model_reasoning_effort = "high"/.test(after), "unrelated top-level settings survive revert");
  } else {
    assert(after === original, "first config file restored EXACTLY to original bytes");
  }
  // extra files that didn't exist before should be gone
  for (let i = 1; i < files.length; i++) {
    assert(!fs.existsSync(files[i]), `extra file removed on revert: ${path.basename(files[i])}`);
  }
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
