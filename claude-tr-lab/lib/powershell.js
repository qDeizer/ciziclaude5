"use strict";

const { execFile } = require("child_process");
const { codedError } = require("./fsx");

// Tek sorumluluk: PowerShell calistirmak. Cagiran taraf ne calistirdigini bilir,
// bu modul nasil calistirildigini bilir.
function createPowerShell({ executable = "powershell.exe", defaultTimeoutMs = 30000 } = {}) {
  function run(script, { timeoutMs = defaultTimeoutMs, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (error) {
            reject(codedError("POWERSHELL_FAILED", String(stderr || error.message).trim(), error));
            return;
          }
          resolve(String(stdout || "").trim());
        },
      );
    });
  }
  return { run };
}

module.exports = { createPowerShell };
