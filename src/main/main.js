const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const store = require("./store");
const api = require("./apiClient");
const toolMgr = require("./tools/apply");
const claudeUninstall = require("./claudeUninstall");
const { createCodexCliService } = require("./codexCli");
const { createCodexDesktopService } = require("./codexDesktop");
const codexConfig = require("./codexConfigFile");
const claudeDesktopBackend = require("./tools/claudeDesktop");
const claudeLifecycle = require("./tools/claudeLifecycle");
const { createClaudeCoordinator } = require("./claudeCoordinator");
const log = require("./logger");
const { CliBridge } = require("./cliBridge");

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_OFFICIAL_URL = "https://code.claude.com/docs/en/getting-started";
const CLAUDE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// The CLI launcher can be invoked repeatedly while the desktop process is
// already starting. Keep one desktop process (and therefore one installer
// mutex) per user session.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // app.quit() may wait for a ready event that this contender never reaches.
  // Exit immediately so it cannot leave a second Electron process behind.
  app.exit(0);
}

const UPDATE_FEED_URL = process.env.CIZI_UPDATE_URL || "https://cizicode.me/desktop-updates";

let session = null; // { baseUrl, apiKey }
let updateState = { status: "idle", message: "" };
let claudeInstallState = { status: "idle", phase: "idle", percent: 0, message: "" };
let claudeInstallPromise = null;
let claudeInstallerLastOutputAt = 0;
let claudeInstallerLastOutput = "";
let mainWindow = null;
const cliBridge = new CliBridge({ getWindow: () => mainWindow, log });
const codexCli = createCodexCliService({
  userDataPath: app.getPath("userData"),
  log,
  onInstallState: (state) => broadcast("cizi:codexCliInstallState", state),
});
const codexDesktop = createCodexDesktopService({
  userDataPath: app.getPath("userData"),
  log,
  onInstallState: (state) => broadcast("cizi:codexDesktopInstallState", state),
});
// Claude Desktop's own transaction/rollback engine is transplanted as-is; the
// coordinator is the only thing that knows the CLI and the desktop app are one
// switch to the user.
let claudeProgressState = { phase: "idle", message: "", details: null };
const claude = createClaudeCoordinator({
  claudeDesktop: claudeDesktopBackend,
  lifecycle: claudeLifecycle,
  toolManager: toolMgr,
  detectCli: () => detectClaudeCodeCli(),
  installCli: () => installClaudeCodeCli(),
  log,
  onDesktopProgress: (state) => {
    claudeProgressState = { ...state, at: new Date().toISOString() };
    broadcast("cizi:claudeProgress", claudeProgressState);
  },
});

function shouldBlockDevToolsShortcut(input) {
  const key = String(input.key || "").toLowerCase();
  return key === "f12" || (input.control && input.shift && ["i", "j", "c"].includes(key));
}

function lockProductionWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (!app.isPackaged) return;

  win.webContents.on("before-input-event", (event, input) => {
    if (shouldBlockDevToolsShortcut(input)) event.preventDefault();
  });
  win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#e9e4ce",
    title: "Cizi Code",
    icon: path.join(__dirname, "..", "..", "assets", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  lockProductionWindow(win);
  const cachedContents = win.webContents;
  win.webContents.on("render-process-gone", () => cliBridge.markRendererUnavailable(cachedContents));
  win.on("closed", () => {
    cliBridge.markRendererUnavailable(cachedContents);
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

function broadcast(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, data);
    } catch {
      // Ignore windows that are closing.
    }
  }
}

function setUpdateState(next) {
  updateState = { ...updateState, ...next };
  broadcast("cizi:updateState", updateState);
  log.info("update", updateState.message || updateState.status, { status: updateState.status });
}

function updateFeedBase() {
  return UPDATE_FEED_URL.replace(/\/+$/, "");
}

