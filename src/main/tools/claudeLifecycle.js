const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { windowsPowerShellEnvironment } = require("../windowsPowerShell");
const {
  CLAUDE_DESKTOP_MSIX_URL,
  installerFailure,
  installerStageFailure,
  claudeCodeWingetPrerequisiteScript,
  claudeCodeWingetInstallScript,
  cliWingetPrerequisiteFailure,
  claudeDesktopInstallScript,
  claudeDesktopInstallFailure,
} = require("./claudeInstallerContract");
// Claude Desktop's own download/verify/remove layer, ported from ciziClaude4.
const installer = require("./claudeDesktopInstaller");
const { assertArtifactResponse } = installer;

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const CLAUDE_PACKAGE_FAMILY = "Claude_pzs8sxrjxfjjc";
const CLAUDE_NEW_CHAT_URI = "claude://claude.ai/new";

function powerShellArguments(script) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

async function runPowerShell(script, { env = {}, timeout = 120000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const result = await execFileAsync(WINDOWS_POWERSHELL, powerShellArguments(script), {
    windowsHide: true,
    timeout,
    maxBuffer,
    env: windowsPowerShellEnvironment(process.env, env),
  });
  return String(result.stdout || "").trim();
}

async function fileSize(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : 0;
  } catch {
    // The download file does not exist yet, or curl has not opened it.
    return 0;
  }
}

