const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");
const store = require("./store");
const api = require("./apiClient");
const toolMgr = require("./tools/apply");
const productRemoval = require("./productRemoval");
const { isInsideManualInstallDirectory } = require("./manualInstall");
const { createCodexCliService } = require("./codexCli");
const { createClaudeCodeCliService } = require("./claudeCodeCli");
const { createCodexDesktopService } = require("./codexDesktop");
const codexConfig = require("./codexConfigFile");
const claudeDesktopBackend = require("./tools/claudeDesktop");
const claudeDesktopBranding = require("./tools/claudeDesktopBranding");
const claudePackageIdentity = require("./tools/claudePackageIdentity");
const claudeShortcuts = require("./tools/claudeShortcuts");
const brandingRepairTask = require("./tools/claudeBrandingTask");
const claudeLaunchGuard = require("./claudeLaunchGuard");
const claudeLifecycle = require("./tools/claudeLifecycle");
const reconcileBackgroundTask = require("./tools/claudeReconcileTask");
const toolIntentStore = require("./tools/toolIntentStore");
const { configurationForTool } = require("./tools/toolModelConfiguration");
const { createIntegrationService } = require("./tools/integrationService");
const { createClaudeCoordinator } = require("./claudeCoordinator");
const log = require("./logger");
const { CliBridge } = require("./cliBridge");
const { assertHttpsUrl } = require("./httpsUrl");

const execFileAsync = promisify(execFile);
const RECONCILE_INTERVAL_MS = Number(process.env.CIZI_RECONCILE_INTERVAL_MS) || 5 * 60 * 1000;
const HEADLESS_RECONCILE = process.argv.includes("--cizi-reconcile-active-tools");

// A redirected Claude shortcut starts Cizi Code with this flag. It is handled
// BEFORE the single-instance lock on purpose: the shortcut has to work while
// Cizi Code is already running, and a contender that asks for the lock would
// simply exit without ever launching Claude. This path only reads state, so it
// is safe to run alongside the main instance.
if (process.argv.includes(claudeShortcuts.LAUNCH_FLAG)) {
  app.whenReady().then(() => claudeLaunchGuard.run({
    brandingTaskName: brandingRepairTask.TASK_NAME,
    branding: claudeDesktopBranding,
    lifecycle: claudeLifecycle,
    packageIdentity: claudePackageIdentity,
    runPowerShellFn: claudeLifecycle.runPowerShell,
  })).finally(() => app.exit(0));
  return;
}

// The CLI launcher can be invoked repeatedly while the desktop process is
// already starting. Keep one desktop process (and therefore one installer
// mutex) per user session.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // app.quit() may wait for a ready event that this contender never reaches.
  // Exit immediately so it cannot leave a second Electron process behind.
  app.exit(0);
}

const UPDATE_FEED_URL = process.env.CIZI_UPDATE_URL || "https://cizicode.me/desktop-updates";

let session = null; // { baseUrl, apiKey, combos? }
let updateState = { status: "idle", message: "" };
let mainWindow = null;
const cliBridge = new CliBridge({ getWindow: () => mainWindow, log });
const codexCli = createCodexCliService({
  userDataPath: app.getPath("userData"),
  log,
  onInstallState: (state) => broadcast("cizi:codexCliInstallState", state),
});
const claudeCodeCli = createClaudeCodeCliService({
  userDataPath: app.getPath("userData"),
  log,
  onInstallState: (state) => broadcast("cizi:claudeCodeInstallState", state),
});
const codexDesktop = createCodexDesktopService({
  userDataPath: app.getPath("userData"),
  log,
  onInstallState: (state) => broadcast("cizi:codexDesktopInstallState", state),
});
// Claude Desktop's own transaction/rollback engine is transplanted as-is; the
// coordinator is the only thing that knows the CLI and the desktop app are one
// switch to the user.
let claudeProgressState = { phase: "idle", message: "", details: null };
const claude = createClaudeCoordinator({
  claudeDesktop: claudeDesktopBackend,
  lifecycle: claudeLifecycle,
  toolManager: toolMgr,
  detectCli: () => claudeCodeCli.detect(),
  log,
  onDesktopProgress: (state) => {
    claudeProgressState = { ...state, at: new Date().toISOString() };
    broadcast("cizi:claudeProgress", claudeProgressState);
  },
});
// The composition root: the service receives every dependency it needs, so the
// on/off policy is the only thing it owns.
const integrations = createIntegrationService({
  toolManager: toolMgr,
  claude,
  intentStore: toolIntentStore,
  // Each switch asks for its own server-declared model access. Claude Desktop
  // and Claude Code share a capability contract, but never an access grant.
  resolveValues: (toolId) => accountToolValues(toolId, recordedModel(toolId)),
  getSession: () => session,
  baseUrl: api.TOOL_BASE_URL,
  log,
  backgroundTask: reconcileBackgroundTask,
  intervalMs: RECONCILE_INTERVAL_MS,
  // Turning a switch writes to somebody else's configuration and can take
  // minutes. Every step reports a measured percentage on one channel, so the
  // screen never has to guess what is happening.
  onProgress: (state) => broadcast("cizi:progress", state),
});

