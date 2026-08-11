// Pure, reviewable contract for the official Claude installers. This module
// builds command text and safe public errors only; it never executes a process,
// touches the registry, downloads a file or installs an application.

const CLAUDE_DESKTOP_MSIX_URLS = Object.freeze({
  x64: "https://claude.ai/api/desktop/win32/x64/msix/latest/redirect",
  arm64: "https://claude.ai/api/desktop/win32/arm64/msix/latest/redirect",
});

function claudeDesktopMsixUrl(architecture = process.arch) {
  const url = CLAUDE_DESKTOP_MSIX_URLS[String(architecture || "").toLowerCase()];
  if (url) return url;
  const error = new Error("The official Claude Desktop installer is not available for this Windows architecture.");
  error.code = "CLAUDE_DESKTOP_ARCHITECTURE_UNSUPPORTED";
  throw error;
}

const CLAUDE_DESKTOP_MSIX_URL = claudeDesktopMsixUrl();

function installerFailure(code, publicMessage, diagnostic = {}) {
  const error = new Error(publicMessage);
  error.code = code;
  error.ciziPublicMessage = publicMessage;
  error.ciziDiagnostic = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
  return error;
}

function installerStageFailure(code, publicMessage, stage, cause) {
  const processExitCode = Number(cause?.code);
  return installerFailure(code, publicMessage, {
    stage,
    ...(Number.isInteger(processExitCode) ? { processExitCode } : {}),
  });
}

// The Claude Desktop package is fetched by claudeDesktopInstaller.js, which
// streams it in Node so the byte count driving the progress bar comes from the
// transfer itself. Shelling out to curl and polling the file's size on disk
// could not report a percentage before the first poll landed, which is why the
// download appeared to sit at nothing.

// Claude Desktop is not shaped like the other tools this app installs. Its
// official MSIX registers a packaged Windows service that runs as localSystem
// (CoworkVMService) and declares firewall rules, so Windows refuses a per-user
// registration outright:
//
//   0x80073D28 - Cannot register the Claude package.
//                Administrator privileges required to install packaged service
//
// The package is therefore always installed through an elevated child process.
// How Cizi Code itself was started (from source or from a packaged build) has
// no bearing on that requirement, so it must never decide the install mode.

// The exit codes the outer (unelevated) install script uses. They separate a
// declined administrator prompt from a deployment that actually ran and failed,
// so the user gets told which of the two happened.
const CLAUDE_DESKTOP_INSTALL_EXIT = Object.freeze({
  ok: 0,
  deploymentFailed: 1,
  approvalDeclined: 2,
});

// Windows deployment errors worth naming. Anything else falls back to the
// generic message plus the HRESULT, which is enough to search for.
const CLAUDE_DESKTOP_DEPLOYMENT_ERRORS = Object.freeze({
  "0x80073D28": [
    "CLAUDE_DESKTOP_INSTALL_ELEVATION_REQUIRED",
    "Windows requires administrator approval to install Claude Desktop, because the package registers a system service.",
  ],
  "0x80073D02": [
    "CLAUDE_DESKTOP_INSTALL_PACKAGE_IN_USE",
    "Claude Desktop is still running. Close it completely, then install again.",
  ],
  "0x80073CF3": [
    "CLAUDE_DESKTOP_INSTALL_PACKAGE_INVALID",
    "The downloaded Claude Desktop package could not be validated. Try the installation again.",
  ],
  "0x80073CF0": [
    "CLAUDE_DESKTOP_INSTALL_PACKAGE_INVALID",
    "The downloaded Claude Desktop package could not be opened. Try the installation again.",
  ],
  "0x80073CFD": [
    "CLAUDE_DESKTOP_INSTALL_UNSUPPORTED_WINDOWS",
    "This Windows version cannot install the official Claude Desktop package.",
  ],
});