function formatByteCount(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.floor(value)} ${units[unit]}`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

// The Claude Desktop package size is resolved by claudeDesktopInstaller's own
// range request, which also gives the streaming downloader its total. The
// PowerShell HEAD/range probe that used to live here is gone with the curl
// downloader it fed.

function createDownloadProgressReporter(onProgress, label, totalBytes) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  const total = Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : null;
  let lastPercent = null;
  let lastBytes = -1;
  let lastAt = 0;

  return (downloadedBytes, { completed = false, force = false } = {}) => {
    const downloaded = Number.isSafeInteger(downloadedBytes) && downloadedBytes > 0 ? downloadedBytes : 0;
    const now = Date.now();
    let percent = null;
    if (completed) {
      percent = 100;
    } else if (downloaded === 0) {
      // Even if a server omits Content-Length, make the start of the download
      // explicit instead of leaving the user with an indeterminate spinner.
      percent = 0;
    } else if (total) {
      // Do not claim 100% before the download command and integrity checks
      // have completed. This also avoids a stuck-looking UI at a false 100%.
      percent = Math.min(99, Math.max(0, Math.floor((downloaded / total) * 100)));
    }

    if (!force) {
      if (percent !== null && percent === lastPercent) return;
      if (percent === null && downloaded === lastBytes) return;
      if (percent === null && now - lastAt < 1000) return;
    }

    lastPercent = percent;
    lastBytes = downloaded;
    lastAt = now;

    const message = percent === null
      ? (downloaded > 0 ? `${label} (${formatByteCount(downloaded)} indirildi)` : `${label}...`)
      : `${label} %${percent}${total ? ` (${formatByteCount(downloaded)} / ${formatByteCount(total)})` : ""}`;
    const details = { downloadedBytes: downloaded };
    if (percent !== null) details.percent = percent;
    if (total) details.totalBytes = total;
    report("downloading", message, details);
  };
}

// WinGet does not expose a stable machine-readable percentage while installing
// portable packages. The child installer writes a local heartbeat file at a
// fixed cadence; this runner turns that into visible activity while retaining
// a bounded timeout and without collecting package-manager output (which can
// contain user-specific local paths).
function runPowerShellWithHeartbeat(script, options = {}, {
  heartbeatPath,
  onHeartbeat = () => {},
  pollIntervalMs = 500,
  timeoutCode = "CLAUDE_CODE_INSTALL_TIMEOUT",
  timeoutMessage = "Claude Code installation timed out. Check your npm/network setup and try again.",
  failureCode = "CLAUDE_CODE_INSTALL_COMMAND_FAILED",
  failureMessage = "Claude Code installation stopped before it finished. Check npm and try again.",
} = {}) {
  const { env = {}, timeout = 20 * 60 * 1000 } = options;
  const interval = Math.min(1000, Math.max(150, Number(pollIntervalMs) || 500));
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let polling = false;
    let timedOut = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let lastBytes = -1;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const inspectHeartbeat = async () => {
      if (settled || polling) return;
      polling = true;
      try {
        const bytes = await fileSize(heartbeatPath);
        if (bytes !== lastBytes) {
          lastBytes = bytes;
          try { onHeartbeat({ ticks: bytes }); } catch { /* UI progress cannot stop installation. */ }
        }
      } finally {
        polling = false;
      }
    };
    try {
      child = spawn(WINDOWS_POWERSHELL, powerShellArguments(script), {
        windowsHide: true,
        env: windowsPowerShellEnvironment(process.env, env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(error);
      return;
    }
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.on("error", (error) => finish(error));
    child.on("close", async (code) => {
      await inspectHeartbeat();
      if (timedOut) {
        finish(installerFailure(
          timeoutCode,
          timeoutMessage,
          { stage: "installing", processExitCode: Number.isInteger(code) ? code : null },
        ));
      } else if (code === 0) {
        finish(null, "");
      } else {
        finish(installerFailure(
          failureCode,
          failureMessage,
          { stage: "installing", processExitCode: Number.isInteger(code) ? code : null },
        ));
      }
    });
    pollTimer = setInterval(() => { void inspectHeartbeat(); }, interval);
    void inspectHeartbeat();
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* close handler settles a raced process. */ }
    }, Math.max(1, Number(timeout) || 20 * 60 * 1000));
  });
}

function normalizedPath(filePath) {
  if (!filePath) return null;
  try {
    return path.resolve(String(filePath)).replace(/\//g, "\\").toLowerCase();
  } catch {
    return null;
  }
}

function pathsEqual(left, right) {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  return !!a && !!b && a === b;
}

function isWithinPath(filePath, rootPath) {
  const file = normalizedPath(filePath);
  const root = normalizedPath(rootPath);
  return !!file && !!root && (file === root || file.startsWith(`${root}\\`));
}

function cliNpmPackagePath() {
  return path.join(
    process.env.APPDATA || "",
    "npm",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "package.json"
  );
}

function wingetClaudeCodePackageRoot() {
  return path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
}

function wingetClaudeCodeCandidates() {
  const root = wingetClaudeCodePackageRoot();
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Anthropic\.ClaudeCode_/i.test(entry.name)) continue;
      candidates.push(path.join(root, entry.name, "claude.exe"));
    }
  } catch {
    // WinGet is not installed, or Claude Code has never been installed with it.
  }
  return candidates;
}

function isOfficialWingetClaudeCodePath(candidate) {
  if (!candidate) return false;
  let resolved;
  try { resolved = fs.realpathSync.native(candidate); } catch { return false; }
  const root = wingetClaudeCodePackageRoot();
  if (!isWithinPath(resolved, root) || path.basename(resolved).toLowerCase() !== "claude.exe") return false;
  const relative = path.relative(root, resolved).split(path.sep).filter(Boolean);
  return relative.length >= 2 && /^Anthropic\.ClaudeCode_/i.test(relative[0]);
}

function hasOfficialNpmClaudeCode() {
  try {
    const pkg = JSON.parse(fs.readFileSync(cliNpmPackagePath(), "utf8"));
    return pkg?.name === "@anthropic-ai/claude-code";
  } catch {
    return false;
  }
}

function knownClaudeCliPaths() {
  const home = os.homedir();
  const npmBin = path.join(process.env.APPDATA || "", "npm");
  return [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "claude.exe"),
    ...wingetClaudeCodeCandidates(),
    path.join(npmBin, "claude.cmd"),
    path.join(npmBin, "claude.exe"),
    // Kept for installations produced by an older official installer.
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Claude", "claude.exe"),
  ];
}

function isTrustedClaudeCliPath(candidate) {
  if (!candidate || /\\Claude-3p\\claude-code\\/i.test(candidate)) return false;
  if (isOfficialWingetClaudeCodePath(candidate)) return true;
  const known = knownClaudeCliPaths();
  const npmBin = path.join(process.env.APPDATA || "", "npm");
  if (pathsEqual(candidate, path.join(os.homedir(), ".local", "bin", "claude.exe"))) return true;
  if (pathsEqual(candidate, path.join(process.env.LOCALAPPDATA || "", "Programs", "Claude", "claude.exe"))) return true;
  // A global npm command is Claude Code only when its actual package is the
  // official @anthropic-ai/claude-code package. Do not trust an arbitrary
  // executable named "claude" found on PATH.
  if (known.some((item) => pathsEqual(candidate, item)) && isWithinPath(candidate, npmBin)) {
    return hasOfficialNpmClaudeCode();
  }
  return false;
}

function uniqueExisting(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const normalized = normalizedPath(candidate);
    if (!normalized || seen.has(normalized) || !fs.existsSync(candidate)) return false;
    if (!isTrustedClaudeCliPath(candidate)) return false;
    seen.add(normalized);
    return true;
  });
}

async function detectClaudeCli() {
  const candidates = knownClaudeCliPaths();
  try {
    const env = {
      ...process.env,
      PATH: [path.join(os.homedir(), ".local", "bin"), path.join(process.env.APPDATA || "", "npm"), process.env.PATH || ""].join(path.delimiter),
    };
    const result = await execFileAsync("where.exe", ["claude"], { windowsHide: true, timeout: 5000, env });
    // where.exe is useful for PATH changes made after Cizi Code launched, but
    // its result is still checked against the official locations above.
    candidates.push(...String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()));
  } catch {
    // Known native/npm paths above are sufficient when where.exe cannot resolve PATH.
  }
  const binaries = uniqueExisting(candidates);
  return {
    installed: binaries.length > 0,
    binaries,
    version: null,
  };
}

async function detectClaudeDesktop() {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-AppxPackage -Name Claude | Where-Object { $_.PackageFamilyName -eq '${CLAUDE_PACKAGE_FAMILY}' -and $_.Status -eq 'Ok' } | Sort-Object Version -Descending | Select-Object -First 1`,
    "if($p){[pscustomobject]@{InstallKind='msix';PackageFullName=$p.PackageFullName;PackageFamilyName=$p.PackageFamilyName;Publisher=$p.Publisher;Version=$p.Version.ToString();InstallLocation=$p.InstallLocation}|ConvertTo-Json -Compress;exit 0}",
    "$expected=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AnthropicClaude')).TrimEnd('\\')",
    "$u=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'Claude' -and $_.Publisher -eq 'Anthropic PBC'} | Select-Object -First 1",
    "if($u){$root=[IO.Path]::GetFullPath([string]$u.InstallLocation).TrimEnd('\\');if([string]::Equals($root,$expected,[StringComparison]::OrdinalIgnoreCase)){$app=Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^app-\\d+(?:\\.\\d+){2,3}$'} | Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1;if($app){$exe=Join-Path $app.FullName 'claude.exe';$asar=Join-Path $app.FullName 'resources\\app.asar';$update=Join-Path $root 'Update.exe';if((Test-Path -LiteralPath $exe -PathType Leaf)-and(Test-Path -LiteralPath $asar -PathType Leaf)-and(Test-Path -LiteralPath $update -PathType Leaf)){[pscustomobject]@{InstallKind='squirrel';PackageFullName=('AnthropicClaude_'+$u.DisplayVersion);PackageFamilyName='AnthropicClaude';Publisher=$u.Publisher;Version=$u.DisplayVersion;InstallLocation=$app.FullName;InstallRoot=$root;Executable=$exe;Asar=$asar;UninstallString=$u.UninstallString}|ConvertTo-Json -Compress}}}}",
  ].join(";");
  try {
    const output = await runPowerShell(script, { timeout: 20000 });
    if (!output) return { installed: false };
    const pkg = JSON.parse(output);
    const appDir = pkg.InstallKind === "squirrel" ? pkg.InstallLocation : path.join(pkg.InstallLocation, "app");
    const executable = pkg.Executable || path.join(appDir, "claude.exe");
    const asar = pkg.Asar || path.join(appDir, "resources", "app.asar");
    if (!fs.existsSync(executable) || !fs.existsSync(asar)) return { installed: false };
    return { installed: true, ...pkg, appDir, executable, asar };
  } catch (error) {
    return { installed: false, detectionError: error.message };
  }
}