function gatewayLabel() {
  const base = api.DEFAULT_BASE_URL;
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(base) ? "Cizi Code Local" : "Cizi Code Cloud";
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function safeMessage(err) {
  return api.sanitizeErrorMessage(err?.message || String(err || ""), err?.status);
}

function claudeInstallMessage(error) {
  if (error?.userMessage) return error.userMessage;
  const raw = String(error?.message || "").trim();
  if (/another process|being used|file.*use/i.test(raw)) {
    return "Another Claude Code CLI installation is already running. Wait for it to finish, then try again.";
  }
  if (/exited with code\s*(\d+)/i.test(raw)) {
    const code = raw.match(/exited with code\s*(\d+)/i)?.[1];
    return `The official Claude Code installer failed (exit code ${code || "unknown"}). See the installation activity for details.`;
  }
  if (/timed out/i.test(raw)) {
    return "The official Claude Code installer timed out. Check your connection and try again.";
  }
  if (/could not be detected/i.test(raw)) {
    return "The installer finished, but the claude command was not found yet. Restart Cizi Code and check again.";
  }
  if (/download.*failed|failed to get|failed to download/i.test(raw)) {
    return "The official Claude Code installer could not download its files. Check your connection and try again.";
  }
  return "Claude Code CLI installation failed. See the installation activity for details.";
}

function claudeVersionText(stdout, stderr) {
  const line = String(stdout || stderr || "").trim().split(/\r?\n/)[0].trim();
  return line ? line.slice(0, 120) : null;
}

async function runClaudeVersion(command) {
  const timeout = { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const quoted = `"${String(command).replace(/"/g, '""')}" --version`;
    return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", quoted], timeout);
  }
  return execFileAsync(command, ["--version"], { ...timeout, shell: false });
}

async function detectClaudeCodeCli() {
  const candidates = [];
  const add = (value) => {
    const command = String(value || "").trim();
    if (!command) return;
    const key = process.platform === "win32" ? command.toLowerCase() : command;
    if (!candidates.some((candidate) => candidate.key === key)) candidates.push({ key, command });
  };

  try {
    const lookup = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(lookup, ["claude"], { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 });
    String(stdout || "").split(/\r?\n/).forEach(add);
  } catch {
    // PATH lookup is best effort; native and npm locations are checked below.
  }

  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(home, ".local", "bin", "claude.cmd"),
      path.join(appData, "npm", "claude.cmd"),
      path.join(appData, "npm", "claude.exe"),
      path.join(localAppData, "Programs", "Claude Code", "claude.exe"),
      path.join(localAppData, "Claude Code", "claude.exe"),
      path.join(programFiles, "Claude Code", "claude.exe"),
    ].forEach(add);
  } else {
    [
      path.join(home, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/usr/bin/claude",
    ].forEach(add);
  }

  for (const candidate of candidates) {
    if (candidate.command !== "claude" && !fs.existsSync(candidate.command)) continue;
    try {
      const result = await runClaudeVersion(candidate.command);
      const version = claudeVersionText(result.stdout, result.stderr);
      if (version) {
        return { installed: true, command: candidate.command, version };
      }
    } catch {
      // Try the next launcher; stale shims are common after an uninstall.
    }
  }
  return { installed: false, command: null, version: null };
}

function setClaudeInstallState(next, { logState = true } = {}) {
  claudeInstallState = { ...claudeInstallState, ...next };
  broadcast("cizi:claudeCodeInstallState", claudeInstallState);
  if (logState) log.info("claude-code-cli", claudeInstallState.message || claudeInstallState.status, { status: claudeInstallState.status });
}

function installerOutputLine(value) {
  return String(value || "")
    .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••")
    .replace(/sk-cizi-[A-Za-z0-9_-]+/gi, "sk-cizi-••••")
    .trim()
    .slice(0, 220);
}

function updateClaudeOperation(id, next, { logState = false } = {}) {
  const previous = Array.isArray(claudeInstallState.operations) ? claudeInstallState.operations : [];
  const current = previous.find((operation) => operation.id === id) || { id, label: id, status: "pending", percent: null, detail: "" };
  const operations = previous.some((operation) => operation.id === id)
    ? previous.map((operation) => operation.id === id ? { ...operation, ...next } : operation)
    : [...previous, { ...current, ...next }];
  setClaudeInstallState({ operations }, { logState });
}

