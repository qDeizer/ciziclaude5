// The one place that decides what turning a switch on or off means.
//
// Everything else in the app either reports a fact (is this configured?) or
// performs a write (configure it). This service owns the policy between them:
//
//   1. Intent is recorded on disk BEFORE anything is touched. A run that is
//      interrupted therefore leaves a machine whose desired state is known, and
//      the periodic reconcile finishes the job instead of undoing it. Recording
//      intent afterwards is what used to let a half-finished disconnect be
//      re-applied five minutes later.
//   2. Every apply is verified. A write that cannot be proven is undone at once.
//   3. Turning off never gives up: intent stays off, the backup stays on disk
//      until the restore is verified, and the reconcile retries.
//   4. One operation per tool at a time. The UI, the CLI bridge and the timer all
//      go through the same queue, so they cannot interleave on the same files.
//
// Dependencies arrive from the composition root, so the policy stays testable.
"use strict";

const { listToolIds, getTool } = require("./registry");

// The id one record used to carry when Claude Code CLI and Claude Desktop were a
// single switch. Kept only so that record can be migrated onto the two ids below.
const LEGACY_CLAUDE_INTENT_ID = "claude";
const CLAUDE_CODE_TOOL_ID = "claude-code";
const CLAUDE_DESKTOP_ID = "claude-desktop";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;
// A user answering "may I close Claude Desktop?" is a question, not a failure:
// it must not change what the user asked for.
const CONFIRMATION_REQUIRED = "PROCESS_RUNNING_CONFIRMATION_REQUIRED";

function errorCode(error) {
  return String(error?.code || error?.message || error || "UNKNOWN_ERROR");
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  return error;
}

