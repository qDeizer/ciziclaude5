// Claude Desktop's installer, ported from the ciziClaude4 "claude-merkez-backend"
// module (DownloadService + SignatureVerifier + ClaudePackageService +
// ClaudeRemovalService + ClaudeCleanupService).
//
// Claude Desktop is not shaped like the other tools this app installs, and the
// three things that make it different all live here:
//
//   1. The package is a quarter of a gigabyte, so the download is the bulk of
//      the wait. It is streamed in Node with a byte counter, and its exact size
//      is resolved up front with a one-byte range request, so the UI always has
//      a real percentage instead of a spinner. (The previous port shelled out to
//      curl and guessed progress by polling the file size.)
//   2. The artifact is executable code from the internet, so its Authenticode
//      signature is verified against Anthropic's publisher identity before
//      anything is installed.
//   3. Removing it is a package operation plus a known set of leftovers, not a
//      config file, so removal is previewed before it runs.
//
// This module downloads, verifies and removes. It never registers the package:
// that requires elevation (the MSIX ships a localSystem service) and lives in
// claudeInstallerContract.js / claudeLifecycle.js.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { windowsPowerShellEnvironment } = require("../windowsPowerShell");

const execFileAsync = promisify(execFile);

const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

// Anthropic publishes the installers on claude.ai and hands the actual bytes to
// a downloads host. Every hop, including the final one, has to stay inside this
// set — a redirect that leaves it is treated as an untrusted source.
const ALLOWED_INSTALLER_HOSTS = new Set([
  "claude.ai",
  "claude.com",
  "downloads.claude.ai",
  "downloads.claude.com",
]);

const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const CLAUDE_PACKAGE_FAMILY = "Claude_pzs8sxrjxfjjc";

const INSTALLER_URLS = Object.freeze({
  setupX64: "https://claude.ai/api/desktop/win32/x64/setup/latest/redirect",
  setupArm64: "https://claude.ai/api/desktop/win32/arm64/setup/latest/redirect",
  msixX64: "https://claude.ai/api/desktop/win32/x64/msix/latest/redirect",
  msixArm64: "https://claude.ai/api/desktop/win32/arm64/msix/latest/redirect",
});

// The installer kinds Anthropic publishes. "msix" is the full signed package;
// "squirrel" is the small online bootstrapper that downloads the rest itself.
const INSTALL_KINDS = Object.freeze(["msix", "squirrel"]);

function installerFailure(code, publicMessage, diagnostic = {}) {
  const error = new Error(publicMessage);
  error.code = code;
  error.ciziPublicMessage = publicMessage;
  error.ciziDiagnostic = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
  return error;
}

async function runPowerShell(script, { env = {}, timeout = 120000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const result = await execFileAsync(WINDOWS_POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], {
    windowsHide: true,
    timeout,
    maxBuffer,
    env: windowsPowerShellEnvironment(process.env, env),
  });
  return String(result.stdout || "").trim();
}

function assertInstallKind(kind) {
  if (!INSTALL_KINDS.includes(kind)) {
    throw installerFailure("CLAUDE_DESKTOP_INSTALL_KIND_INVALID", "The requested Claude Desktop installer type is not available.");
  }
  return kind;
}

function assertInstallerUrl(value, { stage = "downloading" } = {}) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw installerFailure("CLAUDE_DESKTOP_URL_INVALID", "The Claude Desktop download address is not valid.", { stage }); }
  if (url.protocol !== "https:" || !ALLOWED_INSTALLER_HOSTS.has(url.hostname.toLowerCase())) {
    throw installerFailure(
      "CLAUDE_DESKTOP_URL_UNTRUSTED",
      "The Claude Desktop download did not come from an official Anthropic address.",
      { stage, host: url.hostname },
    );
  }
  return url;
}

function resolveInstallSource(kind, architecture = process.arch) {
  assertInstallKind(kind);
  const normalized = String(architecture || "").toLowerCase() === "arm64" ? "arm64" : "x64";
  if (kind === "squirrel") {
    return {
      kind, architecture: normalized,
      fileName: `ClaudeSetup-${normalized}.exe`,
      label: "Claude Desktop çevrimiçi kurucusu",
      url: normalized === "arm64" ? INSTALLER_URLS.setupArm64 : INSTALLER_URLS.setupX64,
    };
  }
  return {
    kind, architecture: normalized,
    fileName: `Claude-${normalized}.msix`,
    label: "Claude Desktop paketi",
    url: normalized === "arm64" ? INSTALLER_URLS.msixArm64 : INSTALLER_URLS.msixX64,
  };
}

function requestHeaders({ range = false } = {}) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    Accept: "application/octet-stream,application/x-msdownload;q=0.9,*/*;q=0.8",
    ...(range ? { Range: "bytes=0-0" } : {}),
  };
}