function isManagedDesktopExecutable(executable) {
  const managedRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "CiziCodeData",
    "ClaudeDesktop",
    "versions"
  );
  const normalized = normalizedPath(executable);
  if (!normalized || !isWithinPath(executable, managedRoot)) return false;
  return /\\windowsapps\\claude_[^\\]*_pzs8sxrjxfjjc\\app\\claude\.exe$/i.test(normalized);
}

function isOfficialDesktopExecutable(executable, desktopInfo) {
  const normalized = normalizedPath(executable);
  if (!normalized) return false;
  if (desktopInfo?.executable && pathsEqual(executable, desktopInfo.executable)) return true;
  const squirrelRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "AnthropicClaude",
  );
  if (isWithinPath(executable, squirrelRoot)
      && /\\anthropicclaude\\app-\d+(?:\.\d+){2,3}\\claude\.exe$/i.test(normalized)) return true;
  return /\\windowsapps\\claude_[^\\]*_pzs8sxrjxfjjc\\app\\claude\.exe$/i.test(normalized);
}

function isClaudeCodeNodeCommand(commandLine) {
  const command = String(commandLine || "").replace(/\//g, "\\").toLowerCase();
  // npm's claude.cmd launches node.exe. The package path is the only reliable
  // discriminator; process name alone must never match arbitrary Node work.
  return /\\@anthropic-ai\\claude-code(?:\\|\")/.test(command);
}

function isOfficialClaudeCliExecutable(executable, cliInfo) {
  if (!executable) return false;
  const explicitBinaries = Array.isArray(cliInfo?.binaries) ? cliInfo.binaries : [];
  if (explicitBinaries.some((candidate) => pathsEqual(candidate, executable))) return true;
  if (pathsEqual(executable, path.join(os.homedir(), ".local", "bin", "claude.exe"))) return true;
  if (isOfficialWingetClaudeCodePath(executable)) return true;
  // The native installer may keep versioned binaries under this directory
  // while the .local\\bin launcher remains the command exposed on PATH.
  const versionedNativeRoot = path.join(os.homedir(), ".local", "share", "claude");
  return isWithinPath(executable, versionedNativeRoot)
    && /\\claude\.exe$/i.test(normalizedPath(executable) || "");
}

async function listClaudeProcesses(kind, installInfo = null, { runPowerShellFn = runPowerShell } = {}) {
  if (kind !== "claude-desktop" && kind !== "claude-code") {
    throw new Error(`Unsupported Claude process type: ${kind}`);
  }

  // tasklist.exe reports only image names. In particular, it cannot tell a
  // Claude Code npm process from an unrelated node.exe process. Query WMI
  // through System.Management directly, avoiding PowerShell's intermittently
  // unavailable CimCmdlets module, for an immutable identity (PID + executable
  // path + creation time). Termination re-verifies the same identity.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$searcher=New-Object System.Management.ManagementObjectSearcher(\"SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE Name='claude.exe' OR Name='node.exe'\")",
    "$rows=@($searcher.Get()|ForEach-Object{",
    "$path=[string]$_.ExecutablePath;if([string]::IsNullOrWhiteSpace($path)){try{$path=[string](Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop).Path}catch{}}",
    "$created=$null;if(-not[string]::IsNullOrWhiteSpace([string]$_.CreationDate)){try{$created=[System.Management.ManagementDateTimeConverter]::ToDateTime([string]$_.CreationDate).ToUniversalTime().ToString('o')}catch{}}",
    "[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=[string]$_.Name;path=$path;commandLine=[string]$_.CommandLine;creationDate=$created}",
    "})",
    "@($rows)|ConvertTo-Json -Compress -Depth 3",
  ].join(";");
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const output = await runPowerShellFn(script, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      if (!output || output === "[]") return [];
      let parsed;
      try { parsed = JSON.parse(output); }
      catch { throw new Error("Process scan returned invalid data."); }
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => Number(item?.pid) > 0);
      const unverifiableClaudeExecutable = rows.some((item) => (
        String(item?.name || "").toLowerCase() === "claude.exe" && !normalizedPath(item?.path)
      ));
      if (unverifiableClaudeExecutable) throw new Error("A claude.exe process could not be identified safely.");
      return rows.filter((item) => {
        const processName = String(item?.name || "").toLowerCase();
        if (kind === "claude-desktop") {
          return processName === "claude.exe"
            && (isOfficialDesktopExecutable(item.path, installInfo) || isManagedDesktopExecutable(item.path));
        }
        if (processName === "claude.exe") return isOfficialClaudeCliExecutable(item.path, installInfo);
        return processName === "node.exe" && isClaudeCodeNodeCommand(item.commandLine)
          && !!normalizedPath(item.path) && !!item.creationDate;
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new Error(`Process scan failed after retries: ${lastError?.message || "WMI is unavailable."}`);
}

function processScanFailure(install) {
  return {
    ...install,
    // Mutating callers already refuse to continue while `running` is true.
    // Treat an unknown process state as running so apply/revert fail closed,
    // while read-only status callers still receive a useful error object.
    running: true,
    processCount: null,
    processes: [],
    processScanOk: false,
    runtimeError: {
      code: "PROCESS_SCAN_FAILED",
      message: "Claude process status could not be verified. No settings were changed.",
    },
  };
}

async function getRuntimeStatus(toolId, {
  detectDesktopFn = detectClaudeDesktop,
  detectCliFn = detectClaudeCli,
  listProcessesFn = listClaudeProcesses,
} = {}) {
  if (toolId === "claude-desktop") {
    const install = await detectDesktopFn();
    // A Cizi-managed copy can still be running after the official MSIX is
    // removed. Always scan so restore/rebuild never mutates files in use.
    try {
      const processes = await listProcessesFn(toolId, install);
      return {
        ...install,
        running: processes.length > 0,
        processCount: processes.length,
        processes,
        processScanOk: true,
        runtimeError: null,
      };
    } catch {
      return processScanFailure(install);
    }
  }
  if (toolId === "claude-code") {
    const install = await detectCliFn();
    try {
      const processes = await listProcessesFn(toolId, install);
      return {
        ...install,
        running: processes.length > 0,
        processCount: processes.length,
        processes,
        processScanOk: true,
        runtimeError: null,
      };
    } catch {
      return processScanFailure(install);
    }
  }
  return { installed: true, running: false, processCount: 0, processes: [], processScanOk: true, runtimeError: null };
}

function processScanError(cause) {
  const error = new Error("Claude process status could not be verified safely. No process was force-closed.");
  error.code = "PROCESS_SCAN_FAILED";
  if (cause) error.cause = cause;
  return error;
}

function expectedProcessIdentities(processes) {
  const identities = [];
  const seen = new Set();
  for (const item of processes || []) {
    const pid = Number(item?.pid);
    const executable = String(item?.path || "").trim();
    const creationDate = item?.creationDate ? String(item.creationDate) : "";
    // PID alone is not a stable process identity: it can be reused between the
    // scan and a force-close. Missing data must therefore block termination.
    if (!Number.isInteger(pid) || pid <= 0 || !executable || !creationDate) return null;
    if (seen.has(pid)) continue;
    seen.add(pid);
    identities.push({
      pid,
      path: executable,
      creationDate,
      identityVerified: true,
    });
  }
  return identities;
}

function expectedProcessPayload(processes) {
  const identities = expectedProcessIdentities(processes);
  if (!identities || !identities.length) return null;
  // ConvertFrom-Json returns a single System.Object[] when the top-level JSON
  // value is an array. Wrapping that output in @() leaves the array nested and
  // turns $item.pid into System.Object[], which blocks the safe close path.
  // A versioned object envelope makes the PowerShell side unambiguously
  // enumerate `processes` for both one and many Claude processes.
  return { schemaVersion: 1, processes: identities };
}

function stopPowerShellScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$payload=$env:CIZI_EXPECTED_PROCESSES|ConvertFrom-Json -ErrorAction Stop",
    "if($null -eq $payload -or [int]$payload.schemaVersion -ne 1){throw 'Claude process close payload is invalid.'}",
    "$expected=@($payload.processes)",
    "if($expected.Count -lt 1){throw 'Claude process close payload is empty.'}",
    "foreach($item in $expected){if($null -eq $item -or $null -eq $item.pid -or [string]::IsNullOrWhiteSpace([string]$item.path) -or [string]::IsNullOrWhiteSpace([string]$item.creationDate)){throw 'Claude process close payload contains an invalid identity.'}}",
    "function Get-ObservedProcess([int]$processId){$searcher=New-Object System.Management.ManagementObjectSearcher((\"SELECT ProcessId,ExecutablePath,CreationDate FROM Win32_Process WHERE ProcessId = {0}\" -f $processId));@($searcher.Get())|Select-Object -First 1}",
    "function Test-SameProcess($wanted,$observed){",
    "if($null -eq $observed){return $false}",
    "if([int64]$observed.ProcessId -ne [int64]$wanted.pid){return $false}",
    "$wantedPath=[string]$wanted.path;$observedPath=[string]$observed.ExecutablePath",
    "if([string]::IsNullOrWhiteSpace($wantedPath)-or [string]::IsNullOrWhiteSpace($observedPath)){return $false}",
    "if(-not [string]::Equals($wantedPath,$observedPath,[StringComparison]::OrdinalIgnoreCase)){return $false}",
    "$wantedCreated=[string]$wanted.creationDate",
    "if(-not [string]::IsNullOrWhiteSpace($wantedCreated)){",
    "if([string]::IsNullOrWhiteSpace([string]$observed.CreationDate)){return $false}",
    "try{$observedCreated=[System.Management.ManagementDateTimeConverter]::ToDateTime([string]$observed.CreationDate).ToUniversalTime().ToString('o')}catch{return $false}",
    "if(-not [string]::Equals($wantedCreated,$observedCreated,[StringComparison]::OrdinalIgnoreCase)){return $false}",
    "}",
    "return $true",
    "}",
    // Revalidate every identity before attempting a close. If WMI cannot
    // confirm it, fail closed rather than targeting a potentially reused PID.
    "foreach($item in $expected){",
    "$observed=Get-ObservedProcess ([int]$item.pid)",
    "if($null -ne $observed -and -not (Test-SameProcess $item $observed)){throw 'Claude process identity changed before close.'}",
    "}",
    "foreach($item in $expected){",
    "$observed=Get-ObservedProcess ([int]$item.pid)",
    "if($null -ne $observed -and (Test-SameProcess $item $observed)){$p=Get-Process -Id ([int]$item.pid) -ErrorAction Stop;if($p.MainWindowHandle -ne 0){$null=$p.CloseMainWindow()}}",
    "}",
    "Start-Sleep -Seconds 5",
    "foreach($item in $expected){",
    "$observed=Get-ObservedProcess ([int]$item.pid)",
    "if($null -eq $observed){continue}",
    "if(-not (Test-SameProcess $item $observed)){throw 'Claude process identity changed before force-close.'}",
    "Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop",
    "}",
  ].join(";");
}

async function stopTool(toolId, {
  getRuntimeStatusFn = getRuntimeStatus,
  runPowerShellFn = runPowerShell,
  delayFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let status = await getRuntimeStatusFn(toolId);
  let stoppedCount = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (status.processScanOk === false) throw processScanError();
    const processes = status.processes || [];
    if (!processes.length && !status.running) return { stopped: true, count: stoppedCount };

    const payload = expectedProcessPayload(processes);
    if (!payload) {
      const error = new Error("Claude process identity could not be verified, so it was not closed.");
      error.code = "PROCESS_IDENTITY_UNVERIFIED";
      throw error;
    }

    try {
      await runPowerShellFn(stopPowerShellScript(), {
        timeout: 30000,
        env: { CIZI_EXPECTED_PROCESSES: JSON.stringify(payload) },
      });
    } catch (error) {
      throw processScanError(error);
    }
    stoppedCount += payload.processes.length;
    // A process that has just exited can remain in WMI briefly while its
    // ExecutablePath is already unavailable. The scanner correctly reports
    // that instant as unverifiable. Retry observation without performing any
    // additional mutation; only a verified fresh scan may drive the next
    // close cycle.
    status = await getRuntimeStatusFn(toolId);
    // Packaged Electron processes can remain visible in WMI briefly after
    // their executable path is released. Keep observing without issuing any
    // further close command until that transient, unverifiable row disappears.
    for (let scanAttempt = 0; status.processScanOk === false && scanAttempt < 20; scanAttempt += 1) {
      await delayFn(500);
      status = await getRuntimeStatusFn(toolId);
    }
  }
  if (status.processScanOk === false) throw processScanError();
  if (!status.running) return { stopped: true, count: stoppedCount };
  const error = new Error(`${toolId === "claude-desktop" ? "Claude Desktop" : "Claude Code"} could not be closed.`);
  error.code = "PROCESS_STILL_RUNNING";
  throw error;
}


async function cleanupTemporaryInstaller(filePath) {
  // Add-AppxPackage can release its source file a moment after it returns on
  // some Windows builds. Retry quietly so cleanup never masks the real error.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (attempt === 2) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function installClaudeCli(onProgress = () => {}, {
  detectClaudeCliFn = detectClaudeCli,
  runPowerShellFn = runPowerShell,
  cleanupTemporaryInstallerFn = cleanupTemporaryInstaller,
  runPowerShellWithHeartbeatFn = null,
} = {}) {
  const existing = await detectClaudeCliFn();
  if (existing.installed) {
    onProgress("verifying", "Claude Code is already installed.");
    return existing;
  }
  onProgress("prerequisite", "Checking the official Claude Code package in WinGet...");
  try {
    await runPowerShellFn(claudeCodeWingetPrerequisiteScript(), { timeout: 60000, maxBuffer: 64 * 1024 });
  } catch (error) {
    throw cliWingetPrerequisiteFailure(error);
  }
  const heartbeatFile = path.join(os.tmpdir(), `Claude-Code-${Date.now()}-${crypto.randomUUID()}.heartbeat`);
  const heartbeatRunner = runPowerShellWithHeartbeatFn ||
    (runPowerShellFn === runPowerShell ? runPowerShellWithHeartbeat : null);
  try {
    onProgress("installing", "Installing the official Claude Code package with WinGet...");
    try {
      const options = {
        env: { CIZI_CLAUDE_CODE_HEARTBEAT: heartbeatFile },
        timeout: 20 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      };
      if (heartbeatRunner) {
        await heartbeatRunner(claudeCodeWingetInstallScript(), options, {
          heartbeatPath: heartbeatFile,
          onHeartbeat: () => onProgress("installing", "WinGet is still installing Claude Code..."),
        });
      } else {
        await runPowerShellFn(claudeCodeWingetInstallScript(), options);
      }
    } catch (error) {
      if (error?.code === "CLAUDE_CODE_INSTALL_TIMEOUT" || error?.code === "CLAUDE_CODE_INSTALL_COMMAND_FAILED") throw error;
      throw installerStageFailure(
        "CLAUDE_CODE_INSTALL_FAILED",
        "Claude Code could not be installed from the official WinGet package. Check WinGet and your network connection, then try again.",
        "installing",
        error,
      );
    }
  } finally {
    await cleanupTemporaryInstallerFn(heartbeatFile);
    await cleanupTemporaryInstallerFn(`${heartbeatFile}.stdout`);
    await cleanupTemporaryInstallerFn(`${heartbeatFile}.stderr`);
    await cleanupTemporaryInstallerFn(`${heartbeatFile}.exit`);
  }
  onProgress("verifying", "Verifying Claude Code installation...");
  let status;
  try {
    status = await detectClaudeCliFn();
  } catch (error) {
    throw installerStageFailure(
      "CLAUDE_CODE_VERIFY_FAILED",
      "Claude Code installation finished but could not be verified. Restart Cizi Code and try again.",
      "verifying",
      error,
    );
  }
  if (!status.installed) {
    throw installerFailure(
      "CLAUDE_CODE_NOT_DETECTED",
      "Claude Code installation finished but the CLI was not detected. Restart Cizi Code and try again.",
      { stage: "verifying" },
    );
  }
  return status;
}