function createIntegrationService({
  toolManager,
  claude,
  intentStore,
  resolveValues,
  getSession,
  baseUrl,
  log,
  backgroundTask = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onProgress = null,
} = {}) {
  if (!toolManager || !claude || !intentStore || typeof resolveValues !== "function" || typeof getSession !== "function") {
    throw new TypeError("Integration service dependencies are required.");
  }

  // Turning a switch is a multi-step operation over somebody else's files, and it
  // can take minutes when an application has to be closed first. The steps are
  // named and weighted here, so the screen shows measured progress rather than a
  // spinner that means "something is happening".
  //
  // The weights are the share of the work each step represents, not guesses about
  // time: they are what makes the reported percentage monotonic.
  const ENABLE_STEPS = Object.freeze({
    precheck: { percent: 10, message: "Ürün ve ayar dosyaları denetleniyor..." },
    models: { percent: 25, message: "Hesabınızın modelleri hazırlanıyor..." },
    backup: { percent: 35, message: "Mevcut ayarlarınızın yedeği alınıyor..." },
    apply: { percent: 70, message: "Ayarlar uygulanıyor..." },
    verify: { percent: 90, message: "Yazılan ayarlar doğrulanıyor..." },
    done: { percent: 100, message: "Bağlantı doğrulandı." },
  });
  const DISABLE_STEPS = Object.freeze({
    precheck: { percent: 15, message: "Geri yükleme hazırlanıyor..." },
    restore: { percent: 65, message: "Orijinal ayarlarınız geri yükleniyor..." },
    verify: { percent: 90, message: "Geri yükleme doğrulanıyor..." },
    done: { percent: 100, message: "Önceki ayarlarınız geri yüklendi." },
  });

  function progress(toolId, step, table, overrides = {}) {
    if (!onProgress) return;
    const entry = table[step] || {};
    try {
      onProgress({
        scope: toolId,
        phase: step,
        percent: entry.percent ?? null,
        message: overrides.message || entry.message || "",
        done: step === "done" || overrides.done === true,
        ...(overrides.error ? { error: overrides.error } : {}),
      });
    } catch {
      // Progress reporting must never be able to fail an operation.
    }
  }

  function progressFor(options) {
    return options?.reportProgress === false ? () => {} : progress;
  }

  // ---------------------------------------------------------------- adapters
  // Every switch looks the same from here: report status, apply, revert, verify.
  // Claude Desktop keeps its own transaction engine and the registry tools are a
  // config file each, but the policy above does not need to know the difference.
  const desktopAdapter = {
    id: CLAUDE_DESKTOP_ID,
    name: "Claude Desktop",
    async status() {
      const status = await claude.desktopStatus(baseUrl);
      return {
        applied: status.applied === true,
        restorable: status.restorable === true,
        installed: status.installed === true,
        blocked: status.blocked === true,
        blockReason: status.blockReason,
        // Claude Desktop reads its managed configuration once at startup, so it
        // has to be closed before anything may be written. Knowing that up front
        // means the question is asked before the intent record is touched.
        requiresClose: status.installed === true && status.running === true,
        raw: status,
      };
    },
    apply: (values, options) => claude.applyDesktop(values, options),
    revert: (options) => claude.revertDesktop(options),
    // Reading Claude Desktop's state means scanning Windows processes, so a
    // status that has just been read is reused rather than paid for twice.
    verify: async (values, status) => (status ? status.applied === true : (await claude.desktopStatus(baseUrl)).applied === true),
  };

  function registryAdapter(toolId) {
    return {
      id: toolId,
      name: getTool(toolId)?.name || toolId,
      async status() {
        const status = toolManager.getToolStatus(toolId, baseUrl);
        return {
          applied: status?.applied === true,
          restorable: status?.restorable === true,
          installed: true,
          blocked: false,
          blockReason: null,
          raw: status,
        };
      },
      apply: async (values) => toolManager.applyTool(toolId, values),
      revert: async () => toolManager.revertTool(toolId, baseUrl),
      verify: async (values) => toolManager.verifyTool(toolId, values),
    };
  }

  function adapterFor(toolId) {
    if (toolId === CLAUDE_DESKTOP_ID) return desktopAdapter;
    if (!listToolIds().includes(toolId)) throw codedError("TOOL_UNKNOWN", `Tanınmayan araç: ${toolId}`);
    return registryAdapter(toolId);
  }

  // Every switch the user can see. Claude Code CLI and Claude Desktop are two of
  // them: they share no configuration file, so one failing must never take the
  // other down. (Codex is the opposite - its two products read one config.toml,
  // which is why it stays a single switch.)
  function switchIds() {
    return [CLAUDE_CODE_TOOL_ID, CLAUDE_DESKTOP_ID, ...listToolIds().filter((id) => id !== CLAUDE_CODE_TOOL_ID)];
  }

  // One record used to describe both Claude products. Split it in two before
  // anything reads it, so a user who had the switch on keeps both halves on
  // instead of silently losing the connection.
  function migrateLegacyIntent() {
    const legacy = intentStore.get(LEGACY_CLAUDE_INTENT_ID);
    if (!legacy) return false;
    for (const id of [CLAUDE_CODE_TOOL_ID, CLAUDE_DESKTOP_ID]) {
      if (!intentStore.get(id)) intentStore.set(id, legacy.enabled, legacy.values);
    }
    intentStore.remove(LEGACY_CLAUDE_INTENT_ID);
    log?.info("tools", "Claude kaydı iki ayrı anahtara taşındı", {
      enabled: legacy.enabled,
      toolIds: [CLAUDE_CODE_TOOL_ID, CLAUDE_DESKTOP_ID],
    });
    return true;
  }

  migrateLegacyIntent();

  // ------------------------------------------------------------------- queue
  // One in-flight operation per tool. Toggling twice, or a timer firing during a
  // toggle, queues instead of racing over the same configuration files.
  const queues = new Map();

  function withLock(toolId, task) {
    const previous = queues.get(toolId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(toolId, next.catch(() => {}));
    return next;
  }

  // ------------------------------------------------------------------ intent
  // A machine with no record yet adopts what it already looks like, so an
  // existing connection survives an app update instead of being torn down.
  function intentFor(toolId, applied) {
    return intentStore.get(toolId) || intentStore.set(toolId, applied === true);
  }

  function intendedValues(entry) {
    return { ...(entry?.values || {}), base: baseUrl, apiKey: getSession()?.apiKey || "" };
  }

  // ------------------------------------------------------------------ enable
  async function enable(toolId, options = {}) {
    return withLock(toolId, () => enableUnlocked(toolId, options));
  }

  async function enableUnlocked(toolId, options) {
    const adapter = adapterFor(toolId);
    const intentId = adapter.id;
    const report = progressFor(options);
    let values = null;
    let intentCommitted = false;
    report(intentId, "precheck", ENABLE_STEPS);
    try {
      const status = await adapter.status();
      if (!status.installed) {
        throw codedError("TOOL_NOT_INSTALLED", `${adapter.name} bu bilgisayarda kurulu değil.`);
      }
      if (status.blocked) {
        throw codedError("TOOL_BLOCKED", status.blockReason || `${adapter.name} şu an ayarlanamıyor.`);
      }
      // Asked before anything is recorded, so a declined prompt leaves the switch
      // exactly as the user left it.
      if (status.requiresClose && options.closeRunning !== true) {
        throw codedError(
          CONFIRMATION_REQUIRED,
          "Claude Desktop şu an açık. Ayarların uygulanabilmesi için kapatılması gerekiyor.",
        );
      }

      report(intentId, "models", ENABLE_STEPS);
      values = await resolveValues(toolId);
      if (!values?.model) {
        throw codedError("MODEL_REQUIRED", `${adapter.name} için uygun bir hesap modeli bulunamadı.`);
      }

      // Intent first: an interrupted apply is finished by the reconcile, not undone.
      intentStore.set(intentId, true, values);
      intentCommitted = true;
      // The backup is taken inside `apply`; it is reported separately because it
      // is the step that protects the user's own settings, and a user watching a
      // switch has a right to see it happen.
      report(intentId, "backup", ENABLE_STEPS);
      report(intentId, "apply", ENABLE_STEPS);
      const result = await adapter.apply(values, options);
      report(intentId, "verify", ENABLE_STEPS);
      if (!await adapter.verify(values)) {
        throw codedError("TOOL_APPLY_VERIFY_FAILED", `${adapter.name} ayarları doğrulanamadı.`);
      }
      intentStore.markSettled(intentId);
      log?.success("tools", `${adapter.name} bağlandı ve doğrulandı`, {
        toolId: intentId,
        defaultModel: values.model,
        modelCount: values.models?.length || 1,
      });
      report(intentId, "done", ENABLE_STEPS, { message: `${adapter.name} bağlandı.` });
      // The periodic monitor is part of keeping a connection alive, so it is put
      // in place as soon as there is a connection to watch. It can never fail the
      // switch: the configuration is already written and verified.
      await ensureMonitor();
      return { ...result, ok: true, toolId: intentId, modelCount: values.models?.length || 1, defaultModel: values.model };
    } catch (error) {
      if (error?.code === CONFIRMATION_REQUIRED) {
        report(intentId, "precheck", ENABLE_STEPS, { message: "Onay bekleniyor.", done: true });
        throw error;
      }
      if (!intentCommitted) {
        log?.warning("tools", `${adapter.name} işlemi ön denetimde durdu: ${errorCode(error)}`, {
          toolId: intentId,
          rollback: "not-required",
        });
        report(intentId, "done", ENABLE_STEPS, {
          message: `${adapter.name} işlemi başlatılamadı.`,
          error: errorCode(error),
        });
        throw error;
      }
      report(intentId, "verify", ENABLE_STEPS, {
        message: `${adapter.name} bağlanamadı; önceki ayarlarınız geri yükleniyor...`,
        error: errorCode(error),
      });
      // The switch could not be turned on, so it is off - and the machine is put
      // back through the same verified undo path the user's own OFF uses.
      intentStore.set(intentId, false, values);
      log?.error("tools", `${adapter.name} bağlanamadı: ${errorCode(error)}`, { toolId: intentId });
      await compensate(adapter, errorCode(error));
      report(intentId, "done", ENABLE_STEPS, {
        message: `${adapter.name} bağlanamadı.`,
        error: errorCode(error),
      });
      throw error;
    }
  }

  async function ensureMonitor() {
    if (!backgroundTask?.ensure) return null;
    try { return await backgroundTask.ensure(); }
    catch (error) {
      log?.error("reconcile", `Periyodik denetim görevi kurulamadı: ${errorCode(error)}`);
      return { ok: false, errorCode: errorCode(error) };
    }
  }

  // Best effort by design: the caller is already reporting a failure. What
  // matters is that the outcome of the undo is logged, so a machine that is
  // genuinely stranded is visible instead of silent.
  async function compensate(adapter, reason) {
    try {
      await adapter.revert({ closeRunning: false });
      const after = await adapter.status();
      if (after.applied || after.restorable) {
        log?.warning("tools", `${adapter.name} kısmen geri alındı; kalan ayarlar denetimde tamamlanacak`, {
          toolId: adapter.id, reason, rollback: "pending",
        });
      } else {
        log?.success("tools", `${adapter.name} geri alma işlemi doğrulandı`, { toolId: adapter.id, reason, rollback: "verified" });
      }
    } catch (revertError) {
      log?.error("tools", `${adapter.name} geri alınamadı: ${errorCode(revertError)}`, {
        toolId: adapter.id, reason, rollback: "failed",
      });
    }
  }

  // ----------------------------------------------------------------- disable
  async function disable(toolId, options = {}) {
    return withLock(toolId, () => disableUnlocked(toolId, options));
  }

  async function disableUnlocked(toolId, options) {
    const adapter = adapterFor(toolId);
    const intentId = adapter.id;
    // Off is what the user asked for, so it is recorded before anything is
    // touched and it is never taken back. An interrupted restore is finished by
    // the reconcile; a restore that needs permission to close an app still
    // leaves the switch off and the remaining work pending.
    const report = progressFor(options);
    intentStore.set(intentId, false);
    report(intentId, "precheck", DISABLE_STEPS);
    report(intentId, "restore", DISABLE_STEPS);
    const result = await adapter.revert(options);
    report(intentId, "verify", DISABLE_STEPS);
    const after = await adapter.status();
    if (after.applied) {
      report(intentId, "done", DISABLE_STEPS, {
        message: `${adapter.name} önceki ayarlarına döndürülemedi.`,
        error: "TOOL_RESTORE_VERIFY_FAILED",
      });
      throw codedError("TOOL_RESTORE_VERIFY_FAILED", `${adapter.name} önceki ayarlarına döndürülemedi. Tekrar deneyin.`);
    }
    // Settled only when nothing is left to put back. A restore that still has a
    // backup on disk is unfinished work, and the periodic check has to keep
    // looking at it.
    if (after.restorable !== true) intentStore.markSettled(intentId);
    log?.success("tools", `${adapter.name} bağlantısı kaldırıldı; önceki ayarlar geri yüklendi`, {
      toolId: intentId,
      restorePending: after.restorable === true,
    });
    report(intentId, "done", DISABLE_STEPS, {
      message: after.restorable === true
        ? "Bağlantı kapatıldı; geri yükleme tamamlanacak."
        : "Önceki ayarlarınız geri yüklendi.",
    });
    return { ...result, ok: true, toolId: intentId, applied: false, restorePending: after.restorable === true };
  }

  // --------------------------------------------------------------- reconcile
  // Compares every switch's recorded intent with what the machine actually looks
  // like, and closes the gap using the very same enable/disable paths the user's
  // own clicks use. There is no second copy of the on/off logic here.
  async function reconcileOne(toolId, { trustSettled = false, reportProgress = true } = {}) {
    return withLock(toolId, async () => {
      const adapter = adapterFor(toolId);
      // Reading a switch's real state is not free: for Claude Desktop it means
      // enumerating Windows processes and querying the package registration.
      //
      // On the idle timer, a switch the user turned off whose restore was already
      // verified is skipped - there is nothing there that could need repairing,
      // and paying for that answer every few minutes is what makes a background
      // check felt on the machine.
      //
      // `trustSettled` is false for the user's own "verify connections", for app
      // startup and for any manual run, so a full check is always available and
      // the drift repair of point 9 never depends on a cached belief.
      const recorded = intentStore.get(adapter.id);
      if (trustSettled && recorded?.enabled === false && recorded.settled === true) {
        return { id: adapter.id, desiredEnabled: false, action: "none", ok: true, skipped: "settled" };
      }
      const status = await adapter.status();
      if (status.installed === false) {
        if (recorded?.enabled === true) {
          intentStore.set(adapter.id, false, recorded.values);
          log?.info("reconcile", `${adapter.name} kurulu olmadığı için eski açık anahtar kaydı kapatıldı`, {
            toolId: adapter.id,
            previousIntent: true,
          });
        }
        if (!status.applied && !status.restorable) {
          intentStore.markSettled(adapter.id);
          return {
            id: adapter.id,
            desiredEnabled: false,
            beforeApplied: false,
            action: "none",
            ok: true,
            skipped: "not-installed",
          };
        }
      }
      const intent = intentFor(adapter.id, status.applied);
      const outcome = {
        id: adapter.id,
        desiredEnabled: intent.enabled,
        beforeApplied: status.applied,
        action: "none",
        ok: true,
      };
      try {
        if (!intent.enabled) {
          if (!status.applied && !status.restorable) {
            // Kapalı, uygulanmamış ve geri yüklenecek bir şey yok: makine niyetle
            // aynı fikirde. Bu DOĞRULANMIŞ bir gözlemdir, o yüzden kaydedilir ve
            // bundan sonraki periyodik turlar bu anahtarı hiç okumaz.
            //
            // Bunu yalnızca kullanıcı bir anahtarı kapattığında kaydetmek yetmiyordu:
            // hiç dokunulmamış bir kurulumda - yani en sık durumda - hiçbir kayıt
            // "oturmuş" olmuyor ve Claude Desktop'ın süreç taraması beş dakikada bir
            // boşuna çalışıyordu.
            if (!intent.settled) intentStore.markSettled(adapter.id);
            return { ...outcome, settled: true };
          }
          outcome.action = "restore";
          const result = await disableUnlocked(adapter.id, { closeRunning: false, reportProgress });
          outcome.restorePending = result.restorePending === true;
          if (result.restorePending) {
            outcome.ok = false;
            outcome.pending = true;
            outcome.reason = "restore-pending";
          }
          return outcome;
        }

        if (status.applied && await adapter.verify(intendedValues(intent), status)) {
          outcome.verified = true;
          return outcome;
        }
        if (!getSession()?.apiKey || !intent.values?.model) {
          outcome.ok = false;
          outcome.pending = true;
          outcome.reason = !getSession()?.apiKey ? "session-required" : "model-record-required";
          log?.warning("reconcile", `${adapter.name} yeniden uygulanamadı; oturum veya model kaydı bekleniyor`, {
            toolId: adapter.id, reason: outcome.reason,
          });
          return outcome;
        }
        outcome.action = "reapply";
        await enableUnlocked(adapter.id, { closeRunning: false, reportProgress });
        outcome.verified = true;
        return outcome;
      } catch (error) {
        outcome.ok = false;
        outcome.errorCode = errorCode(error);
        // A switch that only needs Claude Desktop closed is waiting on the user,
        // not broken - the difference is what the report has to preserve.
        if (outcome.errorCode === CONFIRMATION_REQUIRED) {
          outcome.ok = true;
          outcome.pending = true;
          outcome.reason = "claude-desktop-running";
        } else {
          log?.error("reconcile", `${adapter.name} uzlaştırılamadı: ${outcome.errorCode}`, {
            toolId: adapter.id, action: outcome.action,
          });
        }
        return outcome;
      }
    });
  }

  let running = null;

  // Unattended runs are allowed to skip switches that are already settled off;
  // anything the user asked for reads the machine in full.
  const UNATTENDED_REASONS = new Set(["interval", "scheduled-task"]);

  async function reconcile(reason = "manual") {
    if (running) return running;
    running = (async () => {
      const startedAt = new Date().toISOString();
      const trustSettled = UNATTENDED_REASONS.has(reason);
      const reportProgress = reason === "manual";
      log?.info("reconcile", `Tüm bağlantılar denetleniyor (${reason})`, { reason });
      const tools = [];
      for (const toolId of switchIds()) tools.push(await reconcileOne(toolId, { trustSettled, reportProgress }));
      // The monitor task only matters when something is actually connected;
      // registering it on an idle machine with every switch off is work nobody
      // asked for.
      const monitor = tools.some((item) => item.desiredEnabled) ? await ensureMonitor() : null;
      const repaired = tools.filter((item) => item.ok && item.action !== "none" && !item.pending).length;
      const pending = tools.filter((item) => item.pending).length;
      const skipped = tools.filter((item) => item.skipped).length;
      const failed = tools.filter((item) => !item.ok).length + (monitor?.ok === false ? 1 : 0);
      const level = failed ? "error" : pending ? "warning" : repaired ? "success" : "info";
      log?.[level]?.("reconcile", `Denetim tamamlandı: ${repaired} düzeltildi, ${pending} bekliyor, ${failed} hata`, {
        repaired, pending, failed, skipped, reason,
      });
      return {
        ok: failed === 0,
        reason, startedAt, finishedAt: new Date().toISOString(),
        repaired, pending, failed, skipped, monitor, tools,
      };
    })().finally(() => { running = null; });
    return running;
  }

  // ------------------------------------------------------------------ status
  // What the screen shows. The switch follows intent; "applied" is the fact it is
  // compared against, so a mismatch can be named instead of hidden.
  async function listStatuses() {
    const statuses = [];
    for (const toolId of switchIds()) {
      const adapter = adapterFor(toolId);
      const status = await adapter.status();
      const intent = intentStore.get(adapter.id);
      statuses.push({
        id: adapter.id,
        name: adapter.name,
        desiredEnabled: status.installed === false ? false : (intent ? intent.enabled : status.applied),
        applied: status.applied,
        restorable: status.restorable,
        installed: status.installed,
        blocked: status.blocked,
        blockReason: status.blockReason,
        detail: status.raw,
      });
    }
    return statuses;
  }

  // -------------------------------------------------------------------- timer
  let timer = null;

  function start() {
    if (timer) return timer;
    timer = setIntervalFn(() => { void reconcile("interval"); }, Math.max(MIN_INTERVAL_MS, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    timer?.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return { enable, disable, reconcile, reconcileOne, listStatuses, intentFor, start, stop, switchIds };
}

module.exports = {
  CLAUDE_CODE_TOOL_ID,
  CLAUDE_DESKTOP_ID,
  DEFAULT_INTERVAL_MS,
  CONFIRMATION_REQUIRED,
  createIntegrationService,
};
