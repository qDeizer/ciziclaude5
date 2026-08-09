const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const lifecycle = require("./claudeLifecycle");
const packageIdentity = require("./claudePackageIdentity");
const { version: CIZI_VERSION } = require("../../../package.json");
const updateTrust = require("../claudeOverlayTrust.json");

const OVERLAY_IDENTITY_NAME = "CiziCode.ClaudeTurkish";
const EXPECTED_PATCH_SET_VERSION = 5;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OVERLAY_FEED_BASE = "https://cizicode.me/desktop-updates/claude-overlays";
const MAX_REMOTE_MANIFEST_BYTES = 64 * 1024;
const MAX_REMOTE_PACKAGE_BYTES = 256 * 1024 * 1024;
const SOURCE_ROOT = path.join(__dirname, "..", "..", "..");
const DEVELOPMENT_OVERLAY_ROOT = path.join(SOURCE_ROOT, "release-input", "claude-overlays");

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

function bundledPortableQaOverlayRoot() {
  if (process.defaultApp === true || !process.resourcesPath) return null;
  const manifest = safeReadJson(path.join(process.resourcesPath, "..", "build-manifest.json"));
  if (manifest?.schemaVersion !== 1 || manifest.portableQaOnly !== true
      || manifest.includeClaudeOverlays !== true) return null;
  return path.join(process.resourcesPath, "claude-overlays");
}

function developmentSignerTrust(options = {}) {
  const bundledRoot = bundledPortableQaOverlayRoot();
  const enabled = options.enabled ?? (process.defaultApp === true || !!bundledRoot);
  const root = options.root || bundledRoot || DEVELOPMENT_OVERLAY_ROOT;
  if (!enabled || !fs.existsSync(root)) return null;
  const subjects = new Set();
  const thumbprints = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !versionParts(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const manifest = safeReadJson(path.join(directory, "manifest.json"));
    if (manifest?.schemaVersion !== 1 || manifest.portableQaOnly !== true
        || manifest.publishable !== true || manifest.mainVersion !== entry.name
        || manifest.overlayIdentityName !== OVERLAY_IDENTITY_NAME
        || manifest.fileName !== "overlay.msix"
        || !fs.existsSync(path.join(directory, "overlay.msix"))
        || typeof manifest.signerSubject !== "string" || !manifest.signerSubject.trim()
        || !/^[A-F0-9]{40}$/.test(String(manifest.signerThumbprint || ""))) continue;
    subjects.add(manifest.signerSubject.trim());
    thumbprints.add(String(manifest.signerThumbprint).toUpperCase());
  }
  if (!subjects.size || !thumbprints.size) return null;
  return {
    allowedSignerSubjects: [...subjects],
    allowedCertificateThumbprints: [...thumbprints],
  };
}

const runtimeUpdateTrust = (() => {
  const development = developmentSignerTrust();
  if (!development) return updateTrust;
  return {
    allowedSignerSubjects: [...(updateTrust.allowedSignerSubjects || []), ...development.allowedSignerSubjects],
    allowedCertificateThumbprints: [
      ...(updateTrust.allowedCertificateThumbprints || []),
      ...development.allowedCertificateThumbprints,
    ],
  };
})();

function versionParts(value) {
  if (!/^\d+(?:\.\d+){2,3}$/.test(String(value || ""))) return null;
  return String(value).split(".").map((part) => Number(part));
}
function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

function normalizedSignerTrust(trust = runtimeUpdateTrust) {
  const subjects = Array.isArray(trust?.allowedSignerSubjects)
    ? trust.allowedSignerSubjects.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const thumbprints = Array.isArray(trust?.allowedCertificateThumbprints)
    ? trust.allowedCertificateThumbprints
      .map((value) => String(value).replace(/\s+/g, "").toUpperCase())
      .filter((value) => /^[A-F0-9]{40,64}$/.test(value))
    : [];
  return { subjects, thumbprints };
}

