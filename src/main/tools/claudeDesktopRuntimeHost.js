"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { CLAUDE_MAIN_APP_ID } = require("./claudePackageIdentity");

const execFileAsync = promisify(execFile);
const HOST_NAME = "CiziClaudeRuntimeHost.exe";
const HOST_TIMEOUT_MS = 150000;

function codedError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function bundledRuntimeHostPath() {
  const candidates = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "src", "main", "bin", HOST_NAME),
    path.join(__dirname, "..", "bin", HOST_NAME),
  ];
  const found = candidates.find((candidate) => {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size < 4096) return false;
      const header = Buffer.alloc(2);
      const handle = fs.openSync(candidate, "r");
      try { fs.readSync(handle, header, 0, 2, 0); } finally { fs.closeSync(handle); }
      return header[0] === 0x4d && header[1] === 0x5a;
    } catch {
      return false;
    }
  });
  if (found) return found;
  throw codedError(
    "CLAUDE_RUNTIME_HOST_MISSING",
    "Cizi Code's Claude runtime branding host is missing.",
  );
}

function parseHostPayload(value) {
  const lines = String(value || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* continue */ }
  }
  return null;
}

async function launchCiziRuntime(appUserModelId, {
  execFileFn = execFileAsync,
  hostPath = bundledRuntimeHostPath(),
  timeout = HOST_TIMEOUT_MS,
} = {}) {
  if (appUserModelId !== CLAUDE_MAIN_APP_ID) {
    throw codedError("CLAUDE_APP_ID_INVALID", "The Claude Desktop application identity is invalid.");
  }
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileFn(hostPath, [
      `--aumid=${appUserModelId}`,
      "--timeout-ms=90000",
    ], {
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024,
    });
    stdout = result?.stdout || "";
    stderr = result?.stderr || "";
  } catch (cause) {
    stdout = cause?.stdout || "";
    stderr = cause?.stderr || "";
    const payload = parseHostPayload(stderr) || parseHostPayload(stdout);
    throw codedError(
      String(payload?.code || "CLAUDE_RUNTIME_INJECTION_FAILED"),
      "Cizi Code could not apply runtime branding to Claude Desktop.",
      cause,
    );
  }
  const payload = parseHostPayload(stdout) || parseHostPayload(stderr);
  if (!payload?.ok
      || payload.injected !== true
      || payload.executionVerified !== true
      || payload.visibleBrandingVerified !== true
      || payload.verified !== true
      || payload.developerToolsClosed !== true
      || payload.environmentRestored !== true
      || payload.mainWorkspaceVerified !== true
      || typeof payload.onboardingDetected !== "boolean"
      || !["gateway-selected", "not-present"].includes(payload.onboardingAction)
      || !Number.isInteger(Number(payload.processId))
      || Number(payload.processId) <= 0) {
    throw codedError(
      "CLAUDE_RUNTIME_INJECTION_UNVERIFIED",
      "Cizi Code could not verify Claude Desktop runtime branding.",
    );
  }
  return {
    launched: true,
    appUserModelId,
    processId: Number(payload.processId),
    brandingMode: "runtime-devtools",
    onboardingDetected: payload.onboardingDetected,
    onboardingAction: payload.onboardingAction,
    mainWorkspaceVerified: true,
    injected: true,
    executionVerified: true,
    visibleBrandingVerified: true,
    verified: true,
    developerToolsClosed: true,
    environmentRestored: true,
  };
}

module.exports = {
  HOST_NAME,
  HOST_TIMEOUT_MS,
  bundledRuntimeHostPath,
  parseHostPayload,
  launchCiziRuntime,
};
