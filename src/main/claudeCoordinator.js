// One switch over the two local Claude products.
//
// Unlike Codex — where the CLI and the desktop app read the same config file —
// Claude Code CLI and Claude Desktop are configured through completely
// different mechanisms: the CLI through ~/.claude/settings.json, the desktop
// app through its managed configuration surface plus a credential helper, with
// its own baseline snapshot, transaction and rollback.
//
// This coordinator is the only place that knows both. It connects them as one
// unit: if the second product fails to connect, the first is put back, so the
// user never ends up with half a connection and no way to tell.
//
// Dependencies arrive from the composition root so the flow stays testable.
"use strict";

const CLAUDE_CODE_TOOL_ID = "claude-code";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.userMessage = message;
  return error;
}

// Desktop errors carry machine-readable codes; the user needs a sentence that
// says what to do about it.
const DESKTOP_MESSAGES = {
  PROCESS_RUNNING: "Claude Desktop açıkken bu ayar değiştirilemez. Uygulamayı tamamen kapatıp tekrar deneyin.",
  INSTALL_REQUIRED: "Claude Desktop bu bilgisayarda kurulu değil.",
  MACHINE_POLICY_BLOCK: "Claude Desktop bu bilgisayarda bir kurum politikasıyla yönetiliyor. Cizi Code bu ayarı değiştirmez.",
  USER_POLICY_BLOCK: "Claude Desktop'ta zaten bir kullanıcı politikası var. Cizi Code onu değiştirmedi.",
  REPAIR_REQUIRED: "Claude Desktop'ın önceki ayarlarının yedeği bulunamadı; önce onarım gerekiyor.",
  PROCESS_SCAN_FAILED: "Claude Desktop süreçleri güvenli şekilde denetlenemedi. Tekrar deneyin.",
  CLAUDE_DESKTOP_DETECTION_FAILED: "Cizi Code Claude Desktop'ı doğrulayamadı. Tekrar deneyin.",
  CLAUDE_DESKTOP_MODEL_REQUIRED: "Claude Desktop'ı bağlamadan önce bir model seçin.",
  TOOL_OPERATION_IN_PROGRESS: "Claude Desktop üzerinde başka bir işlem sürüyor. Bitmesini bekleyin.",
  CLAUDE_TRANSLATION_UNAVAILABLE: "Bu Claude Desktop sürümü için doğrulanmış arayüz paketi henüz yok.",
};

function desktopMessage(error) {
  const code = String(error?.code || "");
  return DESKTOP_MESSAGES[code] || error?.userMessage || error?.message || "Claude Desktop ayarlanamadı.";
}