// The official package is a quarter of a gigabyte, and the download is by far
// the slowest part of the installation. It lands on a stable path so a failed
// or declined install can be retried immediately instead of pulling the same
// bytes down again. The cached copy is only trusted when it is byte-for-byte
// the size the server currently reports for "latest" and still starts with a
// zip header, so a stale or truncated file is always replaced.
function claudeDesktopPackagePath() {
  return path.join(os.tmpdir(), "cizi-claude-desktop-latest.msix");
}

async function hasZipHeader(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x50 && header[1] === 0x4b;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function reusableClaudeDesktopPackage(targetPath, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) return false;
  if (await fileSize(targetPath) !== expectedBytes) return false;
  return hasZipHeader(targetPath);
}

async function readInstallResult(resultPath) {
  try {
    const raw = await fs.promises.readFile(resultPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // The elevated installer never started, or could not write its report. The
    // process exit code still tells the caller what to say.
    return null;
  }
}

async function installClaudeDesktop(onProgress = () => {}, {
  detectClaudeDesktopFn = detectClaudeDesktop,
  runPowerShellFn = runPowerShell,
  cleanupTemporaryInstallerFn = cleanupTemporaryInstaller,
  inspectDownloadFn = installer.inspectDownload,
  downloadInstallerFn = installer.downloadInstaller,
  verifyAnthropicSignatureFn = installer.verifyAnthropicSignature,
  runPowerShellWithHeartbeatFn = null,
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  packagePathFn = claudeDesktopPackagePath,
} = {}) {
  const existing = await detectClaudeDesktopFn();
  if (existing.installed) {
    onProgress("verifying", "Claude Desktop zaten kurulu.");
    return existing;
  }
  const packageFile = packagePathFn();
  const resultFile = `${packageFile}.result.json`;
  const heartbeatFile = `${packageFile}.heartbeat`;
  const heartbeatRunner = runPowerShellWithHeartbeatFn
    || (runPowerShellFn === runPowerShell ? runPowerShellWithHeartbeat : null);
  let installed = false;
  try {
    // The exact published size is resolved before a single byte is fetched, so
    // the very first progress event already carries a real percentage instead
    // of an indeterminate spinner.
    onProgress("downloading", "Resmî Claude Desktop paketi hazırlanıyor...", {
      percent: 0, downloadedBytes: 0, totalBytes: null,
    });
    const probed = await inspectDownloadFn(CLAUDE_DESKTOP_MSIX_URL);
    const publishedBytes = Number.isSafeInteger(probed?.contentLength) && probed.contentLength > 0
      ? probed.contentLength
      : null;
    if (await reusableClaudeDesktopPackage(packageFile, publishedBytes)) {
      onProgress("downloading", `Paket zaten indirilmiş (${formatByteCount(publishedBytes)}).`, {
        percent: 100,
        downloadedBytes: publishedBytes,
        totalBytes: publishedBytes,
      });
    } else {
      const report = createDownloadProgressReporter(onProgress, "Claude Desktop paketi indiriliyor", publishedBytes);
      report(0, { force: true });
      await downloadInstallerFn(CLAUDE_DESKTOP_MSIX_URL, packageFile, {
        knownTotalBytes: publishedBytes,
        validateResponse: (details) => assertArtifactResponse("msix", details),
        onProgress: ({ received }) => report(received),
      });
      report(await fileSize(packageFile), { completed: true, force: true });
    }

    // The artifact is executable code fetched over the network, so its
    // Authenticode signature is checked against Anthropic's publisher identity
    // before Windows is ever asked to register it.
    onProgress("verifying-signature", "Anthropic dijital imzası doğrulanıyor...");
    try {
      await verifyAnthropicSignatureFn(packageFile, { runPowerShellFn });
    } catch (error) {
      // A file that fails the signature check is never kept for a retry.
      await cleanupTemporaryInstallerFn(packageFile);
      throw error;
    }

    // Elevation is a property of the package, not of how Cizi Code was started:
    // the MSIX registers a localSystem service, which Windows refuses to install
    // per-user with 0x80073D28.
    onProgress("installing", "Windows yönetici onayı isteyecek...");
    const options = {
      env: {
        CIZI_CLAUDE_MSIX: packageFile,
        CIZI_CLAUDE_APPX_RESULT: resultFile,
        CIZI_CLAUDE_APPX_HEARTBEAT: heartbeatFile,
      },
      timeout: 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    };
    const script = claudeDesktopInstallScript(packageFile, resultFile);
    try {
      if (heartbeatRunner) {
        let ticks = 0;
        await heartbeatRunner(script, options, {
          heartbeatPath: heartbeatFile,
          // The first tick is written before the prompt appears, so the message
          // stays truthful about what the user is being waited on.
          onHeartbeat: () => {
            ticks += 1;
            onProgress("installing", ticks <= 1
              ? "Windows yönetici onayı isteyecek..."
              : "Windows paketi kaydediyor (birkaç dakika sürebilir)...");
          },
          timeoutCode: "CLAUDE_DESKTOP_INSTALL_TIMEOUT",
          timeoutMessage: "The Claude Desktop installation timed out. Approve the Windows prompt promptly, then try again.",
          failureCode: "CLAUDE_DESKTOP_INSTALL_FAILED",
          failureMessage: "Windows could not install the official Claude Desktop package. Try again.",
        });
      } else {
        await runPowerShellFn(script, options);
      }
    } catch (error) {
      // The heartbeat runner reports the exit code as a diagnostic; a plain
      // execFile rejection carries it on the error itself.
      const reported = Number.isInteger(error?.ciziDiagnostic?.processExitCode)
        ? error.ciziDiagnostic.processExitCode
        : Number(error?.code);
      throw claudeDesktopInstallFailure({
        exitCode: Number.isInteger(reported) ? reported : null,
        result: await readInstallResult(resultFile),
        cause: error,
      });
    }
    installed = true;
  } finally {
    await cleanupTemporaryInstallerFn(resultFile);
    await cleanupTemporaryInstallerFn(heartbeatFile);
    // A failed install keeps the package so the retry is instant; a successful
    // one has no further use for a quarter of a gigabyte of temporary files.
    if (installed) await cleanupTemporaryInstallerFn(packageFile);
  }
  onProgress("verifying", "Kurulum doğrulanıyor...");
  let status;
  // Windows finishes registering the package a moment after the deployment
  // command returns, so a single miss is not yet a failed installation.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      status = await detectClaudeDesktopFn();
    } catch (error) {
      throw installerStageFailure(
        "CLAUDE_DESKTOP_VERIFY_FAILED",
        "Claude Desktop installation finished but could not be verified. Restart Cizi Code and try again.",
        "verifying",
        error,
      );
    }
    if (status.installed) return status;
    await delayFn(1000);
  }
  throw installerFailure(
    "CLAUDE_DESKTOP_NOT_DETECTED",
    "Claude Desktop installation finished but the package was not detected. Restart Cizi Code and try again.",
    { stage: "verifying" },
  );
}

