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
const codexCli = read("src/main/codexCli.js");

assert(main.includes('require("./cliBridge")'), "main must compose the CLI bridge");
assert(main.includes('ipcMain.on("cizi:cliResponse"'), "main must accept renderer CLI replies");
assert(main.includes('mainWindow.show();'), "a second launch must reveal an existing hidden Cizi Code window");
assert(main.includes('Cizi Code existing instance was brought to foreground'), "revealing an existing instance must be logged");
assert(preload.includes("onCliRequest"), "preload must expose renderer CLI requests");
assert(renderer.includes("window.ciziCliUi.handle"), "renderer must own CLI UI dispatch");
assert(cliUi.includes("element.click()"), "CLI click must dispatch a DOM click");
assert(cliUi.includes('dispatchEvent(new Event("change"'), "CLI list/switch actions must dispatch UI events");
assert(!cli.includes("cizi.applyTool") && !cli.includes("cizi.login"), "CLI must not call application actions directly");
assert(main.includes("cizi:getCodexCliStatus"), "main must expose Codex CLI status through the UI boundary");
assert(preload.includes("installCodexCli"), "preload must expose Codex CLI install action");
assert(preload.includes("openCodexCli: (model, useCiziProfile)"), "preload must pass the optional Cizi Code profile choice to Codex open");
assert(renderer.includes("codex-cli.install"), "renderer must expose the Codex CLI install control");
assert(renderer.includes('"codex-cli"'), "renderer must expose the Codex configuration switch");
assert(renderer.includes("!!st.applied"), "Codex open must use the Cizi Code profile only when its switch is enabled");
assert(cli.includes("codex-cli.install"), "CLI bridge must allow the long-running Codex install action");
assert(codexCli.includes("https://chatgpt.com/codex/install.ps1"), "Codex installer must use the official Windows installer URL");
assert(codexCli.includes('percent: null, message: "Downloading the official Codex installer..."'), "Codex installer must mark an unknown download percentage as indeterminate");
assert(renderer.includes('stepPercent > 0 || rawActive?.status === "done"'), "Codex activity must not present an unknown installer percentage as 0%");
assert(codexCli.includes('CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "0"'), "Codex installer must use the reachable official GitHub Releases fallback when configured");
assert(codexCli.includes("Last installer step:"), "Codex installation errors must expose the final official-installer step");
assert(codexCli.includes("Recovered stale Codex CLI installer lock"), "Codex installer must recover a lock left behind by a stopped installer");
assert(codexCli.includes("Official Codex package size resolved"), "Codex installer must resolve the official package size for download percentages");
assert(codexCli.includes("Downloading official Codex package: ${formatBytes(archive.stat.size)} / ${formatBytes(packageTotalBytes)}"), "Codex installer must show received and total package bytes with a percentage");

const help = spawnSync(process.execPath, [path.join(root, "scripts", "cizi-cli.cjs"), "help"], {
  cwd: root,
  encoding: "utf8",
});
assert.strictEqual(help.status, 0, `CLI help failed: ${help.stderr}`);
const helpJson = JSON.parse(help.stdout);
assert(helpJson?.ok && helpJson.data?.commands?.click, "CLI help must be readable JSON");
assert(!/sk-cizi-[A-Za-z0-9_-]{8,}/i.test(help.stdout), "CLI help must not contain a real API key");

console.log("✅ CLI contract checks passed");
