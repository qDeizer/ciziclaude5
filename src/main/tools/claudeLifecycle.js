const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { windowsPowerShellEnvironment } = require("../windowsPowerShell");
const {
  CLAUDE_DESKTOP_MSIX_URL,
  installerFailure,
  installerStageFailure,
  claudeDesktopInstallScript,
  claudeDesktopInstallFailure,
} = require("./claudeInstallerContract");
// Claude Desktop's own download/verify/remove layer, ported from ciziClaude4.
const installer = require("./claudeDesktopInstaller");
const { manualInstallDirectory } = require("../manualInstall");
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
  timeoutCode = "CLAUDE_DESKTOP_INSTALL_TIMEOUT",
  timeoutMessage = "The installation timed out. Check your connection and try again.",
  failureCode = "CLAUDE_DESKTOP_INSTALL_FAILED",
  failureMessage = "The installation stopped before it finished. Try again.",
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

async function listClaudeProcesses(kind, installInfo = null, { runPowerShellFn = runPowerShell } = {}) {
  if (kind !== "claude-desktop") {
    throw new Error(`Unsupported Claude process type: ${kind}`);
  }

  // tasklist.exe reports only image names, which cannot distinguish the real
  // Claude Desktop from any other claude.exe. Query WMI through
  // System.Management directly, avoiding PowerShell's intermittently
  // unavailable CimCmdlets module, for an immutable identity (PID + executable
  // path + creation time). Termination re-verifies the same identity.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$searcher=New-Object System.Management.ManagementObjectSearcher(\"SELECT ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE Name='claude.exe'\")",
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
      return rows.filter((item) => String(item?.name || "").toLowerCase() === "claude.exe"
        && (isOfficialDesktopExecutable(item.path, installInfo) || isManagedDesktopExecutable(item.path)));
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

// Claude Desktop'in kurulum ve surec durumu. Claude Code CLI'nin kendi
// tespiti main.js'te yasar (surumu `claude --version` ile okur); burada ikinci
// bir kopyasini tutmak iki farkli "kurulu mu" cevabi uretiyordu.
async function getRuntimeStatus(toolId, {
  detectDesktopFn = detectClaudeDesktop,
  listProcessesFn = listClaudeProcesses,
} = {}) {
  if (toolId !== "claude-desktop") {
    throw new Error(`Unsupported Claude runtime target: ${toolId}`);
  }
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

function processScanError(cause) {
  const error = new Error("Claude process status could not be verified safely. No process was force-closed.");
  error.code = "PROCESS_SCAN_FAILED";
  if (cause) error.cause = cause;
  return error;
}

// Kapatma denemesinin kendisi basarisiz oldu. Bunu tarama hatasi gibi
// bildirmek kullaniciya "surecler denetlenemedi" dedirtiyordu; oysa tarama
// calisiyor, kapatma calismiyordu. Yanlis teshis, dogru teshisten daha
// pahaliya mal olur.
function processCloseError(cause) {
  const error = new Error("Claude Desktop could not be closed.");
  error.code = "PROCESS_CLOSE_FAILED";
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
    // Her PID, ona dokunulmadan HEMEN once yeniden dogrulanir. Uc olasilik var
    // ve ucu de farkli seyler demek:
    //
    //   gozlenemiyor        -> surec cikmis. Isimiz zaten bitti.
    //   kimlik uyusmuyor    -> Windows o PID'i BASKA bir surece vermis; bizim
    //                          surecimiz cikmis demektir. O PID'e dokunulmaz.
    //   kimlik uyusuyor     -> hedef hala ayakta; kapatilir.
    //
    // Ilk iki durum eskiden islemi hataya dusuruyordu. Claude Desktop dokuz
    // surecle calisiyor ve ana pencere kapaninca hepsi birden cikiyor; bes
    // saniyelik beklemede bosalan PID'lerin yeniden kullanilmasi olagan.
    // Sonuc: Claude gercekten kapandigi halde anahtar "kapatilamadi" diyor,
    // yapilan is geri aliniyordu. Bir surecin cikmis olmasi, onu kapatmak
    // isteyen bir islem icin basarisizlik degildir.
    //
    // Guvenlik kurali aynen duruyor: kimligi dogrulanmamis hicbir PID'e
    // dokunulmaz. "Gercekten kapandi mi" sorusunu ise bu betik degil, cagiran
    // taraftaki taze tarama cevaplar.
    "$stopped=0;$vanished=0;$reused=0",
    "foreach($item in $expected){",
    "$observed=Get-ObservedProcess ([int]$item.pid)",
    "if($null -eq $observed){$vanished++;continue}",
    "if(-not (Test-SameProcess $item $observed)){$reused++;continue}",
    "$p=Get-Process -Id ([int]$item.pid) -ErrorAction SilentlyContinue",
    "if($null -ne $p -and $p.MainWindowHandle -ne 0){$null=$p.CloseMainWindow()}",
    "}",
    "Start-Sleep -Seconds 5",
    "foreach($item in $expected){",
    "$observed=Get-ObservedProcess ([int]$item.pid)",
    "if($null -eq $observed){$vanished++;continue}",
    "if(-not (Test-SameProcess $item $observed)){$reused++;continue}",
    // Gozlem ile Stop-Process arasinda da surec cikabilir. Hata yutulmaz:
    // hemen yeniden bakilir ve surec hala ORADA ise hata gercektir.
    "try{Stop-Process -Id ([int]$item.pid) -Force -ErrorAction Stop;$stopped++}catch{$still=Get-ObservedProcess ([int]$item.pid);if($null -ne $still -and (Test-SameProcess $item $still)){throw}else{$vanished++}}",
    "}",
    "[pscustomobject]@{stopped=$stopped;vanished=$vanished;reused=$reused}|ConvertTo-Json -Compress",
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
      throw processCloseError(error);
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
  const error = new Error("Claude Desktop could not be closed.");
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

// Fetches the official package to `targetPath` and refuses to hand back anything
// whose Authenticode signature is not Anthropic's.
//
// Both the automatic installation and the "download only" path go through here,
// so there is exactly one definition of "downloaded and verified". Splitting it
// would let one of the two paths quietly skip the signature check.
//
// `allowReuse` is for the install path: the package is a quarter of a gigabyte
// and a retried install should not pull the same bytes again. A manual download
// always fetches fresh, because the user asked for a file to keep.
async function downloadVerifiedClaudeDesktopPackage(targetPath, onProgress = () => {}, {
  allowReuse = false,
  label = "Claude Desktop paketi indiriliyor",
  runPowerShellFn = runPowerShell,
  cleanupTemporaryInstallerFn = cleanupTemporaryInstaller,
  inspectDownloadFn = installer.inspectDownload,
  downloadInstallerFn = installer.downloadInstaller,
  verifyAnthropicSignatureFn = installer.verifyAnthropicSignature,
} = {}) {
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
  if (allowReuse && await reusableClaudeDesktopPackage(targetPath, publishedBytes)) {
    onProgress("downloading", `Paket zaten indirilmiş (${formatByteCount(publishedBytes)}).`, {
      percent: 100,
      downloadedBytes: publishedBytes,
      totalBytes: publishedBytes,
    });
  } else {
    const report = createDownloadProgressReporter(onProgress, label, publishedBytes);
    report(0, { force: true });
    await downloadInstallerFn(CLAUDE_DESKTOP_MSIX_URL, targetPath, {
      knownTotalBytes: publishedBytes,
      validateResponse: (details) => assertArtifactResponse("msix", details),
      onProgress: ({ received }) => report(received),
    });
    report(await fileSize(targetPath), { completed: true, force: true });
  }

  // The artifact is executable code fetched over the network, so its
  // Authenticode signature is checked against Anthropic's publisher identity
  // before Windows is ever asked to register it - and before the file is handed
  // to a user who intends to run it by hand.
  onProgress("verifying-signature", "Anthropic dijital imzası doğrulanıyor...");
  try {
    await verifyAnthropicSignatureFn(targetPath, { runPowerShellFn });
  } catch (error) {
    // A file that fails the signature check is never kept.
    await cleanupTemporaryInstallerFn(targetPath);
    throw error;
  }
  return { path: targetPath, bytes: await fileSize(targetPath), totalBytes: publishedBytes };
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
    await downloadVerifiedClaudeDesktopPackage(packageFile, onProgress, {
      allowReuse: true,
      runPowerShellFn,
      cleanupTemporaryInstallerFn,
      inspectDownloadFn,
      downloadInstallerFn,
      verifyAnthropicSignatureFn,
    });

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

// "Sadece indir": doğrulanmış paketi kullanıcının indirilenler klasörüne koyar
// ve kurmaz. İmza kontrolü atlanmaz - kullanıcı bu dosyayı elle çalıştıracak.
async function downloadClaudeDesktopForManualInstall(onProgress = () => {}, options = {}) {
  const target = path.join(manualInstallDirectory(), "Claude-Desktop-Setup.msix");
  const result = await downloadVerifiedClaudeDesktopPackage(target, onProgress, {
    ...options,
    allowReuse: false,
    label: "Claude Desktop paketi indiriliyor (manuel kurulum)",
  });
  onProgress("complete", `Paket indirildi: ${result.path}`, { percent: 100 });
  return {
    downloaded: true,
    ...result,
    directory: path.dirname(result.path),
    runHint: "Dosyaya çift tıklayın; Windows kurulum için yönetici onayı isteyecek.",
  };
}

// The non-file part of a removal: registry keys, autostart entries, shortcuts.
// A removal category on its own, so selecting or skipping it is the user's call.
async function removeClaudeDesktopResidue({ runPowerShellFn = runPowerShell } = {}) {
  await runPowerShellFn(installer.removeResidueScript(), { timeout: 60000 });
  return { removed: true };
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
  detectClaudeDesktop,
  listClaudeProcesses,
  expectedProcessIdentities,
  expectedProcessPayload,
  stopPowerShellScript,
  getRuntimeStatus,
  stopTool,
  installClaudeDesktop,
  downloadVerifiedClaudeDesktopPackage,
  downloadClaudeDesktopForManualInstall,
  claudeDesktopPackagePath,
  reusableClaudeDesktopPackage,
  removeClaudeDesktopResidue,
  uninstallClaudeDesktop,
  launchAppUserModelId,
  launchClaudeNewChat,
};
