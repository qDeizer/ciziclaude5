// Secure bridge between the renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cizi", {
  login: (apiKey) => ipcRenderer.invoke("cizi:login", { apiKey }),
  logout: () => ipcRenderer.invoke("cizi:logout"),
  getSession: () => ipcRenderer.invoke("cizi:getSession"),

  getMe: () => ipcRenderer.invoke("cizi:getMe"),
  getUsage: (period) => ipcRenderer.invoke("cizi:getUsage", { period }),
  getTemplates: () => ipcRenderer.invoke("cizi:getTemplates"),
  getClaudeCodeStatus: () => ipcRenderer.invoke("cizi:getClaudeCodeStatus"),
  installClaudeCode: () => ipcRenderer.invoke("cizi:installClaudeCode"),
  openClaudeCodeCli: () => ipcRenderer.invoke("cizi:openClaudeCodeCli"),
  planClaudeCodeUninstall: () => ipcRenderer.invoke("cizi:planClaudeCodeUninstall"),
  uninstallClaudeCode: () => ipcRenderer.invoke("cizi:uninstallClaudeCode"),
  openClaudeCodeSite: () => ipcRenderer.invoke("cizi:openClaudeCodeSite"),
  onClaudeCodeInstallState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cizi:claudeCodeInstallState", listener);
    return () => ipcRenderer.removeListener("cizi:claudeCodeInstallState", listener);
  },
  getCodexCliStatus: () => ipcRenderer.invoke("cizi:getCodexCliStatus"),
  installCodexCli: () => ipcRenderer.invoke("cizi:installCodexCli"),
  openCodexCli: (model, useCizi) => ipcRenderer.invoke("cizi:openCodexCli", { model, useCizi }),
  planCodexCliUninstall: () => ipcRenderer.invoke("cizi:planCodexCliUninstall"),
  uninstallCodexCli: (removeShared) => ipcRenderer.invoke("cizi:uninstallCodexCli", { removeShared }),
  openCodexCliSite: () => ipcRenderer.invoke("cizi:openCodexCliSite"),
  onCodexCliInstallState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cizi:codexCliInstallState", listener);
    return () => ipcRenderer.removeListener("cizi:codexCliInstallState", listener);
  },

  getClaudeState: () => ipcRenderer.invoke("cizi:getClaudeState"),
  getClaudeProgress: () => ipcRenderer.invoke("cizi:getClaudeProgress"),
  connectClaude: (model, models, closeRunning) => ipcRenderer.invoke("cizi:connectClaude", { model, models, closeRunning }),
  disconnectClaude: (closeRunning) => ipcRenderer.invoke("cizi:disconnectClaude", { closeRunning }),
  installClaudeDesktop: () => ipcRenderer.invoke("cizi:installClaudeDesktop"),
  planClaudeDesktopUninstall: () => ipcRenderer.invoke("cizi:planClaudeDesktopUninstall"),
  uninstallClaudeDesktop: (removeLeftovers) => ipcRenderer.invoke("cizi:uninstallClaudeDesktop", { removeLeftovers }),
  launchClaudeDesktop: () => ipcRenderer.invoke("cizi:launchClaudeDesktop"),
  repairClaudeDesktop: () => ipcRenderer.invoke("cizi:repairClaudeDesktop"),
  stopClaudeDesktop: () => ipcRenderer.invoke("cizi:stopClaudeDesktop"),
  onClaudeProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cizi:claudeProgress", listener);
    return () => ipcRenderer.removeListener("cizi:claudeProgress", listener);
  },

  getCodexDesktopStatus: () => ipcRenderer.invoke("cizi:getCodexDesktopStatus"),
  installCodexDesktop: () => ipcRenderer.invoke("cizi:installCodexDesktop"),
  openCodexDesktop: () => ipcRenderer.invoke("cizi:openCodexDesktop"),
  restartCodexDesktop: () => ipcRenderer.invoke("cizi:restartCodexDesktop"),
  planCodexDesktopUninstall: () => ipcRenderer.invoke("cizi:planCodexDesktopUninstall"),
  uninstallCodexDesktop: (removeShared) => ipcRenderer.invoke("cizi:uninstallCodexDesktop", { removeShared }),
  openCodexDesktopStore: () => ipcRenderer.invoke("cizi:openCodexDesktopStore"),
  onCodexDesktopInstallState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cizi:codexDesktopInstallState", listener);
    return () => ipcRenderer.removeListener("cizi:codexDesktopInstallState", listener);
  },

  getCodexState: () => ipcRenderer.invoke("cizi:getCodexState"),
  setCodexModel: (model) => ipcRenderer.invoke("cizi:setCodexModel", { model }),
  listTools: () => ipcRenderer.invoke("cizi:listTools"),
  applyTool: (toolId, modelSlots) => ipcRenderer.invoke("cizi:applyTool", { toolId, modelSlots }),
  revertTool: (toolId) => ipcRenderer.invoke("cizi:revertTool", { toolId }),

  getLogs: (limit) => ipcRenderer.invoke("cizi:getLogs", { limit }),
  clearLogs: () => ipcRenderer.invoke("cizi:clearLogs"),
  openLogFile: () => ipcRenderer.invoke("cizi:openLogFile"),
  clientLog: (level, message, meta) => ipcRenderer.invoke("cizi:clientLog", { level, message, meta }),

  checkForUpdates: () => ipcRenderer.invoke("cizi:checkForUpdates"),
  getUpdateState: () => ipcRenderer.invoke("cizi:getUpdateState"),
  installUpdate: () => ipcRenderer.invoke("cizi:installUpdate"),
  onUpdateState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cizi:updateState", listener);
    return () => ipcRenderer.removeListener("cizi:updateState", listener);
  },

  openExternal: (url) => ipcRenderer.invoke("cizi:openExternal", { url }),

  // The CLI bridge is intentionally renderer-owned. Main can request a
  // renderer snapshot/action, but it cannot call application actions on the
  // CLI's behalf. The renderer resolves the visible DOM control and replies.
  onCliRequest: (callback) => {
    const listener = async (_event, request) => {
      try {
        const data = await callback(request);
        ipcRenderer.send("cizi:cliResponse", { requestId: request?.requestId, ok: true, data });
      } catch (error) {
        ipcRenderer.send("cizi:cliResponse", {
          requestId: request?.requestId,
          ok: false,
          error: String(error?.message || error || "Renderer UI action failed."),
        });
      }
    };
    ipcRenderer.on("cizi:cliRequest", listener);
    return () => ipcRenderer.removeListener("cizi:cliRequest", listener);
  },
  cliReady: () => ipcRenderer.send("cizi:cliReady"),
});
