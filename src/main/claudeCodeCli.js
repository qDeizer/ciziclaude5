// Claude Code CLI as one service: where it lives, whether it is installed, how
// to install it from Anthropic's own script, and how to open it.
//
// This used to sit inside main.js. The composition root is supposed to wire
// services together, not be one, and keeping the CLI there had a concrete cost:
// the list of places the CLI can be installed was written twice - once for
// detection and once for removal - so the two drifted apart and neither knew
// about WinGet installations. Both lists now live here, and they are still two
// functions deliberately: what may be DETECTED is a superset of what may be
// DELETED. productRemoval.js reads the removable list from here.
//
// Shaped deliberately like createCodexCliService in codexCli.js: same factory
// contract ({ userDataPath, log, onInstallState }), same detect/install/open
// surface, so the two CLI products behave the same way for the screen.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const { assertHttpsUrl } = require("./httpsUrl");
const { downloadForManualInstall } = require("./manualInstall");
const { claudeDownloadsDirectory } = require("./claudePaths");
const { usableEditorExtensions } = require("./editorExtensions");

const execFileAsync = promisify(execFile);

const OFFICIAL_SITE_URL = "https://code.claude.com/docs/en/getting-started";
// Kurulum toplam süresine göre değil gerçek indirme ilerlemesine göre izlenir.
// Büyük bir paket yavaş ama düzenli iniyorsa kesilmez; yalnızca 20 dakika
// boyunca indirilen bayt sayısı artmazsa durdurulur.
const INSTALL_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const WINDOWS_INSTALLER_URL = "https://claude.ai/install.ps1";
const POSIX_INSTALLER_URL = "https://claude.ai/install.sh";
const RELEASE_LATEST_URL = "https://downloads.claude.ai/claude-code-releases/latest";

const isWindows = () => process.platform === "win32";

function home() {
  return os.homedir();
}

