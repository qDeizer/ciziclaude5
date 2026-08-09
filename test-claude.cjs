// Coordinator test: the Claude switch connects the CLI and the Desktop app as
// one unit. Uses injected fakes for everything — no real files, processes, or
// packages are touched, and the Desktop engine itself is not exercised here.
const assert = require("assert");
const { createClaudeCoordinator } = require("./src/main/claudeCoordinator");

let fail = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!cond) fail++;
};

function fakeDesktop(overrides = {}) {
  return {
    apply: async () => ({ ok: true, applied: true, launched: true, brandingStatus: "active" }),
    revert: async () => ({ ok: true, restored: true }),
    reconcile: async () => ({ reconciled: true }),
    launch: async () => ({ launched: true }),
    getStatus: async () => ({ installed: false, applied: false, blocked: false, hasBackup: false }),
    ...overrides,
  };
}

function fakeManager(overrides = {}) {
  return {
    getToolStatus: () => ({ applied: false }),
    applyTool: () => ({ ok: true, applied: true }),
    revertTool: () => ({ ok: true, restored: true }),
    ...overrides,
  };
}

const noop = { info() {}, warn() {}, error() {}, debug() {} };

async function main() {
  console.log("--- state: nothing installed ---");
  const empty = createClaudeCoordinator({
    claudeDesktop: fakeDesktop(),
    lifecycle: {},
    toolManager: fakeManager(),
    detectCli: async () => ({ installed: false }),
    log: noop,
  });
  let emptyState = await empty.getState("base");
  check("nothing installed -> not connected", emptyState.connected === false && emptyState.installedProducts.length === 0);

  console.log("--- connect: CLI only ---");
  const cliOnly = createClaudeCoordinator({
    claudeDesktop: fakeDesktop({ getStatus: async () => ({ installed: false, applied: false, blocked: false }) }),
    lifecycle: {},
    toolManager: fakeManager(),
    detectCli: async () => ({ installed: true, version: "x" }),
    log: noop,
  });
  const cliResult = await cliOnly.connect({ base: "b", model: "m" });
  check("connect applies the CLI", cliResult.connectedProducts.includes("cli"));
  check("connect reports the desktop as absent, not failed", cliResult.desktop === null && cliResult.skipped.length === 0);

  console.log("--- connect: both installed ---");
  let cliApplied = false;
  let desktopApplied = false;
  const both = createClaudeCoordinator({
    claudeDesktop: fakeDesktop({
      getStatus: async () => ({ installed: true, applied: false, blocked: false }),
      apply: async () => { desktopApplied = true; return { ok: true, applied: true, launched: true }; },
    }),
    lifecycle: {},
    toolManager: fakeManager({
      applyTool: () => { cliApplied = true; return { ok: true, applied: true }; },
    }),
    detectCli: async () => ({ installed: true, version: "x" }),
    log: noop,
  });
  const bothState = await both.getState("b");
  check("both installed -> connected is false while off", bothState.connected === false);
  const bothResult = await both.connect({ base: "b", model: "m" });
  check("connect applied both", cliApplied && desktopApplied);
  check("connect reports both products", bothResult.connectedProducts.includes("cli") && bothResult.connectedProducts.includes("desktop"));

  console.log("--- connect: desktop refuses -> CLI is rolled back ---");
  let rolledBack = false;
  const failing = createClaudeCoordinator({
    claudeDesktop: fakeDesktop({
      getStatus: async () => ({ installed: true, applied: false, blocked: false }),
      apply: async () => { const e = new Error("PROCESS_RUNNING"); e.code = "PROCESS_RUNNING"; throw e; },
    }),
    lifecycle: {},
    toolManager: fakeManager({
      applyTool: () => ({ ok: true, applied: true }),
      revertTool: () => { rolledBack = true; return { ok: true, restored: true }; },
    }),
    detectCli: async () => ({ installed: true, version: "x" }),
    log: noop,
  });
  let connectFailed = false;
  let caught = null;
  try { await failing.connect({ base: "b", model: "m" }); } catch (e) { connectFailed = true; caught = e; }
  check("connect throws when the desktop refuses", connectFailed);
  check("the CLI half was rolled back", rolledBack === true);
  check("error carries a readable Turkish message", /kapat/i.test(caught?.userMessage || ""));

  console.log("--- disconnect ---");
  let desktopReverted = false;
  const disc = createClaudeCoordinator({
    claudeDesktop: fakeDesktop({
      getStatus: async () => ({ installed: true, applied: true, blocked: false, hasBackup: true }),
      revert: async () => { desktopReverted = true; return { ok: true, restored: true }; },
    }),
    lifecycle: {},
    toolManager: fakeManager({
      getToolStatus: () => ({ applied: true }),
      revertTool: () => ({ ok: true, restored: true }),
    }),
    detectCli: async () => ({ installed: true, version: "x" }),
    log: noop,
  });
  const discResult = await disc.disconnect("b");
  check("disconnect reverts both", desktopReverted && discResult.ok);

  console.log("--- install routing ---");
  let installed = false;
  const installer = createClaudeCoordinator({
    claudeDesktop: fakeDesktop(),
    lifecycle: { installTool: async (id, onProgress) => { installed = id === "claude-desktop"; onProgress("installing", "x"); return {}; } },
    toolManager: fakeManager(),
    detectCli: async () => ({ installed: false }),
    log: noop,
  });
  await installer.installDesktop();
  check("installDesktop routes to the lifecycle installer", installed === true);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
