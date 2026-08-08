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

for (const id of listToolIds()) {
  const tool = getTool(id);
  console.log(`\n[${id}]`);
  // Seed a pre-existing config in the FIRST file so we can verify exact restore.
  const files = tool.files();
  const original = JSON.stringify({ existingUserKey: "keep-me", note: id }, null, 2);
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

  const r = revertTool(id);
  assert(r.restored, "revert restored");
  assert(!tool.isApplied(), "not applied after revert");
  const after = fs.readFileSync(files[0], "utf-8");
  assert(after === original, "first config file restored EXACTLY to original bytes");
  // extra files that didn't exist before should be gone
  for (let i = 1; i < files.length; i++) {
    assert(!fs.existsSync(files[i]), `extra file removed on revert: ${path.basename(files[i])}`);
  }
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
