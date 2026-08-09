const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const OFFICIAL_SITE_URL = "https://developers.openai.com/codex/cli/";
const WINDOWS_INSTALLER_URL = "https://chatgpt.com/codex/install.ps1";
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeOutput(value) {
  return String(value || "")
    .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "sk-••••")
    .trim()
    .slice(0, 220);
}

function quoteCmdArgument(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

async function officialPackageSize(assetName) {
  const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Official release metadata request failed (${response.status}).`);
  const release = await response.json();
  const asset = Array.isArray(release?.assets) ? release.assets.find((item) => item?.name === assetName) : null;
  const size = Number(asset?.size);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function addUnique(list, value) {
  const command = String(value || "").trim();
  if (!command) return;
  const key = process.platform === "win32" ? command.toLowerCase() : command;
  if (!list.some((entry) => entry.key === key)) list.push({ key, command });
}

function standalonePaths() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programDir = path.join(localAppData, "Programs", "OpenAI", "Codex");
  return {
    home,
    appData,
    programDir,
    programBin: path.join(programDir, "bin", "codex.exe"),
    standaloneDir: path.join(home, ".codex", "packages", "standalone"),
    profile: path.join(home, ".codex", "cizicode.config.toml"),
  };
}

async function runVersion(command) {
  const options = { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const quoted = `"${String(command).replace(/"/g, '""')}" --version`;
    return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", quoted], options);
  }
  return execFileAsync(command, ["--version"], { ...options, shell: false });
}

function versionText(result) {
  const line = String(result?.stdout || result?.stderr || "").trim().split(/\r?\n/)[0];
  return line ? line.trim().slice(0, 120) : null;
}

function classifyInstallation(command, paths) {
  const candidate = path.resolve(String(command || ""));
  if (candidate.toLowerCase() === paths.programBin.toLowerCase()) return "standalone";
  if (candidate.toLowerCase().startsWith(paths.standaloneDir.toLowerCase())) return "standalone";
  if (/\\npm\\codex\.(cmd|exe)$/i.test(candidate)) return "npm";
  return "other";
}

async function detectCodexCli() {
  const paths = standalonePaths();
  const candidates = [];
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["codex"], {
      timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    String(stdout || "").split(/\r?\n/).forEach((item) => addUnique(candidates, item));
  } catch {
    // PATH may contain a stale shim; known locations are also checked.
  }

  if (process.platform === "win32") {
    [
      paths.programBin,
      path.join(paths.standaloneDir, "current", "codex.exe"),
      path.join(paths.appData, "npm", "codex.cmd"),
      path.join(paths.appData, "npm", "codex.exe"),
    ].forEach((item) => addUnique(candidates, item));
  } else {
    [path.join(paths.home, ".local", "bin", "codex"), "/usr/local/bin/codex", "/usr/bin/codex"].forEach((item) => addUnique(candidates, item));
  }

  for (const candidate of candidates) {
    if (candidate.command !== "codex" && !fs.existsSync(candidate.command)) continue;
    try {
      const version = versionText(await runVersion(candidate.command));
      if (version) {
        return {
          installed: true,
          command: candidate.command,
          version,
          installation: classifyInstallation(candidate.command, paths),
          profilePath: paths.profile,
        };
      }
    } catch {
      // Continue past broken PATH entries and uninstalled shims.
    }
  }
  return { installed: false, command: null, version: null, installation: null, profilePath: paths.profile };
}