function assertTrustedSigner(subject, thumbprint, trust = runtimeUpdateTrust) {
  const configured = normalizedSignerTrust(trust);
  const normalizedSubject = String(subject || "").trim();
  const normalizedThumbprint = String(thumbprint || "").replace(/\s+/g, "").toUpperCase();
  if (!configured.subjects.length || !configured.thumbprints.length) {
    throw codedError("CLAUDE_OVERLAY_TRUST_NOT_CONFIGURED", "Claude translation signing trust is not configured for this Cizi Code build.");
  }
  if (!configured.subjects.includes(normalizedSubject) || !configured.thumbprints.includes(normalizedThumbprint)) {
    throw codedError("CLAUDE_OVERLAY_SIGNER_MISMATCH", "The Claude translation package signer is not trusted by this Cizi Code build.");
  }
  return { subject: normalizedSubject, thumbprint: normalizedThumbprint };
}

function artifactRoots(version) {
  const roots = [];
  const add = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    if (!roots.some((item) => item.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  };
  if (process.env.CIZI_CLAUDE_OVERLAY_ROOT) {
    add(path.join(process.env.CIZI_CLAUDE_OVERLAY_ROOT, version));
    add(process.env.CIZI_CLAUDE_OVERLAY_ROOT);
  }
  if (process.resourcesPath) {
    add(path.join(process.resourcesPath, "claude-overlays", version));
    add(path.join(process.resourcesPath, "claude-overlay", version));
    add(path.join(process.resourcesPath, "claude-overlay"));
  }
  // Source runs may consume only the explicitly QA-marked, locally prepared
  // overlay for the installed Claude version. Packaged applications never
  // use release-input and continue to require production trust pins.
  if (process.defaultApp === true) add(path.join(DEVELOPMENT_OVERLAY_ROOT, version));
  // Source-tree fallback is useful for release verification and never creates
  // an overlay on an end-user machine. Production builds use resourcesPath.
  add(path.join(__dirname, "..", "..", "..", "artifacts", "claude-overlay", version));
  add(path.join(__dirname, "..", "..", "..", "artifacts", "claude-overlay"));
  return roots;
}

function remoteCacheRoot(version, base = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "CiziCodeData",
  "ClaudeDesktop",
  "overlay-cache",
)) {
  if (!versionParts(version)) throw codedError("CLAUDE_OVERLAY_VERSION_INVALID", "The Claude Desktop version is invalid.");
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, version);
  if (path.dirname(resolved).toLowerCase() !== resolvedBase.toLowerCase()) {
    throw codedError("CLAUDE_OVERLAY_CACHE_PATH_INVALID", "The Claude translation cache path is invalid.");
  }
  return resolved;
}

function remoteArtifactUrl(version, fileName, feedBase = OVERLAY_FEED_BASE) {
  if (!versionParts(version) || !["manifest.json", "overlay.msix"].includes(fileName)) {
    throw codedError("CLAUDE_OVERLAY_REMOTE_URL_INVALID", "The Claude translation download URL is invalid.");
  }
  let feed;
  let candidate;
  try {
    feed = new URL(`${String(feedBase || "").replace(/\/+$/, "")}/`);
    candidate = new URL(`${encodeURIComponent(version)}/${fileName}`, feed);
  } catch {
    throw codedError("CLAUDE_OVERLAY_REMOTE_URL_INVALID", "The Claude translation download URL is invalid.");
  }
  if (feed.protocol !== "https:" || candidate.protocol !== "https:" || candidate.origin !== feed.origin
      || !candidate.pathname.startsWith(feed.pathname)) {
    throw codedError("CLAUDE_OVERLAY_REMOTE_URL_INVALID", "The Claude translation download must stay on the configured HTTPS service.");
  }
  return candidate.toString();
}