async function installTool(toolId, onProgress) {
  const report = typeof onProgress === "function" ? onProgress : () => {};
  if (toolId === "claude-code") return installClaudeCli(report);
  if (toolId === "claude-desktop") return installClaudeDesktop(report);
  throw new Error(`Installation is not supported for ${toolId}.`);
}

// What a Claude Desktop removal would touch, resolved from what is actually on
// the machine. Shown to the user before anything is deleted, the same way the
// Codex products preview their own removal.
async function planClaudeDesktopUninstall({ detectClaudeDesktopFn = detectClaudeDesktop } = {}) {
  const status = await detectClaudeDesktopFn();
  return {
    ...installer.planRemoval({
      installed: status.installed,
      version: status.Version,
      installKind: status.InstallKind,
    }),
    desktop: status,
  };
}

// Removes Claude Desktop itself and the leftovers listed in the plan. Cizi
// Code's own integration is expected to be off first: the caller restores the
// user's original settings before the application that owns them disappears.
async function uninstallClaudeDesktop(onProgress = () => {}, {
  detectClaudeDesktopFn = detectClaudeDesktop,
  runPowerShellFn = runPowerShell,
  stopToolFn = stopTool,
  removeLeftovers = true,
} = {}) {
  const before = await detectClaudeDesktopFn();
  if (!before.installed) {
    onProgress("uninstalling", "Claude Desktop zaten kurulu değil; kalıntılar temizleniyor...");
  } else {
    onProgress("uninstalling", "Claude Desktop kapatılıyor...");
    try { await stopToolFn("claude-desktop"); }
    catch (error) {
      throw installerFailure(
        "CLAUDE_DESKTOP_UNINSTALL_PROCESS_RUNNING",
        "Claude Desktop kapatılamadı. Uygulamayı elle kapatıp tekrar deneyin.",
        { stage: "uninstalling" },
      );
    }
    onProgress("uninstalling", "Claude Desktop kaldırılıyor...");
    try {
      if (before.InstallKind === "squirrel") {
        const parsed = installer.parseTrustedUninstallCommand(
          before.UninstallString || `"${path.join(before.InstallRoot || "", "Update.exe")}" --uninstall`,
        );
        await execFileAsync(parsed.file, parsed.args, { windowsHide: true, timeout: 180000 });
      } else {
        await runPowerShellFn(installer.removeMsixScript(), {
          env: { CIZI_CLAUDE_PACKAGE: before.PackageFullName },
          timeout: 180000,
        });
      }
    } catch (error) {
      if (error?.ciziPublicMessage) throw error;
      throw installerFailure(
        "CLAUDE_DESKTOP_UNINSTALL_FAILED",
        "Windows Claude Desktop'ı kaldıramadı. Tekrar deneyin.",
        { stage: "uninstalling" },
      );
    }
  }

  let leftoverWarning = null;
  if (removeLeftovers) {
    onProgress("uninstalling", "Claude Desktop kalıntıları temizleniyor...");
    // Leftover cleanup is best-effort: the application is already gone, and a
    // locked cache folder must not turn a finished removal into a failure.
    try { await runPowerShellFn(installer.removeLeftoversScript(), { timeout: 180000 }); }
    catch (error) { leftoverWarning = String(error?.message || error); }
  }

  onProgress("verifying", "Kaldırma doğrulanıyor...");
  const after = await detectClaudeDesktopFn();
  const remaining = installer.claudeLeftoverDirectories().filter((target) => fs.existsSync(target));
  return {
    ok: !after.installed,
    removed: before.installed && !after.installed,
    alreadyAbsent: !before.installed,
    installed: !!after.installed,
    remainingDirectories: remaining,
    ...(leftoverWarning ? { leftoverWarning } : {}),
  };
}

