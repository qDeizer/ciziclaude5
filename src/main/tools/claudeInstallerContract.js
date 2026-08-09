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
const CLAUDE_DESKTOP_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

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

function curlOrIwrDownloadScript(targetEnvironmentVariable, url, {
  incompleteMessage,
  minimumBytes = 1,
  requireZipHeader = false,
} = {}) {
  const targetExpression = `$env:${targetEnvironmentVariable}`;
  const validation = [
    "$item=Get-Item -LiteralPath $target -ErrorAction Stop",
    `if($item.Length -lt ${minimumBytes}){throw '${incompleteMessage}'}`,
  ];
  if (requireZipHeader) {
    validation.push(
      "$stream=$null;try{$stream=[System.IO.File]::OpenRead($target);$header=New-Object byte[] 4;$read=$stream.Read($header,0,4)}finally{if($null -ne $stream){$stream.Dispose()}}",
      `if($read -lt 4 -or $header[0] -ne 0x50 -or $header[1] -ne 0x4b){throw '${incompleteMessage}'}`,
    );
  }
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    `$target=${targetExpression}`,
    "if([string]::IsNullOrWhiteSpace($target)){throw 'The Claude download path is missing.'}",
    `$url='${url}'`,
    "Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue",
    "$systemRoot=$env:SystemRoot;if([string]::IsNullOrWhiteSpace($systemRoot)){$systemRoot='C:\\Windows'}",
    "$curlPath=Join-Path $systemRoot 'System32\\curl.exe'",
    "$curlCommand=$null;if(-not (Test-Path -LiteralPath $curlPath -PathType Leaf)){$curlCommand=Get-Command -Name 'curl.exe' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($null -ne $curlCommand -and [string]::Equals([IO.Path]::GetFileName([string]$curlCommand.Source),'curl.exe',[StringComparison]::OrdinalIgnoreCase)){$curlPath=[string]$curlCommand.Source}}",
    "if(Test-Path -LiteralPath $curlPath -PathType Leaf){",
    "& $curlPath --fail --location --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1 --speed-time 60 --output $target -- $url",
    "if($LASTEXITCODE -ne 0){throw ('curl.exe failed while downloading Claude (exit code {0}).' -f $LASTEXITCODE)}",
    "}else{",
    "Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $target -TimeoutSec 120 -MaximumRedirection 10 -ErrorAction Stop",
    "}",
    ...validation,
  ].join("\n");
}

function claudeDesktopDownloadScript(architecture = process.arch) {
  return curlOrIwrDownloadScript("CIZI_CLAUDE_MSIX", claudeDesktopMsixUrl(architecture), {
    incompleteMessage: "The Claude Desktop package download was incomplete.",
    minimumBytes: 1024,
    requireZipHeader: true,
  });
}

function claudeCodeWingetPrerequisiteScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$winget=Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1",
    "if($null -eq $winget){throw 'CLAUDE_CODE_WINGET_MISSING'}",
    "$null=& $winget.Source show --id Anthropic.ClaudeCode --exact --source winget --accept-source-agreements --disable-interactivity",
    "if($LASTEXITCODE -ne 0){throw 'CLAUDE_CODE_WINGET_PACKAGE_UNAVAILABLE'}",
    "[pscustomobject]@{winget=$true;packageId='Anthropic.ClaudeCode'}|ConvertTo-Json -Compress",
  ].join("\n");
}

function claudeCodeWingetInstallScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$heartbeat=$env:CIZI_CLAUDE_CODE_HEARTBEAT",
    "if([string]::IsNullOrWhiteSpace($heartbeat)){throw 'The Claude Code installer heartbeat path is missing.'}",
    "Remove-Item -LiteralPath $heartbeat -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath ($heartbeat+'.stdout') -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath ($heartbeat+'.stderr') -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath ($heartbeat+'.exit') -Force -ErrorAction SilentlyContinue",
    "$winget=Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1",
    "if($null -eq $winget){throw 'CLAUDE_CODE_WINGET_MISSING'}",
    "[IO.File]::WriteAllText($heartbeat,'.',[Text.Encoding]::ASCII)",
    "$env:CIZI_WINGET_PATH=[string]$winget.Source;$env:CIZI_WINGET_EXIT=$heartbeat+'.exit'",
    "$childScript=@'",
    "$ErrorActionPreference='Continue'",
    "& $env:CIZI_WINGET_PATH install --id Anthropic.ClaudeCode --exact --source winget --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity",
    "$exitCode=[int]$LASTEXITCODE;[IO.File]::WriteAllText($env:CIZI_WINGET_EXIT,[string]$exitCode);exit $exitCode",
    "'@",
    "$encodedChild=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))",
    "$powershell=Join-Path $PSHOME 'powershell.exe'",
    "$process=Start-Process -FilePath $powershell -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encodedChild) -NoNewWindow -PassThru -RedirectStandardOutput ($heartbeat+'.stdout') -RedirectStandardError ($heartbeat+'.stderr')",
    "while(-not $process.HasExited){[IO.File]::AppendAllText($heartbeat,'.',[Text.Encoding]::ASCII);Start-Sleep -Seconds 5;$process.Refresh()}",
    "$process.WaitForExit();$process.Refresh()",
    "[IO.File]::AppendAllText($heartbeat,'.',[Text.Encoding]::ASCII)",
    "$exitPath=$heartbeat+'.exit';if(-not (Test-Path -LiteralPath $exitPath -PathType Leaf)){throw 'CLAUDE_CODE_WINGET_INSTALL_FAILED (exit code unavailable)'}",
    "$exitText=(Get-Content -LiteralPath $exitPath -Raw).Trim();if($exitText -notmatch '^\\d+$'){throw 'CLAUDE_CODE_WINGET_INSTALL_FAILED (exit code invalid)'}",
    "if([int]$exitText -ne 0){throw ('CLAUDE_CODE_WINGET_INSTALL_FAILED (exit code {0})' -f [int]$exitText)}",
  ].join("\n");
}