async function responseBuffer(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw codedError("CLAUDE_OVERLAY_DOWNLOAD_TOO_LARGE", "The Claude translation download is larger than allowed.");
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw codedError("CLAUDE_OVERLAY_DOWNLOAD_INVALID", "The Claude translation download body is missing.");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw codedError("CLAUDE_OVERLAY_DOWNLOAD_TOO_LARGE", "The Claude translation download is larger than allowed.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function responseFile(response, targetPath, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw codedError("CLAUDE_OVERLAY_DOWNLOAD_TOO_LARGE", "The Claude translation package is larger than allowed.");
  }
  if (!response.body) throw codedError("CLAUDE_OVERLAY_DOWNLOAD_INVALID", "The Claude translation package body is missing.");
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  const hash = crypto.createHash("sha256");
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(codedError("CLAUDE_OVERLAY_DOWNLOAD_TOO_LARGE", "The Claude translation package is larger than allowed."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    fs.renameSync(temporaryPath, targetPath);
    return { bytes: total, sha256: hash.digest("hex") };
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function fetchWithTimeout(url, { fetchFn = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchFn !== "function") throw codedError("CLAUDE_OVERLAY_FETCH_UNAVAILABLE", "Secure Claude translation downloads are unavailable.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { cache: "no-store", redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertRecordMatchesMain(record, main) {
  if (record?.schemaVersion !== 1 || !record.mainPackage || !record.overlay || !record.package) {
    throw codedError("CLAUDE_OVERLAY_METADATA_INVALID", "The Claude translation package metadata is invalid.");
  }
  const expected = {
    PackageFullName: main.packageFullName,
    PackageFamilyName: main.packageFamilyName,
    Publisher: main.publisher,
    Version: main.version,
    InstallLocation: main.installLocation,
    AppUserModelId: main.appUserModelId,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(record.mainPackage[key] || "") !== String(value || "")) {
      throw codedError("CLAUDE_OVERLAY_MAIN_MISMATCH", "The available translation package was built for a different Claude Desktop package.");
    }
  }
  if (record.overlay.identityName !== OVERLAY_IDENTITY_NAME
      || !String(record.overlay.publisher || "").trim()
      || String(record.overlay.version || "") !== main.version) {
    throw codedError("CLAUDE_OVERLAY_IDENTITY_INVALID", "The Claude translation package identity is invalid.");
  }
  const fileName = String(record.package.file || "");
  if (!fileName || path.basename(fileName) !== fileName || !HASH_PATTERN.test(String(record.package.sha256 || "").toLowerCase())) {
    throw codedError("CLAUDE_OVERLAY_METADATA_INVALID", "The Claude translation package file metadata is invalid.");
  }
}

function assertReleaseManifest(manifest, main, trust = runtimeUpdateTrust) {
  if (manifest?.schemaVersion !== 1 || manifest.publishable !== true
      || manifest.mainPackageFullName !== main.packageFullName
      || manifest.mainVersion !== main.version
      || manifest.overlayIdentityName !== OVERLAY_IDENTITY_NAME
      || manifest.fileName !== "overlay.msix"
      || !HASH_PATTERN.test(String(manifest.sha256 || "").toLowerCase())
      || typeof manifest.signerSubject !== "string" || !manifest.signerSubject.trim()
      || (!manifest.portableQaOnly && /devpoc|test|self[- ]signed|localhost/i.test(manifest.signerSubject))
      || !/^[A-F0-9]{40}$/.test(String(manifest.signerThumbprint || ""))
      || manifest.patchSetVersion !== EXPECTED_PATCH_SET_VERSION
      || !versionParts(manifest.minimumCiziVersion)
      || compareVersions(manifest.minimumCiziVersion, CIZI_VERSION) > 0) {
    throw codedError("CLAUDE_OVERLAY_METADATA_INVALID", "The Claude translation release manifest is invalid or incompatible with this Cizi Code version.");
  }
  assertTrustedSigner(manifest.signerSubject, manifest.signerThumbprint, trust);
}

function verifiedArtifactFromReleaseManifest(root, manifest, main, trust = runtimeUpdateTrust) {
  assertReleaseManifest(manifest, main, trust);
  const packagePath = path.resolve(root, manifest.fileName);
  if (path.dirname(packagePath).toLowerCase() !== path.resolve(root).toLowerCase()
      || !fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
    throw codedError("CLAUDE_OVERLAY_PACKAGE_MISSING", "The signed Claude translation package is missing.");
  }
  const actualHash = sha256File(packagePath);
  if (actualHash !== String(manifest.sha256).toLowerCase()) {
    throw codedError("CLAUDE_OVERLAY_HASH_MISMATCH", "The Claude translation package failed its integrity check.");
  }
  return Object.freeze({
    recordPath: path.join(root, "manifest.json"),
    packagePath,
    packageSha256: actualHash,
    identityName: manifest.overlayIdentityName,
    publisher: manifest.signerSubject,
    signerThumbprint: manifest.signerThumbprint,
    version: manifest.mainVersion,
    mainPackageFullName: manifest.mainPackageFullName,
    patchSetVersion: manifest.patchSetVersion,
    minimumCiziVersion: manifest.minimumCiziVersion,
    portableQaOnly: manifest.portableQaOnly === true,
  });
}

function findVerifiedArtifact(main, { roots = artifactRoots(main.version), trust = runtimeUpdateTrust } = {}) {
  for (const root of roots) {
    const releaseManifestPath = path.join(root, "manifest.json");
    if (fs.existsSync(releaseManifestPath)) {
      const manifest = safeReadJson(releaseManifestPath);
      return verifiedArtifactFromReleaseManifest(root, manifest, main, trust);
    }
    const recordPath = path.join(root, "overlay-build.json");
    if (!fs.existsSync(recordPath)) continue;
    const record = safeReadJson(recordPath);
    assertRecordMatchesMain(record, main);
    if (record.publishable !== true
        || !/^[A-F0-9]{40}$/.test(String(record.overlay.signerThumbprint || ""))
        || record.overlay.patchSetVersion !== EXPECTED_PATCH_SET_VERSION
        || !versionParts(record.overlay.minimumCiziVersion)
        || compareVersions(record.overlay.minimumCiziVersion, CIZI_VERSION) > 0) {
      throw codedError("CLAUDE_OVERLAY_METADATA_INVALID", "The legacy Claude translation build record is not publishable.");
    }
    assertTrustedSigner(record.overlay.publisher, record.overlay.signerThumbprint, trust);
    const packagePath = path.resolve(root, record.package.file);
    if (path.dirname(packagePath).toLowerCase() !== path.resolve(root).toLowerCase()
        || !fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
      throw codedError("CLAUDE_OVERLAY_PACKAGE_MISSING", "The signed Claude translation package is missing.");
    }
    const actualHash = sha256File(packagePath);
    if (actualHash !== String(record.package.sha256).toLowerCase()) {
      throw codedError("CLAUDE_OVERLAY_HASH_MISMATCH", "The Claude translation package failed its integrity check.");
    }
    return Object.freeze({
      recordPath,
      packagePath,
      packageSha256: actualHash,
      identityName: record.overlay.identityName,
      publisher: record.overlay.publisher,
      signerThumbprint: record.overlay.signerThumbprint,
      version: record.overlay.version,
      mainPackageFullName: record.mainPackage.PackageFullName,
      patchSetVersion: record.overlay.patchSetVersion,
      minimumCiziVersion: record.overlay.minimumCiziVersion,
    });
  }
  return null;
}

async function fetchRemoteArtifact(main, options = {}) {
  const trust = options.trust || runtimeUpdateTrust;
  const configuredTrust = normalizedSignerTrust(trust);
  // Development/unsigned builds intentionally have no production signer pins.
  // They must not download or trust an overlay based only on server metadata.
  if (!configuredTrust.subjects.length || !configuredTrust.thumbprints.length) return null;

  const cacheRoot = remoteCacheRoot(main.version, options.cacheBase);
  const cachedManifest = path.join(cacheRoot, "manifest.json");
  const cachedPackage = path.join(cacheRoot, "overlay.msix");
  if (fs.existsSync(cachedManifest) && fs.existsSync(cachedPackage)) {
    try {
      return verifiedArtifactFromReleaseManifest(cacheRoot, safeReadJson(cachedManifest), main, trust);
    } catch {
      // A partial disk write, interrupted update, antivirus quarantine or old
      // cached release must not leave translation repair permanently stuck.
      // Discard the untrusted pair and fetch the pinned release again below.
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  }

  const fetchOptions = { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs };
  let manifestResponse;
  try {
    manifestResponse = await fetchWithTimeout(
      remoteArtifactUrl(main.version, "manifest.json", options.feedBase),
      fetchOptions,
    );
  } catch (error) {
    if (error?.code === "CLAUDE_OVERLAY_REMOTE_URL_INVALID") throw error;
    return null;
  }
  if (manifestResponse.status === 404) return null;
  if (!manifestResponse.ok) return null;
  const manifestMediaType = String(manifestResponse.headers?.get?.("content-type") || "")
    .split(";", 1)[0].trim().toLowerCase();
  // cizicode.me is also a web application and some deployments route missing
  // static paths to index.html with HTTP 200. That means "not published yet",
  // not a corrupt signed release. Never parse or cache the HTML fallback.
  if (manifestMediaType && manifestMediaType !== "application/json" && !manifestMediaType.endsWith("+json")) {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse((await responseBuffer(manifestResponse, MAX_REMOTE_MANIFEST_BYTES)).toString("utf8").replace(/^\uFEFF/, ""));
  } catch (cause) {
    if (cause?.code) throw cause;
    throw codedError("CLAUDE_OVERLAY_METADATA_INVALID", "The remote Claude translation manifest is invalid.");
  }
  assertReleaseManifest(manifest, main, trust);

  let packageResponse;
  try {
    packageResponse = await fetchWithTimeout(
      remoteArtifactUrl(main.version, "overlay.msix", options.feedBase),
      fetchOptions,
    );
  } catch {
    return null;
  }
  if (!packageResponse.ok) return null;

  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  try {
    const downloaded = await responseFile(packageResponse, cachedPackage, MAX_REMOTE_PACKAGE_BYTES);
    if (downloaded.sha256 !== String(manifest.sha256).toLowerCase()) {
      throw codedError("CLAUDE_OVERLAY_HASH_MISMATCH", "The downloaded Claude translation package failed its integrity check.");
    }
    const temporaryManifest = `${cachedManifest}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryManifest, cachedManifest);
    return verifiedArtifactFromReleaseManifest(cacheRoot, manifest, main, trust);
  } catch (error) {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseOptionalPackage(output) {
  const text = String(output || "").trim();
  if (!text || text === "null") return null;
  const value = JSON.parse(text);
  if (!value || Array.isArray(value)) throw codedError("CLAUDE_OVERLAY_STATUS_INVALID", "Windows returned an invalid Claude translation package status.");
  return {
    name: String(value.Name || ""),
    packageFullName: String(value.PackageFullName || ""),
    packageFamilyName: String(value.PackageFamilyName || ""),
    publisher: String(value.Publisher || ""),
    version: String(value.Version || ""),
    status: String(value.Status || ""),
  };
}

async function queryInstalledOverlay({ runPowerShellFn = lifecycle.runPowerShell } = {}) {
  const script = [
    "$p=Get-AppxPackage -PackageTypeFilter Optional | Where-Object {$_.Name -eq $env:CIZI_OVERLAY_NAME} | Sort-Object Version -Descending | Select-Object -First 1",
    "if($null -eq $p){'null'}else{[pscustomobject]@{Name=[string]$p.Name;PackageFullName=[string]$p.PackageFullName;PackageFamilyName=[string]$p.PackageFamilyName;Publisher=[string]$p.Publisher;Version=[string]$p.Version;Status=[string]$p.Status}|ConvertTo-Json -Compress}",
  ].join("\n");
  const output = await runPowerShellFn(script, {
    timeout: 20000,
    env: { CIZI_OVERLAY_NAME: OVERLAY_IDENTITY_NAME },
  });
  return parseOptionalPackage(output);
}

function assertOwnedOverlay(candidate, expectedPublisher) {
  if (!candidate || candidate.name !== OVERLAY_IDENTITY_NAME
      || !expectedPublisher || candidate.publisher !== expectedPublisher) {
    throw codedError("CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED", "Cizi Code could not verify ownership of the installed Claude translation package.");
  }
  packageIdentity.assertOverlayRemovalAllowed(candidate);
  return candidate;
}

function relatedSetRegistrationScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$main=Get-AppxPackage -Name Claude | Where-Object {$_.PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc' -and $_.Status -eq 'Ok'} | Sort-Object Version -Descending | Select-Object -First 1",
    "if($null -eq $main){throw 'CLAUDE_MAIN_PACKAGE_IDENTITY_INVALID'}",
    "$ownedFamily=[string]$env:CIZI_OVERLAY_FAMILY",
    "$ownedName=[string]$env:CIZI_OVERLAY_NAME",
    "$ownedPublisher=[string]$env:CIZI_OVERLAY_PUBLISHER",
    "$includeOwned=[string]$env:CIZI_INCLUDE_OWNED -ceq '1'",
    "if([string]::IsNullOrWhiteSpace($ownedFamily)-or [string]::IsNullOrWhiteSpace($ownedName)-or [string]::IsNullOrWhiteSpace($ownedPublisher)){throw 'CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED'}",
    "$families=New-Object System.Collections.Generic.List[string]",
    "$ownedFound=$false",
    "foreach($candidate in @(Get-AppxPackage -PackageTypeFilter Optional)){",
    "try{$manifest=Get-AppxPackageManifest -Package $candidate.PackageFullName -ErrorAction Stop}catch{continue}",
    "$dependency=@($manifest.Package.Dependencies.MainPackageDependency)|Where-Object {[string]$_.Name -ceq 'Claude' -and [string]$_.Publisher -ceq [string]$main.Publisher}|Select-Object -First 1",
    "if($null -eq $dependency){continue}",
    "$isOwned=[string]$candidate.PackageFamilyName -ceq $ownedFamily -and [string]$candidate.Name -ceq $ownedName -and [string]$candidate.Publisher -ceq $ownedPublisher",
    "if($isOwned){$ownedFound=$true;if(!$includeOwned){continue}}",
    "if(!$families.Contains([string]$candidate.PackageFamilyName)){$families.Add([string]$candidate.PackageFamilyName)}",
    "}",
    "if(!$ownedFound){throw 'CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED'}",
    "$parameters=@{MainPackage=[string]$main.PackageFamilyName;RegisterByFamilyName=$true;ForceApplicationShutdown=$true}",
    "if($families.Count -gt 0){$parameters.OptionalPackages=[string[]]$families.ToArray()}",
    "Add-AppxPackage @parameters -ErrorAction Stop",
    "[pscustomobject]@{ok=$true;included=$includeOwned;optionalFamilies=@($families)}|ConvertTo-Json -Compress",
  ].join("\n");
}

async function registerRelatedSet(candidate, expectedPublisher, {
  includeOwned,
  runPowerShellFn = lifecycle.runPowerShell,
} = {}) {
  const owned = assertOwnedOverlay(candidate, expectedPublisher);
  const output = await runPowerShellFn(relatedSetRegistrationScript(), {
    timeout: 120000,
    env: {
      CIZI_OVERLAY_FAMILY: owned.packageFamilyName,
      CIZI_OVERLAY_NAME: owned.name,
      CIZI_OVERLAY_PUBLISHER: expectedPublisher,
      CIZI_INCLUDE_OWNED: includeOwned ? "1" : "0",
    },
  });
  try {
    const result = JSON.parse(String(output || "{}"));
    if (result.ok !== true || result.included !== !!includeOwned) throw new Error("invalid result");
    return result;
  } catch {
    throw codedError("CLAUDE_OVERLAY_RELATED_SET_FAILED", "Windows could not update Claude's translation package relationship.");
  }
}

async function installArtifact(artifact, {
  runPowerShellFn = lifecycle.runPowerShell,
  queryInstalledOverlayFn = queryInstalledOverlay,
} = {}) {
  const existing = await queryInstalledOverlayFn({ runPowerShellFn });
  if (existing) {
    if (existing.name !== artifact.identityName || existing.publisher !== artifact.publisher) {
      throw codedError("CLAUDE_OVERLAY_IDENTITY_CONFLICT", "Another package is using the Claude translation package identity.");
    }
    if (existing.version === artifact.version && existing.status.toLowerCase() === "ok") {
      await registerRelatedSet(existing, artifact.publisher, { includeOwned: true, runPowerShellFn });
      return { installed: false, reused: true, package: existing };
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$package=$env:CIZI_OVERLAY_PACKAGE",
    "if([string]::IsNullOrWhiteSpace($package)-or !(Test-Path -LiteralPath $package -PathType Leaf)){throw 'CLAUDE_OVERLAY_PACKAGE_MISSING'}",
    "$signature=Get-AuthenticodeSignature -LiteralPath $package",
    "$qa=[string]$env:CIZI_OVERLAY_PORTABLE_QA -ceq '1'",
    "$signatureStatus=[string]$signature.Status",
    "if($signatureStatus -cne 'Valid' -and -not ($qa -and $signatureStatus -ceq 'UnknownError')){throw 'CLAUDE_OVERLAY_SIGNATURE_INVALID'}",
    "if($null -eq $signature.SignerCertificate -or [string]$signature.SignerCertificate.Subject -cne [string]$env:CIZI_OVERLAY_PUBLISHER -or [string]$signature.SignerCertificate.Thumbprint -cne [string]$env:CIZI_OVERLAY_THUMBPRINT){throw 'CLAUDE_OVERLAY_SIGNER_MISMATCH'}",
    "Add-AppxPackage -Path $package -ErrorAction Stop",
  ].join("\n");
  try {
    await runPowerShellFn(script, {
      timeout: 120000,
      env: {
        CIZI_OVERLAY_PACKAGE: artifact.packagePath,
        CIZI_OVERLAY_PUBLISHER: artifact.publisher,
        CIZI_OVERLAY_THUMBPRINT: artifact.signerThumbprint,
        CIZI_OVERLAY_PORTABLE_QA: artifact.portableQaOnly === true && process.defaultApp === true ? "1" : "0",
      },
    });
  } catch (cause) {
    throw codedError(
      "CLAUDE_OVERLAY_INSTALL_FAILED",
      "Windows could not install the Claude Turkish interface package.",
      cause,
    );
  }
  const installed = await queryInstalledOverlayFn({ runPowerShellFn });
  if (!installed || installed.name !== artifact.identityName || installed.publisher !== artifact.publisher
      || installed.version !== artifact.version || installed.status.toLowerCase() !== "ok") {
    throw codedError("CLAUDE_OVERLAY_INSTALL_FAILED", "Windows did not register the signed Claude translation package.");
  }
  await registerRelatedSet(installed, artifact.publisher, { includeOwned: true, runPowerShellFn });
  return { installed: true, reused: false, package: installed };
}

async function removeInstalledOverlay(candidate, expectedPublisher, {
  runPowerShellFn = lifecycle.runPowerShell,
  queryInstalledOverlayFn = queryInstalledOverlay,
} = {}) {
  const owned = assertOwnedOverlay(candidate, expectedPublisher);
  await registerRelatedSet(owned, expectedPublisher, { includeOwned: false, runPowerShellFn });
  return packageIdentity.removeOverlayPackage(owned, async (packageFullName) => {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$fullName=[string]$env:CIZI_OVERLAY_FULL_NAME",
      "$name=[string]$env:CIZI_OVERLAY_NAME",
      "$publisher=[string]$env:CIZI_OVERLAY_PUBLISHER",
      "$p=Get-AppxPackage -PackageTypeFilter Optional | Where-Object {$_.PackageFullName -ceq $fullName -and $_.Name -ceq $name -and $_.Publisher -ceq $publisher} | Select-Object -First 1",
      "if($null -eq $p){throw 'CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED'}",
      "if($p.PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc' -or $p.Name -eq 'Claude'){throw 'CLAUDE_MAIN_PACKAGE_REMOVAL_BLOCKED'}",
      "Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop",
    ].join("\n");
    await runPowerShellFn(script, {
      timeout: 120000,
      env: {
        CIZI_OVERLAY_FULL_NAME: packageFullName,
        CIZI_OVERLAY_NAME: OVERLAY_IDENTITY_NAME,
        CIZI_OVERLAY_PUBLISHER: expectedPublisher,
      },
    });
    const after = await queryInstalledOverlayFn({ runPowerShellFn });
    if (after?.packageFullName === packageFullName) {
      throw codedError("CLAUDE_OVERLAY_REMOVE_FAILED", "The Claude translation package is still registered.");
    }
  });
}

async function ensureForMain(main, options = {}) {
  const query = options.queryInstalledOverlayFn || queryInstalledOverlay;
  const installed = await query({ runPowerShellFn: options.runPowerShellFn });
  let artifact = findVerifiedArtifact(main, options);
  if (!artifact) artifact = await fetchRemoteArtifact(main, options);
  if (!artifact) {
    if (installed) {
      const recorded = options.state?.overlay;
      const exactRecordedPackage = recorded
        && installed.publisher === recorded.publisher
        && installed.packageFullName === recorded.packageFullName;
      if (!exactRecordedPackage) {
        throw codedError("CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED", "An unverified Claude translation package is installed.");
      }
      // A temporary feed outage must not uninstall a previously verified
      // package for the *same* official Claude version. The encrypted Cizi
      // state records the exact registered package and patch-set identity.
      if (installed.version === main.version
          && recorded.version === main.version
          && recorded.patchSetVersion === EXPECTED_PATCH_SET_VERSION) {
        await registerRelatedSet(installed, recorded.publisher, { includeOwned: true, runPowerShellFn: options.runPowerShellFn });
        return {
          status: "active",
          installed: true,
          installedByOperation: false,
          package: installed,
          artifact: {
            signerThumbprint: recorded.signerThumbprint,
            patchSetVersion: recorded.patchSetVersion,
          },
          message: null,
        };
      }
      await removeInstalledOverlay(installed, recorded.publisher, { ...options, queryInstalledOverlayFn: query });
    }
    return {
      status: "pending",
      installed: false,
      package: null,
      artifact: null,
      message: "A signed Turkish interface package is not available for this Claude version yet.",
    };
  }
  if (installed) {
    const recorded = options.state?.overlay;
    // An exact installed package can be adopted after a process/power loss
    // between Add-AppxPackage and state commit. The bundled artifact has just
    // passed hash + signer-subject + signer-thumbprint validation, while the
    // registered package must share its Windows publisher identity. If state
    // exists, its registered package identity cannot be silently replaced.
    // Certificate rotation is allowed because the new bundled artifact itself
    // is thumbprint-pinned by its release manifest. The prior registered
    // package must still match the package/publisher recorded in Cizi state.
    if (recorded && (recorded.publisher !== installed.publisher
        || recorded.packageFullName !== installed.packageFullName)) {
      throw codedError("CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED", "The installed Claude translation package does not match Cizi Code's signed state.");
    }
  }
  const result = await installArtifact(artifact, { ...options, queryInstalledOverlayFn: query });
  return {
    status: "active",
    installed: true,
    installedByOperation: result.installed,
    package: result.package,
    artifact,
    message: null,
  };
}

async function removeForState(state, options = {}) {
  const query = options.queryInstalledOverlayFn || queryInstalledOverlay;
  const installed = await query({ runPowerShellFn: options.runPowerShellFn });
  if (!installed) return { removed: false };
  const expectedPublisher = state?.overlay?.publisher;
  if (!expectedPublisher) {
    throw codedError("CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED", "The installed Claude translation package is not recorded in Cizi Code state.");
  }
  return removeInstalledOverlay(installed, expectedPublisher, { ...options, queryInstalledOverlayFn: query });
}

async function removeOwnedOrphanForMain(main, options = {}) {
  const query = options.queryInstalledOverlayFn || queryInstalledOverlay;
  const installed = await query({ runPowerShellFn: options.runPowerShellFn });
  if (!installed) return { removed: false, absent: true };
  let artifact = findVerifiedArtifact(main, options);
  if (!artifact) artifact = await fetchRemoteArtifact(main, options);
  if (!artifact
      || installed.name !== OVERLAY_IDENTITY_NAME
      || installed.publisher !== artifact.publisher
      || installed.version !== main.version) {
    throw codedError(
      "CLAUDE_OVERLAY_OWNERSHIP_UNVERIFIED",
      "An installed Claude interface package could not be proven to belong to this Cizi Code build.",
    );
  }
  return removeInstalledOverlay(installed, artifact.publisher, {
    ...options,
    queryInstalledOverlayFn: query,
  });
}

module.exports = {
  OVERLAY_IDENTITY_NAME,
  EXPECTED_PATCH_SET_VERSION,
  OVERLAY_FEED_BASE,
  MAX_REMOTE_MANIFEST_BYTES,
  MAX_REMOTE_PACKAGE_BYTES,
  developmentSignerTrust,
  artifactRoots,
  remoteCacheRoot,
  remoteArtifactUrl,
  normalizedSignerTrust,
  assertTrustedSigner,
  findVerifiedArtifact,
  fetchRemoteArtifact,
  assertReleaseManifest,
  parseOptionalPackage,
  queryInstalledOverlay,
  assertOwnedOverlay,
  relatedSetRegistrationScript,
  registerRelatedSet,
  installArtifact,
  removeInstalledOverlay,
  ensureForMain,
  removeForState,
  removeOwnedOrphanForMain,
};
