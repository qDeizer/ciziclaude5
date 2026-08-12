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
  ELEVATION_CANCELLED: "Windows yönetici onayı verilmedi; Claude Desktop ayarları değiştirilmedi.",
  ELEVATION_TIMEOUT: "Windows yönetici işlemi zaman aşımına uğradı. Tekrar deneyin.",
  ELEVATION_RESULT_MISSING: "Windows yönetici işleminin sonucu okunamadı. Claude Desktop ayarları değiştirilmedi.",
  ELEVATION_REQUIRED: "Claude Desktop'ın kurulum dosyalarını değiştirmek için yönetici onayı gerekiyor. Tekrar deneyip Windows'un sorduğu izni onaylayın.",
  ELEVATION_FAILED: "Windows yönetici işlemi tamamlanamadı. Tekrar deneyin.",
  // Arayüz etiketleri Claude'un kendi dosyalarına yazılır; bu adımın hataları
  // eskiden ham İngilizce motor mesajı olarak ekrana düşüyordu.
  CLAUDE_RUNNING_FROM_TARGET: "Claude Desktop kurulu olduğu klasörden çalışıyor. Uygulamayı tamamen kapatıp tekrar deneyin.",
  CLAUDE_BRANDING_UNAVAILABLE: "Cizi Code bu Claude Desktop sürümünün arayüz etiketlerini uygulayamadı.",
  CLAUDE_BRANDING_VERIFY_FAILED: "Claude Desktop arayüz etiketleri yazıldı ama doğrulanamadı. Tekrar deneyin.",
  ELEVATED_BRANDING_FAILED: "Claude Desktop dosyaları yönetici olarak düzenlenirken işlem tamamlanamadı. Tekrar deneyin.",
  PARTIAL_PATCH_STATE: "Claude Desktop dosyalarının bir kısmı yarım kalmış. Anahtarı bir kez kapatıp tekrar açın.",
  LIVE_FILE_DRIFTED: "Claude Desktop dosyaları beklenenden farklı. Anahtarı bir kez kapatıp tekrar açın.",
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

  // What the screen needs about both Claude products. They no longer form one
  // transaction - each has its own switch - but the screen still shows them
  // together, so one call answers for both.
  async function getState(base) {
    const [cli, desktop] = await Promise.all([
      safe(() => detectCli(), { installed: false, command: null, version: null }),
      safe(() => claudeDesktop.getStatus(base), { installed: false, applied: false, blocked: false, errorCode: "CLAUDE_DESKTOP_STATUS_FAILED" }),
    ]);
    const cliStatus = trySync(() => toolManager.getToolStatus(CLAUDE_CODE_TOOL_ID, base), null);
    return {
      // A snapshot on disk means the CLI's original settings.json is still parked
      // somewhere else, whether or not the file currently looks configured. The
      // switch has to be able to put it back either way.
      cli: {
        ...cli,
        applied: cliStatus?.applied === true,
        restorable: cliStatus?.restorable === true,
      },
      desktop,
    };
  }

  // Claude Desktop reads its managed configuration once at startup, so it has to
  // be closed before the switch may change anything - and it opens itself right
  // after being installed, which is exactly when the switch is first used. Rather
  // than refusing with "close it first", the switch asks and then does it.
  function requireClosed(status, closeRunning, purpose) {
    if (!status.installed || !status.running) return false;
    if (!closeRunning) {
      throw codedError(
        "PROCESS_RUNNING_CONFIRMATION_REQUIRED",
        purpose === "apply"
          ? "Claude Desktop şu an açık. Ayarların uygulanabilmesi için kapatılması gerekiyor."
          : "Claude Desktop şu an açık. Önceki ayarlarınızın geri yüklenebilmesi için kapatılması gerekiyor.",
      );
    }
    return true;
  }

  // Connects Claude Desktop alone. The Claude Code CLI is a separate switch with
  // its own configuration file, so nothing here can strand it.
  async function applyDesktop(values, { closeRunning = false } = {}) {
    const status = await claudeDesktop.getStatus(values?.base);
    if (!status.installed) throw codedError("CLAUDE_DESKTOP_NOT_INSTALLED", "Claude Desktop bu bilgisayarda kurulu değil.");
    if (status.blocked) {
      throw codedError("CLAUDE_DESKTOP_BLOCKED", status.blockReason || "Claude Desktop şu an ayarlanamıyor.");
    }
    if (!values?.model) throw codedError("MODEL_REQUIRED", "Claude Desktop için uygun bir hesap modeli bulunamadı.");

    if (requireClosed(status, closeRunning, "apply")) {
      report("stopping", "Claude Desktop kapatılıyor...");
      await stopDesktop();
    }
    try {
      const result = await claudeDesktop.apply(values, (phase, message, details) => report(phase, message, details));
      log?.info("claude-desktop", "Claude Desktop bağlandı", {
        defaultModel: values.model,
        modelCount: values.models?.length || 1,
        branding: result?.brandingStatus || null,
      });
      report("", "");
      return result;
    } catch (error) {
      log?.error("claude-desktop", `Claude Desktop bağlanamadı: ${error?.code || ""} ${error?.message || error}`);
      report("", "");
      throw Object.assign(error, { userMessage: desktopMessage(error) });
    }
  }

  // Restores Claude Desktop's own original settings. A stored baseline is reason
  // enough to run: the record can be lost while the configuration it describes is
  // still applied.
  async function revertDesktop({ closeRunning = false } = {}) {
    const status = await claudeDesktop.getStatus();
    if (status.applied !== true && status.restorable !== true) {
      return { ok: true, applied: false, restored: false, alreadyOff: true };
    }
    if (requireClosed(status, closeRunning, "revert")) {
      report("stopping", "Claude Desktop kapatılıyor...");
      await stopDesktop();
    }
    try {
      report("restoring", "Claude Desktop önceki ayarlarına döndürülüyor...");
      const result = await claudeDesktop.revert();
      log?.success("claude-desktop", "Claude Desktop ayarları geri alındı", { restored: result?.restored === true });
      report("", "");
      return result;
    } catch (error) {
      log?.error("claude-desktop", `Claude Desktop geri alınamadı: ${error?.code || ""} ${error?.message || error}`);
      report("", "");
      throw Object.assign(error, { userMessage: desktopMessage(error) });
    }
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
      const result = await lifecycle.installClaudeDesktop((phase, message, details) => report(phase, message, details));
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

  // "Sadece indir": paket doğrulanır, indirilenler klasörüne konur, kurulmaz.
  async function downloadDesktopOnly() {
    try {
      const result = await lifecycle.downloadClaudeDesktopForManualInstall(
        (phase, message, details) => report(phase, message, details),
      );
      log?.info("claude", "Claude Desktop paketi manuel kurulum için indirildi", { bytes: result?.bytes || null });
      return result;
    } catch (error) {
      const message = desktopMessage(error);
      report("error", message);
      throw Object.assign(error, { userMessage: message });
    }
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

  // The part of a removal that is not a file: registry keys, autostart entries
  // and shortcuts. Offered as its own removal category, so it runs only when the
  // user asked for it.
  async function removeDesktopResidue() {
    try {
      const result = await lifecycle.removeClaudeDesktopResidue();
      log?.info("claude", "Claude Desktop kayıt defteri ve kısayol kalıntıları temizlendi");
      return result;
    } catch (error) {
      log?.warning("claude", `Claude Desktop kalıntı temizliği tamamlanamadı: ${error?.message || error}`);
      return { removed: false, error: String(error?.message || error).slice(0, 300) };
    }
  }

  // Removes Claude Desktop itself. The user's original Claude configuration is
  // restored before the application goes away: once the package is gone the
  // baseline could never be verified against it again, and a saved backup that
  // outlives its application is a backup nothing can ever put back.
  async function uninstallDesktop({ removeLeftovers = true } = {}) {
    const state = await getState();
    if (state.desktop.applied === true || state.desktop.restorable === true) {
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
    // Claude Desktop alone, without paying for the CLI probe that getState runs.
    desktopStatus: (base) => claudeDesktop.getStatus(base),
    applyDesktop,
    revertDesktop,
    installDesktop,
    downloadDesktopOnly,
    uninstallDesktop,
    removeDesktopResidue,
    repairDesktop,
    launchDesktop,
    stopDesktop,
    desktopMessage,
  };
}

module.exports = { createClaudeCoordinator, desktopMessage, CLAUDE_CODE_TOOL_ID };
