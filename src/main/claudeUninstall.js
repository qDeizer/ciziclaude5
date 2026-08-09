const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function home() {
  return os.homedir();
}

function planClaudeCodeUninstall() {
  const h = home();
  const appData = process.env.APPDATA || path.join(h, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";

  const bins = [];
  const dirs = [];
  const configs = [];

  if (process.platform === "win32") {
    bins.push(
      path.join(h, ".local", "bin", "claude.exe"),
      path.join(h, ".local", "bin", "claude.cmd"),
      path.join(appData, "npm", "claude.cmd"),
      path.join(appData, "npm", "claude.exe"),
      path.join(localAppData, "Programs", "Claude Code", "claude.exe"),
      path.join(localAppData, "Claude Code", "claude.exe"),
      path.join(programFiles, "Claude Code", "claude.exe"),
    );
    dirs.push(
      path.join(h, ".local", "share", "claude"),
      path.join(localAppData, "Programs", "Claude Code"),
      path.join(localAppData, "Claude Code"),
      path.join(programFiles, "Claude Code"),
      path.join(h, ".claude", "downloads"),
    );
    configs.push(
      path.join(h, ".claude"),
      path.join(h, ".claude.json"),
      path.join(h, ".claude", "settings.json"),
    );
  } else {
    bins.push(
      path.join(h, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      "/opt/homebrew/bin/claude",
    );
    dirs.push(
      path.join(h, ".local", "share", "claude"),
      path.join(h, ".claude", "downloads"),
    );
    configs.push(
      path.join(h, ".claude"),
      path.join(h, ".claude.json"),
      path.join(h, ".claude", "settings.json"),
    );
  }

  const dedup = (arr) => {
    const seen = new Set();
    const out = [];
    for (const p of arr) {
      const key = process.platform === "win32" ? String(p).toLowerCase() : String(p);
      if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
    return out;
  };

  return {
    bins: dedup(bins),
    dirs: dedup(dirs),
    configs: dedup(configs),
    npmPackage: "@anthropic-ai/claude-code",
  };
}

function describeExisting(plan) {
  const all = [...plan.bins, ...plan.dirs, ...plan.configs];
  return all.filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

async function npmUninstallGlobal(pkg) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(npmCmd, ["uninstall", "-g", pkg], { timeout: 30000, windowsHide: true, maxBuffer: 256 * 1024 });
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/not installed|not found|ENOENT/i.test(msg)) return { ok: true, skipped: true, reason: msg.slice(0, 300) };
    return { ok: false, error: msg.slice(0, 500) };
  }
}

async function killClaudeProcesses() {
  if (process.platform === "win32") {
    for (const exe of ["claude.exe"]) {
      try { await execFileAsync("taskkill.exe", ["/im", exe, "/f"], { windowsHide: true, timeout: 5000 }); } catch {}
    }
  } else {
    try { await execFileAsync("pkill", ["-f", "claude"], { timeout: 5000 }); } catch {}
  }
}

function removePath(target) {
  try {
    if (!fs.existsSync(target)) return { path: target, removed: false, reason: "not-found" };
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    return { path: target, removed: true };
  } catch (e) {
    return { path: target, removed: false, error: String(e?.message || e).slice(0, 400) };
  }
}

async function uninstallClaudeCode({ log } = {}) {
  const plan = planClaudeCodeUninstall();
  const before = describeExisting(plan);
  if (log) log.info("claude-code-cli", `Kökten kaldır planı: ${before.length} iz bulundu`, { count: before.length });

  await killClaudeProcesses();
  const npmRes = await npmUninstallGlobal(plan.npmPackage);
  if (log) log.info("claude-code-cli", npmRes.ok ? "npm global kaldırıldı/atlandı" : `npm kaldırma uyarısı: ${npmRes.error || ""}`);

  const results = [];
  for (const p of [...plan.bins, ...plan.dirs]) {
    const r = removePath(p);
    results.push(r);
    if (log && r.removed) log.info("claude-code-cli", `Silindi: ${p}`);
  }
  for (const p of plan.configs) {
    if ([...plan.bins, ...plan.dirs].some((x) => x === p)) continue;
    const r = removePath(p);
    results.push(r);
    if (log && r.removed) log.info("claude-code-cli", `Config silindi: ${p}`);
  }

  try { fs.rmSync(path.join(home(), ".claude", "downloads"), { recursive: true, force: true }); } catch {}
  const removed = results.filter((r) => r.removed).map((r) => r.path);
  const failed = results.filter((r) => !r.removed && r.error);
  const stillExists = describeExisting(plan);

  return {
    ok: failed.length === 0,
    removed,
    failed,
    stillExists,
    npm: npmRes,
    before,
  };
}

module.exports = { planClaudeCodeUninstall, describeExisting, uninstallClaudeCode };