function claudeDesktopDeploymentHresult(message) {
  const match = /0x[0-9a-f]{8}/i.exec(String(message || ""));
  return match ? match[0].toUpperCase().replace("0X", "0x") : null;
}

// Turns the elevated child's own report into the error the UI shows. The result
// file is written by the installer itself, so the real deployment message never
// has to be scraped out of PowerShell's output stream.
function claudeDesktopInstallFailure({ exitCode = null, result = null, cause = null } = {}) {
  if (result?.cancelled === true || exitCode === CLAUDE_DESKTOP_INSTALL_EXIT.approvalDeclined) {
    return installerFailure(
      "CLAUDE_DESKTOP_INSTALL_CANCELLED",
      "Administrator approval was cancelled. Claude Desktop was not installed.",
      { stage: "installing" },
    );
  }
  const detail = String(result?.message || cause?.message || "");
  const hresult = result?.hresult || claudeDesktopDeploymentHresult(detail);
  const known = hresult ? CLAUDE_DESKTOP_DEPLOYMENT_ERRORS[hresult] : null;
  if (known) {
    return installerFailure(known[0], known[1], {
      stage: "installing",
      hresult,
      ...(Number.isInteger(exitCode) ? { processExitCode: exitCode } : {}),
    });
  }
  return installerFailure(
    "CLAUDE_DESKTOP_INSTALL_FAILED",
    hresult
      ? `Windows could not install the official Claude Desktop package (${hresult}).`
      : "Windows could not install the official Claude Desktop package. Try again.",
    {
      stage: "installing",
      ...(hresult ? { hresult } : {}),
      ...(Number.isInteger(exitCode) ? { processExitCode: exitCode } : {}),
    },
  );
}

