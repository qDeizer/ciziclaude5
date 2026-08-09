const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");
const secureStore = require("./secureStore");

const execFileAsync = promisify(execFile);
const CREDENTIAL_TARGET_PREFIX = "CiziCode-Claude/GatewayCredential/";

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function dataRoot() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "CiziCodeData",
    "ClaudeDesktop",
  );
}
function helperDir() { return path.join(dataRoot(), "helper"); }
function helperPath() { return path.join(helperDir(), "CiziClaudeCredentialHelper.exe"); }
function helperHostPath() { return path.join(helperDir(), "cizicode-host.txt"); }
function helperTargetPath() { return path.join(helperDir(), "cizicode-credential-target.txt"); }

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function captureFile(filePath) {
  try { return { existed: true, content: fs.readFileSync(filePath).toString("base64") }; }
  catch (error) {
    if (error?.code === "ENOENT") return { existed: false };
    throw error;
  }
}
function captureOwnedFiles() {
  return {
    helper: captureFile(helperPath()),
    host: captureFile(helperHostPath()),
    target: captureFile(helperTargetPath()),
  };
}
function restoreFile(filePath, prior) {
  if (prior?.existed) {
    if (typeof prior.content !== "string") throw codedError("BACKUP_INVALID", "Claude Desktop helper backup is incomplete.");
    secureStore.atomicWrite(filePath, Buffer.from(prior.content, "base64"));
  } else fs.rmSync(filePath, { force: true });
}
function restoreOwnedFiles(snapshot) {
  // Schema-2 backups predate helper-file capture. Those backups always refer
  // to a Cizi-created helper, so removal is the only correct original state.
  const owned = snapshot?.ownedFiles || {
    helper: { existed: false },
    host: { existed: false },
    target: { existed: false },
  };
  deleteCurrentCredential();
  restoreFile(helperPath(), owned.helper);
  restoreFile(helperHostPath(), owned.host);
  restoreFile(helperTargetPath(), owned.target);
  try { fs.rmdirSync(helperDir()); } catch { /* non-empty/already absent */ }
}

function ownedFilesFromBaseline(snapshot) {
  return snapshot?.ownedFiles || {
    helper: { existed: false },
    host: { existed: false },
    target: { existed: false },
  };
}
function ownedFilesEqual(expectedSnapshot, actualOwnedFiles) {
  const expected = ownedFilesFromBaseline(expectedSnapshot);
  for (const name of ["helper", "host", "target"]) {
    const left = expected[name] || { existed: false };
    const right = actualOwnedFiles?.[name] || { existed: false };
    if (!!left.existed !== !!right.existed) return false;
    if (left.existed && left.content !== right.content) return false;
  }
  return true;
}

function bundledCredentialHelperPath() {
  const candidates = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "src", "main", "bin", "CiziClaudeCredentialHelper.exe"),
    path.join(__dirname, "..", "bin", "CiziClaudeCredentialHelper.exe"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (found) return found;
  throw codedError("CREDENTIAL_HELPER_MISSING", "Cizi Code's Claude credential helper is missing.");
}
function ensureCredentialHelper() {
  const bundled = bundledCredentialHelperPath();
  const content = fs.readFileSync(bundled);
  secureStore.atomicWrite(helperPath(), content);
  fs.rmSync(helperHostPath(), { force: true });
  secureStore.atomicWrite(
    helperTargetPath(),
    `${CREDENTIAL_TARGET_PREFIX}${crypto.randomUUID().replaceAll("-", "")}\n`,
  );
  if (sha256File(bundled) !== sha256File(helperPath())) {
    throw codedError("CREDENTIAL_HELPER_INTEGRITY_FAILED", "Cizi Code's Claude credential helper failed its integrity check.");
  }
  return helperPath();
}
function credentialHelperIsCurrent() {
  try {
    return sha256File(bundledCredentialHelperPath()) === sha256File(helperPath())
      && !fs.existsSync(helperHostPath())
      && validCredentialTarget(fs.readFileSync(helperTargetPath(), "utf8").trim());
  } catch { return false; }
}

function validCredentialTarget(value) {
  return new RegExp(`^${CREDENTIAL_TARGET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{32}$`, "i")
    .test(String(value || ""));
}

function currentCredentialTarget() {
  const target = fs.readFileSync(helperTargetPath(), "utf8").trim();
  if (!validCredentialTarget(target)) {
    throw codedError("CREDENTIAL_TARGET_INVALID", "Cizi Code's Claude credential target is invalid.");
  }
  return target;
}

function runHelperWithInput(filePath, argumentsList, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = execFile(filePath, argumentsList, {
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

async function provisionCredential(resolvedHelper, secret, {
  runHelperFn = runHelperWithInput,
  target = null,
} = {}) {
  const value = String(secret || "");
  if (!value.trim() || value !== value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw codedError("CREDENTIAL_INVALID", "Cizi Code's Claude credential is invalid.");
  }
  try {
    await runHelperFn(
      resolvedHelper,
      ["--store-stdin", `--target=${target || currentCredentialTarget()}`],
      value,
    );
  } catch (cause) {
    throw codedError(
      "CREDENTIAL_PROVISION_FAILED",
      "Cizi Code could not store the temporary Claude credential in Windows Credential Manager.",
      cause,
    );
  }
}

function deleteCurrentCredential() {
  let target;
  try {
    if (!fs.existsSync(helperTargetPath())) return { removed: false };
    target = currentCredentialTarget();
  } catch {
    return { removed: false };
  }
  const executable = fs.existsSync(helperPath()) ? helperPath() : bundledCredentialHelperPath();
  const result = spawnSync(executable, ["--delete", `--target=${target}`], {
    windowsHide: true,
    timeout: 15000,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw codedError(
      "CREDENTIAL_DELETE_FAILED",
      "Cizi Code could not remove its temporary Claude credential.",
      result.error || null,
    );
  }
  return { removed: true };
}
async function preflightCredentialHelper(resolvedHelper, { execFileFn = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileFn(resolvedHelper, [], {
      windowsHide: true,
      timeout: 35000,
      maxBuffer: 16 * 1024,
    });
    if (!String(stdout || "").trim()) throw new Error("Credential helper returned no credential.");
  } catch (cause) {
    throw codedError(
      "CREDENTIAL_HELPER_PREFLIGHT_FAILED",
      "Cizi Code could not prepare Claude Desktop authentication. Keep Cizi Code signed in and try again.",
      cause,
    );
  }
}

module.exports = {
  dataRoot,
  helperDir,
  helperPath,
  helperHostPath,
  helperTargetPath,
  captureOwnedFiles,
  restoreOwnedFiles,
  ownedFilesEqual,
  bundledCredentialHelperPath,
  ensureCredentialHelper,
  provisionCredential,
  deleteCurrentCredential,
  credentialHelperIsCurrent,
  preflightCredentialHelper,
};