function desiredToolState(toolId, applied) {
  const intent = toolIntentStore.get(toolId);
  return intent ? intent.enabled : applied === true;
}

// Keeping the model the user is already connected with means a reconnect does
// not silently move them to a different default.
function recordedModel(toolId) {
  if (toolId === "codex") return codexConfig.readState(api.TOOL_BASE_URL).model || null;
  return toolIntentStore.get(toolId)?.values?.model || null;
}

function shouldBlockDevToolsShortcut(input) {
  const key = String(input.key || "").toLowerCase();
  return key === "f12" || (input.control && input.shift && ["i", "j", "c"].includes(key));
}

function lockProductionWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (!app.isPackaged) return;

  win.webContents.on("before-input-event", (event, input) => {
    if (shouldBlockDevToolsShortcut(input)) event.preventDefault();
  });
  win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#e9e4ce",
    title: "Cizi Code",
    icon: path.join(__dirname, "..", "..", "assets", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  lockProductionWindow(win);
  // A renderer script that throws while loading leaves the window on its default
  // markup and produces no trace anywhere - which is indistinguishable from "the
  // user is not logged in". Renderer errors are therefore recorded in the same
  // log as everything else, so a broken screen is diagnosable from the log file.
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level < 2) return; // 0=verbose 1=info 2=warning 3=error
    const where = source ? `${String(source).split(/[\\/]/).pop()}:${line}` : "renderer";
    log[level >= 3 ? "error" : "warning"]("ui", `${message}`, { at: where });
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    log.error("ui", `Preload could not be loaded: ${error?.message || error}`, { preload: preloadPath });
  });
  const cachedContents = win.webContents;
  win.webContents.on("render-process-gone", () => cliBridge.markRendererUnavailable(cachedContents));
  win.on("closed", () => {
    cliBridge.markRendererUnavailable(cachedContents);
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

function broadcast(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, data);
    } catch {
      // Ignore windows that are closing.
    }
  }
}

function setUpdateState(next) {
  updateState = { ...updateState, ...next };
  broadcast("cizi:updateState", updateState);
  log.info("update", updateState.message || updateState.status, { status: updateState.status });
}

function updateFeedBase() {
  return UPDATE_FEED_URL.replace(/\/+$/, "");
}

