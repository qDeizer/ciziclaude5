// ChatGPT Desktop (MSIX package "OpenAI.Codex") detection, installation and
// removal.
//
// The app is distributed through the Microsoft Store only, so installation goes
// through winget's msstore source and removal goes through Remove-AppxPackage.
// WindowsApps is never touched by hand: taking ownership of that folder breaks
// Windows' package registration and leaves the machine in a state the Store
// cannot repair.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const paths = require("./codexPaths");

const execFileAsync = promisify(execFile);
const INSTALL_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const PACKAGE_REGISTRATION_POLL_MS = 3000;
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

function sanitizeOutput(value) {
  return String(value || "")
    .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "sk-••••")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function powershell(script, { timeout = 20000 } = {}) {
  const { stdout } = await execFileAsync("powershell.exe", [...PS_ARGS, script], {
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  return String(stdout || "").trim();
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Reports the installed MSIX package without hard-coding a version: the real
// PackageFullName and InstallLocation always come from Windows itself.
async function detectCodexDesktop() {
  const desktop = paths.desktopPaths();
  const absent = {
    installed: false,
    packageName: desktop.packageName,
    packageFamilyName: desktop.familyName,
    storeId: desktop.storeId,
    version: null,
    packageFullName: null,
    installLocation: null,
    status: null,
  };
  if (process.platform !== "win32") return { ...absent, unsupported: true };

  try {
    const stdout = await powershell(
      `Get-AppxPackage -Name '${desktop.packageName}' | Select-Object -First 1 Name,Version,PackageFullName,PackageFamilyName,InstallLocation,Status | ConvertTo-Json -Compress`,
      { timeout: 20000 }
    );
    const info = parseJsonOutput(stdout);
    if (!info?.PackageFullName) return absent;
    return {
      installed: true,
      packageName: info.Name || desktop.packageName,
      version: info.Version || null,
      packageFullName: info.PackageFullName,
      packageFamilyName: info.PackageFamilyName || desktop.familyName,
      installLocation: info.InstallLocation || null,
      // Status arrives as an enum; ConvertTo-Json may render it as a number.
      status: info.Status == null ? null : String(info.Status),
      storeId: desktop.storeId,
    };
  } catch {
    // A failed AppX query means "cannot confirm", which is reported as absent
    // rather than throwing, so the UI can still offer installation.
    return absent;
  }
}

async function listDesktopProcesses() {
  if (process.platform !== "win32") return [];
  const desktop = paths.desktopPaths();
  const runtime = desktop.runtimeDir.replace(/'/g, "''");
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*' " +
    `-or $_.ExecutablePath -like '${runtime}\\*' } | ` +
    "Select-Object ProcessId,Name | ConvertTo-Json -Compress";
  try {
    const parsed = parseJsonOutput(await powershell(script, { timeout: 20000 }));
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return list.filter((item) => Number(item?.ProcessId) > 0).map((item) => ({ pid: Number(item.ProcessId), name: String(item.Name || "") }));
  } catch {
    return [];
  }
}

// The Desktop app keeps helper processes alive after its window closes, and an
// MSIX package cannot be removed while any of them run.
async function closeDesktop({ log } = {}) {
  const running = await listDesktopProcesses();
  for (const item of running) {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(item.pid), "/t", "/f"], { timeout: 10000, windowsHide: true });
    } catch {
      // Already-exited children are expected while a tree is being closed.
    }
  }
  if (running.length) log?.info("codex-desktop", "ChatGPT Desktop süreçleri kapatıldı", { count: running.length });
  const remaining = await listDesktopProcesses();
  return { closed: running.length, remaining: remaining.length, processes: running.map((item) => item.name) };
}

async function openDesktop({ log } = {}) {
  const desktop = paths.desktopPaths();
  const status = await detectCodexDesktop();
  if (!status.installed) throw new Error("ChatGPT Desktop bu bilgisayarda kurulu değil.");
  // Package activation, not the raw exe under WindowsApps: only activation
  // gives the app its package identity and permissions.
  const child = spawn("explorer.exe", [`shell:AppsFolder\\${desktop.activation}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  log?.info("codex-desktop", "ChatGPT Desktop başlatıldı", { activation: desktop.activation });
  return { opened: true, activation: desktop.activation };
}

function removePath(target) {
  try {
    if (!fs.existsSync(target)) return { path: target, removed: false, reason: "not-found" };
    fs.rmSync(target, { recursive: true, force: true });
    return { path: target, removed: !fs.existsSync(target) };
  } catch (error) {
    return { path: target, removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

// Progress parsing for winget. Percentages and byte counters are language
// independent, so they drive the bar; the phase words are only a hint and the
// UI falls back to an indeterminate state when nothing measurable is present.
const UNIT_FACTORS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };

function parseProgress(line) {
  const text = String(line || "");
  const bytes = text.match(/([\d.,]+)\s*(B|KB|MB|GB)\s*\/\s*([\d.,]+)\s*(B|KB|MB|GB)/i);
  if (bytes) {
    const toBytes = (amount, unit) => Number(String(amount).replace(/,/g, "")) * (UNIT_FACTORS[String(unit).toLowerCase()] || 1);
    const received = toBytes(bytes[1], bytes[2]);
    const total = toBytes(bytes[3], bytes[4]);
    if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
      return { percent: Math.max(0, Math.min(100, Math.round((received / total) * 100))), received, total };
    }
  }
  const percent = text.match(/(?:^|\s)(\d{1,3})\s*%/);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) return { percent: value };
  }
  return null;
}

function parsePhase(line) {
  const text = String(line || "").toLowerCase();
  if (/verif|doğrula|dogrula|hash/.test(text)) return "verify";
  if (/install|kur(ul)?|starting package/.test(text)) return "install";
  if (/download|indir/.test(text)) return "download";
  return null;
}

function runWinget(storeId, startedAt, {
  detect,
  onPackageRegistered,
  onProgress = () => {},
  spawnProcess = spawn,
  timeoutMs = INSTALL_INACTIVITY_TIMEOUT_MS,
  registrationPollMs = PACKAGE_REGISTRATION_POLL_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "install",
      "--id", storeId,
      "--source", "msstore",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    const child = spawnProcess("winget.exe", args, {
      cwd: os.homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let lastDetail = "";
    // winget can wait for Store/App Installer cleanup after Windows has already
    // registered the package. Package registration is the authoritative result
    // users need, so do not leave the UI spinning solely for that child to exit.
    let phase = null;
    let settled = false;
    let probingRegistration = false;
    let registrationWatcher = null;
    let lastProgressAt = startedAt;
    const measuredProgress = new Map();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearInterval(timeoutWatcher);
      clearInterval(heartbeat);
      clearInterval(registrationWatcher);
      if (error) reject(error);
      else resolve({ lastDetail, ...(result || {}) });
    };

    const detachAfterRegistration = () => {
      // Do not kill winget after the package is visible: it may only be doing
      // Store cleanup. Disconnecting it prevents that background cleanup from
      // keeping Cizi Code alive or its progress strip stuck.
      try { child.stdout?.destroy(); } catch { /* best effort */ }
      try { child.stderr?.destroy(); } catch { /* best effort */ }
      try { child.unref?.(); } catch { /* best effort */ }
    };

    const probeRegistration = async () => {
      if (settled || probingRegistration || typeof detect !== "function") return;
      probingRegistration = true;
      try {
        const installed = await detect();
        if (!installed?.installed) return;
        onPackageRegistered?.(installed);
        detachAfterRegistration();
        finish(null, { installed, completedBy: "package-registration" });
      } catch {
        // A transient AppX query failure must not turn a still-running official
        // installer into an error. The normal completion path remains active.
      } finally {
        probingRegistration = false;
      }
    };

    const timeoutWatcher = setInterval(() => {
      if (Date.now() - lastProgressAt < timeoutMs) return;
      try { execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {}); } catch { /* best effort */ }
      finish(new Error("Microsoft Store kurulumu 20 dakika ölçülebilir ilerleme olmadığı için zaman aşımına uğradı."));
    }, Math.min(1000, Math.max(50, Math.floor(timeoutMs / 4))));
    timeoutWatcher.unref?.();

    // Store installs can stay silent for long stretches; the elapsed clock is
    // what tells the user the process is still alive.
    const heartbeat = setInterval(() => {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      onProgress({ type: "heartbeat", elapsed, detail: lastDetail });
    }, 1000);
    registrationWatcher = setInterval(() => { void probeRegistration(); }, registrationPollMs);

    const onChunk = (chunk) => {
      // winget redraws its progress bar with carriage returns.
      const parts = String(chunk).split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean);
      for (const part of parts) {
        const detail = sanitizeOutput(part);
        if (!detail) continue;
        const progress = parseProgress(part);
        const named = parsePhase(part);
        if (named) phase = named;
        if (progress) {
          const id = phase === "download" ? "download" : "install";
          const metric = Number.isFinite(progress.received) ? progress.received : progress.percent;
          const key = `${id}:${Number.isFinite(progress.received) ? "bytes" : "percent"}`;
          if (Number.isFinite(metric) && metric > (measuredProgress.get(key) ?? -1)) {
            measuredProgress.set(key, metric);
            lastProgressAt = Date.now();
          }
        }
        lastDetail = progress?.total
          ? `${detail} (${formatBytes(progress.received)} / ${formatBytes(progress.total)})`
          : detail;
        const id = phase === "download" ? "download" : "install";
        onProgress({ type: "output", id, phase, named, progress, detail: lastDetail });
      }
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Microsoft Store kurulumu ${code} çıkış koduyla bitti.`));
    });
  });
}

