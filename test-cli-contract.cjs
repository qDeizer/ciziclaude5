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
const claudeCoordinator = read("src/main/claudeCoordinator.js");
const claudeDesktop = read("src/main/tools/claudeDesktop.js");
const claudeLifecycle = read("src/main/tools/claudeLifecycle.js");

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
assert(preload.includes("openCodexCli: (model, useCizi)"), "preload must pass the connection state to Codex open");
assert(renderer.includes('idPrefix: "codex-cli"'), "renderer must expose the Codex CLI controls");
assert(renderer.includes('cliId: `${idPrefix}.install`'), "each Codex product must expose an install control");
assert(renderer.includes('cliId: `${idPrefix}.purge`'), "each Codex product must expose a root-removal control");
assert(renderer.includes('cb.dataset.cliId = "tool.codex.switch"'), "renderer must expose one Codex configuration switch");
assert(renderer.includes("!!st.applied"), "Codex open must forward the gateway model only when its switch is enabled");
assert(cli.includes("codex-cli.install") && cli.includes("codex-desktop.install"), "CLI bridge must allow the long-running Codex install actions");

// ChatGPT Desktop and the Codex CLI share one config file, so one switch has to
// reach both, and every Desktop action needs the same UI/CLI parity.
const codexDesktop = read("src/main/codexDesktop.js");
const codexPaths = read("src/main/codexPaths.js");
const codexConfigFile = read("src/main/codexConfigFile.js");
assert(main.includes("cizi:getCodexDesktopStatus"), "main must expose ChatGPT Desktop status");
assert(main.includes("cizi:installCodexDesktop"), "main must expose ChatGPT Desktop installation");
assert(main.includes("cizi:planCodexDesktopUninstall"), "main must expose the Desktop removal preview");
assert(main.includes("cizi:uninstallCodexDesktop"), "main must expose ChatGPT Desktop removal");
assert(main.includes("cizi:setCodexModel"), "main must expose the Codex model switch");
assert(preload.includes("getCodexState"), "preload must expose the combined Codex state");
assert(preload.includes("installCodexDesktop") && preload.includes("uninstallCodexDesktop"), "preload must expose the Desktop install and removal actions");
assert(renderer.includes('idPrefix: "codex-desktop"'), "renderer must expose the ChatGPT Desktop controls");
assert(renderer.includes('modelSelect.dataset.cliId = "tool.codex.model"'), "renderer must expose the Codex model list to the CLI");
assert(codexPaths.includes('DESKTOP_STORE_ID = "9PLM9XGG6VKS"'), "the Desktop install must use the verified Microsoft Store id");
assert(codexDesktop.includes('"--source", "msstore"'), "ChatGPT Desktop must be installed from the official Microsoft Store source");
assert(codexDesktop.includes("Remove-AppxPackage"), "ChatGPT Desktop must be removed through the supported package mechanism");
assert(!/takeown|icacls/i.test(codexDesktop), "WindowsApps ownership must never be changed by hand");
assert(codexDesktop.includes("after.installed ? [] : targets.map(removePath)"), "leftover Desktop state may only be cleared once Windows no longer reports the package");
assert(codexPaths.includes("sharedRemovable"), "removal must state whether the shared Codex folder can be cleared");
assert(main.includes("codexDesktop.detect()") && main.includes("codexCli.detect()"), "the other product's presence must be resolved in main, not trusted from the renderer");
assert(codexConfigFile.includes("experimental_bearer_token"), "the API key must be written straight into the provider config");
assert(!/env_key/.test(codexConfigFile), "the Codex provider must not depend on an environment variable");
assert(codexConfigFile.includes("writeVerified"), "every config write must be read back and verified");
assert(codexConfigFile.includes("fs.writeFileSync(target, previousText"), "a failed verification must restore the previous config bytes");
// Electron's Node cannot require() an ES-only module, so the runtime must not
// depend on one; the tests parse the results with a real TOML parser instead.
assert(!/require\(["']confbox["']\)/.test(codexConfigFile), "the main process must not require the ES-only TOML package");
assert(!codexCli.includes('"--profile"'), "a CLI-only profile cannot configure ChatGPT Desktop and must not be passed to Codex");

// Claude: one switch over Claude Code CLI + Claude Desktop, with the desktop's
// own transaction engine transplanted and the coordinator as the only glue.
assert(main.includes("cizi:getClaudeState"), "main must expose the combined Claude state");
assert(main.includes("cizi:connectClaude") && main.includes("cizi:disconnectClaude"), "main must expose the single Claude connect/disconnect switch");
assert(main.includes("cizi:installClaudeDesktop"), "main must expose Claude Desktop installation");
assert(main.includes("cizi:launchClaudeDesktop") && main.includes("cizi:stopClaudeDesktop"), "main must expose Claude Desktop launch and stop");
assert(main.includes("cizi:repairClaudeDesktop"), "main must expose Claude Desktop repair");
assert(preload.includes("getClaudeState") && preload.includes("connectClaude") && preload.includes("disconnectClaude"), "preload must expose the Claude switch");
assert(preload.includes("installClaudeDesktop") && preload.includes("repairClaudeDesktop"), "preload must expose the Desktop install and repair actions");
assert(preload.includes("onClaudeProgress"), "preload must expose Claude Desktop progress events");
assert(renderer.includes('idPrefix: "claude-code-cli"'), "renderer must expose the Claude Code CLI controls");
assert(renderer.includes("claude-desktop.install"), "renderer must expose the Claude Desktop install control");
assert(renderer.includes("claude-desktop.repair"), "renderer must expose the Claude Desktop repair control");
assert(renderer.includes('cb.dataset.cliId = "tool.claude.switch"'), "renderer must expose one Claude configuration switch");
assert(renderer.includes("claude-desktop-install-activity"), "renderer must host the Claude Desktop install activity panel");
assert(renderer.includes("updateClaudeProgress"), "renderer must map Claude Desktop progress phases onto the activity panel");
assert(claudeCoordinator.includes("connect") && claudeCoordinator.includes("disconnect"), "the coordinator must implement both halves of the switch");
assert(claudeCoordinator.includes("toolManager.revertTool"), "a desktop failure must roll the CLI half back");
assert(claudeCoordinator.includes("applyTool(CLAUDE_CODE_TOOL_ID"), "the coordinator must configure the CLI through the same service the UI uses");
assert(claudeDesktop.includes("createClaudeDesktopBackend"), "the transplanted Desktop engine must be present");
assert(claudeLifecycle.includes("installClaudeDesktop"), "the transplanted lifecycle must provide Desktop installation");
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