function gatewayLabel() {
  const base = api.DEFAULT_BASE_URL;
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(base) ? "Cizi Code Local" : "Cizi Code Cloud";
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function safeMessage(err) {
  return api.sanitizeErrorMessage(err?.message || String(err || ""), err?.status);
}

async function downloadFile(url, targetPath) {
  const res = await fetch(assertHttpsUrl(url, "Download URL"), { cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(targetPath, bytes);
  return bytes.length;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function checkForUpdates() {
  try {
    if (!app.isPackaged && process.env.CIZI_ALLOW_DEV_UPDATE !== "1") {
      setUpdateState({ status: "skipped", message: "Update checks run in packaged builds." });
      return updateState;
    }
    setUpdateState({ status: "checking", message: "Checking for updates..." });
    const manifestUrl = `${updateFeedBase()}/latest.json?ts=${Date.now()}`;
    const res = await fetch(manifestUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`Update manifest could not be loaded (${res.status}).`);
    const manifest = await res.json();
    const currentVersion = app.getVersion();
    if (!manifest?.version || compareVersions(manifest.version, currentVersion) <= 0) {
      setUpdateState({ status: "current", message: "Cizi Code is up to date.", currentVersion });
      return updateState;
    }
    setUpdateState({
      status: "ready",
      message: `Version ${manifest.version} is ready to install.`,
      currentVersion,
      version: manifest.version,
      manifest,
    });
    return updateState;
  } catch (err) {
    setUpdateState({ status: "error", message: safeMessage(err) || "Update check failed." });
    return updateState;
  }
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    log.info("app", "Cizi Code existing instance was brought to foreground");
  });

  app.whenReady().then(() => {
    log.info("app", `Cizi Code desktop started (v${app.getVersion()}); logs at ${log.filePath()}`);
    try {
      const saved = store.loadSession();
      session = saved?.apiKey ? { baseUrl: api.DEFAULT_BASE_URL, apiKey: saved.apiKey } : null;
      log.info("auth", session?.apiKey ? "Restored saved session" : "No saved session");
    } catch {
      session = null;
      log.warn("auth", "Failed to load saved session");
    }

    if (HEADLESS_RECONCILE) {
      integrations.reconcile("scheduled-task")
        .then((result) => {
          log.info("reconcile", "Zamanlanmış tool denetimi tamamlandı", {
            repaired: result.repaired,
            pending: result.pending,
            failed: result.failed,
          });
        })
        .catch((error) => log.error("reconcile", `Zamanlanmış tool denetimi başarısız: ${safeMessage(error)}`))
        .finally(() => app.quit());
      return;
    }

    createWindow();
    cliBridge.start().catch((err) => {
      log.error("cli", `CLI bridge could not start: ${safeMessage(err)}`);
    });
    setTimeout(() => checkForUpdates().catch(() => {}), 2500);
    setTimeout(() => integrations.reconcile("startup").catch(() => {}), 4000);
    integrations.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  integrations.stop();
  cliBridge.stop();
});

ipcMain.on("cizi:cliReady", (event) => cliBridge.markRendererReady(event.sender));
ipcMain.on("cizi:cliResponse", (event, response) => cliBridge.handleRendererResponse(event.sender, response));

function requireSession() {
  if (!session?.apiKey || !session?.baseUrl) {
    const e = new Error("Not logged in");
    e.code = "NO_SESSION";
    throw e;
  }
  return session;
}

// The gateway's own model list tells us which models really have a 1M variant
// and which ids Claude Desktop will attach an effort picker to. It is an
// enrichment, not a requirement: a gateway that cannot answer still configures,
// just with the tier rule instead of facts.
async function gatewayModelIds() {
  const s = requireSession();
  if (Array.isArray(s.gatewayModels)) return s.gatewayModels;
  try {
    s.gatewayModels = await api.getGatewayModels(api.TOOL_BASE_URL, s.apiKey);
    log.info("models", `Gateway model listesi alındı (${s.gatewayModels.length} kayıt)`);
  } catch (error) {
    s.gatewayModels = [];
    log.warning("models", "Gateway model listesi okunamadı; yetenekler aile kuralından türetilecek", {
      status: error?.status || null,
    });
  }
  return s.gatewayModels;
}

async function accountToolValues(toolId, currentModel = null) {
  const s = requireSession();
  if (!Array.isArray(s.combos)) {
    const me = await api.getMe(s.baseUrl, s.apiKey);
    s.combos = Array.isArray(me?.combos) ? me.combos : [];
    s.gatewayModels = null;
  }
  const gatewayModels = await gatewayModelIds();
  const automatic = configurationForTool(toolId, s.combos, { currentModel, gatewayModels });
  return { base: api.TOOL_BASE_URL, apiKey: s.apiKey, ...automatic };
}

function wrap(label, handler) {
  return async (_evt, args) => {
    const t0 = Date.now();
    log.debug("ipc", `start ${label}`);
    try {
      const data = await handler(args || {});
      log.info("ipc", `ok ${label} (${Date.now() - t0}ms)`);
      return { ok: true, data };
    } catch (err) {
      const message = err?.userMessage || safeMessage(err);
      log.error("ipc", `failed ${label}: ${message}`, { status: err.status || null, code: err.code || null });
      return { ok: false, error: message, status: err.status || null, code: err.code || null };
    }
  };
}

ipcMain.handle("cizi:login", wrap("login", async ({ apiKey }) => {
  if (!apiKey) throw new Error("API key is required.");
  log.info("auth", "Login attempt");
  const me = await api.getMe(api.DEFAULT_BASE_URL, apiKey);
  session = { baseUrl: api.DEFAULT_BASE_URL, apiKey, combos: Array.isArray(me?.combos) ? me.combos : [], gatewayModels: null };
  store.saveSession({ apiKey });
  log.info("auth", `Login OK (models: ${(me?.combos || []).length})`);
  return me;
}));

ipcMain.handle("cizi:logout", wrap("logout", async () => {
  session = null;
  store.clearSession();
  log.info("auth", "Logged out");
  return { loggedOut: true };
}));

ipcMain.handle("cizi:getSession", wrap("getSession", async () => {
  if (!session?.apiKey) return { loggedIn: false };
  return { loggedIn: true, gateway: gatewayLabel() };
}));

ipcMain.handle("cizi:getMe", wrap("getMe", async () => {
  const s = requireSession();
  const me = await api.getMe(s.baseUrl, s.apiKey);
  s.combos = Array.isArray(me?.combos) ? me.combos : [];
  s.gatewayModels = null;
  return me;
}));

ipcMain.handle("cizi:getUsage", wrap("getUsage", async ({ period }) => {
  const s = requireSession();
  return await api.getUsage(s.baseUrl, s.apiKey, period || "30d");
}));

ipcMain.handle("cizi:getTemplates", wrap("getTemplates", async () => {
  const s = requireSession();
  return await api.getTemplates(s.baseUrl, s.apiKey);
}));

ipcMain.handle("cizi:getClaudeCodeStatus", wrap("getClaudeCodeStatus", async () => claudeCodeCli.detect()));
ipcMain.handle("cizi:installClaudeCode", wrap("installClaudeCode", async () => claudeCodeCli.install()));
ipcMain.handle("cizi:downloadClaudeCode", wrap("downloadClaudeCode", async () => claudeCodeCli.downloadOnly()));
ipcMain.handle("cizi:openClaudeCodeCli", wrap("openClaudeCodeCli", async () => claudeCodeCli.open()));
ipcMain.handle("cizi:openClaudeCodeSite", wrap("openClaudeCodeSite", async () => {
  await shell.openExternal(claudeCodeCli.officialSiteUrl);
  return { opened: true, url: claudeCodeCli.officialSiteUrl };
}));
ipcMain.handle("cizi:getCodexCliStatus", wrap("getCodexCliStatus", async () => codexCli.detect()));
ipcMain.handle("cizi:installCodexCli", wrap("installCodexCli", async () => codexCli.install()));
ipcMain.handle("cizi:downloadCodexCli", wrap("downloadCodexCli", async () => codexCli.downloadOnly()));
ipcMain.handle("cizi:openCodexCli", wrap("openCodexCli", async ({ useCizi } = {}) => codexCli.open({ useCizi })));
ipcMain.handle("cizi:openCodexCliSite", wrap("openCodexCliSite", async () => {
  await shell.openExternal(codexCli.officialSiteUrl);
  return { opened: true, url: codexCli.officialSiteUrl };
}));

// --- Root removal, one contract for all four products --------------------
//
// The removal categories the user sees, and their execution, live in
// productRemoval.js. What belongs here is only the machine facts that decide
// which paths may be touched: whether the OTHER product of a shared pair is
// still installed, and which version is being removed.
//
// Those facts are resolved HERE rather than trusted from the renderer: a stale
// screen must never be able to authorise deleting data another product still
// needs.
//
// Only what a SAFETY decision depends on is resolved. The version number was
// once looked up too, purely to put it in a label - and for Claude Desktop that
// meant running a full Windows process and package scan, which made simply
// opening the removal menu take over two seconds. Decoration does not get to
// cost that (point 10).
async function removalContext(productId) {
  if (productId === productRemoval.CODEX_CLI) {
    const desktop = await codexDesktop.detect();
    return { otherInstalled: desktop.installed === true };
  }
  if (productId === productRemoval.CODEX_DESKTOP) {
    const cli = await codexCli.detect();
    return { otherInstalled: cli.installed === true };
  }
  return {};
}

// Removing the application itself is the product's own operation (an MSIX
// removal, Anthropic's uninstaller); only these two are injected.
function removalActions(productId) {
  if (productId === productRemoval.CLAUDE_DESKTOP) {
    return {
      // `removeLeftovers: false` on purpose: what happens to the data Claude
      // Desktop leaves behind is decided by the categories the user selected,
      // not by the uninstaller sweeping everything.
      removeApplication: () => claude.uninstallDesktop({ removeLeftovers: false }),
      removeResidue: () => claude.removeDesktopResidue(),
    };
  }
  if (productId === productRemoval.CODEX_DESKTOP) {
    return { removeApplication: () => codexDesktop.removePackage() };
  }
  return {};
}

// A binary that is still running cannot be deleted on Windows.
async function freeProductFiles(productId) {
  if (productId === productRemoval.CODEX_CLI) return codexCli.closeProcesses();
  if (productId === productRemoval.CLAUDE_CODE) return claudeCodeCli.closeProcesses();
  return null;
}

ipcMain.handle("cizi:planProductRemoval", wrap("planProductRemoval", async ({ productId } = {}) =>
  productRemoval.planRemoval(productId, await removalContext(productId))));

ipcMain.handle("cizi:removeProduct", wrap("removeProduct", async ({ productId, categories } = {}) => {
  const context = await removalContext(productId);
  await freeProductFiles(productId);
  return productRemoval.executeRemoval(productId, {
    selection: Array.isArray(categories) ? categories : null,
    context,
    ...removalActions(productId),
    onProgress: (state) => broadcast("cizi:progress", { scope: productId, ...state }),
    log,
  });
}));

ipcMain.handle("cizi:revealPath", wrap("revealPath", async ({ target } = {}) => {
  // Only ever a path Cizi Code itself just wrote into its own download folder.
  // The check is separator-aware: a plain string prefix would also accept a
  // sibling directory whose name merely starts with ours.
  const resolved = path.resolve(String(target || ""));
  if (!isInsideManualInstallDirectory(resolved)) {
    throw new Error("Bu konum Cizi Code'un indirme klasöründe değil.");
  }
  shell.showItemInFolder(resolved);
  return { revealed: true, path: resolved };
}));

// Claude Code CLI and Claude Desktop are two switches over two unrelated
// configuration files. This call reports both products for the screen; the
// switches themselves go through the generic applyTool/revertTool handlers.
ipcMain.handle("cizi:getClaudeState", wrap("getClaudeState", async () => claude.getState(api.TOOL_BASE_URL)));
ipcMain.handle("cizi:getClaudeProgress", wrap("getClaudeProgress", async () => claudeProgressState));

ipcMain.handle("cizi:installClaudeDesktop", wrap("installClaudeDesktop", async () => claude.installDesktop()));
ipcMain.handle("cizi:downloadClaudeDesktop", wrap("downloadClaudeDesktop", async () => claude.downloadDesktopOnly()));
ipcMain.handle("cizi:launchClaudeDesktop", wrap("launchClaudeDesktop", async () => claude.launchDesktop()));
ipcMain.handle("cizi:repairClaudeDesktop", wrap("repairClaudeDesktop", async () => claude.repairDesktop()));
ipcMain.handle("cizi:stopClaudeDesktop", wrap("stopClaudeDesktop", async () => claude.stopDesktop()));

ipcMain.handle("cizi:getCodexDesktopStatus", wrap("getCodexDesktopStatus", async () => codexDesktop.detect()));
ipcMain.handle("cizi:installCodexDesktop", wrap("installCodexDesktop", async () => codexDesktop.install()));
ipcMain.handle("cizi:openCodexDesktop", wrap("openCodexDesktop", async () => codexDesktop.open()));
ipcMain.handle("cizi:openCodexDesktopStore", wrap("openCodexDesktopStore", async () => {
  await shell.openExternal(codexDesktop.storeUrl);
  return { opened: true, url: codexDesktop.storeUrl };
}));

// Shared state for the single Codex switch: what the one config.toml currently
// says, and which of the two products would be affected by changing it.
ipcMain.handle("cizi:getCodexState", wrap("getCodexState", async () => {
  const [cli, desktop] = await Promise.all([codexCli.detect(), codexDesktop.detect()]);
  const config = codexConfig.readState(api.TOOL_BASE_URL);
  return {
    cli,
    desktop,
    config: { ...config, tokenConfigured: config.tokenConfigured === true },
    desiredEnabled: desiredToolState("codex", config.applied),
    configPath: codexConfig.configPath(),
  };
}));

// One switch per row, each reporting what the user asked for next to what the
// machine actually looks like. The Claude pair appears once, as "claude".
ipcMain.handle("cizi:listTools", wrap("listTools", async () => integrations.listStatuses()));

// `closeRunning` is the user's answer to "may I close Claude Desktop?"; only the
// Claude Desktop switch ever asks, and the service ignores it elsewhere.
ipcMain.handle("cizi:applyTool", wrap("applyTool", async ({ toolId, closeRunning } = {}) =>
  integrations.enable(toolId, { closeRunning: closeRunning === true })));

ipcMain.handle("cizi:revertTool", wrap("revertTool", async ({ toolId, closeRunning } = {}) =>
  integrations.disable(toolId, { closeRunning: closeRunning === true })));

ipcMain.handle("cizi:reconcileTools", wrap("reconcileTools", async () => integrations.reconcile("manual")));

ipcMain.handle("cizi:openExternal", wrap("openExternal", async ({ url }) => {
  await shell.openExternal(assertHttpsUrl(url, "External URL"));
  return { opened: true };
}));

ipcMain.handle("cizi:getLogs", wrap("getLogs", async ({ limit } = {}) => ({ entries: log.recent(limit || 200), filePath: log.filePath() })));

ipcMain.handle("cizi:clearLogs", wrap("clearLogs", async () => {
  log.clear();
  log.info("app", "Activity cleared by user");
  return { cleared: true };
}));

ipcMain.handle("cizi:openLogFile", wrap("openLogFile", async () => {
  await shell.showItemInFolder(log.filePath());
  return { opened: true, path: log.filePath() };
}));

ipcMain.handle("cizi:clientLog", wrap("clientLog", async ({ level, message, meta } = {}) => {
  log.log(level || "info", "ui", message || "", meta);
  return { logged: true };
}));

ipcMain.handle("cizi:checkForUpdates", wrap("checkForUpdates", async () => checkForUpdates()));
ipcMain.handle("cizi:getUpdateState", wrap("getUpdateState", async () => updateState));
ipcMain.handle("cizi:installUpdate", wrap("installUpdate", async () => {
  if (updateState.status !== "ready") throw new Error("No downloaded update is ready.");
  const installScriptUrl = assertHttpsUrl(updateState.manifest?.installScriptUrl || `${updateFeedBase()}/install.ps1`, "Installer URL");
  const releaseUrl = assertHttpsUrl(updateState.manifest?.url, "Release URL");
  const expectedHash = String(updateState.manifest?.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Release manifest hash is missing or invalid.");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cizicode-update-"));
  const scriptPath = path.join(tempDir, "install.ps1");
  const zipPath = path.join(tempDir, "release.zip");
  const launcherPath = path.join(tempDir, "launch-install.ps1");

  setUpdateState({ status: "downloading", message: `Downloading version ${updateState.version}...` });
  await downloadFile(releaseUrl, zipPath);
  const actualHash = sha256File(zipPath);
  if (actualHash !== expectedHash) {
    throw new Error("Downloaded update could not be verified.");
  }
  await downloadFile(installScriptUrl, scriptPath);

  setUpdateState({ status: "installing", message: "Installing update..." });
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    `$installScript = ${JSON.stringify(scriptPath)}`,
    `$baseUrl = ${JSON.stringify(updateFeedBase())}`,
    `$releaseUrl = ${JSON.stringify(releaseUrl)}`,
    `$expectedSha256 = ${JSON.stringify(expectedHash)}`,
    `$localZipPath = ${JSON.stringify(zipPath)}`,
    "$argsList = @(",
    "  '-NoProfile',",
    "  '-ExecutionPolicy',",
    "  'Bypass',",
    "  '-File',",
    "  $installScript,",
    "  '-BaseUrl',",
    "  $baseUrl,",
    "  '-ReleaseUrl',",
    "  $releaseUrl,",
    "  '-ExpectedSha256',",
    "  $expectedSha256,",
    "  '-LocalZipPath',",
    "  $localZipPath",
    ")",
    "Start-Process -FilePath 'powershell.exe' -WorkingDirectory $env:TEMP -WindowStyle Hidden -ArgumentList $argsList",
  ].join("\r\n");
  fs.writeFileSync(launcherPath, launcher, "utf8");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
  ], {
    cwd: os.tmpdir(),
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Update launcher exited with code ${code}`));
    });
  });

  setTimeout(() => app.quit(), 800);
  return { installing: true };
}));
