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
  CLAUDE_DESKTOP_MODEL_REQUIRED: "Claude Desktop için uygun bir hesap modeli bulunamadı.",
  TOOL_OPERATION_IN_PROGRESS: "Claude Desktop üzerinde başka bir işlem sürüyor. Bitmesini bekleyin.",
  CLAUDE_STATE_UNREADABLE: "Claude Desktop entegrasyon kaydı okunamıyor. Anahtarı kapatın; kayıtlı orijinal ayarlar geri yüklenecek.",
  CLAUDE_DESKTOP_DISCONNECT_PENDING: "Önceki bağlantı tam kapatılmamış; orijinal ayarlarınız hâlâ yedekte duruyor. Anahtarı bir kez kapatıp geri yükleyin, sonra tekrar bağlanın.",
  CLAUDE_BASELINE_RESTORE_VERIFY_FAILED: "Claude Desktop'ın orijinal ayarları birebir geri yüklenemedi. Tekrar deneyin.",
  // Claude Desktop'ın resmî MSIX paketi localSystem altında çalışan bir Windows
  // servisi kaydeder. Windows bunu yönetici onayı olmadan kurmaz; kullanıcıya
  // istenen şeyin ne olduğu açıkça söylenir.
  CLAUDE_DESKTOP_INSTALL_CANCELLED: "Yönetici onayı verilmedi, bu yüzden Claude Desktop kurulmadı. Tekrar deneyip Windows'un sorduğu izni onaylayın.",
  CLAUDE_DESKTOP_INSTALL_ELEVATION_REQUIRED: "Claude Desktop paketi bir Windows servisi kaydettiği için yönetici onayı gerekiyor. Tekrar deneyip Windows'un sorduğu izni onaylayın.",
  CLAUDE_DESKTOP_INSTALL_PACKAGE_IN_USE: "Claude Desktop hâlâ çalışıyor. Uygulamayı tamamen kapatıp kurulumu tekrar başlatın.",
  CLAUDE_DESKTOP_INSTALL_PACKAGE_INVALID: "İndirilen Claude Desktop paketi doğrulanamadı. Kurulumu tekrar başlatın.",
  CLAUDE_DESKTOP_INSTALL_UNSUPPORTED_WINDOWS: "Bu Windows sürümü resmî Claude Desktop paketini kuramıyor.",
  CLAUDE_DESKTOP_INSTALL_TIMEOUT: "Claude Desktop kurulumu zaman aşımına uğradı. Windows'un sorduğu izni gecikmeden onaylayıp tekrar deneyin.",
  CLAUDE_DESKTOP_INSTALL_FAILED: "Windows resmî Claude Desktop paketini kuramadı. Tekrar deneyin.",
  CLAUDE_DESKTOP_NOT_DETECTED: "Kurulum bitti ama Claude Desktop paketi görünmüyor. Cizi Code'u yeniden başlatıp tekrar deneyin.",
  CLAUDE_DESKTOP_VERIFY_FAILED: "Kurulum bitti ama doğrulanamadı. Cizi Code'u yeniden başlatıp tekrar deneyin.",
  CLAUDE_DOWNLOAD_TIMEOUT: "Claude Desktop paketi indirilirken zaman aşımı oldu. Bağlantınızı kontrol edip tekrar deneyin.",
  CLAUDE_DOWNLOAD_FAILED: "Claude Desktop paketi indirilemedi. İnternet bağlantınızı ve disk alanınızı kontrol edip tekrar deneyin.",
  // Download / signature (ciziClaude4'ten taşınan indirme katmanı)
  CLAUDE_DESKTOP_DOWNLOAD_FAILED: "Claude Desktop paketi indirilemedi. İnternet bağlantınızı ve disk alanınızı kontrol edip tekrar deneyin.",
  CLAUDE_DESKTOP_DOWNLOAD_TOO_LARGE: "İndirilen dosya beklenenden büyük olduğu için indirme durduruldu.",
  CLAUDE_DESKTOP_URL_INVALID: "Claude Desktop indirme adresi geçersiz.",
  CLAUDE_DESKTOP_URL_UNTRUSTED: "İndirme resmî bir Anthropic adresinden gelmediği için durduruldu.",
  CLAUDE_DESKTOP_RESPONSE_INVALID: "İndirme adresi bir kurulum dosyası döndürmedi. Daha sonra tekrar deneyin.",
  CLAUDE_DESKTOP_SIGNATURE_CHECK_FAILED: "Windows paketin dijital imzasını denetleyemedi. Tekrar deneyin.",
  CLAUDE_DESKTOP_SIGNATURE_UNTRUSTED: "İndirilen dosya geçerli bir Anthropic imzası taşımıyor; güvenlik nedeniyle kurulmadı.",
  CLAUDE_DESKTOP_ARTIFACT_TYPE_INVALID: "Seçilen kurulum dosyasının türü beklenenle uyuşmuyor.",
  CLAUDE_DESKTOP_INSTALL_KIND_INVALID: "İstenen Claude Desktop kurulum türü mevcut değil.",
  // Uninstall
  CLAUDE_DESKTOP_UNINSTALL_PROCESS_RUNNING: "Claude Desktop kapatılamadı. Uygulamayı elle kapatıp tekrar deneyin.",
  CLAUDE_DESKTOP_UNINSTALL_FAILED: "Windows Claude Desktop'ı kaldıramadı. Tekrar deneyin.",
  CLAUDE_DESKTOP_UNINSTALL_COMMAND_INVALID: "Claude Desktop kaldırma komutu okunamadı.",
  CLAUDE_DESKTOP_UNINSTALL_COMMAND_UNTRUSTED: "Tanınmayan bir kaldırma programı güvenlik nedeniyle çalıştırılmadı.",
  // The switch asks before closing a running Claude Desktop rather than
  // refusing outright, so this is a question the UI turns into a prompt.
  PROCESS_RUNNING_CONFIRMATION_REQUIRED: "Claude Desktop açık; devam etmek için kapatma onayı gerekiyor.",
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
    const cliStatus = trySync(() => toolManager.getToolStatus(CLAUDE_CODE_TOOL_ID, base), null);
    const cliApplied = cliStatus?.applied === true;
    // A snapshot on disk means the CLI's original settings.json is still parked
    // somewhere else, whether or not the file currently looks configured. The
    // switch has to be able to put it back either way.
    const cliHasBackup = cliStatus?.hasBackup === true;
    // "Connected" means every product that is actually installed is connected.
    // With nothing installed there is nothing to connect.
    const installed = [];
    if (cli.installed) installed.push("cli");
    if (desktop.installed) installed.push("desktop");
    const connected = installed.length > 0
      && (!cli.installed || cliApplied)
      && (!desktop.installed || desktop.applied === true);
    return {
      cli: { ...cli, applied: cliApplied, hasBackup: cliHasBackup },
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
  //
  // `closeRunning` is the user's explicit answer to "may I close Claude
  // Desktop?". Claude Desktop reads its managed configuration once at startup,
  // so it has to be closed before the switch can change anything — and it
  // launches itself right after being installed, which is exactly when the user
  // first reaches for the switch. Rather than refusing with "close it first",
  // the switch asks and then does it.
  async function connect(values, { closeRunning = false } = {}) {
    const state = await getState(values?.base);
    if (!state.installedProducts.length) {
      throw codedError("CLAUDE_NOT_INSTALLED", "Önce Claude Code CLI veya Claude Desktop kurun.");
    }
    if (state.desktop.blocked && state.desktop.installed) {
      throw codedError("CLAUDE_DESKTOP_BLOCKED", state.blockReason || "Claude Desktop şu an ayarlanamıyor.");
    }
    if (!values?.model) throw codedError("MODEL_REQUIRED", "Bu araç için uygun bir hesap modeli bulunamadı.");

    if (state.desktop.installed && state.desktop.running) {
      if (!closeRunning) {
        throw codedError(
          "PROCESS_RUNNING_CONFIRMATION_REQUIRED",
          "Claude Desktop şu an açık. Ayarların uygulanabilmesi için kapatılması gerekiyor.",
        );
      }
      report("stopping", "Claude Desktop kapatılıyor...");
      await stopDesktop();
      log?.info("claude", "Claude Desktop kullanıcı onayıyla kapatıldı");
    }

    let cliApplied = false;
    if (state.cli.installed) {
      report("configuring", "Claude Code CLI ayarlanıyor...");
      toolManager.applyTool(CLAUDE_CODE_TOOL_ID, values);
      cliApplied = true;
      log?.info("claude", "Claude Code CLI bağlandı", { defaultModel: values.model, modelCount: values.models?.length || 1 });
    }

    let desktopResult = null;
    if (state.desktop.installed) {
      try {
        desktopResult = await claudeDesktop.apply(values, (phase, message, details) => report(phase, message, details));
        // Connecting configures Claude Desktop without opening it; the app is
        // started only from the shortcut/launch action.
        log?.info("claude", "Claude Desktop bağlandı", {
          defaultModel: values.model,
          modelCount: values.models?.length || 1,
          branding: desktopResult?.brandingStatus || null,
        });
      } catch (error) {
        // Undo the CLI half so the two never disagree about being connected.
        if (cliApplied) {
          try {
            const rollback = toolManager.revertTool(CLAUDE_CODE_TOOL_ID, values.base);
            const rollbackStatus = toolManager.getToolStatus(CLAUDE_CODE_TOOL_ID, values.base);
            if (rollback?.applied === true || rollbackStatus?.applied === true) {
              error.rollbackError = codedError(
                "CLAUDE_CLI_ROLLBACK_VERIFY_FAILED",
                "Claude Code CLI settings could not be restored after Claude Desktop failed.",
              );
              log?.error("claude", "Claude Desktop bağlantısı başarısız oldu ve Claude Code CLI geri alma işlemi doğrulanamadı", {
                rollback: "failed",
                stillApplied: true,
              });
            } else {
              log?.success?.("claude", "Claude Code CLI geri alma işlemi doğrulandı", { rollback: "verified" });
            }
            log?.info("claude", "Claude Desktop bağlanamadığı için Claude Code CLI ayarı geri alındı");
          } catch (revertError) {
            error.rollbackError = revertError;
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
  async function disconnect(base, { closeRunning = false } = {}) {
    const state = await getState(base);
    let desktopResult = null;
    let desktopError = null;

    // Restoring the original configuration has the same constraint as applying
    // one: Claude Desktop must not be reading it at the time.
    if ((state.desktop.applied === true || state.desktop.hasBackup) && state.desktop.running) {
      if (!closeRunning) {
        throw codedError(
          "PROCESS_RUNNING_CONFIRMATION_REQUIRED",
          "Claude Desktop şu an açık. Önceki ayarlarınızın geri yüklenebilmesi için kapatılması gerekiyor.",
        );
      }
      report("stopping", "Claude Desktop kapatılıyor...");
      await stopDesktop();
      log?.info("claude", "Claude Desktop kullanıcı onayıyla kapatıldı");
    }

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
    // Mirrors the desktop half: a stored backup is reason enough to revert, so
    // a hand-edited or deleted settings.json cannot strand the snapshot and
    // leave the CLI half looking permanently off while its backup lives on.
    if (state.cli.applied || state.cli.hasBackup) {
      cliResult = toolManager.revertTool(CLAUDE_CODE_TOOL_ID, base);
      log?.info("claude", "Claude Code CLI ayarları geri alındı", {
        restored: cliResult?.restored === true,
        fromBackupOnly: !state.cli.applied,
      });
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

  // The package now downloads to a stable path so a retry can reuse it, which
  // means two installations must never run at once and fight over that file.
  let desktopInstallPromise = null;

  async function installDesktop() {
    if (desktopInstallPromise) return desktopInstallPromise;
    desktopInstallPromise = runDesktopInstall().finally(() => { desktopInstallPromise = null; });
    return desktopInstallPromise;
  }

  async function runDesktopInstall() {
    report("starting", "Claude Desktop kurulumu başlatılıyor...");
    try {
      const result = await lifecycle.installTool("claude-desktop", (phase, message, details) => report(phase, message, details));
      log?.info("claude", "Claude Desktop kuruldu", { version: result?.Version || result?.version || null });
      report("complete", "Claude Desktop kuruldu.");
      return result;
    } catch (error) {
      // Installer errors carry a machine-readable code and an English public
      // message; the user gets the Turkish sentence for that code instead.
      const message = desktopMessage(error);
      report("error", message);
      log?.error("claude", `Claude Desktop kurulumu başarısız: ${error?.code || ""} ${error?.message || error}`, {
        stage: error?.ciziDiagnostic?.stage || null,
        hresult: error?.ciziDiagnostic?.hresult || null,
      });
      throw Object.assign(error, { userMessage: message });
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

  // What removing Claude Desktop would delete, so the user sees it first.
  async function planDesktopUninstall() {
    return lifecycle.planClaudeDesktopUninstall();
  }

  // Removes Claude Desktop itself. The user's original Claude configuration is
  // restored before the application goes away: once the package is gone the
  // baseline could never be verified against it again, and a saved backup that
  // outlives its application is a backup nothing can ever put back.
  async function uninstallDesktop({ removeLeftovers = true } = {}) {
    const state = await getState();
    if (state.desktop.applied === true || state.desktop.hasBackup) {
      report("restoring", "Kaldırmadan önce orijinal Claude ayarlarınız geri yükleniyor...");
      try {
        await claudeDesktop.revert();
        log?.info("claude", "Claude Desktop kaldırılmadan önce ayarlar geri alındı");
      } catch (error) {
        report("error", desktopMessage(error));
        log?.error("claude", `Kaldırma öncesi geri alma başarısız: ${error?.code || ""} ${error?.message || error}`);
        throw Object.assign(error, { userMessage: desktopMessage(error) });
      }
    }
    try {
      const result = await lifecycle.uninstallClaudeDesktop(
        (phase, message, details) => report(phase, message, details),
        { removeLeftovers },
      );
      log?.info("claude", "Claude Desktop kaldırıldı", {
        removed: result?.removed === true,
        remaining: result?.remainingDirectories?.length || 0,
      });
      report("complete", "Claude Desktop kaldırıldı.");
      return result;
    } catch (error) {
      const message = desktopMessage(error);
      report("error", message);
      log?.error("claude", `Claude Desktop kaldırılamadı: ${error?.code || ""} ${error?.message || error}`);
      throw Object.assign(error, { userMessage: message });
    }
  }

  return {
    getState,
    connect,
    disconnect,
    installDesktop,
    planDesktopUninstall,
    uninstallDesktop,
    installCli: installCliTool,
    repairDesktop,
    launchDesktop,
    stopDesktop,
    desktopMessage,
  };
}

module.exports = { createClaudeCoordinator, desktopMessage, CLAUDE_CODE_TOOL_ID };