function claudeDesktopInstallScript(targetPath, resultPath) {
  const encodedParameters = Buffer.from(JSON.stringify({ targetPath, resultPath }), "utf8").toString("base64");
  const elevatedScript = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    `$encodedParameters='${encodedParameters}'`,
    "$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedParameters))",
    "$installParameters=$payload|ConvertFrom-Json -ErrorAction Stop",
    "$target=[string]$installParameters.targetPath",
    "$resultPath=[string]$installParameters.resultPath",
    "$utf8=New-Object System.Text.UTF8Encoding($false)",
    "function Write-Result([bool]$ok,[string]$message){if([string]::IsNullOrWhiteSpace($resultPath)){return};try{$hresult='';$found=[Text.RegularExpressions.Regex]::Match($message,'0x[0-9A-Fa-f]{8}');if($found.Success){$hresult=$found.Value.ToUpperInvariant().Replace('0X','0x')};$payload=[pscustomobject]@{ok=$ok;message=$message;hresult=$hresult}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($resultPath,$payload,$utf8)}catch{}}",
    "try{",
    "if([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)){throw 'The Claude Desktop package file is missing.'}",
    "Add-AppxPackage -Path $target -ErrorAction Stop",
    "Write-Result $true ''",
    `exit ${CLAUDE_DESKTOP_INSTALL_EXIT.ok}`,
    "}catch{",
    "Write-Result $false ([string]$_.Exception.Message)",
    `exit ${CLAUDE_DESKTOP_INSTALL_EXIT.deploymentFailed}`,
    "}",
  ].join("\n");
  const encodedElevatedScript = Buffer.from(elevatedScript, "utf16le").toString("base64");
  // The outer script does not use Start-Process -Wait: it polls the elevated
  // child so it can tick a heartbeat file the whole time. Registering a 250 MB
  // package with a system service takes minutes, and without that tick the UI
  // has nothing to show and looks frozen.
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$target=$env:CIZI_CLAUDE_MSIX",
    "$resultPath=$env:CIZI_CLAUDE_APPX_RESULT",
    "$heartbeat=$env:CIZI_CLAUDE_APPX_HEARTBEAT",
    "if([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)){throw 'The Claude Desktop package file is missing.'}",
    "if([string]::IsNullOrWhiteSpace($resultPath)){throw 'The Claude Desktop install result path is missing.'}",
    "if([string]::IsNullOrWhiteSpace($heartbeat)){throw 'The Claude Desktop install heartbeat path is missing.'}",
    "$utf8=New-Object System.Text.UTF8Encoding($false)",
    "Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath $heartbeat -Force -ErrorAction SilentlyContinue",
    "[IO.File]::WriteAllText($heartbeat,'.',[Text.Encoding]::ASCII)",
    `$encodedElevatedScript='${encodedElevatedScript}'`,
    "$powershell=Join-Path $PSHOME 'powershell.exe'",
    // A declined UAC prompt surfaces as ERROR_CANCELLED (1223) somewhere in the
    // exception chain. The accompanying text is localised by Windows, so it is
    // never matched on words - only on the numeric code, wherever it sits.
    "function Test-ApprovalDeclined($exception){$current=$exception;while($null -ne $current){$code=$null;try{$code=$current.NativeErrorCode}catch{};if($null -eq $code){try{$code=$current.ErrorCode}catch{}};if($code -eq 1223){return $true};if($current.HResult -eq -2147023673){return $true};$current=$current.InnerException};return $false}",
    "$process=$null",
    "try{$process=Start-Process -FilePath $powershell -Verb RunAs -PassThru -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encodedElevatedScript) -ErrorAction Stop}catch{",
    "$declined=Test-ApprovalDeclined $_.Exception",
    "try{$payload=[pscustomobject]@{ok=$false;cancelled=$declined;message=([string]$_.Exception.Message);hresult=''}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($resultPath,$payload,$utf8)}catch{}",
    `if($declined){exit ${CLAUDE_DESKTOP_INSTALL_EXIT.approvalDeclined}}`,
    `exit ${CLAUDE_DESKTOP_INSTALL_EXIT.deploymentFailed}`,
    "}",
    // ShellExecute can hand back a null process object even though elevation
    // succeeded; without a handle to watch there is nothing honest to report.
    "if($null -eq $process){try{$payload=[pscustomobject]@{ok=$false;cancelled=$false;message='The elevated Claude Desktop installer could not be observed.';hresult=''}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($resultPath,$payload,$utf8)}catch{};" +
      `exit ${CLAUDE_DESKTOP_INSTALL_EXIT.deploymentFailed}}`,
    "while(-not $process.HasExited){[IO.File]::AppendAllText($heartbeat,'.',[Text.Encoding]::ASCII);Start-Sleep -Seconds 2;$process.Refresh()}",
    "$process.WaitForExit();$process.Refresh()",
    "[IO.File]::AppendAllText($heartbeat,'.',[Text.Encoding]::ASCII)",
    // An unelevated parent cannot always read an elevated child's exit code.
    // The installer's own report is the fallback, so a successful deployment is
    // never turned into a failure by a missing handle right.
    "$exitCode=$null",
    "try{$exitCode=[int]$process.ExitCode}catch{$exitCode=$null}",
    "if($null -eq $exitCode){$reported=$false;if(Test-Path -LiteralPath $resultPath){try{$reported=[bool]((Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json).ok)}catch{$reported=$false}};" +
      `if($reported){exit ${CLAUDE_DESKTOP_INSTALL_EXIT.ok}}else{exit ${CLAUDE_DESKTOP_INSTALL_EXIT.deploymentFailed}}}`,
    "exit $exitCode",
  ].join("\n");
}

module.exports = {
  CLAUDE_DESKTOP_MSIX_URLS,
  CLAUDE_DESKTOP_MSIX_URL,
  CLAUDE_DESKTOP_INSTALL_EXIT,
  CLAUDE_DESKTOP_DEPLOYMENT_ERRORS,
  claudeDesktopDeploymentHresult,
  claudeDesktopInstallFailure,
  claudeDesktopMsixUrl,
  installerFailure,
  installerStageFailure,
  claudeDesktopInstallScript,
};