function launchExecutable(executable, cwd) {
  const target = String(executable || "").trim();
  const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(target);
  const command = shim ? (process.env.ComSpec || "cmd.exe") : target;
  const args = shim ? ["/d", "/k", "call", `"${target}"`] : [];
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, shell: false });
  child.unref();
  return child;
}

function launchAppUserModelId(appUserModelId) {
  const expected = `${CLAUDE_PACKAGE_FAMILY}!Claude`;
  if (appUserModelId !== expected) {
    const error = new Error("The Claude Desktop application identity is invalid.");
    error.code = "CLAUDE_APP_ID_INVALID";
    throw error;
  }
  // shell:AppsFolder activates the registered Anthropic package. It does not
  // resolve or execute a Cizi-owned copy of Claude.exe.
  const child = spawn("explorer.exe", [`shell:AppsFolder\\${expected}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { launched: true, appUserModelId: expected };
}

function launchClaudeNewChat(appUserModelId) {
  const expected = `${CLAUDE_PACKAGE_FAMILY}!Claude`;
  if (appUserModelId !== expected) {
    const error = new Error("The Claude Desktop application identity is invalid.");
    error.code = "CLAUDE_APP_ID_INVALID";
    throw error;
  }
  // Anthropic documents this URI as the official way to launch Claude
  // Desktop directly into a new chat. Windows resolves the registered
  // claude:// handler; Cizi never locates or starts a copied Claude.exe.
  const protocolLauncher = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
  const child = spawn(protocolLauncher, ["url.dll,FileProtocolHandler", CLAUDE_NEW_CHAT_URI], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { launched: true, appUserModelId: expected, uri: CLAUDE_NEW_CHAT_URI };
}

module.exports = {
  CLAUDE_PACKAGE_FAMILY,
  CLAUDE_NEW_CHAT_URI,
  runPowerShell,
  createDownloadProgressReporter,
  runPowerShellWithHeartbeat,
  claudeCodeWingetPrerequisiteScript,
  claudeCodeWingetInstallScript,
  wingetClaudeCodeCandidates,
  isOfficialWingetClaudeCodePath,
  detectClaudeCli,
  detectClaudeDesktop,
  listClaudeProcesses,
  expectedProcessIdentities,
  expectedProcessPayload,
  stopPowerShellScript,
  getRuntimeStatus,
  stopTool,
  installClaudeCli,
  installClaudeDesktop,
  claudeDesktopPackagePath,
  reusableClaudeDesktopPackage,
  planClaudeDesktopUninstall,
  uninstallClaudeDesktop,
  installTool,
  launchExecutable,
  launchAppUserModelId,
  launchClaudeNewChat,
};
