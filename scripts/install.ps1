param(
  [string]$BaseUrl = "https://cizicode.me/desktop-updates",
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "CiziCode"),
  [string]$ReleaseUrl = "",
  [string]$ExpectedSha256 = "",
  [string]$LocalZipPath = "",
  [switch]$NoShortcut,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$BaseUrl = $BaseUrl.TrimEnd("/")
$AppExe = Join-Path $InstallRoot "Cizi Code.exe"
$TempRoot = Join-Path $env:TEMP "cizicode-desktop-install"
$ZipPath = Join-Path $TempRoot "cizicode-desktop.zip"
$ExtractDir = Join-Path $TempRoot "extract"
$ManifestUrl = "$BaseUrl/latest.json"
$LogPath = Join-Path $env:TEMP "cizicode-desktop-install.log"

# Keep PowerShell out of the install directory so Windows can move/replace it.
Set-Location -LiteralPath $env:TEMP

function Write-Step($Message) {
  Write-Host "[Cizi Code] $Message"
  $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Invoke-WithRetry($Label, [scriptblock]$Action, [int]$Attempts = 12, [int]$DelayMs = 1000) {
  for ($i = 1; $i -le $Attempts; $i++) {
    try {
      return & $Action
    } catch {
      if ($i -ge $Attempts) {
        Write-Step "$Label failed after $Attempts attempts: $($_.Exception.Message)"
        throw
      }
      Write-Step "$Label attempt $i failed: $($_.Exception.Message)"
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Stop-CiziCodeProcesses {
  Write-Step "Closing running Cizi Code instances..."
  for ($i = 1; $i -le 20; $i++) {
    $processes = @(Get-Process -Name "Cizi Code" -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
      Write-Step "All Cizi Code instances are closed."
      return
    }
    foreach ($process in $processes) {
      try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
      } catch {
        Write-Step "Could not stop process $($process.Id): $($_.Exception.Message)"
      }
    }
    Start-Sleep -Milliseconds 750
  }

  $remaining = @(Get-Process -Name "Cizi Code" -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    throw "Cizi Code is still running. Close it manually and run the installer again."
  }
}

function Assert-UserLocalPath($Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $local = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
  if (-not $full.StartsWith($local, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Install path must stay inside LOCALAPPDATA."
  }
}

function Get-HttpsOrigin($Url, $Label) {
  try {
    $uri = [Uri]$Url
  } catch {
    throw "$Label is not a valid URL."
  }
  if ($uri.Scheme -ne "https") {
    throw "$Label must use HTTPS."
  }
  return "$($uri.Scheme)://$($uri.Authority)"
}

function Assert-TrustedDownloadUrl($Url, $TrustedBaseUrl) {
  $downloadOrigin = Get-HttpsOrigin $Url "Release download URL"
  $trustedOrigin = Get-HttpsOrigin $TrustedBaseUrl "Base URL"
  if (-not $downloadOrigin.Equals($trustedOrigin, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release download URL must use the same origin as the update feed."
  }
}

function Find-VerifiedLocalZip($ExpectedHash) {
  $candidates = @()
  if ($LocalZipPath -and (Test-Path -LiteralPath $LocalZipPath)) {
    $candidates += Get-Item -LiteralPath $LocalZipPath
  }
  $candidates += Get-ChildItem -Path $env:TEMP -Directory -Filter "cizicode-update-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName "release.zip") -ErrorAction SilentlyContinue } |
    Where-Object { $_ }

  foreach ($candidate in ($candidates | Sort-Object LastWriteTime -Descending)) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $candidate.FullName).Hash.ToLowerInvariant()
    if ($hash -eq $ExpectedHash.ToLowerInvariant()) {
      return $candidate.FullName
    }
  }
  return $null
}

Assert-UserLocalPath $InstallRoot
Get-HttpsOrigin $BaseUrl "Base URL" | Out-Null

if (Test-Path $LogPath) {
  Remove-Item -LiteralPath $LogPath -Force -ErrorAction SilentlyContinue
}
Write-Step "Installer log: $LogPath"

Write-Step "Loading release manifest..."
$manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
if ($manifest -is [string]) {
  $manifestText = $manifest.TrimStart([char]0xFEFF) -replace '^\u00ef\u00bb\u00bf', ''
  $manifest = $manifestText | ConvertFrom-Json
}
if (-not $manifest.url -or -not $manifest.sha256 -or -not $manifest.version) {
  throw "Release manifest is missing required fields."
}
$downloadUrl = if ($ReleaseUrl) { $ReleaseUrl } else { $manifest.url }
$expectedHash = if ($ExpectedSha256) { $ExpectedSha256 } else { [string]$manifest.sha256 }
if (-not $downloadUrl -or -not $expectedHash) {
  throw "Release download URL or hash is missing."
}
Assert-TrustedDownloadUrl $downloadUrl $BaseUrl
if ($expectedHash -notmatch "^[a-fA-F0-9]{64}$") {
  throw "Release hash is invalid."
}

if (Test-Path $TempRoot) {
  Invoke-WithRetry "Removing temp directory" { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
}
New-Item -ItemType Directory -Path $TempRoot | Out-Null
New-Item -ItemType Directory -Path $ExtractDir | Out-Null

Write-Step "Preparing Cizi Code $($manifest.version)..."
$verifiedLocalZip = Find-VerifiedLocalZip $expectedHash
if ($verifiedLocalZip) {
  Write-Step "Using verified local package..."
  Copy-Item -LiteralPath $verifiedLocalZip -Destination $ZipPath -Force
} else {
  Write-Step "Downloading package..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $ZipPath -UseBasicParsing
}

Write-Step "Verifying package..."
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
  throw "Hash verification failed. Expected $expectedHash but got $actualHash."
}

Stop-CiziCodeProcesses

Write-Step "Extracting package..."
Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

if (-not (Test-Path (Join-Path $ExtractDir "Cizi Code.exe"))) {
  throw "Downloaded package does not contain Cizi Code.exe."
}

$backupDir = "$InstallRoot.previous"
if (Test-Path $backupDir) {
  Invoke-WithRetry "Removing previous backup" { Remove-Item -LiteralPath $backupDir -Recurse -Force }
}
if (Test-Path $InstallRoot) {
  Invoke-WithRetry "Backing up current install" { Move-Item -LiteralPath $InstallRoot -Destination $backupDir -Force }
}
New-Item -ItemType Directory -Path $InstallRoot | Out-Null
Invoke-WithRetry "Copying new install" { Copy-Item -Path (Join-Path $ExtractDir "*") -Destination $InstallRoot -Recurse -Force }

if (-not $NoShortcut) {
  Write-Step "Creating shortcuts..."
  $shell = New-Object -ComObject WScript.Shell
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Cizi Code.lnk"
  $startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Cizi Code"
  New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
  $startShortcut = Join-Path $startMenuDir "Cizi Code.lnk"

  foreach ($shortcutPath in @($desktopShortcut, $startShortcut)) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $AppExe
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.IconLocation = "$AppExe,0"
    $shortcut.Save()
  }
}

if (Test-Path $backupDir) {
  Invoke-WithRetry "Removing install backup" { Remove-Item -LiteralPath $backupDir -Recurse -Force }
}

if (-not $NoLaunch) {
  Write-Step "Starting Cizi Code..."
  Start-Process -FilePath $AppExe -WorkingDirectory $InstallRoot
}
Write-Step "Done."