function responseDetails(response, requestedUrl) {
  // A range response reports the full size in Content-Range; a normal response
  // reports it in Content-Length.
  const range = String(response.headers.get("content-range") || "").match(/\/(\d+)$/);
  const length = range ? Number(range[1]) : Number(response.headers.get("content-length"));
  return {
    url: requestedUrl,
    finalUrl: response.url || requestedUrl,
    contentLength: Number.isFinite(length) && length > 0 ? length : null,
    contentType: String(response.headers.get("content-type") || "").toLowerCase(),
    contentDisposition: String(response.headers.get("content-disposition") || ""),
  };
}

function assertResponseSize(length, maxBytes = MAX_INSTALLER_BYTES) {
  if (length != null && (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes)) {
    throw installerFailure("CLAUDE_DESKTOP_DOWNLOAD_TOO_LARGE", "The Claude Desktop package is larger than this app will download.", { stage: "downloading", contentLength: length });
  }
}

// A redirect that ends on an HTML error page or a JSON body is not an
// installer. This catches an outage or a captive portal before a quarter of a
// gigabyte of the wrong thing is written to disk and handed to Windows.
function assertArtifactResponse(kind, details) {
  const expectedExtension = kind === "squirrel" ? ".exe" : ".msix";
  const contentType = String(details.contentType || "").toLowerCase();
  if (/\b(?:text\/html|application\/json|text\/json)\b/.test(contentType)) {
    throw installerFailure("CLAUDE_DESKTOP_RESPONSE_INVALID", "The Claude Desktop download address did not return an installer.", { stage: "downloading", contentType });
  }
  assertInstallerUrl(details.finalUrl, { stage: "downloading" });
  let finalPath = "";
  try { finalPath = decodeURIComponent(new URL(details.finalUrl).pathname).toLowerCase(); }
  catch { throw installerFailure("CLAUDE_DESKTOP_RESPONSE_INVALID", "The Claude Desktop download was redirected to an invalid address.", { stage: "downloading" }); }
  const disposition = String(details.contentDisposition || "").toLowerCase();
  const dispositionMatches = new RegExp(`filename[^;]*${expectedExtension.replace(".", "\\.")}`).test(disposition);
  if (!finalPath.endsWith(expectedExtension) && !dispositionMatches) {
    throw installerFailure(
      "CLAUDE_DESKTOP_RESPONSE_INVALID",
      `The Claude Desktop download did not return a ${expectedExtension} file.`,
      { stage: "downloading", finalPath },
    );
  }
}

// Resolves the exact published size without downloading the body, so the very
// first progress event can already report a real percentage. A one-byte range
// request is used because the redirect endpoint rejects HEAD.
async function inspectDownload(url, { fetchImpl = globalThis.fetch } = {}) {
  try {
    assertInstallerUrl(url);
    const response = await fetchImpl(url, { method: "GET", redirect: "follow", headers: requestHeaders({ range: true }) });
    if (!response.ok) {
      await response.body?.cancel?.();
      return { url, finalUrl: response.url || url, contentLength: null, contentType: null, contentDisposition: null };
    }
    const details = responseDetails(response, url);
    assertResponseSize(details.contentLength);
    await response.body?.cancel?.();
    return details;
  } catch {
    // A size probe is an optimisation, never a gate: the download still runs
    // and still reports the bytes it has received.
    return { url, finalUrl: url, contentLength: null, contentType: null, contentDisposition: null };
  }
}

