// Contract checks for the renderer-owned CLI boundary.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const main = read("src/main/main.js");
const preload = read("src/main/preload.js");
const renderer = read("src/renderer/renderer.js");
const cliUi = read("src/renderer/cliUi.js");
const cli = read("scripts/cizi-cli.cjs");

assert(main.includes('require("./cliBridge")'), "main must compose the CLI bridge");
assert(main.includes('ipcMain.on("cizi:cliResponse"'), "main must accept renderer CLI replies");
assert(preload.includes("onCliRequest"), "preload must expose renderer CLI requests");
assert(renderer.includes("window.ciziCliUi.handle"), "renderer must own CLI UI dispatch");
assert(cliUi.includes("element.click()"), "CLI click must dispatch a DOM click");
assert(cliUi.includes('dispatchEvent(new Event("change"'), "CLI list/switch actions must dispatch UI events");
assert(!cli.includes("cizi.applyTool") && !cli.includes("cizi.login"), "CLI must not call application actions directly");

const help = spawnSync(process.execPath, [path.join(root, "scripts", "cizi-cli.cjs"), "help"], {
  cwd: root,
  encoding: "utf8",
});
assert.strictEqual(help.status, 0, `CLI help failed: ${help.stderr}`);
const helpJson = JSON.parse(help.stdout);
assert(helpJson?.ok && helpJson.data?.commands?.click, "CLI help must be readable JSON");
assert(!/sk-cizi-[A-Za-z0-9_-]{8,}/i.test(help.stdout), "CLI help must not contain a real API key");

console.log("✅ CLI contract checks passed");
