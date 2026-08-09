const { listToolIds } = require("./registry");

const CLAUDE_INTENT_ID = "claude";
const CLAUDE_CODE_TOOL_ID = "claude-code";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function errorText(error) {
  return String(error?.code || error?.message || error || "UNKNOWN_ERROR");
}

function createIntegrationReconciler({
  toolManager,
  claude,
  intentStore,
  getSession,
  baseUrl,
  log,
  backgroundTask = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!toolManager || !claude || !intentStore || typeof getSession !== "function") {
    throw new TypeError("Integration reconciler dependencies are required.");
  }

  let running = null;
  let timer = null;

  function intendedValues(entry, session) {
    return {
      ...(entry?.values || {}),
      base: baseUrl,
      apiKey: session?.apiKey || "",
    };
  }

  function ensureIntent(toolId, enabled, values = null) {
    return intentStore.get(toolId) || intentStore.set(toolId, enabled, values);
  }

  async function reconcileTool(toolId, session) {
    let before = toolManager.getToolStatus(toolId, baseUrl);
    const intent = ensureIntent(toolId, before?.applied === true);
    const result = {
      id: toolId,
      desiredEnabled: intent.enabled,
      beforeApplied: before?.applied === true,
      action: "none",
      ok: true,
    };

    try {
      if (!intent.enabled) {
        if (before?.applied || before?.hasBackup) {
          result.action = "restore";
          const restored = toolManager.revertTool(toolId, baseUrl);
          const after = toolManager.getToolStatus(toolId, baseUrl);
          result.afterApplied = after?.applied === true;
          result.restored = restored?.restored === true || restored?.cleanup?.changed === true;
          if (result.afterApplied) throw new Error("TOOL_RESTORE_VERIFY_FAILED");
          log?.success?.("reconcile", `${toolId} kapalı durumla uzlaştırıldı; önceki ayarlar geri yüklendi`, { toolId, action: result.action });
        } else {
          result.afterApplied = false;
        }
        return result;
      }

      const values = intendedValues(intent, session);
      const verified = session?.apiKey && intent.values?.model
        ? toolManager.verifyTool(toolId, values)
        : before?.applied === true;
      if (verified) {
        result.afterApplied = true;
        result.verified = true;
        return result;
      }
      if (!session?.apiKey || !intent.values?.model) {
        result.ok = false;
        result.pending = true;
        result.reason = !session?.apiKey ? "session-required" : "model-record-required";
        log?.warning?.("reconcile", `${toolId} doğrulanamadı; yeniden uygulama için oturum veya model kaydı bekleniyor`, { toolId, reason: result.reason });
        return result;
      }

      result.action = "reapply";
      toolManager.applyTool(toolId, values);
      before = toolManager.getToolStatus(toolId, baseUrl);
      result.afterApplied = before?.applied === true;
      result.verified = toolManager.verifyTool(toolId, values);
      if (!result.afterApplied || !result.verified) throw new Error("TOOL_APPLY_VERIFY_FAILED");
      log?.success?.("reconcile", `${toolId} açık durumla uzlaştırıldı; yapılandırma yeniden doğrulandı`, { toolId, action: result.action });
      return result;
    } catch (error) {
      result.ok = false;
      result.errorCode = errorText(error);
      log?.error?.("reconcile", `${toolId} uzlaştırılamadı: ${result.errorCode}`, { toolId, action: result.action });
      return result;
    }
  }

  async function reconcileClaude(session) {
    let state = await claude.getState(baseUrl);
    const intent = ensureIntent(CLAUDE_INTENT_ID, state.connected === true);
    const result = {
      id: CLAUDE_INTENT_ID,
      desiredEnabled: intent.enabled,
      beforeApplied: state.connected === true,
      partialBefore: state.partial === true,
      action: "none",
      ok: true,
    };

    try {
      if (!intent.enabled) {
        // The CLI half is always safe to restore independently. This is what
        // heals a failed Desktop activation even while Claude Desktop is open.
        if (state.cli?.applied || state.cli?.hasBackup) {
          result.action = "restore";
          const cliRestore = toolManager.revertTool(CLAUDE_CODE_TOOL_ID, baseUrl);
          const cliAfter = toolManager.getToolStatus(CLAUDE_CODE_TOOL_ID, baseUrl);
          result.cliRestored = cliAfter?.applied !== true;
          if (!result.cliRestored) throw new Error("CLAUDE_CLI_RESTORE_VERIFY_FAILED");
          result.cliRestore = { restored: cliRestore?.restored === true, cleanupChanged: cliRestore?.cleanup?.changed === true };
        }

        state = await claude.getState(baseUrl);
        if (state.desktop?.applied || state.desktop?.hasBackup) {
          if (state.desktop?.running) {
            result.ok = false;
            result.pending = true;
            result.reason = "claude-desktop-running";
            result.afterApplied = false;
            log?.warning?.("reconcile", "Claude Code CLI geri alındı; Claude Desktop kapanınca kalan ayarlar geri yüklenecek", { toolId: CLAUDE_INTENT_ID });
            return result;
          }
          result.action = "restore";
          await claude.disconnect(baseUrl, { closeRunning: false });
        }

        const after = await claude.getState(baseUrl);
        result.afterApplied = after.connected === true || after.partial === true;
        if (after.cli?.applied || after.desktop?.applied) throw new Error("CLAUDE_RESTORE_VERIFY_FAILED");
        if (result.action === "none") {
          log?.info?.("reconcile", "Claude kapalı durumu doğrulandı; Cizi Code kalıntısı bulunmadı", { toolId: CLAUDE_INTENT_ID });
        } else {
          log?.success?.("reconcile", "Claude kapalı durumla uzlaştırıldı; CLI ve Desktop kalıntıları geri alındı", { toolId: CLAUDE_INTENT_ID, action: result.action });
        }
        return result;
      }

      if (state.connected) {
        result.afterApplied = true;
        result.verified = true;
        return result;
      }
      if (!session?.apiKey || !intent.values?.model) {
        result.ok = false;
        result.pending = true;
        result.reason = !session?.apiKey ? "session-required" : "model-record-required";
        return result;
      }
      if (state.desktop?.running) {
        result.ok = false;
        result.pending = true;
        result.reason = "claude-desktop-running";
        return result;
      }

      result.action = "reapply";
      await claude.connect(intendedValues(intent, session), { closeRunning: false });
      state = await claude.getState(baseUrl);
      result.afterApplied = state.connected === true;
      result.verified = state.connected === true;
      if (!result.verified) throw new Error("CLAUDE_APPLY_VERIFY_FAILED");
      log?.success?.("reconcile", "Claude açık durumla uzlaştırıldı; CLI ve Desktop yeniden doğrulandı", { toolId: CLAUDE_INTENT_ID, action: result.action });
      return result;
    } catch (error) {
      result.ok = false;
      result.errorCode = errorText(error);
      log?.error?.("reconcile", `Claude uzlaştırılamadı: ${result.errorCode}`, { toolId: CLAUDE_INTENT_ID, action: result.action });
      return result;
    }
  }

  async function run(reason = "manual") {
    if (running) return running;
    running = (async () => {
      const startedAt = new Date().toISOString();
      log?.info?.("reconcile", `Tüm tool yapılandırmaları denetleniyor (${reason})`, { reason });
      const session = getSession() || null;
      const results = [];
      results.push(await reconcileClaude(session));
      for (const toolId of listToolIds()) {
        if (toolId === CLAUDE_CODE_TOOL_ID) continue;
        results.push(await reconcileTool(toolId, session));
      }
      let monitor = null;
      if (backgroundTask?.ensure) {
        try {
          monitor = await backgroundTask.ensure();
        } catch (error) {
          monitor = { ok: false, errorCode: errorText(error) };
          log?.error?.("reconcile", `Periyodik tool denetim görevi doğrulanamadı: ${monitor.errorCode}`);
        }
      }
      const repaired = results.filter((item) => item.ok && item.action !== "none").length;
      const pending = results.filter((item) => item.pending).length;
      const failed = results.filter((item) => !item.ok && !item.pending).length + (monitor?.ok === false ? 1 : 0);
      const report = { ok: failed === 0, reason, startedAt, finishedAt: new Date().toISOString(), repaired, pending, failed, monitor, tools: results };
      const level = failed ? "error" : pending ? "warning" : repaired ? "success" : "info";
      log?.[level]?.("reconcile", `Tool denetimi tamamlandı: ${repaired} düzeltildi, ${pending} bekliyor, ${failed} hata`, { repaired, pending, failed, reason });
      return report;
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (timer) return timer;
    timer = setIntervalFn(() => { void run("interval"); }, Math.max(30000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    timer?.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return { run, start, stop, reconcileTool, reconcileClaude };
}

module.exports = { CLAUDE_INTENT_ID, CLAUDE_CODE_TOOL_ID, DEFAULT_INTERVAL_MS, createIntegrationReconciler };