// Streams the artifact to disk, reporting every chunk. Unlike a file-size poll,
// the byte count here comes from the transfer itself, so the percentage is
// exact and starts moving immediately.
async function downloadInstaller(url, destination, {
  onProgress = () => {},
  validateResponse = () => {},
  knownTotalBytes = null,
  maxBytes = MAX_INSTALLER_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertInstallerUrl(url);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.part`;
  fs.rmSync(temporary, { force: true });
  try {
    const response = await fetchImpl(url, { redirect: "follow", headers: requestHeaders() });
    if (!response.ok || !response.body) {
      throw installerFailure("CLAUDE_DESKTOP_DOWNLOAD_FAILED", "The Claude Desktop download server did not return the package.", { stage: "downloading", status: response.status });
    }
    const details = responseDetails(response, url);
    assertResponseSize(details.contentLength, maxBytes);
    validateResponse(details);
    const total = details.contentLength
      || (Number.isSafeInteger(knownTotalBytes) && knownTotalBytes > 0 ? knownTotalBytes : 0);
    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(installerFailure("CLAUDE_DESKTOP_DOWNLOAD_TOO_LARGE", "The Claude Desktop package is larger than this app will download.", { stage: "downloading" }));
          return;
        }
        try { onProgress({ received, total: total || null, percent: total ? Math.floor((received / total) * 100) : null }); }
        catch { /* a progress listener must never interrupt the download */ }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
    return { filePath: destination, receivedBytes: received, ...details };
  } catch (cause) {
    fs.rmSync(temporary, { force: true });
    if (cause?.ciziPublicMessage) throw cause;
    throw installerFailure("CLAUDE_DESKTOP_DOWNLOAD_FAILED", "The Claude Desktop package could not be downloaded. Check your connection and free disk space, then try again.", { stage: "downloading" });
  }
}

// Anthropic signs both installers. The subject is matched on the organisation
// rather than the exact certificate string, because the certificate is reissued
// periodically; an optional thumbprint pin can be supplied by the environment
// for a deployment that wants to be stricter.
const ANTHROPIC_THUMBPRINT_PIN = String(process.env.CLAUDE_ANTHROPIC_SIGNER_THUMBPRINT || "").replace(/\s/g, "").toUpperCase();

async function verifyAnthropicSignature(filePath, {
  runPowerShellFn = runPowerShell,
  expectedThumbprint = ANTHROPIC_THUMBPRINT_PIN,
} = {}) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$s=Get-AuthenticodeSignature -LiteralPath $env:CIZI_CLAUDE_ARTIFACT",
    "[pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;thumbprint=[string]$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress",
  ].join("\n");
  let signature;
  try {
    const output = await runPowerShellFn(script, { env: { CIZI_CLAUDE_ARTIFACT: filePath }, timeout: 60000, maxBuffer: 64 * 1024 });
    signature = JSON.parse(output);
  } catch (cause) {
    throw installerFailure("CLAUDE_DESKTOP_SIGNATURE_CHECK_FAILED", "Windows could not check the Claude Desktop package signature.", { stage: "verifying-signature" });
  }
  const subject = String(signature?.subject || "");
  const organizationTrusted = /(?:^|,)\s*CN="?Anthropic,? PBC"?/i.test(subject)
    && /(?:^|,)\s*O="?Anthropic,? PBC"?/i.test(subject);
  const thumbprint = String(signature?.thumbprint || "").replace(/\s/g, "").toUpperCase();
  const thumbprintTrusted = !expectedThumbprint || thumbprint === expectedThumbprint;
  if (signature?.status !== "Valid" || !organizationTrusted || !thumbprintTrusted) {
    throw installerFailure(
      "CLAUDE_DESKTOP_SIGNATURE_UNTRUSTED",
      "The downloaded file does not carry a valid Anthropic signature, so it was not installed.",
      { stage: "verifying-signature", signatureStatus: signature?.status || null },
    );
  }
  return { status: signature.status, subject, thumbprint };
}

function assertLocalArtifact(kind, filePath) {
  const expected = kind === "squirrel" ? ".exe" : ".msix";
  if (path.extname(String(filePath || "")).toLowerCase() !== expected) {
    throw installerFailure("CLAUDE_DESKTOP_ARTIFACT_TYPE_INVALID", `The selected Claude Desktop installation needs a ${expected} file.`, { stage: "verifying-signature" });
  }
}

// --- Removal -------------------------------------------------------------
//
// Everything Claude Desktop leaves on a machine, so a removal can be shown to
// the user before it runs. Cizi Code's own integration data is listed
// separately: it is removed with the switch, not with the application.

function claudeLeftoverDirectories(env = process.env) {
  return [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "AnthropicClaude"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Claude"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Claude-3p"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Claude"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Packages", CLAUDE_PACKAGE_FAMILY),
    env.APPDATA && path.join(env.APPDATA, "Claude"),
    env.APPDATA && path.join(env.APPDATA, "AnthropicClaude"),
  ].filter(Boolean);
}

// The Claude Code CLI keeps its settings and history in ~/.claude. It is a
// different product with its own switch and its own uninstall, so removing
// Claude Desktop must never touch it.
function preservedDirectories(env = process.env) {
  return [env.USERPROFILE && path.join(env.USERPROFILE, ".claude")].filter(Boolean);
}

function claudeLeftoverRegistryKeys() {
  return [
    "HKCU\\SOFTWARE\\Policies\\Claude",
    "HKCU\\Software\\Classes\\claude",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnthropicClaude",
  ];
}

function planRemoval({ installed, version, installKind, env = process.env } = {}) {
  const remove = [
    ...(installed ? [{
      path: installKind === "squirrel" ? "Claude Desktop (Update.exe --uninstall)" : `Claude Desktop paketi${version ? ` (${version})` : ""}`,
      reason: "Uygulamanın kendisi",
    }] : []),
    ...claudeLeftoverDirectories(env).map((target) => ({
      path: target,
      reason: "Claude Desktop ayarları, önbelleği ve oturum verisi",
      exists: fs.existsSync(target),
    })),
    ...claudeLeftoverRegistryKeys().map((key) => ({ path: key, reason: "Claude Desktop kayıt defteri girdisi" })),
  ];
  return {
    destructive: true,
    installed: !!installed,
    remove: remove.filter((item) => item.exists !== false),
    preserve: [
      ...preservedDirectories(env).map((target) => ({ path: target, reason: "Claude Code CLI'ye ait — Claude Desktop ile silinmez" })),
      { path: "Cizi Code ayarları", reason: "Anahtar kapatıldığında orijinal ayarlarınız zaten geri yüklenir" },
    ],
    packageFamily: CLAUDE_PACKAGE_FAMILY,
  };
}

// Only Anthropic's own uninstaller is ever executed. A registry uninstall
// string that names anything else is refused rather than run.
function parseTrustedUninstallCommand(commandLine) {
  const match = String(commandLine || "").trim().match(/^(?:"([^"]+)"|(\S+))(.*)$/);
  if (!match) throw installerFailure("CLAUDE_DESKTOP_UNINSTALL_COMMAND_INVALID", "The Claude Desktop uninstall command could not be read.", { stage: "uninstalling" });
  const file = match[1] || match[2];
  if (!/^(?:update|unins\d*|uninstall)\.exe$/i.test(path.basename(file))) {
    throw installerFailure("CLAUDE_DESKTOP_UNINSTALL_COMMAND_UNTRUSTED", "An unrecognised uninstall program was refused for safety.", { stage: "uninstalling" });
  }
  const args = [...String(match[3] || "").matchAll(/"([^"]*)"|(\S+)/g)].map((item) => item[1] ?? item[2]);
  return { file, args };
}

function removeMsixScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$p=Get-AppxPackage -PackageTypeFilter Main|Where-Object{$_.PackageFullName -ceq $env:CIZI_CLAUDE_PACKAGE}|Select-Object -First 1",
    "if($p){Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop}",
  ].join("\n");
}

// Clears what the package removal leaves behind. Every path is one this module
// listed in the removal plan, and ~/.claude is never among them.
function removeLeftoversScript() {
  return [
    "$ErrorActionPreference='Continue'",
    `$family='${CLAUDE_PACKAGE_FAMILY}'`,
    "$dirs=@((Join-Path $env:LOCALAPPDATA 'AnthropicClaude'),(Join-Path $env:LOCALAPPDATA 'Claude'),(Join-Path $env:LOCALAPPDATA 'Claude-3p'),(Join-Path $env:LOCALAPPDATA 'Programs\\Claude'),(Join-Path $env:LOCALAPPDATA ('Packages\\'+$family)),(Join-Path $env:APPDATA 'Claude'),(Join-Path $env:APPDATA 'AnthropicClaude'))",
    "foreach($dir in $dirs){if($dir -and (Test-Path -LiteralPath $dir)){Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue}}",
    "$keys=@('HKCU:\\SOFTWARE\\Policies\\Claude','HKCU:\\Software\\Classes\\claude','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AnthropicClaude')",
    "foreach($key in $keys){if(Test-Path -LiteralPath $key){Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue}}",
    // Only Run entries that actually point at Claude Desktop are removed; a
    // "Claude Code" entry belongs to the other product and is left alone.
    "$run='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    "if(Test-Path $run){(Get-ItemProperty $run).PSObject.Properties|Where-Object{$_.Name -notmatch '^PS' -and $_.Name -notmatch 'Code' -and ($_.Name -match 'Claude' -or [string]$_.Value -match 'AnthropicClaude')}|ForEach-Object{Remove-ItemProperty -LiteralPath $run -Name $_.Name -Force -ErrorAction SilentlyContinue}}",
    "$roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('StartMenu'))",
    "foreach($root in $roots){if($root -and (Test-Path $root)){Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue|Where-Object{$_.BaseName -match '^Claude(?: Desktop)?$'}|Remove-Item -Force -ErrorAction SilentlyContinue}}",
  ].join("\n");
}

module.exports = {
  ALLOWED_INSTALLER_HOSTS,
  MAX_INSTALLER_BYTES,
  CLAUDE_PACKAGE_FAMILY,
  INSTALLER_URLS,
  INSTALL_KINDS,
  installerFailure,
  runPowerShell,
  assertInstallKind,
  assertInstallerUrl,
  resolveInstallSource,
  requestHeaders,
  responseDetails,
  assertResponseSize,
  assertArtifactResponse,
  assertLocalArtifact,
  inspectDownload,
  downloadInstaller,
  verifyAnthropicSignature,
  claudeLeftoverDirectories,
  preservedDirectories,
  claudeLeftoverRegistryKeys,
  planRemoval,
  parseTrustedUninstallCommand,
  removeMsixScript,
  removeLeftoversScript,
};