function createClaudeCoordinator({
  claudeDesktop,
  lifecycle,
  toolManager,
  detectCli,
  installCli,
  log,
  onDesktopProgress,
} = {}) {
  const report = (phase, message, details) => {
    try { onDesktopProgress?.({ phase, message, details: details || null }); } catch { /* progress is advisory */ }
  };

  async function safe(task, fallback) {
    try { return await task(); } catch (error) {
      log?.warn("claude", `Claude durumu okunamadı: ${error?.message || error}`);
      return fallback;
    }
  }

  function trySync(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  // Combined view of both products plus whether each is currently connected.
  async function getState(base) {
    const [cli, desktop] = await Promise.all([
      safe(() => detectCli(), { installed: false, command: null, version: null }),
      safe(() => claudeDesktop.getStatus(base), { installed: false, applied: false, blocked: false, errorCode: "CLAUDE_DESKTOP_STATUS_FAILED" }),
    ]);
    const cliApplied = trySync(() => toolManager.getToolStatus(CLAUDE_CODE_TOOL_ID, base)?.applied === true, false);
    // "Connected" means every product that is actually installed is connected.
    // With nothing installed there is nothing to connect.
    const installed = [];
    if (cli.installed) installed.push("cli");
    if (desktop.installed) installed.push("desktop");
    const connected = installed.length > 0
      && (!cli.installed || cliApplied)
      && (!desktop.installed || desktop.applied === true);
    return {
      cli: { ...cli, applied: cliApplied },
      desktop,
      installedProducts: installed,
      connected,
      partial: installed.length > 0 && !connected && (cliApplied || desktop.applied === true),
      canConnect: installed.length > 0 && !desktop.blocked,
      blockReason: desktop.blocked ? (desktop.blockReason || "Claude Desktop şu an denetlenemiyor.") : null,
    };
  }

  // Connects both products as one unit. The CLI goes first because it is the
  // cheap, reversible half; if the desktop transaction then fails, the CLI is
  // reverted so the switch never reports a half-connected state.
  async function connect(values) {
    const state = await getState(values?.base);
    if (!state.installedProducts.length) {
      throw codedError("CLAUDE_NOT_INSTALLED", "Önce Claude Code CLI veya Claude Desktop kurun.");
    }
    if (state.desktop.blocked && state.desktop.installed) {
      throw codedError("CLAUDE_DESKTOP_BLOCKED", state.blockReason || "Claude Desktop şu an ayarlanamıyor.");
    }
    if (!values?.model) throw codedError("MODEL_REQUIRED", "Önce bir model seçin.");

    let cliApplied = false;
    if (state.cli.installed) {
      report("configuring", "Claude Code CLI ayarlanıyor...");
      toolManager.applyTool(CLAUDE_CODE_TOOL_ID, values);
      cliApplied = true;
      log?.info("claude", "Claude Code CLI bağlandı", { model: values.model });
    }

    let desktopResult = null;
    if (state.desktop.installed) {
      try {
        desktopResult = await claudeDesktop.apply(values, (phase, message, details) => report(phase, message, details));
        log?.info("claude", "Claude Desktop bağlandı", {
          model: values.model,
          launched: desktopResult?.launched === true,
          branding: desktopResult?.brandingStatus || null,
        });
      } catch (error) {
        // Undo the CLI half so the two never disagree about being connected.
        if (cliApplied) {
          try {
            toolManager.revertTool(CLAUDE_CODE_TOOL_ID, values.base);
            log?.info("claude", "Claude Desktop bağlanamadığı için Claude Code CLI ayarı geri alındı");
          } catch (revertError) {
            log?.error("claude", `Claude Code CLI geri alınamadı: ${revertError?.message || revertError}`);
          }
        }
        log?.error("claude", `Claude Desktop bağlanamadı: ${error?.code || ""} ${error?.message || error}`);
        throw Object.assign(error, { userMessage: desktopMessage(error) });
      }
    }

    report("", "");
    return {
      ok: true,
      connectedProducts: [...(cliApplied ? ["cli"] : []), ...(desktopResult ? ["desktop"] : [])],
      skipped: state.installedProducts.filter((id) => (id === "cli" ? !cliApplied : !desktopResult)),
      desktop: desktopResult,
    };
  }

  // Disconnects both. The desktop half runs first because it is the one that
  // can refuse (a running app, a missing baseline); the CLI half is then always
  // reverted, so a desktop failure cannot strand the CLI in a connected state.
  async function disconnect(base) {
    const state = await getState(base);
    let desktopResult = null;
    let desktopError = null;

    if (state.desktop.applied === true || state.desktop.hasBackup) {
      try {
        report("restoring", "Claude Desktop önceki ayarlarına döndürülüyor...");
        desktopResult = await claudeDesktop.revert();
        log?.info("claude", "Claude Desktop ayarları geri alındı", { restored: desktopResult?.restored === true });
      } catch (error) {
        desktopError = error;
        log?.error("claude", `Claude Desktop geri alınamadı: ${error?.code || ""} ${error?.message || error}`);
      }
    }

    let cliResult = null;
    if (state.cli.applied) {
      cliResult = toolManager.revertTool(CLAUDE_CODE_TOOL_ID, base);
      log?.info("claude", "Claude Code CLI ayarları geri alındı", { restored: cliResult?.restored === true });
    }

    report("", "");
    if (desktopError) {
      throw Object.assign(desktopError, {
        userMessage: desktopMessage(desktopError),
        partial: { cliReverted: !!cliResult },
      });
    }
    return { ok: true, desktop: desktopResult, cli: cliResult };
  }

  async function installDesktop() {
    report("starting", "Claude Desktop kurulumu başlatılıyor...");
    try {
      const result = await lifecycle.installTool("claude-desktop", (phase, message, details) => report(phase, message, details));
      log?.info("claude", "Claude Desktop kuruldu", { version: result?.Version || result?.version || null });
      report("complete", "Claude Desktop kuruldu.");
      return result;
    } catch (error) {
      report("error", error?.userMessage || error?.message || "Claude Desktop kurulamadı.");
      log?.error("claude", `Claude Desktop kurulumu başarısız: ${error?.code || ""} ${error?.message || error}`);
      throw error;
    }
  }

  async function installCliTool() {
    if (typeof installCli !== "function") throw codedError("NOT_SUPPORTED", "Claude Code CLI kurulumu bu sürümde yok.");
    return installCli();
  }

  // Re-applies the configuration after a Claude Desktop update replaced it.
  async function repairDesktop() {
    report("repairing", "Claude Desktop ayarları yenileniyor...");
    try {
      const result = await claudeDesktop.reconcile((phase, message, details) => report(phase, message, details));
      log?.info("claude", "Claude Desktop onarımı tamamlandı", { reconciled: result?.reconciled === true, reason: result?.reason || null });
      report("", "");
      return result;
    } catch (error) {
      report("error", desktopMessage(error));
      throw Object.assign(error, { userMessage: desktopMessage(error) });
    }
  }

  async function launchDesktop() {
    try {
      const result = await claudeDesktop.launch((phase, message, details) => report(phase, message, details));
      log?.info("claude", "Claude Desktop başlatıldı", { target: result?.launchTarget || null });
      report("", "");
      return result;
    } catch (error) {
      report("", "");
      throw Object.assign(error, { userMessage: desktopMessage(error) });
    }
  }

  async function stopDesktop() {
    const result = await lifecycle.stopTool("claude-desktop");
    log?.info("claude", "Claude Desktop kapatıldı", { stopped: result?.stopped ?? null });
    return result;
  }

  return {
    getState,
    connect,
    disconnect,
    installDesktop,
    installCli: installCliTool,
    repairDesktop,
    launchDesktop,
    stopDesktop,
    desktopMessage,
  };
}

module.exports = { createClaudeCoordinator, desktopMessage, CLAUDE_CODE_TOOL_ID };
