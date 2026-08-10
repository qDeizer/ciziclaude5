#!/usr/bin/env node
"use strict";

// Composition root + CLI. Is mantigi burada YAZILMAZ; yalnizca bagimliliklar
// olusturulup servis metodlari cagrilir. Sonuc stdout'a okunabilir JSON,
// loglar stderr'e JSON satiri olarak gider.

const fs = require("fs");
const path = require("path");

const { createLogger } = require("./lib/logger");
const { createPowerShell } = require("./lib/powershell");
const { createClaudePackageService } = require("./lib/claudePackage");
const { createTargetScanner } = require("./lib/targetScanner");
const { createCatalogPatcher } = require("./lib/catalogPatcher");
const { createLabelPatcher } = require("./lib/labelPatcher");
const { createBuildService } = require("./lib/buildService");
const { createApplyService } = require("./lib/applyService");
const { createElevation } = require("./lib/elevation");
const { createClaudeProcess } = require("./lib/claudeProcess");
const { createLock } = require("./lib/lock");
const { createReconcileService } = require("./lib/reconcileService");
const { createScheduledTaskService } = require("./lib/scheduledTask");
const { createGatewayModeService } = require("./lib/gatewayMode");
const { createAppLauncher } = require("./lib/appLauncher");
const { codedError, readJson } = require("./lib/fsx");

const ROOT = __dirname;
const WORK_ROOT = path.join(ROOT, "work");
const DICTIONARY_PATHS = {
  labels: path.join(ROOT, "dictionary", "tr-TR.labels.json"),
  catalog: path.join(ROOT, "dictionary", "tr-TR.catalog.json"),
};
const GENERATED_BY = "claude-tr-lab/cli.js";

function loadDictionary() {
  const labels = readJson(DICTIONARY_PATHS.labels);
  const catalog = readJson(DICTIONARY_PATHS.catalog);
  if (labels.schemaVersion !== 1 || !Array.isArray(labels.rules)) {
    throw codedError("DICTIONARY_INVALID", "Etiket sozlugu gecersiz.");
  }
  if (catalog.schemaVersion !== 1 || !catalog.entries || typeof catalog.entries !== "object") {
    throw codedError("DICTIONARY_INVALID", "Katalog sozlugu gecersiz.");
  }
  for (const rule of [...labels.rules, ...(labels.tokenRules || [])]) {
    for (const field of ["id", "objectKey", "from", "to"]) {
      // objectKey yalnizca JS etiket kurallarinda zorunludur.
      if (field === "objectKey" && !("objectKey" in rule)) continue;
      if (typeof rule[field] !== "string" || !rule[field]) {
        throw codedError("DICTIONARY_INVALID", `Kuralda '${field}' eksik: ${rule.id || "?"}`);
      }
    }
    if (rule.from === rule.to) {
      throw codedError("DICTIONARY_INVALID", `Etiket kuralinda kaynak ve hedef ayni: ${rule.id}`);
    }
  }
  return { labels, catalog };
}

function compose({ logLevel }) {
  const logger = createLogger({ minLevel: logLevel });
  const powershell = createPowerShell();
  const claudePackage = createClaudePackageService({ powershell, logger });
  const scanner = createTargetScanner({ logger });
  const catalogPatcher = createCatalogPatcher({ logger });
  const labelPatcher = createLabelPatcher({ logger });
  const buildService = createBuildService({
    logger,
    scanner,
    catalogPatcher,
    labelPatcher,
    workRoot: WORK_ROOT,
    dictionaryPaths: DICTIONARY_PATHS,
    generatedBy: GENERATED_BY,
  });
  const elevation = createElevation({ powershell });
  const claudeProcess = createClaudeProcess({ powershell, logger });
  const lock = createLock({ logger, workRoot: WORK_ROOT });
  const applyService = createApplyService({
    logger, powershell, elevation, claudeProcess, lock, workRoot: WORK_ROOT,
  });
  const gatewayMode = createGatewayModeService({ logger, powershell, elevation, workRoot: WORK_ROOT });
  const launcher = createAppLauncher({ logger, powershell });
  const reconcileService = createReconcileService({ logger, buildService, applyService });
  const scheduledTask = createScheduledTaskService({
    logger, powershell, elevation, labRoot: ROOT, nodePath: process.execPath,
  });
  return {
    logger, claudePackage, scanner, buildService, applyService, gatewayMode,
    launcher, claudeProcess, reconcileService, scheduledTask, lock,
  };
}