function cliWingetPrerequisiteFailure(error) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
  const known = [
    ["CLAUDE_CODE_WINGET_MISSING", "Windows Package Manager (WinGet) is required for the one-click Claude Code installation. Use the official setup link if WinGet is unavailable."],
    ["CLAUDE_CODE_WINGET_PACKAGE_UNAVAILABLE", "The official Anthropic Claude Code package is currently unavailable from WinGet. Try again or use the official setup link."],
  ];
  for (const [code, message] of known) {
    if (text.includes(code)) return installerFailure(code, message, { stage: "prerequisite" });
  }
  return installerStageFailure(
    "CLAUDE_CODE_PREREQUISITE_CHECK_FAILED",
    "Cizi Code could not verify the official Claude Code package in WinGet.",
    "prerequisite",
    error,
  );
}

function claudeDesktopInstallScript(targetPath, resultPath, { elevated = true } = {}) {
  if (!elevated) {
    return [
      "$ErrorActionPreference='Stop'",
      "$target=$env:CIZI_CLAUDE_MSIX",
      "if([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)){throw 'The Claude Desktop package file is missing.'}",
      "Add-AppxPackage -Path $target -ErrorAction Stop",
    ].join("\n");
  }
  const encodedParameters = Buffer.from(JSON.stringify({ targetPath, resultPath }), "utf8").toString("base64");
  const elevatedScript = [
    "$ErrorActionPreference='Stop'",
    `$encodedParameters='${encodedParameters}'`,
    "$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedParameters))",
    "$installParameters=$payload|ConvertFrom-Json -ErrorAction Stop",
    "$target=[string]$installParameters.targetPath",
    "$resultPath=[string]$installParameters.resultPath",
    "$utf8=New-Object System.Text.UTF8Encoding($false)",
    "function Write-Result([bool]$ok,[string]$message){if([string]::IsNullOrWhiteSpace($resultPath)){return};try{$payload=[pscustomobject]@{ok=$ok;message=$message}|ConvertTo-Json -Compress;[IO.File]::WriteAllText($resultPath,$payload,$utf8)}catch{}}",
    "try{",
    "if([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)){throw 'The Claude Desktop package file is missing.'}",
    "Add-AppxPackage -Path $target -ErrorAction Stop",
    "Write-Result $true ''",
    "exit 0",
    "}catch{",
    "Write-Result $false ([string]$_.Exception.Message)",
    "exit 1",
    "}",
  ].join("\n");
  const encodedElevatedScript = Buffer.from(elevatedScript, "utf16le").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "$target=$env:CIZI_CLAUDE_MSIX",
    "$resultPath=$env:CIZI_CLAUDE_APPX_RESULT",
    "if([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)){throw 'The Claude Desktop package file is missing.'}",
    "if([string]::IsNullOrWhiteSpace($resultPath)){throw 'The Claude Desktop install result path is missing.'}",
    "Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue",
    `$encodedElevatedScript='${encodedElevatedScript}'`,
    "$powershell=Join-Path $PSHOME 'powershell.exe'",
    "try{$process=Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$encodedElevatedScript) -ErrorAction Stop}catch{if($_.Exception.NativeErrorCode -eq 1223 -or [string]$_.Exception.Message -match 'cancel'){throw 'Administrator approval was cancelled. Claude Desktop was not installed.'};throw ('Could not start the elevated Claude Desktop installer: {0}' -f $_.Exception.Message)}",
    "$detail=''",
    "if(Test-Path -LiteralPath $resultPath){try{$result=Get-Content -LiteralPath $resultPath -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop;$detail=[string]$result.message}catch{}}",
    "if($process.ExitCode -ne 0){if(-not [string]::IsNullOrWhiteSpace($detail)){throw ('Claude Desktop installation failed after administrator approval: {0}' -f $detail)};throw ('Claude Desktop installation failed after administrator approval (exit code {0}).' -f $process.ExitCode)}",
  ].join("\n");
}

module.exports = {
  CLAUDE_DESKTOP_MSIX_URLS,
  CLAUDE_DESKTOP_MSIX_URL,
  CLAUDE_DESKTOP_DOWNLOAD_TIMEOUT_MS,
  claudeDesktopMsixUrl,
  installerFailure,
  installerStageFailure,
  curlOrIwrDownloadScript,
  claudeDesktopDownloadScript,
  claudeCodeWingetPrerequisiteScript,
  claudeCodeWingetInstallScript,
  cliWingetPrerequisiteFailure,
  claudeDesktopInstallScript,
};
