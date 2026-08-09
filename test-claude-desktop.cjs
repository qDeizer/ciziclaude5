// Claude Desktop is the odd one out among the tools this app installs: its
// official MSIX registers a packaged Windows service that runs as localSystem,
// so Windows refuses a per-user registration with 0x80073D28. These checks pin
// down the two things that follow from that — the install always elevates, and
// the wait is always visible — plus the model families that decide which local
// products a key is allowed to configure at all.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const contract = require("./src/main/tools/claudeInstallerContract");
const lifecycle = require("./src/main/tools/claudeLifecycle");
const { desktopMessage } = require("./src/main/claudeCoordinator");

let fail = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fail++;
};

function elevatedChildScript(outerScript) {
  const match = /encodedElevatedScript='([A-Za-z0-9+/=]+)'/.exec(outerScript);
  return match ? Buffer.from(match[1], "base64").toString("utf16le") : "";
}

async function main() {
  console.log("--- install script: elevation is a property of the package ---");
  const script = contract.claudeDesktopInstallScript("C:\\tmp\\claude.msix", "C:\\tmp\\claude.json");
  const child = elevatedChildScript(script);
  check("the desktop install always elevates", script.includes("-Verb RunAs"));
  check("elevation is not conditional", contract.CLAUDE_DESKTOP_INSTALL_REQUIRES_ELEVATION === true
    && !/elevated\s*[=:]\s*false/.test(script));
  check("only the elevated child registers the package",
    child.includes("Add-AppxPackage") && !script.replace(/encodedElevatedScript='[^']*'/, "").includes("Add-AppxPackage"));
  check("the outer script ticks a heartbeat while it waits",
    script.includes("AppendAllText($heartbeat") && script.includes("while(-not $process.HasExited)"));
  check("a declined prompt has its own exit code",
    script.includes(`exit ${contract.CLAUDE_DESKTOP_INSTALL_EXIT.approvalDeclined}`) && script.includes("1223"));
  // Windows localises the ERROR_CANCELLED text, so a Turkish machine reports
  // "İşlem kullanıcı tarafından iptal edildi" and never the word "cancel".
  check("a declined prompt is recognised by its code, not by English text",
    !/match\s*'cancel'/i.test(script) && script.includes("Test-ApprovalDeclined"));
  check("an unreadable elevated exit code falls back to the installer's own report",
    script.includes("try{$exitCode=[int]$process.ExitCode}catch"));
  check("the elevated child reports the deployment HRESULT", child.includes("0x[0-9A-Fa-f]{8}"));

  console.log("--- deployment failures are named, not flattened ---");
  const declined = contract.claudeDesktopInstallFailure({ exitCode: contract.CLAUDE_DESKTOP_INSTALL_EXIT.approvalDeclined });
  check("a declined prompt is not reported as a failed install", declined.code === "CLAUDE_DESKTOP_INSTALL_CANCELLED");
  const elevation = contract.claudeDesktopInstallFailure({
    exitCode: 1,
    result: { ok: false, message: "Deployment failed with HRESULT: 0x80073D28, ...", hresult: "0x80073D28" },
  });
  check("0x80073D28 is reported as an elevation requirement", elevation.code === "CLAUDE_DESKTOP_INSTALL_ELEVATION_REQUIRED");
  const running = contract.claudeDesktopInstallFailure({ exitCode: 1, result: { message: "error 0x80073D02" } });
  check("0x80073D02 tells the user to close Claude", running.code === "CLAUDE_DESKTOP_INSTALL_PACKAGE_IN_USE");
  const unknown = contract.claudeDesktopInstallFailure({ exitCode: 1, result: { message: "error 0x8007000B" } });
  check("an unmapped deployment error still carries its HRESULT", unknown.message.includes("0x8007000B"));
  check("every install failure code has a Turkish sentence",
    [declined, elevation, running, unknown].every((error) => desktopMessage(error) !== error.message
      && /[a-zçğıöşü]/i.test(desktopMessage(error))));

  console.log("--- the download is reused instead of pulled twice ---");
  const sample = path.join(os.tmpdir(), `cizi-claude-reuse-${process.pid}.msix`);
  fs.writeFileSync(sample, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  const size = fs.statSync(sample).size;
  check("a complete package is reused", await lifecycle.reusableClaudeDesktopPackage(sample, size) === true);
  check("a partial package is not reused", await lifecycle.reusableClaudeDesktopPackage(sample, size + 1) === false);
  check("an unknown published size never reuses", await lifecycle.reusableClaudeDesktopPackage(sample, null) === false);
  fs.writeFileSync(sample, Buffer.from([0x00, 0x00, 0x03, 0x04, 0, 0, 0, 0]));
  check("a file that is not a package is not reused", await lifecycle.reusableClaudeDesktopPackage(sample, size) === false);
  fs.rmSync(sample, { force: true });

  console.log("--- install flow: progress keeps moving, the cache survives a failure ---");
  const fixture = path.join(os.tmpdir(), `cizi-claude-flow-${process.pid}.msix`);
  fs.writeFileSync(fixture, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const phases = [];
  let heartbeat = null;
  const deleted = [];
  let signatureChecked = null;
  const failure = await lifecycle.installClaudeDesktop(
    (phase, message, details) => phases.push({ phase, message, percent: details?.percent ?? null }),
    {
      packagePathFn: () => fixture,
      detectClaudeDesktopFn: async () => ({ installed: false }),
      inspectDownloadFn: async () => ({ contentLength: fs.statSync(fixture).size }),
      downloadInstallerFn: async () => { throw new Error("the package download must not run twice"); },
      verifyAnthropicSignatureFn: async (file) => { signatureChecked = file; return { status: "Valid" }; },
      runPowerShellFn: async () => { throw new Error("the package download must not run twice"); },
      runPowerShellWithHeartbeatFn: async (text, options, hooks) => {
        heartbeat = { text, options, hooks };
        hooks.onHeartbeat({ ticks: 1 });
        hooks.onHeartbeat({ ticks: 2 });
        const error = new Error("install failed");
        error.ciziDiagnostic = { processExitCode: 1 };
        throw error;
      },
      cleanupTemporaryInstallerFn: async (file) => { deleted.push(file); },
      delayFn: async () => {},
    },
  ).then(() => null).catch((error) => error);
  check("an already-downloaded package is not downloaded again",
    phases.some((p) => p.phase === "downloading" && p.percent === 100));
  check("the package signature is verified before Windows is asked to install it",
    signatureChecked === fixture);
  check("the signature check is its own reported phase",
    phases.some((p) => p.phase === "verifying-signature"));
  check("a failed install reports the deployment failure", failure?.code === "CLAUDE_DESKTOP_INSTALL_FAILED", failure?.code);
  check("the installer waits on the heartbeat runner", !!heartbeat?.hooks?.heartbeatPath);
  check("the heartbeat runner reports Claude Desktop errors, not Claude Code ones",
    heartbeat?.hooks?.timeoutCode === "CLAUDE_DESKTOP_INSTALL_TIMEOUT");
  check("the install phase reports more than once", phases.filter((p) => p.phase === "installing").length >= 3);
  check("a failed install keeps the downloaded package", !deleted.includes(fixture));
  fs.rmSync(fixture, { force: true });

  console.log("--- a package that fails the signature check is never installed ---");
  const badFixture = path.join(os.tmpdir(), `cizi-claude-unsigned-${process.pid}.msix`);
  fs.writeFileSync(badFixture, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const discarded = [];
  let installAttempted = false;
  const untrusted = await lifecycle.installClaudeDesktop(() => {}, {
    packagePathFn: () => badFixture,
    detectClaudeDesktopFn: async () => ({ installed: false }),
    inspectDownloadFn: async () => ({ contentLength: fs.statSync(badFixture).size }),
    downloadInstallerFn: async () => { throw new Error("must not re-download"); },
    verifyAnthropicSignatureFn: async () => {
      const error = new Error("untrusted");
      error.code = "CLAUDE_DESKTOP_SIGNATURE_UNTRUSTED";
      error.ciziPublicMessage = "untrusted";
      throw error;
    },
    runPowerShellWithHeartbeatFn: async () => { installAttempted = true; },
    cleanupTemporaryInstallerFn: async (file) => { discarded.push(file); },
    delayFn: async () => {},
  }).then(() => null).catch((error) => error);
  check("an unsigned package stops the installation", untrusted?.code === "CLAUDE_DESKTOP_SIGNATURE_UNTRUSTED", untrusted?.code);
  check("an unsigned package is never handed to Windows", installAttempted === false);
  check("an unsigned package is discarded rather than cached for a retry", discarded.includes(badFixture));
  fs.rmSync(badFixture, { force: true });

  console.log("--- a finished install clears the cached package ---");
  const doneFixture = path.join(os.tmpdir(), `cizi-claude-done-${process.pid}.msix`);
  fs.writeFileSync(doneFixture, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const cleared = [];
  let attempts = 0;
  const installed = await lifecycle.installClaudeDesktop(() => {}, {
    packagePathFn: () => doneFixture,
    // Windows finishes registering a moment after the command returns, so the
    // first status read may still miss the package.
    detectClaudeDesktopFn: async () => { attempts += 1; return { installed: attempts > 2, Version: "1.2.3" }; },
    inspectDownloadFn: async () => ({ contentLength: fs.statSync(doneFixture).size }),
    downloadInstallerFn: async () => { throw new Error("the package download must not run twice"); },
    verifyAnthropicSignatureFn: async () => ({ status: "Valid" }),
    runPowerShellWithHeartbeatFn: async () => {},
    cleanupTemporaryInstallerFn: async (file) => { cleared.push(file); },
    delayFn: async () => {},
  });
  check("verification retries instead of failing on the first miss", installed?.installed === true, `attempts=${attempts}`);
  check("a finished install clears the cached package", cleared.includes(doneFixture));
  fs.rmSync(doneFixture, { force: true });

  console.log("--- the download reports a real percentage from the first byte ---");
  const installerModule = require("./src/main/tools/claudeDesktopInstaller");
  {
    const target = path.join(os.tmpdir(), `cizi-claude-stream-${process.pid}.msix`);
    const payload = Buffer.alloc(8192, 7);
    const chunks = [payload.subarray(0, 4096), payload.subarray(4096)];
    const events = [];
    const fakeFetch = async () => ({
      ok: true,
      url: "https://downloads.claude.ai/releases/win32/x64/1.0.0/Claude.msix",
      headers: new Map([["content-length", String(payload.length)], ["content-type", "application/octet-stream"]]),
      body: (function toWeb() {
        let index = 0;
        return {
          getReader: () => ({
            read: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }),
            cancel: async () => {},
            releaseLock: () => {},
          }),
        };
      })(),
    });
    // Node's Readable.fromWeb needs a real ReadableStream, so the body is built
    // from one rather than hand-rolled.
    const realFetch = async () => ({
      ok: true,
      url: "https://downloads.claude.ai/releases/win32/x64/1.0.0/Claude.msix",
      headers: { get: (name) => ({ "content-length": String(payload.length), "content-type": "application/octet-stream" })[String(name).toLowerCase()] ?? null },
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
    });
    void fakeFetch;
    const result = await installerModule.downloadInstaller(
      "https://claude.ai/api/desktop/win32/x64/msix/latest/redirect",
      target,
      { fetchImpl: realFetch, onProgress: (p) => events.push(p) },
    );
    check("the download writes the file it streamed", result.receivedBytes === payload.length
      && fs.statSync(target).size === payload.length);
    check("progress is reported per chunk, not per poll", events.length === chunks.length, `events=${events.length}`);
    check("every progress event carries a real percentage",
      events.length > 0 && events.every((p) => Number.isFinite(p.percent)));
    check("the percentage ends at 100", events[events.length - 1]?.percent === 100);
    fs.rmSync(target, { force: true });
  }

  console.log("--- only official Anthropic addresses are downloaded from ---");
  check("the published redirect endpoint is accepted",
    installerModule.assertInstallerUrl("https://claude.ai/api/desktop/win32/x64/msix/latest/redirect").hostname === "claude.ai");
  check("the downloads host the redirect lands on is accepted",
    installerModule.assertInstallerUrl("https://downloads.claude.ai/releases/x.msix").hostname === "downloads.claude.ai");
  for (const [label, url] of [
    ["a look-alike host", "https://claude.ai.evil.example/x.msix"],
    ["plain http", "http://claude.ai/x.msix"],
    ["an unrelated host", "https://example.com/Claude.msix"],
  ]) {
    let refused = null;
    try { installerModule.assertInstallerUrl(url); } catch (error) { refused = error.code; }
    check(`${label} is refused`, refused === "CLAUDE_DESKTOP_URL_UNTRUSTED" || refused === "CLAUDE_DESKTOP_URL_INVALID", String(refused));
  }
  {
    // A redirect that ends on an error page must not be written to disk and
    // handed to Windows as if it were a package.
    let refused = null;
    try {
      installerModule.assertArtifactResponse("msix", {
        finalUrl: "https://claude.ai/outage", contentType: "text/html", contentDisposition: "",
      });
    } catch (error) { refused = error.code; }
    check("an HTML response is not treated as an installer", refused === "CLAUDE_DESKTOP_RESPONSE_INVALID", String(refused));
  }

  console.log("--- only Anthropic's own uninstaller is ever executed ---");
  check("Anthropic's Squirrel uninstaller is accepted",
    installerModule.parseTrustedUninstallCommand('"C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\Update.exe" --uninstall').args[0] === "--uninstall");
  for (const [label, command] of [
    ["an arbitrary executable", '"C:\\Windows\\System32\\cmd.exe" /c del /s /q C:\\'],
    ["a renamed helper", '"C:\\Temp\\payload.exe" --uninstall'],
  ]) {
    let refused = null;
    try { installerModule.parseTrustedUninstallCommand(command); } catch (error) { refused = error.code; }
    check(`${label} is refused as an uninstaller`, refused === "CLAUDE_DESKTOP_UNINSTALL_COMMAND_UNTRUSTED", String(refused));
  }

  console.log("--- removal is previewed, and never takes the CLI's data with it ---");
  {
    // The plan only lists folders that actually exist, so a real directory is
    // created to prove Claude Desktop's own data is offered for removal.
    const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-claude-plan-"));
    fs.mkdirSync(path.join(planRoot, "local", "Claude-3p"), { recursive: true });
    fs.mkdirSync(path.join(planRoot, "user", ".claude"), { recursive: true });
    const plan = installerModule.planRemoval({
      installed: true, version: "1.2.3", installKind: "msix",
      env: {
        LOCALAPPDATA: path.join(planRoot, "local"),
        APPDATA: path.join(planRoot, "roaming"),
        USERPROFILE: path.join(planRoot, "user"),
      },
    });
    const removePaths = plan.remove.map((item) => item.path).join("|");
    const preservePaths = plan.preserve.map((item) => item.path).join("|");
    check("the plan names the application itself", /Claude Desktop paketi/.test(removePaths));
    check("the plan lists Claude Desktop's own data", removePaths.includes("Claude-3p"), removePaths);
    check("the plan only lists what is really there",
      !plan.remove.some((item) => item.exists === false));
    check("the Claude Code CLI's folder is preserved, not removed",
      preservePaths.includes(".claude") && !removePaths.includes(path.join(planRoot, "user", ".claude")));
    fs.rmSync(planRoot, { recursive: true, force: true });
    check("the removal script never deletes the CLI's folder",
      !/USERPROFILE/.test(installerModule.removeLeftoversScript()));
    // The two products are separate: a Run entry for Claude Code must survive a
    // Claude Desktop removal.
    check("the leftover sweep skips Claude Code's own entries",
      installerModule.removeLeftoversScript().includes("-notmatch 'Code'"));
  }

  console.log("--- a running Claude Desktop is a question, not a dead switch ---");
  {
    const { createClaudeCoordinator } = require("./src/main/claudeCoordinator");
    let stopped = 0;
    let applied = 0;
    const makeCoordinator = () => createClaudeCoordinator({
      claudeDesktop: {
        getStatus: async () => ({ installed: true, applied: false, running: stopped === 0, blocked: false, hasBackup: false }),
        apply: async () => { applied += 1; return { ok: true, applied: true, launched: true }; },
        revert: async () => ({ ok: true, restored: true }),
      },
      lifecycle: { stopTool: async () => { stopped += 1; return { stopped: true }; } },
      toolManager: { getToolStatus: () => ({ applied: false, hasBackup: false }), applyTool: () => ({ ok: true }), revertTool: () => ({ ok: true }) },
      detectCli: async () => ({ installed: false }),
      log: { info() {}, warn() {}, error() {} },
    });

    const asked = await makeCoordinator().connect({ base: "https://gw", model: "Opus-4.8" })
      .then(() => null, (error) => error);
    check("connecting while Claude Desktop is open asks instead of failing",
      asked?.code === "PROCESS_RUNNING_CONFIRMATION_REQUIRED", asked?.code);
    check("the question has a Turkish sentence", /kapat/i.test(desktopMessage(asked)));
    check("nothing was applied and nothing was closed without an answer", applied === 0 && stopped === 0);

    const answered = await makeCoordinator().connect({ base: "https://gw", model: "Opus-4.8" }, { closeRunning: true });
    check("answering yes closes Claude Desktop and connects",
      stopped === 1 && applied === 1 && answered.connectedProducts.includes("desktop"));
  }

  console.log("--- removing the application restores the user's settings first ---");
  {
    const { createClaudeCoordinator } = require("./src/main/claudeCoordinator");
    const order = [];
    const coordinator = createClaudeCoordinator({
      claudeDesktop: {
        getStatus: async () => ({ installed: true, applied: true, running: false, blocked: false, hasBackup: true }),
        revert: async () => { order.push("revert"); return { ok: true, restored: true }; },
      },
      lifecycle: {
        uninstallClaudeDesktop: async () => { order.push("uninstall"); return { ok: true, removed: true, remainingDirectories: [] }; },
        planClaudeDesktopUninstall: async () => ({ remove: [], preserve: [] }),
      },
      toolManager: { getToolStatus: () => ({ applied: false, hasBackup: false }) },
      detectCli: async () => ({ installed: false }),
      log: { info() {}, warn() {}, error() {} },
    });
    const result = await coordinator.uninstallDesktop();
    check("the original configuration is restored before the app is removed",
      order.join(">") === "revert>uninstall", order.join(">"));
    check("the removal reports what it did", result.removed === true);
  }

  console.log("--- model families decide which products a key may configure ---");
  const families = require("./src/renderer/modelFamilies");
  const claudeOnly = ["Opus-4.8", "Sonnet-4.6", "Fable-5"];
  const codexOnly = ["gpt-5.6-luna", "Terra-Pro", "astra-1", "sol-mini"];
  check("Claude models unlock the Claude products", families.toolIsUnlocked(claudeOnly, "claude-code") === true);
  check("Claude models do not unlock the Codex products", families.toolIsUnlocked(claudeOnly, "codex") === false);
  check("Codex models unlock the Codex products", families.toolIsUnlocked(codexOnly, "codex") === true);
  check("Codex models do not unlock the Claude products", families.toolIsUnlocked(codexOnly, "claude-code") === false);
  check("a mixed key unlocks both", families.toolIsUnlocked([...claudeOnly, ...codexOnly], "claude-code")
    && families.toolIsUnlocked([...claudeOnly, ...codexOnly], "codex"));
  check("each row only offers models of its own family",
    families.modelsForTool([...claudeOnly, ...codexOnly], "codex").join() === codexOnly.join()
    && families.modelsForTool([...claudeOnly, ...codexOnly], "claude-code").join() === claudeOnly.join());
  // Keywords are matched per word so a short one cannot swallow an unrelated id.
  check("a keyword never matches inside an unrelated word",
    families.modelBelongsToFamily("resolve-x", "codex") === false
    && families.modelBelongsToFamily("gpt5-luna", "codex") === true);
  check("model objects are accepted alongside plain names",
    families.toolIsUnlocked([{ name: "Opus-4.8" }], "claude-code") === true);
  check("an unknown model unlocks nothing",
    families.toolIsUnlocked(["mistral-large"], "claude-code") === false
    && families.toolIsUnlocked(["mistral-large"], "codex") === false);
  check("only the family-gated tools are gated",
    families.toolIsGated("claude-code") && families.toolIsGated("codex") && !families.toolIsGated("cline"));

  const renderer = fs.readFileSync(path.join(__dirname, "src/renderer/renderer.js"), "utf8");
  check("the tool list is filtered by the key's model families",
    renderer.includes("toolIsUnlocked(models, id)"));
  check("each row is handed only its own family's models",
    renderer.includes("modelsForTool(models, CODEX_CLI_TOOL_ID)")
    && renderer.includes("modelsForTool(models, CLAUDE_CODE_CLI_TOOL_ID)"));
  check("the gate is loaded before the renderer that uses it",
    fs.readFileSync(path.join(__dirname, "src/renderer/index.html"), "utf8")
      .indexOf("modelFamilies.js") < fs.readFileSync(path.join(__dirname, "src/renderer/index.html"), "utf8").indexOf("renderer.js"));

  console.log("--- config library: only Cizi Code's own entry is ever removed ---");
  const configLibrary = require("./src/main/tools/claudeDesktopConfigLibrary");
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-configlib-"));
  try {
    process.env.LOCALAPPDATA = sandbox;
    const resolved = configLibrary.paths();
    fs.mkdirSync(resolved.root, { recursive: true });
    const otherId = "11111111-2222-3333-4444-555555555555";
    fs.writeFileSync(resolved.metadata, JSON.stringify({
      appliedId: configLibrary.CONFIGURATION_ID,
      entries: [{ id: otherId, name: "Another tool" }, { id: configLibrary.CONFIGURATION_ID, name: configLibrary.CONFIGURATION_NAME }],
    }));
    fs.writeFileSync(resolved.entry, JSON.stringify({ base: "https://gw" }));
    check("Cizi Code's entry is seen as present", configLibrary.ownedAbsent() === false);
    const removal = configLibrary.cleanupOwned();
    const after = JSON.parse(fs.readFileSync(resolved.metadata, "utf8"));
    check("cleanup reports that it changed something", removal.removed === true);
    check("Cizi Code's configuration file is gone", !fs.existsSync(resolved.entry));
    check("another application's entry survives", after.entries.length === 1 && after.entries[0].id === otherId);
    check("the applied marker no longer points at Cizi Code", after.appliedId === undefined);
    check("cleanup is idempotent", configLibrary.cleanupOwned().removed === false && configLibrary.ownedAbsent() === true);

    // A list that never held anything but Cizi Code's entry is removed whole,
    // so the switch does not leave behind a file Claude never had.
    fs.mkdirSync(resolved.root, { recursive: true });
    fs.writeFileSync(resolved.metadata, JSON.stringify({
      appliedId: configLibrary.CONFIGURATION_ID,
      entries: [{ id: configLibrary.CONFIGURATION_ID, name: configLibrary.CONFIGURATION_NAME }],
    }));
    fs.writeFileSync(resolved.entry, JSON.stringify({ base: "https://gw" }));
    configLibrary.cleanupOwned();
    check("a list that only held Cizi Code's entry is removed entirely", !fs.existsSync(resolved.metadata));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  console.log("--- the switch always has something to turn off ---");
  const { createClaudeDesktopBackend } = require("./src/main/tools/claudeDesktop");
  const BASELINE = Object.freeze({ schemaVersion: 3, policy: { keyExisted: false, values: {} }, ownedFiles: {} });

  function switchAdapters({ state, baseline, configured }) {
    const box = { library: configured ? { base: "https://gw/v1" } : null };
    return {
      box,
      adapters: {
        features: { translation: false, configurationSurface: "config-library" },
        runtime: {
          getStatus: async () => ({
            installed: true, running: false, processScanOk: true, Version: "1.0.0.0",
            PackageFullName: "Claude_1.0.0.0_x64__pzs8sxrjxfjjc", PackageFamilyName: "Claude_pzs8sxrjxfjjc",
            Publisher: "CN=Anthropic", InstallLocation: "C:/claude",
          }),
          launchOriginal: async () => {}, launchChat: async () => {}, launchCiziRuntime: async () => {},
        },
        policy: {
          machineBlock: async () => ({ blocked: false }), capture: async () => ({ keyExisted: false, values: {} }),
          restore: async () => {}, apply: async () => {}, verify: async () => true, cleanupOwnedOrphans: async () => {},
        },
        configLibrary: {
          capture: () => ({ configurationId: "x", metadata: { existed: false }, entry: { existed: false } }),
          restore: () => { box.library = null; },
          matches: () => box.library === null,
          apply: (c) => { box.library = c; },
          verify: () => box.library !== null,
          cleanupOwned: () => { const removed = box.library !== null; box.library = null; return { removed }; },
          ownedAbsent: () => box.library === null,
        },
        helper: {
          capture: () => ({}), restore: () => {}, ensure: () => "C:/helper.exe", provision: async () => {},
          isCurrent: () => true, preflight: async () => {}, path: () => "C:/helper.exe",
        },
        overlay: {
          ensureForMain: async () => ({ status: "inactive", mode: "none" }),
          removeForState: async () => ({ removed: false }),
          queryInstalledOverlay: async () => null,
          removeOwnedOrphanForMain: async () => {},
        },
        legacy: { cleanupLegacy: () => ({}) },
        reconcileTask: {
          getStatus: async () => ({ exists: false, current: true }), ensure: async () => ({ current: true }),
          remove: async () => ({ removed: false }), isCurrent: async () => true,
        },
        operationLock: { acquire: async () => () => {} },
        state: {
          read: () => {
            if (state === "unreadable") {
              const error = new Error("unreadable");
              error.code = "CLAUDE_STATE_UNREADABLE";
              throw error;
            }
            return state;
          },
          write: () => {}, readBaseline: () => baseline, writeBaseline: () => {},
          remove: () => {}, hasBaseline: () => !!baseline,
        },
        identity: {
          mainPackageIdentity: (r) => ({ appUserModelId: "Claude_pzs8sxrjxfjjc!Claude", version: r.Version, packageFullName: r.PackageFullName }),
          assertMainPackagePreserved: () => {},
          CLAUDE_MAIN_APP_ID: "Claude_pzs8sxrjxfjjc!Claude",
        },
        now: () => "2026-01-01T00:00:00.000Z",
      },
    };
  }

  // The state record is lost (deleted, or written by an install that can no
  // longer decrypt it) while the machine is still configured.
  for (const [label, lostState] of [["missing", null], ["unreadable", "unreadable"]]) {
    const lost = switchAdapters({ state: lostState, baseline: BASELINE, configured: true });
    const backend = createClaudeDesktopBackend(lost.adapters);
    const status = await backend.getStatus("https://gw");
    check(`a ${label} record with a stored backup still reads as connected`, status.applied === true);
    check(`a ${label} record asks to be repaired`, status.needsRefresh === true);
    const reverted = await backend.revert();
    check(`turning off a ${label} record restores`, reverted.restored === true && reverted.alreadyOff !== true);
    check(`turning off a ${label} record leaves nothing configured`, lost.box.library === null);
    const refused = await backend.apply({ base: "https://gw", apiKey: "k", model: "Opus-4.8" }).then(() => null, (e) => e.code);
    check(`connecting over a ${label} record is refused instead of overwriting the backup`,
      refused === (lostState === "unreadable" ? "CLAUDE_STATE_UNREADABLE" : "CLAUDE_DESKTOP_DISCONNECT_PENDING"), String(refused));
    check(`the refusal for a ${label} record explains itself in Turkish`,
      /anahtarı/i.test(desktopMessage({ code: refused })));
  }

  // A baseline written by a build that predates the configuration-library
  // surface carries no section for it.
  const legacy = switchAdapters({
    state: { schemaVersion: 3, active: true, phase: "on", configurationSurface: "config-library", baseUrl: "https://gw/v1", models: ["Opus-4.8"] },
    baseline: BASELINE,
    configured: true,
  });
  const legacyBackend = createClaudeDesktopBackend(legacy.adapters);
  const legacyRevert = await legacyBackend.revert();
  check("a legacy baseline still clears the configuration library", legacy.box.library === null);
  check("a legacy revert reports the restore it actually performed", legacyRevert.restored === true);

  // Nothing applied and nothing stored: the status sweep clears leftovers.
  const orphan = switchAdapters({ state: null, baseline: null, configured: true });
  const orphanBackend = createClaudeDesktopBackend(orphan.adapters);
  const orphanStatus = await orphanBackend.getStatus("https://gw");
  check("with nothing to restore the status sweep clears an owned leftover", orphan.box.library === null);
  check("and reports the integration as off", orphanStatus.applied === false);

  console.log("--- the CLI half reverts on its stored backup too ---");
  const { createClaudeCoordinator } = require("./src/main/claudeCoordinator");
  let cliReverted = false;
  const coordinator = createClaudeCoordinator({
    claudeDesktop: {
      getStatus: async () => ({ installed: false, applied: false, blocked: false, hasBackup: false }),
      revert: async () => ({ ok: true, restored: true }),
    },
    lifecycle: {},
    // The file was hand-edited or deleted, so it no longer looks configured,
    // but the snapshot of the user's original settings is still stored.
    toolManager: {
      getToolStatus: () => ({ applied: false, hasBackup: true }),
      applyTool: () => ({ ok: true }),
      revertTool: () => { cliReverted = true; return { ok: true, restored: true }; },
    },
    detectCli: async () => ({ installed: true, version: "x" }),
    log: { info() {}, warn() {}, error() {} },
  });
  await coordinator.disconnect("https://gw");
  check("a stored CLI backup is restored even when the file no longer looks configured", cliReverted === true);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