function createCodexDesktopService({ userDataPath, log, onInstallState, detect = detectCodexDesktop, runWingetProcess = runWinget }) {
  let installPromise = null;
  // `null` percent means "running but not measurable" and is rendered as an
  // indeterminate bar, which is honest about Store installs that report no
  // byte counts at all.
  let installState = { status: "idle", phase: "idle", percent: null, message: "", operations: [] };

  const emit = (next) => {
    installState = { ...installState, ...next };
    onInstallState?.(installState);
  };

  const operation = (id, next) => {
    const previous = Array.isArray(installState.operations) ? installState.operations : [];
    const current = previous.find((item) => item.id === id) || { id, label: id, status: "pending", percent: null, detail: "" };
    const operations = previous.some((item) => item.id === id)
      ? previous.map((item) => (item.id === id ? { ...item, ...next } : item))
      : [...previous, { ...current, ...next }];
    emit({ operations });
  };

  const lockPath = () => path.join(userDataPath, "codex-desktop-install.lock");

  const isProcessAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };

  const acquireLock = () => {
    fs.mkdirSync(userDataPath, { recursive: true });
    let fd;
    const create = () => {
      fd = fs.openSync(lockPath(), "wx");
      fs.writeFileSync(fd, String(process.pid));
    };
    try {
      create();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const recorded = Number.parseInt(String(fs.readFileSync(lockPath(), "utf8")).trim(), 10);
      if (isProcessAlive(recorded)) {
        const busy = new Error("Başka bir ChatGPT Desktop kurulumu zaten çalışıyor.");
        busy.userMessage = busy.message;
        throw busy;
      }
      fs.rmSync(lockPath(), { force: true });
      log?.warn("codex-desktop", "Askıda kalan kurulum kilidi temizlendi", { previousPid: Number.isInteger(recorded) ? recorded : null });
      create();
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
    return () => {
      try { fs.rmSync(lockPath(), { force: true }); } catch { /* the lock is advisory */ }
    };
  };

  const failureMessage = (error) => {
    const text = String(error?.message || error || "");
    if (/zaten çalışıyor/i.test(text)) return text;
    if (/timed out|zaman aşımı/i.test(text)) return "Microsoft Store kurulumu zaman aşımına uğradı. Bağlantınızı kontrol edip yeniden deneyin.";
    if (/winget/i.test(text) && /not found|ENOENT|bulunamadı/i.test(text)) {
      return "Bu bilgisayarda winget bulunamadı. Mağaza sayfasını açıp ChatGPT'yi elle kurabilirsiniz.";
    }
    if (/exited with code|çıkış kodu/i.test(text)) return "Microsoft Store kurulumu tamamlanamadı. Mağaza sayfasından elle kurmayı deneyin.";
    if (/could not be detected|doğrulanamadı/i.test(text)) return "Kurulum bitti ama ChatGPT Desktop henüz görünmüyor. Cizi Code'u yeniden başlatıp tekrar bakın.";
    return "ChatGPT Desktop kurulamadı. Kurulum etkinliğindeki ayrıntılara bakın.";
  };

  const install = async () => {
    if (installPromise) return installPromise;
    installPromise = (async () => {
      if (process.platform !== "win32") throw new Error("ChatGPT Desktop kurulumu şu an yalnızca Windows'ta yapılabiliyor.");
      const desktop = paths.desktopPaths();
      const release = acquireLock();
      try {
        emit({ status: "checking", phase: "detecting", percent: null, message: "ChatGPT Desktop aranıyor...", operations: [] });
        operation("detect", { label: "ChatGPT Desktop'ı kontrol et", status: "running", percent: null, detail: "Windows uygulama paketleri taranıyor..." });
        const existing = await detect();
        if (existing.installed) {
          operation("detect", { status: "done", percent: 100, detail: `Kurulu: ${existing.version || existing.packageFullName}` });
          emit({ status: "installed", phase: "complete", percent: 100, message: "ChatGPT Desktop zaten kurulu.", ...existing });
          return existing;
        }
        operation("detect", { status: "done", percent: 100, detail: "ChatGPT Desktop bulunamadı." });

        operation("install", { label: "Microsoft Store'dan kur", status: "running", percent: null, detail: "Resmî Microsoft Store kurulumu başlatılıyor..." });
        emit({ status: "installing", phase: "install", percent: null, message: "Resmî Microsoft Store kurulumu başlatılıyor..." });
        log?.info("codex-desktop", "Resmî Microsoft Store kurulumu başlatıldı", { storeId: desktop.storeId });
        const wingetResult = await runWingetProcess(desktop.storeId, Date.now(), {
          detect,
          onProgress: ({ type, elapsed, detail, id, phase, named, progress }) => {
            if (type === "heartbeat") {
              const message = detail || `Microsoft Store kurulumu sürüyor (${elapsed} sn).`;
              operation("install", { detail: message });
              emit({ message });
              return;
            }
            if (id === "download") {
              operation("download", { label: "Microsoft Store'dan indir", status: "running" });
            } else if (named === "install") {
              // Reaching the install step means any download step is finished.
              operation("download", { status: "done", percent: 100 });
            }
            operation(id, {
              detail,
              ...(progress?.percent == null ? {} : { percent: progress.percent }),
            });
            emit({
              ...(phase ? { phase } : {}),
              ...(progress?.percent == null ? {} : { percent: progress.percent }),
              message: detail,
            });
          },
          onPackageRegistered: (registered) => {
            operation("install", { status: "done", percent: 100, detail: "Windows paket kaydını tamamladı." });
            emit({ status: "verifying", phase: "verify", percent: null, message: "ChatGPT Desktop bulundu; kurulum doğrulanıyor..." });
            log?.success("codex-desktop", "Windows paket kaydı algılandı; winget kapanışı beklenmeden kurulum tamamlanıyor", {
              version: registered.version || null,
              packageFullName: registered.packageFullName || null,
            });
          },
        });
        operation("install", { status: "done", percent: 100, detail: "Microsoft Store kurulumu tamamlandı." });

        operation("verify", { label: "Kurulumu doğrula", status: "running", percent: null, detail: "Uygulama paketi kontrol ediliyor..." });
        emit({ status: "verifying", phase: "verify", percent: null, message: "Kurulum doğrulanıyor..." });
        const installed = wingetResult?.installed || await detect();
        if (!installed.installed) throw new Error("Kurulum bitti ama ChatGPT Desktop doğrulanamadı.");
        operation("verify", { status: "done", percent: 100, detail: `${installed.version || ""} ${installed.packageFullName || ""}`.trim() });
        emit({ status: "installed", phase: "complete", percent: 100, message: "ChatGPT Desktop kuruldu.", ...installed });
        log?.info("codex-desktop", "ChatGPT Desktop kuruldu", { version: installed.version, packageFullName: installed.packageFullName });
        return installed;
      } finally {
        release();
      }
    })().catch((error) => {
      const message = failureMessage(error);
      const active = [...(installState.operations || [])].reverse().find((item) => item.status === "running");
      if (active) operation(active.id, { status: "error", detail: message });
      emit({ status: "error", phase: "error", message });
      log?.error("codex-desktop", `ChatGPT Desktop kurulumu başarısız: ${message}`);
      throw Object.assign(error, { userMessage: message });
    }).finally(() => {
      installPromise = null;
    });
    return installPromise;
  };

  // Removes the application and nothing else. What happens to the data it
  // leaves behind is decided by the removal categories the user selected, so
  // this deliberately deletes no files: sweeping the state directory here would
  // silently override a category the user chose to keep.
  const removePackage = async () => {
    const desktop = paths.desktopPaths();
    const before = await detect();
    if (!before.installed) return { removed: false, reason: "not-installed" };
    const closed = await closeDesktop({ log });
    try {
      await powershell(
        `Get-AppxPackage -Name '${desktop.packageName}' | Remove-AppxPackage -ErrorAction Stop`,
        { timeout: 180000 }
      );
    } catch (error) {
      return { removed: false, error: sanitizeOutput(error?.message), closedProcesses: closed };
    }
    const after = await detect();
    log?.info("codex-desktop", after.installed
      ? "ChatGPT Desktop paketi hâlâ kayıtlı"
      : "ChatGPT Desktop paketi kaldırıldı");
    return { removed: !after.installed, closedProcesses: closed, version: before.version || null };
  };

  return {
    detect,
    install,
    open: (options) => openDesktop({ ...options, log }),
    close: () => closeDesktop({ log }),
    removePackage,
    storeUrl: paths.DESKTOP_STORE_URL,
  };
}

module.exports = {
  createCodexDesktopService,
  detectCodexDesktop,
  closeDesktop,
  openDesktop,
  listDesktopProcesses,
  parseProgress,
  parsePhase,
  runWinget,
};