const COMMANDS = {
  async detect({ claudePackage }) {
    const info = await claudePackage.detect();
    return { command: "detect", claude: info };
  },

  async scan({ claudePackage, scanner }) {
    const info = await claudePackage.detect();
    const dictionary = loadDictionary();
    const result = scanner.scan(info.installLocation, dictionary.labels.rules);
    return {
      command: "scan",
      claude: { version: info.version, packageFullName: info.packageFullName },
      catalogs: result.catalogs.map((catalog) => ({
        id: catalog.id,
        relativePath: catalog.relativePath.split(path.sep).join("/"),
        keyCount: catalog.keyCount,
        bytes: catalog.bytes,
        sha256: catalog.sha256,
      })),
      labelSites: result.labels.sites.map((site) => ({
        ruleId: site.ruleId,
        relativePath: site.relativePath,
        byteOffset: site.byteOffset,
        matched: site.matched,
        siblingsFound: site.siblingsFound,
      })),
      labelProblems: result.labels.problems,
      contextRejected: result.labels.rejections.length,
      alreadyTranslated: result.labels.alreadyTranslated,
      scannedRendererFiles: result.labels.scannedFiles,
      asar: {
        present: result.asar.present,
        untouchedOccurrences: result.asar.occurrences?.length || 0,
      },
    };
  },

  async build({ claudePackage, buildService }) {
    const info = await claudePackage.detect();
    const dictionary = loadDictionary();
    const result = buildService.build(info, dictionary);
    return {
      command: "build",
      claude: { version: info.version, packageFullName: info.packageFullName },
      versionRoot: result.versionRoot,
      report: result.report,
      files: result.provenance.files,
    };
  },

  async verify({ claudePackage, applyService, buildService }) {
    const info = await claudePackage.detect();
    const { provenance } = buildService.loadStaged(info.version);
    const result = applyService.verifyLive(info, provenance);
    return {
      command: "verify",
      claude: { version: info.version },
      allPatched: result.allPatched,
      files: result.files,
    };
  },

  async apply({ claudePackage, applyService, buildService }, options) {
    const info = await claudePackage.detect();
    const build = buildService.loadStaged(info.version);
    const result = await applyService.apply(info, build, { confirm: options.yes });
    const verification = applyService.verifyLive(info, build.provenance);
    return {
      command: "apply",
      claude: { version: info.version },
      applied: result.applied,
      files: result.files,
      verification,
    };
  },

  async restore({ claudePackage, applyService }, options) {
    const info = await claudePackage.detect();
    const result = await applyService.restore(info, { confirm: options.yes });
    return { command: "restore", claude: { version: info.version }, ...result };
  },

  async "gateway-on"({ gatewayMode }, options) {
    const result = await gatewayMode.enable({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
    });
    return { command: "gateway-on", ...result, apiKeySet: !!options.apiKey };
  },

  async "gateway-off"({ gatewayMode }) {
    const result = await gatewayMode.disable();
    return { command: "gateway-off", ...result };
  },

  async launch({ claudePackage, launcher, claudeProcess }) {
    const info = await claudePackage.detect();
    if ((await claudeProcess.runsFrom(info.installLocation)).runsFromTarget) {
      return { command: "launch", launched: false, reason: "ALREADY_RUNNING" };
    }
    const result = await launcher.launch(info);
    return { command: "launch", ...result };
  },

  // Tek adimda test akisi: yama uygulanmis mi kontrol et -> gateway modunu ac
  // -> Claude'u baslat. Etiketler yalnizca gateway modunda render edilir.
  async start({ claudePackage, applyService, buildService, gatewayMode, launcher, claudeProcess, logger }, options) {
    const info = await claudePackage.detect();
    const { provenance } = buildService.loadStaged(info.version);
    const verification = applyService.verifyLive(info, provenance);
    if (!verification.allPatched) {
      throw codedError(
        "PATCH_NOT_APPLIED",
        "Turkce yama canli kurulumda degil. Once yonetici terminalde 'node cli.js apply --yes' calistir.",
      );
    }
    if ((await claudeProcess.runsFrom(info.installLocation)).runsFromTarget) {
      throw codedError("CLAUDE_RUNNING_FROM_TARGET", "Claude Desktop acik; gateway modunu degistirmeden once kapat.");
    }
    const gateway = await gatewayMode.enable({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
    });
    const launched = await launcher.launch(info);
    logger.success("start", "Yama uygulanmis halde gateway modunda baslatildi", {
      version: info.version,
      baseUrl: options.baseUrl,
    });
    return {
      command: "start",
      claude: { version: info.version },
      verification,
      gateway: { active: gateway.enabled, values: gateway.values },
      launch: launched,
      nextCheck: "Claude acildiginda sol alttaki saglayici etiketi 'Ağ Geçidi' olmali.",
    };
  },

  // Tek adimda tam akis, idempotent: gerekiyorsa build -> gerekiyorsa apply ->
  // gateway modu -> baslat. Zaten yapilmis adimlari atlar. start.bat bunu
  // cagirir; sarmalayici hicbir karar vermez, mantik burada durur.
  async up({ claudePackage, reconcileService, gatewayMode, launcher, claudeProcess, logger }, options) {
    const info = await claudePackage.detect();
    if ((await claudeProcess.runsFrom(info.installLocation)).runsFromTarget) {
      throw codedError("CLAUDE_RUNNING_FROM_TARGET", "Claude Desktop yamalanacak surumden calisiyor; once kapat.");
    }
    const dictionary = loadDictionary();
    const patched = await reconcileService.ensurePatched(info, dictionary, { confirm: options.yes });
    const steps = [...patched.steps];
    let verification = patched.verification;

    const gatewayBefore = await gatewayMode.status();
    let gateway = gatewayBefore;
    if (!gatewayBefore.active || (options.baseUrl && gatewayBefore.baseUrl !== options.baseUrl)) {
      const enabled = await gatewayMode.enable({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
      });
      steps.push("gateway-on");
      gateway = { ...(await gatewayMode.status()), values: enabled.values };
    }

    const launched = await launcher.launch(info);
    steps.push("launch");

    logger.success("up", "Turkce yama aktif halde gateway modunda baslatildi", {
      version: info.version,
      steps,
    });
    return {
      command: "up",
      claude: { version: info.version },
      steps,
      verification,
      gatewayMode: gateway,
      launch: launched,
      nextCheck: "Claude acildiginda sol alttaki saglayici etiketi 'Ağ Geçidi' olmali.",
    };
  },

  // KATMAN 2'nin aksiyonu. Zamanlanmis gorev bunu cagirir. Idempotent ve
  // gateway/baslatma yapmaz - SYSTEM olarak calistigi icin HKCU'ya dokunmamali.
  async reconcile({ claudePackage, reconcileService, logger }, options) {
    const info = await claudePackage.detect();
    const dictionary = loadDictionary();
    const result = await reconcileService.ensurePatched(info, dictionary, { confirm: options.yes });
    return {
      command: "reconcile",
      claude: { version: info.version, packageFullName: info.packageFullName },
      changed: result.changed,
      steps: result.steps,
      verification: result.verification,
    };
  },

  // Yalnizca hedef klasorden calisan surecleri kapatir. Ada gore kapatmak
  // Claude Code CLI'yi de oldururdu (ikisinin adi da claude.exe).
  async "desktop-close"({ claudePackage, claudeProcess }, options) {
    const info = await claudePackage.detect();
    const result = await claudeProcess.closeDesktop(info.installLocation, { confirm: options.yes });
    return { command: "desktop-close", ...result };
  },

  async "task-install"({ scheduledTask }) {
    const result = await scheduledTask.install();
    return { command: "task-install", ...result };
  },

  async "task-status"({ scheduledTask }) {
    const result = await scheduledTask.status();
    return { command: "task-status", ...result };
  },

  async "task-remove"({ scheduledTask }) {
    const result = await scheduledTask.remove();
    return { command: "task-remove", ...result };
  },

  async "task-run"({ scheduledTask }) {
    const result = await scheduledTask.runNow();
    return { command: "task-run", ...result };
  },

  async status({ claudePackage, applyService, buildService, gatewayMode, claudeProcess, scheduledTask }) {
    const info = await claudePackage.detect();
    let staged = null;
    let verification = null;
    try {
      const build = buildService.loadStaged(info.version);
      staged = { versionRoot: build.versionRoot, fileCount: build.stagedFiles.length };
      verification = applyService.verifyLive(info, build.provenance);
    } catch (error) {
      staged = { available: false, reason: error.code || "UNKNOWN" };
    }
    const backupPath = applyService.backupManifestPath(info.version);
    const gateway = await gatewayMode.status();
    const processState = await claudeProcess.runsFrom(info.installLocation);
    const running = processState.paths.length > 0;
    const task = await scheduledTask.status();

    // Siradaki aksiyon: yama zinciri once, sonra gorunurluk on kosulu.
    let action;
    if (staged?.available === false) action = "build-required";
    else if (!verification?.allPatched) action = "apply-required";
    else if (!gateway.active) action = "gateway-mode-required";
    else if (!running) action = "launch-required";
    else action = "up-to-date";

    return {
      command: "status",
      claude: {
        version: info.version,
        packageFullName: info.packageFullName,
        running,
        runningFromTarget: processState.runsFromTarget,
      },
      stagedBuild: staged,
      backupPresent: fs.existsSync(backupPath),
      verification,
      gatewayMode: gateway,
      // Iki paralel koruyucu: gorev (katman 2) ve baslatici (katman 3)
      guards: {
        repairTask: {
          installed: task.exists,
          current: task.current === true,
          state: task.state || null,
          lastRunTime: task.lastRunTime || null,
          lastResult: task.lastResult || null,
          nextRunTime: task.nextRunTime || null,
        },
        launcherPreCheck: { available: true, note: "start.bat / up komutu her baslatmada dogrular" },
      },
      action,
    };
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || "status";
  const flagValue = (name) => {
    const index = argv.indexOf(name);
    return index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")
      ? argv[index + 1]
      : null;
  };
  const options = {
    yes: argv.includes("--yes"),
    logLevel: argv.includes("--debug") ? "debug" : "info",
    baseUrl: flagValue("--base-url"),
    apiKey: flagValue("--api-key"),
    model: flagValue("--model"),
  };

  if (!COMMANDS[command]) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: "UNKNOWN_COMMAND", message: `Bilinmeyen komut: ${command}` },
      usage: `node cli.js <${Object.keys(COMMANDS).join("|")}> [--yes] [--debug]`,
    }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const container = compose({ logLevel: options.logLevel });
  try {
    const result = await COMMANDS[command](container, options);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    container.logger.error("cli", "Komut basarisiz", { command, code: error.code, message: error.message });
    const payload = {
      ok: false,
      command,
      error: { code: error.code || "UNEXPECTED_ERROR", message: error.message },
    };
    if (error.rollback) payload.rollback = error.rollback;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}

main();