function removePath(target) {
  try {
    if (!fs.existsSync(target)) return { path: target, removed: false, reason: "not-found" };
    fs.rmSync(target, { recursive: true, force: true });
    return { path: target, removed: true };
  } catch (error) {
    return { path: target, removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

function removeUserPathEntry(target) {
  if (process.platform !== "win32") return { removed: false, reason: "not-windows" };
  try {
    const current = String(require("child_process").execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"], { windowsHide: true, encoding: "utf8" }) || "").trim();
    const parts = current.split(";").filter(Boolean);
    const next = parts.filter((part) => part.replace(/[\\/]+$/, "").toLowerCase() !== target.replace(/[\\/]+$/, "").toLowerCase());
    if (next.length === parts.length) return { removed: false, reason: "not-found" };
    const output = next.join(";");
    execFileSyncSafe("powershell.exe", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', '${output.replace(/'/g, "''")}', 'User')`]);
    return { removed: true };
  } catch (error) {
    return { removed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

function execFileSyncSafe(command, args) {
  const { execFileSync } = require("child_process");
  execFileSync(command, args, { windowsHide: true, stdio: "ignore" });
}

async function closeStandaloneProcesses(programBin, log) {
  if (process.platform !== "win32") return [];
  const escaped = programBin.replace(/'/g, "''");
  const script = `$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' -or (($_.Name -in @('cmd.exe','powershell.exe','pwsh.exe')) -and $_.CommandLine -like '*${escaped}*') }; $p | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 });
    const parsed = JSON.parse(String(stdout || "null"));
    const processes = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter((item) => Number(item?.ProcessId) > 0);
    for (const item of processes) {
      try { await execFileAsync("taskkill.exe", ["/pid", String(item.ProcessId), "/t", "/f"], { timeout: 8000, windowsHide: true }); } catch {}
    }
    if (processes.length) log?.info("codex-cli", "Standalone Codex CLI processes closed", { count: processes.length });
    return processes.map((item) => ({ pid: Number(item.ProcessId), name: item.Name }));
  } catch (error) {
    log?.warn("codex-cli", "Could not enumerate standalone Codex CLI processes", { error: sanitizeOutput(error?.message) });
    return [];
  }
}

function removeLegacyCiziBlock() {
  const config = path.join(standalonePaths().home, ".codex", "config.toml");
  try {
    if (!fs.existsSync(config)) return { changed: false, reason: "not-found" };
    const original = fs.readFileSync(config, "utf8");
    let next = original.replace(/^\s*model_provider\s*=\s*["']cizicode["']\s*\r?\n/gmi, "");
    next = next.replace(/^\[model_providers\.cizicode\][\s\S]*?(?=^\[|(?![\s\S]))/gmi, "");
    if (next === original) return { changed: false, reason: "not-present" };
    fs.writeFileSync(config, next.replace(/\n{3,}/g, "\n\n"), "utf8");
    return { changed: true, path: config };
  } catch (error) {
    return { changed: false, error: String(error?.message || error).slice(0, 300) };
  }
}

async function uninstallCodexCli({ log } = {}) {
  const paths = standalonePaths();
  const before = await detectCodexCli();
  const closedProcesses = await closeStandaloneProcesses(paths.programBin, log);
  const results = [removePath(paths.standaloneDir), removePath(paths.programDir), removePath(paths.profile)];
  const pathResult = removeUserPathEntry(path.dirname(paths.programBin));
  const legacyConfig = removeLegacyCiziBlock();
  let npm = { removed: false, reason: "not-installed" };
  try {
    await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", ["uninstall", "-g", "@openai/codex"], { timeout: 30000, windowsHide: true, maxBuffer: 256 * 1024 });
    npm = { removed: true };
  } catch (error) {
    npm = { removed: false, error: sanitizeOutput(error?.message) };
  }
  const after = await detectCodexCli();
  const failed = results.filter((item) => item.error);
  const stillExists = [paths.standaloneDir, paths.programDir, paths.profile].filter((item) => fs.existsSync(item));
  log?.info("codex-cli", "Standalone Codex CLI uninstall finished", { removed: results.filter((item) => item.removed).length, remaining: stillExists.length });
  return {
    ok: failed.length === 0 && stillExists.length === 0,
    before,
    after,
    removed: results.filter((item) => item.removed).map((item) => item.path),
    failed,
    stillExists,
    closedProcesses,
    path: pathResult,
    profile: results[2],
    legacyConfig,
    npm,
    protected: [path.join(paths.home, ".codex"), path.join(process.env.LOCALAPPDATA || path.join(paths.home, "AppData", "Local"), "OpenAI", "Codex")],
  };
}

function createCodexCliService({ userDataPath, log, onInstallState, detect = detectCodexCli, spawnProcess = spawn }) {
  let installPromise = null;
  let lastInstallerOutput = "";
  // `null` means that the installer is alive but does not expose a measurable
  // percentage.  Keeping that distinct from zero prevents a stalled-looking
  // 0% bar while the official installer is resolving or downloading a release.
  let installState = { status: "idle", phase: "idle", percent: null, message: "", operations: [] };
  const emit = (next) => {
    installState = { ...installState, ...next };
    onInstallState?.(installState);
  };
  const operation = (id, next) => {
    const current = installState.operations.find((item) => item.id === id) || { id, status: "pending", percent: null, detail: "" };
    const operations = installState.operations.some((item) => item.id === id)
      ? installState.operations.map((item) => item.id === id ? { ...item, ...next } : item)
      : [...installState.operations, { ...current, ...next }];
    emit({ operations });
  };
  const lockPath = () => path.join(userDataPath, "codex-cli-install.lock");
  const isProcessAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but cannot be signalled by this process.
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
      const recordedPid = Number.parseInt(fs.readFileSync(lockPath(), "utf8").trim(), 10);
      if (!isProcessAlive(recordedPid)) {
        fs.rmSync(lockPath(), { force: true });
        log?.warn("codex-cli", "Recovered stale Codex CLI installer lock", { previousPid: Number.isInteger(recordedPid) ? recordedPid : null });
        create();
      } else {
      const error = new Error("Another Codex CLI installation is already running.");
      error.userMessage = error.message;
      throw error;
      }
    } finally { if (fd != null) fs.closeSync(fd); }
    return () => { try { fs.rmSync(lockPath(), { force: true }); } catch {} };
  };
  const failureMessage = (error) => {
    const text = String(error?.message || error || "");
    const installerDetail = String(error?.installerDetail || lastInstallerOutput || "").trim();
    if (/timed out/i.test(text)) return "The official Codex CLI installer timed out. Check your connection and try again.";
    if (/exited with code/i.test(text)) {
      const suffix = installerDetail ? ` Last installer step: ${installerDetail}` : "";
      return `The official Codex CLI installer failed.${suffix}`;
    }
    if (/another codex cli installation is already running/i.test(text)) return "Another Codex CLI installation is already running. Wait for it to finish before trying again.";
    if (/not found|could not be detected/i.test(text)) return "The installer finished, but the codex command was not found yet. Restart Cizi Code and check again.";
    return "Codex CLI installation failed. See the installation activity for details.";
  };
  const download = async (url, target) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Official installer download failed (${response.status}).`);
    const total = Number(response.headers.get("content-length")) || null;
    const chunks = []; let received = 0; let lastPercent = -1;
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk); chunks.push(buffer); received += buffer.length;
      const percent = total ? Math.min(100, Math.round(received / total * 100)) : null;
      if (percent !== lastPercent) {
        lastPercent = percent;
        operation("download", { percent, detail: total ? `${formatBytes(received)} / ${formatBytes(total)}` : `${formatBytes(received)} downloaded` });
        emit({ percent });
      }
    }
    fs.writeFileSync(target, Buffer.concat(chunks));
    return received;
  };
  const waitFor = (child) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {}); } catch {} reject(new Error("The official Codex CLI installer timed out.")); }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Codex CLI installer exited with code ${code}.`)); });
  });
  const monitorInstaller = (startedAt) => {
    let lastDetail = "";
    let packageTotalBytes = null;
    let packageSizeLookupStarted = false;
    const loadPackageTotal = (assetName) => {
      if (packageSizeLookupStarted) return;
      packageSizeLookupStarted = true;
      void officialPackageSize(assetName)
        .then((size) => {
          packageTotalBytes = size;
          if (size) log?.debug("codex-cli", "Official Codex package size resolved", { assetName, totalBytes: size });
          update();
        })
        .catch((error) => {
          // Size metadata is optional; installation progress stays indeterminate if unavailable.
          log?.warn("codex-cli", "Official Codex package size could not be resolved", { assetName, error: sanitizeOutput(error?.message) });
        });
    };
    const update = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const paths = standalonePaths();
      let detail = `The official installer is still running (${elapsed}s elapsed).`;
      let percent = null;
      try {
        const currentBinary = path.join(paths.standaloneDir, "current", "bin", "codex.exe");
        if (fs.existsSync(currentBinary)) {
          detail = `Codex files are in place; verifying the command and finalizing (${elapsed}s elapsed).`;
          percent = 100;
        } else {
          const recent = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-install-"))
            .map((entry) => path.join(os.tmpdir(), entry.name))
            .map((directory) => ({ directory, stat: fs.statSync(directory) }))
            .filter((entry) => entry.stat.birthtimeMs >= startedAt - 5000)
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
          if (recent) {
            const archive = fs.readdirSync(recent.directory)
              .map((name) => path.join(recent.directory, name))
              .filter((file) => /codex-package.*\.tar\.gz$/i.test(file) && fs.existsSync(file))
              .map((file) => ({ file, stat: fs.statSync(file) }))
              .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
            if (archive) {
              loadPackageTotal(path.basename(archive.file));
              const packagePercent = packageTotalBytes
                ? Math.min(100, Math.round((archive.stat.size / packageTotalBytes) * 100))
                : null;
              percent = packagePercent;
              detail = packageTotalBytes
                ? `Downloading official Codex package: ${formatBytes(archive.stat.size)} / ${formatBytes(packageTotalBytes)} (${packagePercent}%, ${elapsed}s elapsed).`
                : `Downloading official Codex package: ${formatBytes(archive.stat.size)} received (${elapsed}s elapsed).`;
            }
            else detail = `Resolving the official Codex release and download details (${elapsed}s elapsed).`;
          }
        }
      } catch {
        // Monitoring only enriches the UI; the official installer remains authoritative.
      }
      if (detail !== lastDetail) {
        lastDetail = detail;
        operation("install", { detail, ...(percent == null ? { percent: null } : { percent }) });
      }
      emit({ percent, message: detail });
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  };
  const install = async () => {
    if (installPromise) return installPromise;
    installPromise = (async () => {
      if (process.platform !== "win32") throw new Error("Automatic Codex CLI installation is currently available on Windows only.");
      lastInstallerOutput = "";
      const release = acquireLock();
      try {
        emit({ status: "checking", phase: "detecting", percent: 5, message: "Checking for Codex CLI...", operations: [] });
        operation("detect", { label: "Check for Codex CLI", status: "running", percent: 0, detail: "Searching PATH, standalone, and npm locations..." });
        const existing = await detect();
        if (existing.installed) { operation("detect", { status: "done", percent: 100, detail: existing.version || existing.command }); emit({ status: "installed", phase: "complete", percent: 100, message: "Codex CLI is already installed.", ...existing }); return existing; }
        operation("detect", { status: "done", percent: 100, detail: "Codex CLI was not found." });
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cizi-codex-install-"));
        const script = path.join(tempDir, "install.ps1");
        operation("download", { label: "Download official installer", status: "running", percent: null, detail: "Connecting to the official Codex installer..." });
        emit({ status: "downloading", phase: "download", percent: null, message: "Downloading the official Codex installer..." });
        const bytes = await download(WINDOWS_INSTALLER_URL, script);
        operation("download", { status: "done", percent: 100, detail: `${formatBytes(bytes)} downloaded.` });
        operation("install", { label: "Run official installer", status: "running", percent: null, detail: "The official installer is running..." });
        emit({ status: "installing", phase: "install", percent: null, message: "Running the official Codex installer..." });
        const startedAt = Date.now();
        // The official installer supports this flag.  On this machine its
        // releases.openai.com asset repeatedly reached the 300-second timeout,
        // while the official GitHub Releases fallback is immediately reachable.
        const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
          cwd: os.homedir(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: false,
          env: { ...process.env, CODEX_INSTALLER_USE_RELEASES_OPENAI_COM: "0" },
        });
        log?.info("codex-cli", "Official installer started with the GitHub Releases fallback", { releaseSource: "github" });
        const onOutput = (chunk) => {
          lastInstallerOutput = sanitizeOutput(chunk) || lastInstallerOutput;
          operation("install", { detail: lastInstallerOutput || "The official installer is running..." });
        };
        child.stdout?.on("data", onOutput); child.stderr?.on("data", onOutput);
        const stopMonitor = monitorInstaller(startedAt);
        try {
          await waitFor(child);
        } catch (error) {
          error.installerDetail = lastInstallerOutput;
          throw error;
        } finally { stopMonitor(); }
        operation("install", { status: "done", percent: 100, detail: "Official installer finished." });
        operation("verify", { label: "Verify Codex CLI", status: "running", percent: null, detail: "Running codex --version..." });
        emit({ status: "verifying", phase: "verify", percent: null, message: "Verifying the Codex CLI installation..." });
        const installed = await detect();
        if (!installed.installed) throw new Error("Installer finished, but Codex CLI could not be detected yet.");
        operation("verify", { status: "done", percent: 100, detail: installed.version || installed.command });
        emit({ status: "installed", phase: "complete", percent: 100, message: "Codex CLI is installed.", ...installed });
        return installed;
      } finally { release(); }
    })().catch((error) => {
      const message = failureMessage(error); const active = [...installState.operations].reverse().find((item) => item.status === "running");
      if (active) operation(active.id, { status: "error", detail: message });
      emit({ status: "error", phase: "error", message });
      throw Object.assign(error, { userMessage: message });
    }).finally(() => { installPromise = null; });
    return installPromise;
  };
  const open = async ({ model, useCiziProfile = false } = {}) => {
    const status = await detect();
    if (!status.installed || !status.command) throw new Error("Codex CLI is not installed on this computer.");
    const useProfile = useCiziProfile === true;
    const selectedModel = useProfile ? String(model || "").trim() : "";
    if (selectedModel && !/^[A-Za-z0-9._:-]+$/.test(selectedModel)) throw new Error("The selected Codex model is invalid.");
    const command = String(status.command);
    const args = useProfile ? ["--profile", "cizicode"] : [];
    if (selectedModel) args.push("-m", selectedModel);
    // Codex is a console application.  Electron has no interactive console, so
    // ask Windows to create one while targeting the detected .exe itself.
    const startCommand = `start "" ${quoteCmdArgument(command)} ${args.map(quoteCmdArgument).join(" ")}`;
    const child = spawnProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", startCommand], {
      cwd: os.homedir(),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      // cmd.exe receives this command verbatim; otherwise Node adds backslashes
      // before quotes and Windows treats the executable path as invalid.
      windowsVerbatimArguments: true,
    });
    child.unref();
    log?.info("codex-cli", "Codex CLI opened", { command: status.command, profile: useProfile ? "cizicode" : null, model: selectedModel || null, launch: "direct-exe-in-new-console" });
    return { opened: true, command: status.command, profile: useProfile ? "cizicode" : null, model: selectedModel || null };
  };
  return { detect: detectCodexCli, install, open, uninstall: (options) => uninstallCodexCli({ ...options, log }), getInstallState: () => installState, officialSiteUrl: OFFICIAL_SITE_URL };
}

module.exports = { createCodexCliService, detectCodexCli, uninstallCodexCli, standalonePaths, OFFICIAL_SITE_URL };