async function downloadClaudeInstaller(url, targetPath, onProgress) {
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

function appendClaudeInstallerOutput(operationId, buffer) {
  const lines = String(buffer || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const percentMatch = line.match(/(?:^|\s)(\d{1,3})%/);
    const percent = percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : null;
    const detail = installerOutputLine(line);
    claudeInstallerLastOutputAt = Date.now();
    claudeInstallerLastOutput = detail;
    updateClaudeOperation(operationId, { detail, ...(percent == null ? {} : { percent }) });
  }
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

async function fetchClaudeNativeMetadata(isWindows) {
  if (!isWindows) return null;
  try {
    const latestUrl = "https://downloads.claude.ai/claude-code-releases/latest";
    const versionResponse = await fetch(assertHttpsUrl(latestUrl, "Claude Code release URL"), { cache: "no-store" });
    if (!versionResponse.ok) return null;
    const version = (await versionResponse.text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    const manifestUrl = `https://downloads.claude.ai/claude-code-releases/${encodeURIComponent(version)}/manifest.json`;
    const manifestResponse = await fetch(assertHttpsUrl(manifestUrl, "Claude Code release manifest URL"), { cache: "no-store" });
    if (!manifestResponse.ok) return null;
    const manifest = await manifestResponse.json();
    const platform = manifest?.platforms?.["win32-x64"];
    const size = Number(platform?.size);
    return { version, size: Number.isFinite(size) && size > 0 ? size : null };
  } catch {
    // Metadata only improves progress reporting; the official script remains authoritative.
    return null;
  }
}

function latestClaudeNativeBinary(startedAt) {
  const directory = path.join(os.homedir(), ".claude", "downloads");
  try {
    const files = fs.readdirSync(directory)
      .filter((name) => /^claude-[^/]+\.(exe|bin)$/i.test(name))
      .map((name) => {
        const filePath = path.join(directory, name);
        const stat = fs.statSync(filePath);
        return { filePath, name, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((entry) => entry.mtimeMs >= startedAt - 5000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0] || null;
  } catch {
    return null;
  }
}

function monitorClaudeInstaller(child, { startedAt, metadata }) {
  let lastSize = -1;
  let lastFileChangeAt = startedAt;
  const update = () => {
    if (!child || child.exitCode != null) return;
    const launcherPath = process.platform === "win32"
      ? path.join(os.homedir(), ".local", "bin", "claude.exe")
      : path.join(os.homedir(), ".local", "bin", "claude");
    const elapsed = formatElapsed(startedAt);
    const aliveMark = child.pid ? `PID ${child.pid} alive ✓` : "alive ✓";
    const launcherExists = fs.existsSync(launcherPath);
    const binary = latestClaudeNativeBinary(startedAt);
    let detail;
    if (launcherExists && binary && metadata?.size && binary.size >= metadata.size) {
      detail = `Launcher detected; verifying checksum and finishing setup — 1–2 dk sürebilir (${elapsed} elapsed, ${aliveMark}).`;
      updateClaudeOperation("install", { detail, percent: 99 });
      setClaudeInstallState({ percent: 99, message: `Finalizing installation (${elapsed}) — almost done...` }, { logState: false });
      return;
    } else if (launcherExists) {
      detail = `Launcher detected; finishing setup (${elapsed} elapsed, ${aliveMark}).`;
      updateClaudeOperation("install", { detail, percent: 99 });
      setClaudeInstallState({ percent: 99, message: `Finalizing installation (${elapsed})...` }, { logState: false });
      return;
    } else if (binary) {
      if (binary.size !== lastSize) lastFileChangeAt = Date.now();
      lastSize = binary.size;
      const percent = metadata?.size ? Math.min(99, Math.round((binary.size / metadata.size) * 100)) : null;
      const quietFor = Math.max(0, Math.floor((Date.now() - lastFileChangeAt) / 1000));
      if (quietFor >= 30 && metadata?.size && binary.size >= metadata.size * 0.97) {
        detail = `İndirme %99'da tamamlandı — şimdi checksum doğrulanıyor & açılıyor (normal, 1–2 dk). Hâlâ çalışıyor ✓ (${elapsed} elapsed, ${formatBytes(binary.size)} / ${formatBytes(metadata.size)}, ${aliveMark}).`;
        updateClaudeOperation("install", { detail, percent: 99 });
        setClaudeInstallState({ percent: 99, message: `Verifying & extracting (${elapsed}) — still working, please wait...` }, { logState: false });
        return;
      } else {
        const stage = binary.size === 0
          ? "Official native binary download started"
          : metadata?.size && binary.size >= metadata.size
            ? "Official native binary downloaded; verifying checksum"
            : "Downloading official native binary";
        detail = metadata?.size
          ? `${stage}: ${formatBytes(binary.size)} / ${formatBytes(metadata.size)} (${percent}%, ${elapsed} elapsed, ${aliveMark})${quietFor >= 30 ? `; no byte change for ${quietFor}s` : ""}.`
          : `${stage}: ${formatBytes(binary.size)} (${elapsed} elapsed, ${aliveMark})${quietFor >= 30 ? `; no byte change for ${quietFor}s` : ""}.`;
        const stepPercent = percent;
        updateClaudeOperation("install", { detail, ...(stepPercent == null ? {} : { percent: stepPercent }) });
        if (stepPercent != null) setClaudeInstallState({ percent: stepPercent, message: `Official installer is running (${elapsed}) — ${aliveMark}.` }, { logState: false });
        return;
      }
    } else if (Date.now() - claudeInstallerLastOutputAt < 5000 && claudeInstallerLastOutput) {
      detail = `${claudeInstallerLastOutput} (${elapsed} elapsed, ${aliveMark}).`;
      updateClaudeOperation("install", { detail });
    } else {
      const quietFor = Math.max(0, Math.floor((Date.now() - lastFileChangeAt) / 1000));
      detail = quietFor >= 30
        ? `Official installer is still running ✓; no file/output change for ${quietFor}s. It may be verifying files or waiting on the network (${elapsed} elapsed, ${aliveMark}).`
        : `Official installer process is running ✓; waiting for its next step (${elapsed} elapsed, ${aliveMark}).`;
      updateClaudeOperation("install", { detail });
    }
    setClaudeInstallState({ message: `Official installer is running (${elapsed}) — ${aliveMark}.` }, { logState: false });
  };
  update();
  const timer = setInterval(update, 1000);
  return () => clearInterval(timer);
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function claudeInstallerLockPath() {
  return path.join(app.getPath("userData"), "claude-code-install.lock");
}

function acquireClaudeInstallerLock() {
  const lockPath = claudeInstallerLockPath();
  try {
    const previous = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const previousPid = Number(previous?.pid);
    let alive = false;
    if (Number.isInteger(previousPid) && previousPid > 0) {
      try { process.kill(previousPid, 0); alive = true; } catch { alive = false; }
    }
    if (!alive) fs.rmSync(lockPath, { force: true });
  } catch {
    // Missing or malformed locks are stale and can be replaced.
    try { fs.rmSync(lockPath, { force: true }); } catch {}
  }

  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const e = new Error("Another Claude Code CLI installation is already running.");
      e.userMessage = "Another Claude Code CLI installation is already running. Wait for it to finish, then try again.";
      e.code = "CLAUDE_INSTALL_IN_PROGRESS";
      throw e;
    }
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  return () => { try { fs.rmSync(lockPath, { force: true }); } catch {} };
}

function waitForInstaller(child, startedAt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const checkProgress = () => {
      if (settled) return;
      if (Date.now() - startedAt >= CLAUDE_INSTALL_TIMEOUT_MS) {
        const launcherPath = process.platform === "win32"
          ? path.join(os.homedir(), ".local", "bin", "claude.exe")
          : path.join(os.homedir(), ".local", "bin", "claude");
        const binary = latestClaudeNativeBinary(startedAt);
        const launcherExists = fs.existsSync(launcherPath);
        const nearDone = binary && launcherExists;
        const stalledNearEnd = binary && (Date.now() - claudeInstallerLastOutputAt > 90000);
        if (nearDone || stalledNearEnd) return;
        settled = true;
        terminateProcessTree(child);
        const error = new Error("The official Claude Code installer timed out.");
        error.userMessage = claudeInstallMessage(error);
        reject(error);
      }
    };
    const progressTimer = setInterval(checkProgress, 15000);
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      terminateProcessTree(child);
      const error = new Error("The official Claude Code installer timed out.");
      error.userMessage = claudeInstallMessage(error);
      reject(error);
    }, CLAUDE_INSTALL_TIMEOUT_MS + 90 * 1000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearInterval(progressTimer);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", finish);
    child.once("exit", (code) => {
      if (code === 0) finish();
      else {
        const error = new Error(`Claude Code installer exited with code ${code}.`);
        error.userMessage = claudeInstallMessage(error);
        finish(error);
      }
    });
  });
}

async function installClaudeCodeCli() {
  if (claudeInstallPromise) return claudeInstallPromise;
  let releaseInstallerLock = null;
  claudeInstallPromise = (async () => {
    releaseInstallerLock = acquireClaudeInstallerLock();
    claudeInstallState = { status: "checking", phase: "detecting", percent: 5, message: "Checking for Claude Code CLI...", operations: [] };
    broadcast("cizi:claudeCodeInstallState", claudeInstallState);
    updateClaudeOperation("detect", { label: "Check for Claude Code CLI", status: "running", percent: 0, detail: "Searching PATH and native install locations..." }, { logState: true });
    const before = await detectClaudeCodeCli();
    if (before.installed) {
      updateClaudeOperation("detect", { status: "done", percent: 100, detail: before.version || before.command || "Detected" }, { logState: false });
      setClaudeInstallState({ status: "installed", phase: "complete", percent: 100, message: "Claude Code CLI is already installed.", ...before });
      return before;
    }

    updateClaudeOperation("detect", { status: "done", percent: 100, detail: "Claude Code CLI was not found." }, { logState: false });
    const isWindows = process.platform === "win32";
    const installerUrl = isWindows ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-claude-install-"));
    const installerPath = path.join(tempDir, isWindows ? "install.ps1" : "install.sh");
    updateClaudeOperation("download", { label: "Download official installer", status: "running", percent: 0, detail: installerUrl }, { logState: true });
    setClaudeInstallState({ status: "downloading", phase: "download", percent: 0, message: "Downloading the official Claude Code installer..." }, { logState: false });
    const downloaded = await downloadClaudeInstaller(installerUrl, installerPath, ({ received, total, percent }) => {
      updateClaudeOperation("download", {
        percent,
        detail: total ? `${received} / ${total} bytes` : `${received} bytes downloaded`,
      });
      setClaudeInstallState({ percent: percent ?? 0 }, { logState: false });
    });
    updateClaudeOperation("download", { status: "done", percent: 100, detail: `${downloaded.bytes} bytes downloaded.` }, { logState: false });
    setClaudeInstallState({ percent: 100 }, { logState: false });

    updateClaudeOperation("install", { label: "Run official installer", status: "running", percent: 0, detail: "Preparing official release metadata..." }, { logState: true });
    setClaudeInstallState({ status: "installing", phase: "install", percent: 0, message: "Running the official Claude Code installer..." }, { logState: false });
    const nativeMetadata = await fetchClaudeNativeMetadata(isWindows);
    updateClaudeOperation("install", {
      detail: nativeMetadata?.size
        ? `Official installer ready; expected native binary size is ${formatBytes(nativeMetadata.size)}.`
        : "Official installer ready; waiting for native binary download or verification...",
    }, { logState: false });
    claudeInstallerLastOutputAt = 0;
    claudeInstallerLastOutput = "";
    const installerStartedAt = Date.now();
    const child = isWindows
      ? spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installerPath,
      ], {
        cwd: app.getPath("home"),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      })
      : spawn("bash", [installerPath], {
      cwd: app.getPath("home"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });

    child.stdout?.on("data", (chunk) => appendClaudeInstallerOutput("install", chunk));
    child.stderr?.on("data", (chunk) => appendClaudeInstallerOutput("install", chunk));
    const stopInstallerMonitor = monitorClaudeInstaller(child, { startedAt: installerStartedAt, metadata: nativeMetadata });
    try {
      await waitForInstaller(child, installerStartedAt);
    } finally {
      stopInstallerMonitor();
    }
    updateClaudeOperation("install", { status: "done", percent: 100, detail: "Official installer finished." }, { logState: false });

    updateClaudeOperation("verify", { label: "Verify Claude Code CLI", status: "running", percent: 0, detail: "Running claude --version..." }, { logState: true });
    setClaudeInstallState({ status: "verifying", phase: "verify", percent: 0, message: "Verifying the Claude Code CLI installation..." }, { logState: false });
    const after = await detectClaudeCodeCli();
    if (!after.installed) throw new Error("Installer finished, but Claude Code CLI could not be detected yet.");
    updateClaudeOperation("verify", { status: "done", percent: 100, detail: after.version || after.command || "Detected" }, { logState: false });
    setClaudeInstallState({ status: "installed", phase: "complete", percent: 100, message: "Claude Code CLI is installed.", ...after });
    return after;
  })().catch((error) => {
    const message = claudeInstallMessage(error);
    error.userMessage = message;
    const active = [...(claudeInstallState.operations || [])].reverse().find((operation) => operation.status === "running");
    if (active) updateClaudeOperation(active.id, { status: "error", detail: message }, { logState: false });
    setClaudeInstallState({ status: "error", phase: "error", percent: claudeInstallState.percent || 0, message });
    throw error;
  }).finally(() => {
    releaseInstallerLock?.();
    releaseInstallerLock = null;
    claudeInstallPromise = null;
  });
  return claudeInstallPromise;
}

async function openClaudeCodeCli() {
  const status = await detectClaudeCodeCli();
  if (!status.installed || !status.command) throw new Error("Claude Code CLI is not installed on this computer.");
  const command = String(status.command);
  const isExe = /\.exe$/i.test(command) && fs.existsSync(command);
  log.info("claude-code-cli", `Open Claude Code CLI: ${command}`, { installed: true });
  if (process.platform === "win32") {
    let shellCommand;
    let shellArgs;
    if (isExe) {
      shellCommand = "cmd.exe";
      shellArgs = ["/c", "start", '""', command];
    } else {
      const run = /\.(cmd|bat)$/i.test(command) ? `"${command.replace(/"/g, '""')}"` : command;
      shellCommand = process.env.ComSpec || "cmd.exe";
      shellArgs = ["/d", "/s", "/c", `start "" ${run}`];
    }
    const child = spawn(shellCommand, shellArgs, { cwd: os.homedir(), detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } else {
    const terminal = process.env.TERM_PROGRAM || "xterm";
    const child = spawn(command, [], { cwd: os.homedir(), detached: true, stdio: "ignore" });
    child.unref();
    void terminal;
  }
  return { opened: true, command };
}

function assertHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} is not valid.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  return parsed.toString();
}

async function downloadFile(url, targetPath) {
  const res = await fetch(assertHttpsUrl(url, "Download URL"), { cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(targetPath, bytes);
  return bytes.length;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function checkForUpdates() {
  try {
    if (!app.isPackaged && process.env.CIZI_ALLOW_DEV_UPDATE !== "1") {
      setUpdateState({ status: "skipped", message: "Update checks run in packaged builds." });
      return updateState;
    }
    setUpdateState({ status: "checking", message: "Checking for updates..." });
    const manifestUrl = `${updateFeedBase()}/latest.json?ts=${Date.now()}`;
    const res = await fetch(manifestUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Update manifest could not be loaded (${res.status}).`);
    const manifest = await res.json();
    const currentVersion = app.getVersion();
    if (!manifest?.version || compareVersions(manifest.version, currentVersion) <= 0) {
      setUpdateState({ status: "current", message: "Cizi Code is up to date.", currentVersion });
      return updateState;
    }
    setUpdateState({
      status: "ready",
      message: `Version ${manifest.version} is ready to install.`,
      currentVersion,
      version: manifest.version,
      manifest,
    });
    return updateState;
  } catch (err) {
    setUpdateState({ status: "error", message: safeMessage(err) || "Update check failed." });
    return updateState;
  }
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    log.info("app", "Cizi Code existing instance was brought to foreground");
  });

  app.whenReady().then(() => {
    log.info("app", `Cizi Code desktop started (v${app.getVersion()}); logs at ${log.filePath()}`);
    try {
      const saved = store.loadSession();
      session = saved?.apiKey ? { baseUrl: api.DEFAULT_BASE_URL, apiKey: saved.apiKey } : null;
      log.info("auth", session?.apiKey ? "Restored saved session" : "No saved session");
    } catch {
      session = null;
      log.warn("auth", "Failed to load saved session");
    }

    createWindow();
    cliBridge.start().catch((err) => {
      log.error("cli", `CLI bridge could not start: ${safeMessage(err)}`);
    });
    setTimeout(() => checkForUpdates().catch(() => {}), 2500);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => cliBridge.stop());

ipcMain.on("cizi:cliReady", (event) => cliBridge.markRendererReady(event.sender));
ipcMain.on("cizi:cliResponse", (event, response) => cliBridge.handleRendererResponse(event.sender, response));

function requireSession() {
  if (!session?.apiKey || !session?.baseUrl) {
    const e = new Error("Not logged in");
    e.code = "NO_SESSION";
    throw e;
  }
  return session;
}

function wrap(label, handler) {
  return async (_evt, args) => {
    const t0 = Date.now();
    log.debug("ipc", `start ${label}`);
    try {
      const data = await handler(args || {});
      log.info("ipc", `ok ${label} (${Date.now() - t0}ms)`);
      return { ok: true, data };
    } catch (err) {
      const message = err?.userMessage || safeMessage(err);
      log.error("ipc", `failed ${label}: ${message}`, { status: err.status || null, code: err.code || null });
      return { ok: false, error: message, status: err.status || null, code: err.code || null };
    }
  };
}

ipcMain.handle("cizi:login", wrap("login", async ({ apiKey }) => {
  if (!apiKey) throw new Error("API key is required.");
  log.info("auth", "Login attempt");
  const me = await api.getMe(api.DEFAULT_BASE_URL, apiKey);
  session = { baseUrl: api.DEFAULT_BASE_URL, apiKey };
  store.saveSession({ apiKey });
  log.info("auth", `Login OK (models: ${(me?.combos || []).length})`);
  return me;
}));

ipcMain.handle("cizi:logout", wrap("logout", async () => {
  session = null;
  store.clearSession();
  log.info("auth", "Logged out");
  return { loggedOut: true };
}));

ipcMain.handle("cizi:getSession", wrap("getSession", async () => {
  if (!session?.apiKey) return { loggedIn: false };
  return { loggedIn: true, gateway: gatewayLabel() };
}));

ipcMain.handle("cizi:getMe", wrap("getMe", async () => {
  const s = requireSession();
  return await api.getMe(s.baseUrl, s.apiKey);
}));

ipcMain.handle("cizi:getUsage", wrap("getUsage", async ({ period }) => {
  const s = requireSession();
  return await api.getUsage(s.baseUrl, s.apiKey, period || "30d");
}));

ipcMain.handle("cizi:getTemplates", wrap("getTemplates", async () => {
  const s = requireSession();
  return await api.getTemplates(s.baseUrl, s.apiKey);
}));

ipcMain.handle("cizi:getClaudeCodeStatus", wrap("getClaudeCodeStatus", async () => detectClaudeCodeCli()));
ipcMain.handle("cizi:installClaudeCode", wrap("installClaudeCode", async () => installClaudeCodeCli()));
ipcMain.handle("cizi:openClaudeCodeCli", wrap("openClaudeCodeCli", async () => openClaudeCodeCli()));
ipcMain.handle("cizi:planClaudeCodeUninstall", wrap("planClaudeCodeUninstall", async () => ({ plan: claudeUninstall.planClaudeCodeUninstall(), existing: claudeUninstall.describeExisting(claudeUninstall.planClaudeCodeUninstall()) })));
ipcMain.handle("cizi:uninstallClaudeCode", wrap("uninstallClaudeCode", async () => claudeUninstall.uninstallClaudeCode({ log })));
ipcMain.handle("cizi:openClaudeCodeSite", wrap("openClaudeCodeSite", async () => {
  await shell.openExternal(CLAUDE_CODE_OFFICIAL_URL);
  return { opened: true, url: CLAUDE_CODE_OFFICIAL_URL };
}));
ipcMain.handle("cizi:getCodexCliStatus", wrap("getCodexCliStatus", async () => codexCli.detect()));
ipcMain.handle("cizi:installCodexCli", wrap("installCodexCli", async () => codexCli.install()));
ipcMain.handle("cizi:openCodexCli", wrap("openCodexCli", async ({ model, useCizi } = {}) => codexCli.open({ model, useCizi })));
ipcMain.handle("cizi:planCodexCliUninstall", wrap("planCodexCliUninstall", async () => {
  const desktop = await codexDesktop.detect();
  return codexCli.planUninstall({ desktopInstalled: desktop.installed });
}));
// `desktopInstalled` is resolved here rather than trusted from the renderer, so
// a stale UI can never authorise deleting data ChatGPT Desktop still needs.
ipcMain.handle("cizi:uninstallCodexCli", wrap("uninstallCodexCli", async ({ removeShared } = {}) => {
  const desktop = await codexDesktop.detect();
  return codexCli.uninstall({ desktopInstalled: desktop.installed, removeShared: removeShared === true });
}));
ipcMain.handle("cizi:openCodexCliSite", wrap("openCodexCliSite", async () => {
  await shell.openExternal(codexCli.officialSiteUrl);
  return { opened: true, url: codexCli.officialSiteUrl };
}));

// Claude: one switch over Claude Code CLI + Claude Desktop.
ipcMain.handle("cizi:getClaudeState", wrap("getClaudeState", async () => claude.getState(api.TOOL_BASE_URL)));
ipcMain.handle("cizi:getClaudeProgress", wrap("getClaudeProgress", async () => claudeProgressState));

ipcMain.handle("cizi:connectClaude", wrap("connectClaude", async ({ model, models } = {}) => {
  const s = requireSession();
  if (!model) throw new Error("Önce bir model seçin.");
  const values = {
    base: api.TOOL_BASE_URL,
    apiKey: s.apiKey,
    model,
    opus: model,
    sonnet: model,
    haiku: model,
    models: Array.isArray(models) && models.length ? models : [model],
  };
  return claude.connect(values);
}));

ipcMain.handle("cizi:disconnectClaude", wrap("disconnectClaude", async () => claude.disconnect(api.TOOL_BASE_URL)));
ipcMain.handle("cizi:installClaudeDesktop", wrap("installClaudeDesktop", async () => claude.installDesktop()));
ipcMain.handle("cizi:launchClaudeDesktop", wrap("launchClaudeDesktop", async () => claude.launchDesktop()));
ipcMain.handle("cizi:repairClaudeDesktop", wrap("repairClaudeDesktop", async () => claude.repairDesktop()));
ipcMain.handle("cizi:stopClaudeDesktop", wrap("stopClaudeDesktop", async () => claude.stopDesktop()));

ipcMain.handle("cizi:getCodexDesktopStatus", wrap("getCodexDesktopStatus", async () => codexDesktop.detect()));
ipcMain.handle("cizi:installCodexDesktop", wrap("installCodexDesktop", async () => codexDesktop.install()));
ipcMain.handle("cizi:openCodexDesktop", wrap("openCodexDesktop", async () => codexDesktop.open()));
ipcMain.handle("cizi:restartCodexDesktop", wrap("restartCodexDesktop", async () => codexDesktop.restart()));
ipcMain.handle("cizi:planCodexDesktopUninstall", wrap("planCodexDesktopUninstall", async () => {
  const cli = await codexCli.detect();
  return codexDesktop.planUninstall({ cliInstalled: cli.installed });
}));
ipcMain.handle("cizi:uninstallCodexDesktop", wrap("uninstallCodexDesktop", async ({ removeShared } = {}) => {
  const cli = await codexCli.detect();
  return codexDesktop.uninstall({ cliInstalled: cli.installed, removeShared: removeShared === true });
}));
ipcMain.handle("cizi:openCodexDesktopStore", wrap("openCodexDesktopStore", async () => {
  await shell.openExternal(codexDesktop.storeUrl);
  return { opened: true, url: codexDesktop.storeUrl };
}));

// Shared state for the single Codex switch: what the one config.toml currently
// says, and which of the two products would be affected by changing it.
ipcMain.handle("cizi:getCodexState", wrap("getCodexState", async () => {
  const [cli, desktop] = await Promise.all([codexCli.detect(), codexDesktop.detect()]);
  const config = codexConfig.readState(api.TOOL_BASE_URL);
  return {
    cli,
    desktop,
    config: { ...config, tokenConfigured: config.tokenConfigured === true },
    sharesConfig: true,
    configPath: codexConfig.configPath(),
  };
}));

// Switching models keeps one provider and changes only `model`. Both products
// read the new value when they next start, so the caller is told to restart.
ipcMain.handle("cizi:setCodexModel", wrap("setCodexModel", async ({ model } = {}) => {
  const state = codexConfig.readState(api.TOOL_BASE_URL);
  if (!state.applied) throw new Error("Model değiştirmeden önce Codex bağlantısını açın.");
  const result = codexConfig.setModel(model);
  const desktop = await codexDesktop.detect();
  log.info("codex", "Codex modeli değiştirildi", { model: result.model, changed: result.changed });
  return { ...result, restartRequired: desktop.installed, desktopInstalled: desktop.installed };
}));

ipcMain.handle("cizi:listTools", wrap("listTools", async () => toolMgr.listToolStatuses(api.TOOL_BASE_URL)));

ipcMain.handle("cizi:applyTool", wrap("applyTool", async ({ toolId, modelSlots }) => {
  const s = requireSession();
  const slots = modelSlots || {};
  const values = {
    base: api.TOOL_BASE_URL,
    apiKey: s.apiKey,
    model: slots.model,
    opus: slots.opus || slots.model,
    sonnet: slots.sonnet || slots.model,
    haiku: slots.haiku || slots.model,
    models: slots.models || (slots.model ? [slots.model] : []),
  };
  if (!values.model) throw new Error("Select a model first.");
  log.info("tools", `Apply ${toolId}`, { model: values.model });
  const res = toolMgr.applyTool(toolId, values);
  log.info("tools", `Applied ${toolId}`, { hasBackup: res?.hasBackup });
  return res;
}));

ipcMain.handle("cizi:revertTool", wrap("revertTool", async ({ toolId }) => {
  log.info("tools", `Revert ${toolId}`);
  const res = toolMgr.revertTool(toolId, api.TOOL_BASE_URL);
  // A surgical revert reports restored=false by design: it undoes only its own
  // keys instead of putting a whole snapshot back over the file.
  log.info("tools", `Reverted ${toolId}`, {
    restored: res?.restored,
    surgical: res?.surgical === true,
    stillApplied: res?.applied === true,
    cleanup: res?.cleanup?.reason || (res?.cleanup?.changed ? "changed" : null),
  });
  return res;
}));

ipcMain.handle("cizi:openExternal", wrap("openExternal", async ({ url }) => {
  await shell.openExternal(assertHttpsUrl(url, "External URL"));
  return { opened: true };
}));

ipcMain.handle("cizi:getLogs", wrap("getLogs", async ({ limit } = {}) => ({ entries: log.recent(limit || 200), filePath: log.filePath() })));

ipcMain.handle("cizi:clearLogs", wrap("clearLogs", async () => {
  log.clear();
  log.info("app", "Activity cleared by user");
  return { cleared: true };
}));

ipcMain.handle("cizi:openLogFile", wrap("openLogFile", async () => {
  await shell.showItemInFolder(log.filePath());
  return { opened: true, path: log.filePath() };
}));

ipcMain.handle("cizi:clientLog", wrap("clientLog", async ({ level, message, meta } = {}) => {
  log.log(level || "info", "ui", message || "", meta);
  return { logged: true };
}));

ipcMain.handle("cizi:checkForUpdates", wrap("checkForUpdates", async () => checkForUpdates()));
ipcMain.handle("cizi:getUpdateState", wrap("getUpdateState", async () => updateState));
ipcMain.handle("cizi:installUpdate", wrap("installUpdate", async () => {
  if (updateState.status !== "ready") throw new Error("No downloaded update is ready.");
  const installScriptUrl = assertHttpsUrl(updateState.manifest?.installScriptUrl || `${updateFeedBase()}/install.ps1`, "Installer URL");
  const releaseUrl = assertHttpsUrl(updateState.manifest?.url, "Release URL");
  const expectedHash = String(updateState.manifest?.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Release manifest hash is missing or invalid.");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cizicode-update-"));
  const scriptPath = path.join(tempDir, "install.ps1");
  const zipPath = path.join(tempDir, "release.zip");
  const launcherPath = path.join(tempDir, "launch-install.ps1");

  setUpdateState({ status: "downloading", message: `Downloading version ${updateState.version}...` });
  await downloadFile(releaseUrl, zipPath);
  const actualHash = sha256File(zipPath);
  if (actualHash !== expectedHash) {
    throw new Error("Downloaded update could not be verified.");
  }
  await downloadFile(installScriptUrl, scriptPath);

  setUpdateState({ status: "installing", message: "Installing update..." });
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    `$installScript = ${JSON.stringify(scriptPath)}`,
    `$baseUrl = ${JSON.stringify(updateFeedBase())}`,
    `$releaseUrl = ${JSON.stringify(releaseUrl)}`,
    `$expectedSha256 = ${JSON.stringify(expectedHash)}`,
    `$localZipPath = ${JSON.stringify(zipPath)}`,
    "$argsList = @(",
    "  '-NoProfile',",
    "  '-ExecutionPolicy',",
    "  'Bypass',",
    "  '-File',",
    "  $installScript,",
    "  '-BaseUrl',",
    "  $baseUrl,",
    "  '-ReleaseUrl',",
    "  $releaseUrl,",
    "  '-ExpectedSha256',",
    "  $expectedSha256,",
    "  '-LocalZipPath',",
    "  $localZipPath",
    ")",
    "Start-Process -FilePath 'powershell.exe' -WorkingDirectory $env:TEMP -WindowStyle Hidden -ArgumentList $argsList",
  ].join("\r\n");
  fs.writeFileSync(launcherPath, launcher, "utf8");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
  ], {
    cwd: os.tmpdir(),
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Update launcher exited with code ${code}`));
    });
  });

  setTimeout(() => app.quit(), 800);
  return { installing: true };
}));