// Launchers Cizi Code may delete when the user asks for a root removal: files
// the official script or npm put there, all owned by the user.
function claudeCliRemovablePaths() {
  const h = home();
  if (!isWindows()) {
    return [
      path.join(h, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
  }
  const appData = process.env.APPDATA || path.join(h, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
  return [
    path.join(h, ".local", "bin", "claude.exe"),
    path.join(h, ".local", "bin", "claude.cmd"),
    path.join(appData, "npm", "claude.cmd"),
    path.join(appData, "npm", "claude.exe"),
    path.join(localAppData, "Programs", "Claude Code", "claude.exe"),
    path.join(localAppData, "Claude Code", "claude.exe"),
    path.join(programFiles, "Claude Code", "claude.exe"),
  ];
}

// A WinGet installation lives under a versioned package directory and is exposed
// through a shim on PATH. These are found by scanning, because the directory name
// carries the source id. They are DETECTION-only on purpose: the files belong to
// WinGet's own package state, so deleting them behind its back would leave WinGet
// believing Claude Code is still installed. Removing that install is
// `winget uninstall --id Anthropic.ClaudeCode`, not a file delete.
function wingetClaudeCliPaths() {
  if (!isWindows()) return [];
  const root = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet");
  const found = [path.join(root, "Links", "claude.exe")];
  try {
    for (const entry of fs.readdirSync(path.join(root, "Packages"), { withFileTypes: true })) {
      if (entry.isDirectory() && /^Anthropic\.ClaudeCode_/i.test(entry.name)) {
        found.push(path.join(root, "Packages", entry.name, "claude.exe"));
      }
    }
  } catch {
    // WinGet is absent, or Claude Code was never installed through it.
  }
  return found;
}

// VS Code (ve türevleri) için Claude Code eklentisi KENDİ CLI ikilisini taşıyor:
// `resources/native-binary/claude.exe`. Yani eklentiyi kuran bir kullanıcıda
// Claude Code VARDIR - ama PATH'te `claude` yoktur. Yalnız PATH'e ve bilinen
// kurulum dizinlerine bakan bir algılama bu kullanıcıya "kurulu değil" der ve
// anahtarı kapalı tutar; oysa bağlanması gereken bir Claude Code oradadır.
//
// Aynı çekirdek olduğu için yapılandırma da aynı yerden okunur: eklentinin
// kendi şeması (`claude-code-settings.schema.json`) `env`, `availableModels` ve
// `effortLevel` anahtarlarını tanıyor ve ikili `CLAUDE_CONFIG_DIR || ~/.claude`
// çözümlemesini kullanıyor. Bu yüzden AYRI bir yapılandırma yazılmaz - eklentinin
// kendi açıklaması da "env değişkenlerini Claude'un settings.json'una yazmayı
// tercih edin" diyor. Tek dosya ikisini de yapılandırır.
//
// Kod düzenleyicinin uzantı dizinleri sürüm ve ürüne göre değişir, bu yüzden yol
// listesi değil DİZİN TARAMASI yapılır: `anthropic.claude-code-*`.
const VSCODE_EXTENSION_ID = "anthropic.claude-code";

// Eklentinin taşıdığı CLI. Sürüm KLASÖR ADINDAN okunuyor, ikili
// çalıştırılmıyor: 279 MB'lık bir süreci her durum sorgusunda `--version` için
// başlatmak, ekran her yenilendiğinde çeyrek gigabaytlık bir iş demek (madde 10).
function vscodeClaudeInstallations() {
  return usableEditorExtensions(VSCODE_EXTENSION_ID, {
    binaries: [["resources", "native-binary", isWindows() ? "claude.exe" : "claude"]],
  }).map((item) => ({ ...item, binary: item.binaries[0] }));
}

function vscodeClaudeCliPaths() {
  return vscodeClaudeInstallations().map((item) => item.binary);
}

// Eklenti kurulumunun kendisi (ikili değil, klasör). Kaldırma listesi bunu
// yalnızca RAPORLAR: klasörü VS Code'un arkasından silmek onu bozuk bir uzantı
// kaydıyla bırakır; doğru yol `code --uninstall-extension`.
function vscodeClaudeExtensionDirectories() {
  return vscodeClaudeInstallations().map((item) => item.directory);
}

// Every command that could be the Claude Code CLI. Detection probes these plus
// `claude` on PATH. Deliberately a SUPERSET of what may be deleted: the WinGet
// and VS Code copies are found here but owned by their package managers.
function claudeCliPaths() {
  return [...claudeCliRemovablePaths(), ...wingetClaudeCliPaths(), ...vscodeClaudeCliPaths()];
}

// The launcher the official installer creates. Its appearance is what tells the
// progress reporter that the install has reached its final stage.
function launcherPath() {
  return path.join(home(), ".local", "bin", isWindows() ? "claude.exe" : "claude");
}

// Yükleyicinin indirdiği sürümler buraya iner; kurulum ilerlemesi buradan
// izlendiği için yapılandırma dizini taşınmışsa onu takip etmesi gerekir.
function downloadsDirectory() {
  return claudeDownloadsDirectory();
}

// ------------------------------------------------------------------ detection
function versionText(stdout, stderr) {
  const line = String(stdout || stderr || "").trim().split(/\r?\n/)[0].trim();
  return line ? line.slice(0, 120) : null;
}

async function runVersion(command) {
  const options = { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 };
  if (isWindows() && /\.(cmd|bat)$/i.test(command)) {
    const quoted = `"${String(command).replace(/"/g, '""')}" --version`;
    return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", quoted], options);
  }
  return execFileAsync(command, ["--version"], { ...options, shell: false });
}

// Kurulumun hangi biçimde olduğu, kullanıcıya nerede olduğunu söylemek için
// gerekiyor: aynı ürün üç farklı yoldan gelebilir ve kaldırma kuralları farklıdır.
function classifyInstallation(command) {
  const value = String(command || "").toLowerCase();
  if (/[\\/]resources[\\/]native-binary[\\/]/.test(value)) return "vscode-extension";
  if (/[\\/]microsoft[\\/]winget[\\/]/.test(value)) return "winget";
  if (/[\\/]npm[\\/]/.test(value)) return "npm";
  return "standalone";
}

async function detectClaudeCodeCli() {
  const candidates = [];
  const add = (value) => {
    const command = String(value || "").trim();
    if (!command) return;
    const key = isWindows() ? command.toLowerCase() : command;
    if (!candidates.some((candidate) => candidate.key === key)) candidates.push({ key, command });
  };

  try {
    const lookup = isWindows() ? "where.exe" : "which";
    const { stdout } = await execFileAsync(lookup, ["claude"], { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 });
    String(stdout || "").split(/\r?\n/).forEach(add);
  } catch {
    // PATH lookup is best effort; the known locations below are checked anyway.
  }
  // Yalnızca çalıştırılabilir adayları dener. Eklentinin taşıdığı ikili bilerek
  // bu listeye girmez: onu sürüm öğrenmek için çalıştırmak pahalı, ve zaten
  // gerekmiyor (aşağıdaki geri düşüş).
  [...claudeCliRemovablePaths(), ...wingetClaudeCliPaths()].forEach(add);

  const editorInstallations = vscodeClaudeInstallations();
  for (const candidate of candidates) {
    if (candidate.command !== "claude" && !fs.existsSync(candidate.command)) continue;
    try {
      const result = await runVersion(candidate.command);
      const version = versionText(result.stdout, result.stderr);
      if (version) {
        return {
          installed: true,
          command: candidate.command,
          version,
          installation: classifyInstallation(candidate.command),
          // Bağımsız bir CLI varken bile eklenti kurulu olabilir; ekran ikisini
          // birlikte söylemeli, çünkü tek ayar dosyası ikisini de yapılandırıyor.
          editorExtensions: editorInstallations.map((item) => ({ editor: item.editor, version: item.version })),
        };
      }
    } catch {
      // Try the next launcher; stale shims are common after an uninstall.
    }
  }

  // Düzenleyici eklentisi Claude Code'un kendi ikilisini taşısa da bu
  // BAĞIMSIZ kurulum sayılmaz: ekran "Kurulu" gösterip İndir ve Kur'u gizlerse
  // kullanıcı bağımsız CLI kuramaz. Eklenti yalnızca BİLGİ olarak raporlanır;
  // anahtar yine de aynı settings.json üzerinden eklentiyi yapılandırır ama
  // `installed` yalnızca gerçek başlatıcı (PATH/WinGet/standalone) için true olur.
  return {
    installed: false,
    command: null,
    version: null,
    installation: null,
    editorExtensions: editorInstallations.map((item) => ({ editor: item.editor, version: item.version })),
  };
}

// ------------------------------------------------------------ progress helpers
function installMessage(error) {
  if (error?.userMessage) return error.userMessage;
  if (error?.code === "CLAUDE_INSTALL_INACTIVITY_TIMEOUT") {
    return "Claude Code indirmesinde 20 dakika boyunca MB ilerlemesi görülmedi. Bağlantınızı kontrol edip tekrar deneyin.";
  }
  const raw = String(error?.message || "").trim();
  if (/another process|being used|file.*use/i.test(raw)) {
    return "Başka bir Claude Code CLI kurulumu sürüyor. Bitmesini bekleyip tekrar deneyin.";
  }
  if (/exited with code\s*(\d+)/i.test(raw)) {
    const code = raw.match(/exited with code\s*(\d+)/i)?.[1];
    return `Resmî Claude Code yükleyicisi başarısız oldu (çıkış kodu ${code || "bilinmiyor"}). Ayrıntılar kurulum etkinliğinde.`;
  }
  if (/timed out/i.test(raw)) return "Resmî Claude Code yükleyicisi zaman aşımına uğradı. Bağlantınızı kontrol edip tekrar deneyin.";
  if (/could not be detected/i.test(raw)) return "Kurulum bitti ama claude komutu henüz bulunamadı. Cizi Code'u yeniden başlatıp kontrol edin.";
  if (/download.*failed|failed to get|failed to download/i.test(raw)) {
    return "Resmî Claude Code yükleyicisi dosyalarını indiremedi. Bağlantınızı kontrol edip tekrar deneyin.";
  }
  return "Claude Code CLI kurulamadı. Ayrıntılar kurulum etkinliğinde.";
}

function installerOutputLine(value) {
  return String(value || "")
    .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••")
    .replace(/sk-cizi-[A-Za-z0-9_-]+/gi, "sk-cizi-••••")
    .trim()
    .slice(0, 220);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes;
  let index = -1;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

// The official release manifest only improves progress reporting: with the
// expected binary size known, the download can be shown as a real percentage.
// A failure here is never fatal - the installer script stays authoritative.
async function fetchNativeMetadata() {
  if (!isWindows()) return null;
  try {
    const versionResponse = await fetch(assertHttpsUrl(RELEASE_LATEST_URL, "Claude Code release URL"), { cache: "no-store" });
    if (!versionResponse.ok) return null;
    const version = (await versionResponse.text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    const manifestUrl = `https://downloads.claude.ai/claude-code-releases/${encodeURIComponent(version)}/manifest.json`;
    const manifestResponse = await fetch(assertHttpsUrl(manifestUrl, "Claude Code release manifest URL"), { cache: "no-store" });
    if (!manifestResponse.ok) return null;
    const manifest = await manifestResponse.json();
    const size = Number(manifest?.platforms?.["win32-x64"]?.size);
    return { version, size: Number.isFinite(size) && size > 0 ? size : null };
  } catch {
    return null;
  }
}

// The binary the official script is downloading right now, if any. Its growing
// size is the only measurable progress the script exposes.
function latestNativeBinary(startedAt) {
  try {
    return fs.readdirSync(downloadsDirectory())
      .filter((name) => /^claude-[^/]+\.(exe|bin)$/i.test(name))
      .map((name) => {
        const filePath = path.join(downloadsDirectory(), name);
        const stat = fs.statSync(filePath);
        return { filePath, name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => entry.mtimeMs >= startedAt - 5000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

// Timeout karari yalnizca gerçek indirme boyutuna dayanır. Çıktı mesajları,
// işlem varlığı veya mtime tek başına sayacı sıfırlayamaz; böylece ekranda MB
// ilerlemesi yokken kurulum sonsuza kadar beklemez.
function installerByteProgress({ previous = null, binary = null, startedAt = 0, now = Date.now() } = {}) {
  const bytes = Number(binary?.size);
  const hasBinary = Number.isFinite(bytes) && bytes >= 0;
  const sameFile = previous?.filePath && previous.filePath === binary?.filePath;
  const byteProgressed = hasBinary && (!sameFile || bytes > Number(previous?.bytes ?? -1));
  const binaryTime = Number(binary?.mtimeMs);
  const observedAt = Number.isFinite(binaryTime)
    ? Math.max(startedAt, Math.min(now, binaryTime))
    : now;
  return {
    filePath: hasBinary ? binary.filePath : (previous?.filePath || null),
    bytes: hasBinary ? bytes : Number(previous?.bytes || 0),
    lastByteProgressAt: byteProgressed ? observedAt : (previous?.lastByteProgressAt || startedAt),
    byteProgressed,
  };
}

// Native setup progress is trustworthy only when the official installer prints
// it after the measured download has completed. Anything else would be a
// guessed installation percentage.
function installationOutputPercent({ outputPercent = null, outputAt = 0, installStartedAt = 0 } = {}) {
  const percent = Number(outputPercent);
  const observedAt = Number(outputAt);
  const stageStartedAt = Number(installStartedAt);
  if (!Number.isFinite(percent) || !Number.isFinite(observedAt) || !Number.isFinite(stageStartedAt)) return null;
  if (stageStartedAt <= 0 || observedAt < stageStartedAt) return null;
  return Math.max(0, Math.min(100, percent));
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (isWindows()) {
    execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

// -------------------------------------------------------------------- service
function createClaudeCodeCliService({ userDataPath, log, onInstallState, detect = detectClaudeCodeCli } = {}) {
  let installPromise = null;
  let installState = { status: "idle", phase: "idle", percent: 0, message: "", operations: [] };
  let lastOutput = "";
  let lastOutputAt = 0;
  // The official native installer has no documented progress API. Preserve a
  // percentage only when it actually prints one, so the UI never invents it.
  let lastOutputPercent = null;
  let lastOutputPercentAt = 0;
  let nativeSetupOutputAt = 0;

  const emit = (next, { logState = true } = {}) => {
    installState = { ...installState, ...next };
    onInstallState?.(installState);
    if (logState) log?.info("claude-code-cli", installState.message || installState.status, { status: installState.status });
  };

  const operation = (id, next, { logState = false } = {}) => {
    const previous = Array.isArray(installState.operations) ? installState.operations : [];
    const current = previous.find((item) => item.id === id) || { id, label: id, status: "pending", percent: null, detail: "" };
    const operations = previous.some((item) => item.id === id)
      ? previous.map((item) => (item.id === id ? { ...item, ...next } : item))
      : [...previous, { ...current, ...next }];
    emit({ operations }, { logState });
  };

  const appendOutput = (operationId, buffer) => {
    for (const line of String(buffer || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const percentMatch = line.match(/(?:^|\s)(\d{1,3})%/);
      const percent = percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : null;
      lastOutput = installerOutputLine(line);
      lastOutputAt = Date.now();
      if (percent != null) {
        lastOutputPercent = percent;
        lastOutputPercentAt = lastOutputAt;
      }
      if (/\b(setting up claude code|installing claude code native build)\b/i.test(line)) {
        nativeSetupOutputAt = lastOutputAt;
      }
      operation(operationId, { detail: lastOutput, ...(percent == null ? {} : { percent }) });
    }
  };

  async function downloadInstaller(url, targetPath, onProgress) {
    const response = await fetch(assertHttpsUrl(url, "Claude Code installer URL"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Claude Code installer download failed (${response.status}).`);
    const total = Number(response.headers.get("content-length")) || null;
    const chunks = [];
    let received = 0;
    let lastPercent = -1;
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      received += buffer.length;
      const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress({ received, total, percent });
      }
    }
    fs.writeFileSync(targetPath, Buffer.concat(chunks));
    onProgress({ received, total, percent: 100 });
    return { bytes: received, total };
  }

  // The official script prints little and can go quiet for minutes while it
  // verifies a checksum. Silence is therefore never reported as a stall: the
  // reporter says what it can actually see (launcher present, bytes growing,
  // process alive) so a long wait does not look like a hang.
  function monitorInstaller(child, { startedAt, metadata }) {
    let lastSize = -1;
    let lastFileChangeAt = startedAt;
    let nativeDownloadFinishedAt = 0;

    // A percentage printed before the native binary finishes downloading is
    // not an installation percentage. Only use a value observed afterwards.
    const reportedInstallPercent = () => installationOutputPercent({
      outputPercent: lastOutputPercent,
      outputAt: lastOutputPercentAt,
      installStartedAt: nativeDownloadFinishedAt,
    });

    const publishInstalling = ({ elapsed, aliveMark, detail }) => {
      const percent = reportedInstallPercent();
      operation("install", {
        label: "Claude Code CLI kuruluyor",
        status: "running",
        detail,
        percent,
      });
      emit({
        status: "installing",
        phase: "install",
        percent,
        determinate: percent != null,
        message: percent == null
          ? `Claude Code CLI kuruluyor (${elapsed}) — yükleyici bu aşamanın yüzdesini bildirmiyor.`
          : `Claude Code CLI kuruluyor (%${percent}, ${elapsed}) — sürüyor...`,
      }, { logState: false });
    };

    const update = () => {
      if (!child || child.exitCode != null) return;
      const elapsed = formatElapsed(startedAt);
      const aliveMark = child.pid ? `PID ${child.pid} çalışıyor ✓` : "çalışıyor ✓";
      const launcherExists = fs.existsSync(launcherPath());
      const binary = latestNativeBinary(startedAt);

      // The official script explicitly announces native setup. This is the
      // fallback when a release manifest was unavailable, so it never keeps
      // calling a confirmed installation an "indirme" step.
      if (nativeSetupOutputAt) {
        if (!nativeDownloadFinishedAt) nativeDownloadFinishedAt = nativeSetupOutputAt;
        publishInstalling({
          elapsed,
          aliveMark,
          detail: `Claude Code CLI kuruluyor (${elapsed}, ${aliveMark}).`,
        });
        return;
      }

      if (launcherExists) {
        if (!nativeDownloadFinishedAt) nativeDownloadFinishedAt = Date.now();
        const finishing = binary && metadata?.size && binary.size >= metadata.size
          ? `İndirme tamamlandı; kurulum tamamlanıyor (${elapsed}, ${aliveMark}).`
          : `Launcher bulundu; kurulum tamamlanıyor (${elapsed}, ${aliveMark}).`;
        publishInstalling({ elapsed, aliveMark, detail: finishing });
        return;
      }

      if (binary) {
        if (binary.size !== lastSize) lastFileChangeAt = Date.now();
        lastSize = binary.size;
        const quietFor = Math.max(0, Math.floor((Date.now() - lastFileChangeAt) / 1000));
        const downloadComplete = Boolean(metadata?.size && binary.size >= metadata.size);
        if (downloadComplete) {
          if (!nativeDownloadFinishedAt) {
            nativeDownloadFinishedAt = Date.now();
            operation("runtime-download", {
              label: "Claude Code CLI indiriliyor",
              status: "done",
              percent: 100,
              detail: `${formatBytes(binary.size)} indirildi.`,
            });
          }
          publishInstalling({
            elapsed,
            aliveMark,
            detail: `İndirme tamamlandı; Claude Code CLI doğrulanıyor ve kuruluyor (${elapsed}, ${aliveMark}).`,
          });
          return;
        }
        const percent = metadata?.size ? Math.min(100, Math.round((binary.size / metadata.size) * 100)) : null;
        const stage = binary.size === 0
          ? "Resmî sürüm indirilmeye başlandı"
          : "Resmî sürüm indiriliyor";
        const quiet = quietFor >= 30 ? `; ${quietFor} sn'dir bayt değişimi yok` : "";
        operation("runtime-download", {
          label: "Claude Code CLI indiriliyor",
          status: "running",
          detail: metadata?.size
            ? `${stage}: ${formatBytes(binary.size)} / ${formatBytes(metadata.size)} (%${percent}, ${elapsed}, ${aliveMark})${quiet}.`
            : `${stage}: ${formatBytes(binary.size)} (${elapsed}, ${aliveMark})${quiet}.`,
          percent,
        });
        emit({
          status: "downloading",
          phase: "download",
          percent,
          determinate: percent != null,
          message: percent == null
            ? `Claude Code CLI indiriliyor (${elapsed}) — boyut bilgisi bekleniyor...`
            : `Claude Code CLI indiriliyor (%${percent}, ${elapsed})...`,
        }, { logState: false });
        return;
      }

      if (Date.now() - lastOutputAt < 5000 && lastOutput) {
        operation("runtime-download", { label: "Claude Code CLI indiriliyor", status: "running", percent: null, detail: `${lastOutput} (${elapsed}, ${aliveMark}).` });
      } else {
        const quietFor = Math.max(0, Math.floor((Date.now() - lastFileChangeAt) / 1000));
        operation("runtime-download", {
          label: "Claude Code CLI indiriliyor",
          status: "running",
          percent: null,
          detail: quietFor >= 30
            ? `Resmî yükleyici çalışmaya devam ediyor ✓; ${quietFor} sn'dir dosya/çıktı değişimi yok. Dosyaları doğruluyor ya da ağı bekliyor olabilir (${elapsed}, ${aliveMark}).`
            : `Resmî yükleyici süreci çalışıyor ✓; sonraki adım bekleniyor (${elapsed}, ${aliveMark}).`,
        });
      }
      emit({
        status: "downloading",
        phase: "download",
        percent: null,
        determinate: false,
        message: `Claude Code CLI indiriliyor (${elapsed}) — indirmenin başlaması bekleniyor...`,
      }, { logState: false });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }

  const lockPath = () => path.join(userDataPath, "claude-code-install.lock");

  // A second installation would fight the first over the same target files, so
  // the lock is a real file: it survives a crash and is only reclaimed once the
  // process that wrote it is gone.
  function acquireLock() {
    const filePath = lockPath();
    try {
      const previous = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const previousPid = Number(previous?.pid);
      let alive = false;
      if (Number.isInteger(previousPid) && previousPid > 0) {
        try { process.kill(previousPid, 0); alive = true; } catch { alive = false; }
      }
      if (!alive) fs.rmSync(filePath, { force: true });
    } catch {
      try { fs.rmSync(filePath, { force: true }); } catch { /* nothing to reclaim */ }
    }

    let handle;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      handle = fs.openSync(filePath, "wx");
      fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    } catch (error) {
      if (error?.code === "EEXIST") {
        const busy = new Error("Another Claude Code CLI installation is already running.");
        busy.code = "CLAUDE_INSTALL_IN_PROGRESS";
        busy.userMessage = "Başka bir Claude Code CLI kurulumu sürüyor. Bitmesini bekleyip tekrar deneyin.";
        throw busy;
      }
      throw error;
    } finally {
      if (handle != null) fs.closeSync(handle);
    }
    return () => { try { fs.rmSync(filePath, { force: true }); } catch { /* already released */ } };
  }

  // Resmî yükleyici toplam çalışma süresine göre kesilmez. İndirilen bayt
  // sayısı artarken devam eder; 20 dakika boyunca hiç artış yoksa durdurulur.
  function waitForInstaller(child, startedAt) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let graceReported = false;
      let byteProgress = installerByteProgress({ binary: latestNativeBinary(startedAt), startedAt });
      const inspectProgress = () => {
        const binary = latestNativeBinary(startedAt);
        byteProgress = installerByteProgress({
          previous: byteProgress,
          binary,
          startedAt,
        });
        return byteProgress;
      };
      const fail = () => {
        const error = new Error("The official Claude Code installer made no download progress for 20 minutes.");
        error.code = "CLAUDE_INSTALL_INACTIVITY_TIMEOUT";
        error.userMessage = installMessage(error);
        return error;
      };
      const progressTimer = setInterval(() => {
        if (settled) return;
        const progress = inspectProgress();
        const inactiveFor = Date.now() - progress.lastByteProgressAt;
        if (inactiveFor < INSTALL_INACTIVITY_TIMEOUT_MS) return;
        settled = true;
        clearInterval(progressTimer);
        terminateProcessTree(child);
        log?.warning("claude-code-cli", "Claude Code yükleyicisinde 20 dakika boyunca indirme ilerlemesi görülmedi; işlem durduruldu", {
          lastBytes: progress.bytes,
          lastByteProgressAt: new Date(progress.lastByteProgressAt).toISOString(),
          inactiveForMs: inactiveFor,
        });
        reject(fail());
      }, 15000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearInterval(progressTimer);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", finish);
      child.once("exit", (code) => {
        if (code === 0) return finish();
        const error = new Error(`Claude Code installer exited with code ${code}.`);
        error.userMessage = installMessage(error);
        return finish(error);
      });
    });
  }

  async function runInstall() {
    const release = acquireLock();
    try {
      installState = { status: "checking", phase: "detecting", percent: 5, message: "Claude Code CLI aranıyor...", operations: [] };
      onInstallState?.(installState);
      operation("detect", { label: "Claude Code CLI kontrolü", status: "running", percent: 0, detail: "PATH ve bilinen kurulum yerleri taranıyor..." }, { logState: true });

      const before = await detect();
      if (before.installed) {
        operation("detect", { status: "done", percent: 100, detail: before.version || before.command || "Bulundu" });
        emit({ status: "installed", phase: "complete", percent: 100, message: "Claude Code CLI zaten kurulu.", ...before });
        return before;
      }
      operation("detect", { status: "done", percent: 100, detail: "Claude Code CLI bulunamadı." });

      const installerUrl = isWindows() ? WINDOWS_INSTALLER_URL : POSIX_INSTALLER_URL;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-claude-install-"));
      const installerPath = path.join(tempDir, isWindows() ? "install.ps1" : "install.sh");

      operation("download", { label: "Resmî yükleyiciyi indir", status: "running", percent: 0, detail: installerUrl }, { logState: true });
      emit({ status: "downloading", phase: "download", percent: 0, message: "Resmî Claude Code yükleyicisi indiriliyor..." }, { logState: false });
      const downloaded = await downloadInstaller(installerUrl, installerPath, ({ received, total, percent }) => {
        operation("download", { percent, detail: total ? `${received} / ${total} bayt` : `${received} bayt indirildi` });
        emit({ percent: percent ?? 0 }, { logState: false });
      });
      operation("download", { status: "done", percent: 100, detail: `${downloaded.bytes} bayt indirildi.` });

      operation("runtime-download", { label: "Claude Code CLI indiriliyor", status: "running", percent: null, detail: "Resmî sürüm bilgisi hazırlanıyor..." }, { logState: true });
      emit({ status: "downloading", phase: "download", percent: null, determinate: false, message: "Claude Code CLI indirmeye hazırlanıyor..." }, { logState: false });
      const metadata = await fetchNativeMetadata();
      operation("runtime-download", {
        detail: metadata?.size
          ? `Yükleyici hazır; beklenen sürüm boyutu ${formatBytes(metadata.size)}.`
          : "Yükleyici hazır; indirme ya da doğrulama bekleniyor...",
      });

      lastOutput = "";
      lastOutputAt = 0;
      lastOutputPercent = null;
      lastOutputPercentAt = 0;
      nativeSetupOutputAt = 0;
      const startedAt = Date.now();
      const child = isWindows()
        ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath], {
          cwd: home(), stdio: ["ignore", "pipe", "pipe"], windowsHide: false,
        })
        : spawn("bash", [installerPath], { cwd: home(), stdio: ["ignore", "pipe", "pipe"], windowsHide: false });

      child.stdout?.on("data", (chunk) => appendOutput("install", chunk));
      child.stderr?.on("data", (chunk) => appendOutput("install", chunk));
      const stopMonitor = monitorInstaller(child, { startedAt, metadata });
      try {
        await waitForInstaller(child, startedAt);
      } finally {
        stopMonitor();
      }
      operation("install", { label: "Claude Code CLI kuruluyor", status: "done", percent: 100, detail: "Resmî yükleyici tamamlandı." });

      operation("verify", { label: "Claude Code CLI doğrula", status: "running", percent: 0, detail: "claude --version çalıştırılıyor..." }, { logState: true });
      emit({ status: "verifying", phase: "verify", percent: null, determinate: false, message: "Claude Code CLI kurulumu doğrulanıyor..." }, { logState: false });
      const after = await detect();
      if (!after.installed) throw new Error("Installer finished, but Claude Code CLI could not be detected yet.");
      operation("verify", { status: "done", percent: 100, detail: after.version || after.command || "Bulundu" });
      emit({ status: "installed", phase: "complete", percent: 100, message: "Claude Code CLI kuruldu.", ...after });
      return after;
    } finally {
      release();
    }
  }

  // One installation per app instance; a second request joins the first.
  function install() {
    if (installPromise) return installPromise;
    installPromise = runInstall()
      .catch((error) => {
        const message = installMessage(error);
        error.userMessage = message;
        const active = [...(installState.operations || [])].reverse().find((item) => item.status === "running");
        if (active) operation(active.id, { status: "error", detail: message });
        emit({ status: "error", phase: "error", percent: installState.percent || 0, message });
        throw error;
      })
      .finally(() => { installPromise = null; });
    return installPromise;
  }

  async function open() {
    const status = await detect();
    if (!status.installed || !status.command) throw new Error("Claude Code CLI bu bilgisayarda kurulu değil.");
    const command = String(status.command);
    log?.info("claude-code-cli", "Claude Code CLI açılıyor", { command });
    if (isWindows()) {
      const isExe = /\.exe$/i.test(command) && fs.existsSync(command);
      const run = /\.(cmd|bat)$/i.test(command) ? `"${command.replace(/"/g, '""')}"` : command;
      const child = isExe
        ? spawn("cmd.exe", ["/c", "start", '""', command], { cwd: home(), detached: true, stdio: "ignore", windowsHide: false })
        : spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `start "" ${run}`], { cwd: home(), detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    } else {
      const child = spawn(command, [], { cwd: home(), detached: true, stdio: "ignore" });
      child.unref();
    }
    return { opened: true, command };
  }

  // "Sadece indir": resmî yükleyici script'i indirilenler klasörüne konur ve
  // çalıştırılmaz. Kullanıcı kurulumu kendi zamanlamasıyla yapar.
  async function downloadOnly() {
    const url = isWindows() ? WINDOWS_INSTALLER_URL : POSIX_INSTALLER_URL;
    const fileName = isWindows() ? "claude-code-install.ps1" : "claude-code-install.sh";
    emit({ status: "downloading", phase: "download", percent: 0, message: "Resmî Claude Code yükleyicisi indiriliyor..." });
    operation("download", { label: "Yükleyiciyi indir (manuel kurulum)", status: "running", percent: 0, detail: url }, { logState: true });
    try {
      const saved = await downloadForManualInstall({
        url, fileName, label: "Claude Code yükleyicisi",
        onProgress: ({ received, total, percent }) => {
          operation("download", { percent, detail: total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received) });
          emit({ percent: percent ?? 0 }, { logState: false });
        },
      });
      operation("download", { status: "done", percent: 100, detail: saved.path });
      emit({ status: "installed", phase: "complete", percent: 100, message: `Yükleyici indirildi: ${saved.path}` });
      return { downloaded: true, ...saved, runHint: isWindows()
        ? "PowerShell'de: powershell -ExecutionPolicy Bypass -File \"<dosya>\""
        : "Terminalde: bash <dosya>" };
    } catch (error) {
      const message = installMessage(error);
      operation("download", { status: "error", detail: message });
      emit({ status: "error", phase: "error", percent: 0, message });
      throw Object.assign(error, { userMessage: message });
    }
  }

  // Windows refuses to delete a binary that is still executing, so a removal
  // closes the CLI first. Deleting files is the removal module's job; this only
  // frees them - and it is deliberately a separate call, because the same
  // executable name is how Cizi Code's own developer session runs.
  async function closeProcesses() {
    if (!isWindows()) {
      try { await execFileAsync("pkill", ["-f", "claude"], { timeout: 5000 }); } catch { /* nothing running */ }
      return { closed: true };
    }
    try {
      await execFileAsync("taskkill.exe", ["/im", "claude.exe", "/f"], { windowsHide: true, timeout: 8000 });
      return { closed: true };
    } catch {
      return { closed: false, reason: "not-running" };
    }
  }

  return { detect, install, downloadOnly, open, closeProcesses, officialSiteUrl: OFFICIAL_SITE_URL };
}

module.exports = {
  createClaudeCodeCliService,
  detectClaudeCodeCli,
  claudeCliPaths,
  claudeCliRemovablePaths,
  wingetClaudeCliPaths,
  vscodeClaudeInstallations,
  vscodeClaudeExtensionDirectories,
  installerByteProgress,
  installationOutputPercent,
  VSCODE_EXTENSION_ID,
  OFFICIAL_SITE_URL,
};
