function $(id) {
  const el = document.getElementById(id);
  if (!el) console.error("Missing element:", id);
  return el;
}

var cizi = window.cizi;
var TEMPLATES = null;
var CLAUDE_CLI_STATUS = { installed: false, command: null, version: null };
var CLAUDE_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var ME = null;
var LOG_TIMER = null;
var LAST_USAGE_REFRESH = null;
const CLAUDE_CODE_CLI_TOOL_ID = "claude-code";
const CLAUDE_CODE_CLI_NAME = "Claude Code CLI";
var FIRST_RELEASE_TOOLS = [CLAUDE_CODE_CLI_TOOL_ID];

function clog(level, msg, meta) {
  try {
    cizi.clientLog(level, msg, meta);
  } catch (_) {
    // Logging must never break the UI.
  }
}

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("dash-view").classList.toggle("hidden", view !== "dash");
}

function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add("hidden"), 3200);
}

function clientMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "Cizi Code could not complete the request.";
  if (/[{}]/.test(text) || /(command\s*code|commandcode|deepseek|qwen|provider|upstream|gateway|backend|model endpoint|\/v1\/models)/i.test(text)) {
    return "Cizi Code could not complete the request.";
  }
  return text;
}

function percentText(value) {
  if (value == null) return "Unlimited";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unlimited";
  return String(Math.max(0, Math.min(100, Math.round(n))));
}

async function doLogin() {
  const errEl = $("login-error");
  errEl.classList.add("hidden");
  const keyEl = $("login-key");
  const key = (keyEl.value || "").trim();
  if (!key) {
    errEl.textContent = "API key is required.";
    errEl.classList.remove("hidden");
    clog("warn", "Sign in failed: missing API key");
    return;
  }

  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in...";
  clog("info", "Sign in attempt");

  const res = await cizi.login(key);
  btn.disabled = false;
  btn.textContent = "Sign In";

  if (!res || !res.ok) {
    errEl.textContent = clientMessage(res?.error || "Sign in failed.");
    errEl.classList.remove("hidden");
    return;
  }

  await enterDashboard();
}

async function enterDashboard() {
  show("dash");
  const sess = await cizi.getSession();
  if (sess.ok && sess.data?.gateway) $("conn-base").textContent = sess.data.gateway;
  await refreshDashboardData();
  await loadLogs();
  await refreshUpdateState();
  startLogAutoRefresh();
}

async function refreshDashboardData() {
  await loadMe();
  await loadUsage($("period-select").value);
  await loadTemplatesAndTools();
  LAST_USAGE_REFRESH = new Date();
  renderLastUpdated();
}

async function loadMe() {
  const res = await cizi.getMe();
  if (!res.ok) {
    toast(clientMessage(res.error || "Account details could not be loaded."), "bad");
    return;
  }
  ME = res.data;
  renderQuota(ME);
  renderModels(ME.combos || []);
}

function renderQuota(me) {
  const pct = me.remainingPercent;
  const display = percentText(pct);
  $("quota-pct").textContent = display === "Unlimited" ? "100" : display;
  $("quota-note").textContent = display === "Unlimited"
    ? "Your plan is currently unlimited."
    : `${display}% of your usage allowance remains.`;

  const r = 52;
  const circ = 2 * Math.PI * r;
  const ring = $("ring-fg");
  ring.style.strokeDasharray = String(circ);
  const frac = pct == null ? 1 : Math.max(0, Math.min(1, Number(pct) / 100));
  ring.style.strokeDashoffset = String(circ * (1 - frac));
  ring.style.stroke = pct != null && pct <= 10 ? "var(--bad)" : pct != null && pct <= 30 ? "var(--warn)" : "var(--usage-ring)";

  const limitEl = $("limit-msg");
  if (me.isLimitReached) {
    limitEl.textContent = me.limitMessage || "Your Cizi Code usage limit has been reached.";
    limitEl.classList.remove("hidden");
  } else {
    limitEl.classList.add("hidden");
  }
}

function renderLastUpdated() {
  const el = $("usage-updated");
  if (!LAST_USAGE_REFRESH) {
    el.textContent = "Not refreshed yet";
    return;
  }
  el.textContent = `Last updated ${LAST_USAGE_REFRESH.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function renderModels(models) {
  const box = $("model-chips");
  box.innerHTML = "";
  if (!models.length) {
    const c = document.createElement("div");
    c.className = "chip empty";
    c.textContent = "No models are available yet";
    box.appendChild(c);
    return;
  }
  for (const model of models) {
    const name = typeof model === "string" ? model : model.name;
    const c = document.createElement("div");
    c.className = "chip";
    c.textContent = name;
    box.appendChild(c);
  }
}

async function loadUsage(period) {
  const res = await cizi.getUsage(period);
  if (!res.ok) {
    toast(clientMessage(res.error || "Usage trend could not be loaded."), "bad");
    return;
  }
  drawChart(normalizeUsageChart(res.data));
}

function normalizeUsageChart(payload) {
  const raw = payload?.chart || payload?.usage?.chart || payload?.data?.chart || [];
  return Array.isArray(raw) ? raw : [];
}

function chartValue(point) {
  const value = Number(
    point?.percent ??
    point?.usagePercent ??
    point?.remainingPercent ??
    point?.tokens ??
    point?.totalLimitTokens ??
    point?.totalTokens ??
    0
  );
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function drawChart(data) {
  const canvas = $("usage-chart");
  const ctx = canvas.getContext("2d");
  const W = canvas.clientWidth || canvas.parentElement.clientWidth - 36;
  const H = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const values = data.map(chartValue);
  if (!data.length || values.every((value) => value <= 0)) {
    ctx.fillStyle = "#5d6358";
    ctx.font = "12px -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No usage trend for this period yet.", W / 2, H / 2);
    return;
  }
  const max = Math.max(1, ...values);
  const bw = (W - pad.l - pad.r) / data.length;
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, "#0f312e");
  grad.addColorStop(1, "#276257");

  values.forEach((value, i) => {
    const h = (value / max) * (H - pad.t - pad.b);
    const x = pad.l + i * bw;
    const y = H - pad.b - h;
    ctx.fillStyle = grad;
    const w = Math.max(1, bw - 3);
    const rr = Math.min(4, w / 2);
    roundRect(ctx, x + 1.5, y, w, Math.max(h, 1), rr);
    ctx.fill();
  });

  ctx.fillStyle = "#5d6358";
  ctx.textAlign = "left";
  ctx.font = "10px -apple-system, Segoe UI, sans-serif";
  const step = Math.ceil(data.length / 6);
  data.forEach((d, i) => {
    if (i % step !== 0 && i !== data.length - 1) return;
    ctx.fillText(String(d.label || ""), pad.l + i * bw, H - 7);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function loadTemplatesAndTools() {
  const [toolsRes, claudeRes] = await Promise.all([cizi.listTools(), cizi.getClaudeCodeStatus()]);
  CLAUDE_CLI_STATUS = claudeRes?.ok ? (claudeRes.data || { installed: false }) : { installed: false };
  TEMPLATES = buildDefaultTemplates();
  renderTools(toolsRes.ok ? toolsRes.data : []);
}

function buildDefaultTemplates() {
  const combos = Array.isArray(ME?.combos) ? ME.combos : [];
  const names = combos.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  return {
    combos,
    defaultCombo: names.includes("Opus-4.8") ? "Opus-4.8" : names[0],
    tools: [{ id: CLAUDE_CODE_CLI_TOOL_ID, enabled: true }],
  };
}

function updateClaudeInstallFeedback(state) {
  CLAUDE_INSTALL_STATE = { ...CLAUDE_INSTALL_STATE, ...(state || {}) };
  renderClaudeInstallActivity(CLAUDE_INSTALL_STATE);
}

function renderClaudeInstallActivity(state) {
  const box = document.getElementById("claude-cli-install-activity");
  if (!box) return;
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  const visible = operations.length > 0 && state?.status !== "idle";
  box.classList.toggle("hidden", !visible);
  if (!visible) return;

  box.innerHTML = "";
  const header = document.createElement("div");
  header.className = "cli-activity-head";
  const title = document.createElement("strong");
  title.textContent = "Claude Code CLI installation activity";
  const overall = document.createElement("span");
  overall.className = "cli-activity-overall";
  overall.textContent = state?.percent != null && Number.isFinite(Number(state.percent)) ? `${Math.round(Number(state.percent))}%` : "...";
  header.appendChild(title);
  header.appendChild(overall);
  box.appendChild(header);

  const message = document.createElement("div");
  message.className = "cli-activity-message";
  message.textContent = state?.message || "Working...";
  box.appendChild(message);

  const list = document.createElement("div");
  list.className = "cli-operation-list";
  for (const operation of operations) {
    const row = document.createElement("div");
    row.className = `cli-operation cli-operation-${operation.status || "pending"}`;

    const rowHead = document.createElement("div");
    rowHead.className = "cli-operation-head";
    const label = document.createElement("span");
    label.className = "cli-operation-label";
    label.textContent = operation.label || operation.id || "Operation";
    const percent = document.createElement("span");
    percent.className = "cli-operation-percent";
    const hasPercent = operation.percent != null && Number.isFinite(Number(operation.percent));
    percent.textContent = hasPercent
      ? `${Math.round(Number(operation.percent))}%`
      : operation.status === "done" ? "100%" : "...";
    rowHead.appendChild(label);
    rowHead.appendChild(percent);
    row.appendChild(rowHead);

    const track = document.createElement("div");
    track.className = "cli-operation-track";
    const fill = document.createElement("span");
    fill.className = "cli-operation-fill";
    if (hasPercent) fill.style.width = `${Math.max(0, Math.min(100, Number(operation.percent)))}%`;
    else fill.classList.add("indeterminate");
    track.appendChild(fill);
    row.appendChild(track);

    const detail = document.createElement("div");
    detail.className = "cli-operation-detail";
    detail.textContent = operation.detail || (operation.status === "done" ? "Completed" : "Waiting...");
    row.appendChild(detail);
    list.appendChild(row);
  }
  box.appendChild(list);
}

function renderClaudeInstallActions(row, info) {
  const actions = document.createElement("div");
  actions.className = "tool-actions tool-install-actions";

  const buttons = document.createElement("div");
  buttons.className = "tool-actions-buttons";

  const install = document.createElement("button");
  install.type = "button";
  install.className = "primary tiny-btn";
  install.dataset.cliId = "claude-code-cli.install";
  install.dataset.cliLabel = "Install Claude Code CLI";
  install.dataset.cliAwait = "long";
  install.dataset.cliAwaitTimeout = String(5 * 60 * 1000);
  install.textContent = "Download & Install";

  const site = document.createElement("button");
  site.type = "button";
  site.className = "ghost tiny-btn";
  site.dataset.cliId = "claude-code-cli.official-site";
  site.dataset.cliLabel = "Open official Claude Code site";
  site.textContent = "Go to official site";
  install.addEventListener("click", async () => {
    install.disabled = true;
    site.disabled = true;
    install.textContent = "Installing...";
    updateClaudeInstallFeedback({ status: "starting", percent: 0, message: "Starting the official Claude Code installer..." });
    let res;
    try {
      res = await cizi.installClaudeCode();
    } catch (error) {
      res = { ok: false, error: error?.message || "Claude Code CLI could not be installed." };
    }
    if (res.ok && res.data?.installed) {
      CLAUDE_CLI_STATUS = res.data;
      updateClaudeInstallFeedback({ status: "installed", percent: 100, message: "Claude Code CLI is installed." });
      toast("Claude Code CLI installed.", "good");
      await loadTemplatesAndTools();
    } else {
      install.disabled = false;
      site.disabled = false;
      install.textContent = "Download & Install";
      updateClaudeInstallFeedback({ status: "error", message: res.error || "Claude Code CLI could not be installed." });
      toast(clientMessage(res.error || "Claude Code CLI could not be installed."), "bad");
    }
  });
  site.addEventListener("click", async () => {
    const res = await cizi.openClaudeCodeSite();
    if (!res.ok) toast(clientMessage(res.error || "Official site could not be opened."), "bad");
  });

  buttons.appendChild(install);
  buttons.appendChild(site);
  actions.appendChild(buttons);
  row.appendChild(info);
  row.appendChild(actions);
}

function renderTools(statuses) {
  const list = $("tools-list");
  list.innerHTML = "";
  if (!TEMPLATES) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Tool access could not be loaded.";
    list.appendChild(empty);
    return;
  }

  const models = TEMPLATES?.combos || [];
  const templateTools = Array.isArray(TEMPLATES?.tools) ? TEMPLATES.tools : [];
  const enabledIds = new Set(templateTools.filter((t) => t.enabled).map((t) => t.id));
  const offered = templateTools
    .map((t) => t.id)
    .filter((id) => FIRST_RELEASE_TOOLS.includes(id));
  const defaultModel = getDefaultModel(models);

  if (!offered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = `${CLAUDE_CODE_CLI_NAME} is not available for this key.`;
    list.appendChild(empty);
    return;
  }

  for (const st of statuses) {
    if (!offered.includes(st.id)) continue;

    const row = document.createElement("div");
    row.className = "tool-row";

    const info = document.createElement("div");
    info.className = "tool-info";

    const name = document.createElement("div");
    name.className = "tool-name";
    name.textContent = st.name;

    const sub = document.createElement("div");
    sub.className = "tool-sub";
    sub.textContent = st.applied
      ? `${CLAUDE_CODE_CLI_NAME} is connected to Cizi Code`
      : st.hasBackup
        ? "Turn on to reconnect, or leave off to keep your previous settings"
        : `Turn on to prepare ${CLAUDE_CODE_CLI_NAME} automatically`;

    info.appendChild(name);
    info.appendChild(sub);

    if (st.id === CLAUDE_CODE_CLI_TOOL_ID && !CLAUDE_CLI_STATUS.installed) {
      sub.textContent = CLAUDE_CLI_STATUS.message || `${CLAUDE_CODE_CLI_NAME} is not installed on this computer.`;
      renderClaudeInstallActions(row, info);
      list.appendChild(row);
      continue;
    }

    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const cliToolId = st.id === CLAUDE_CODE_CLI_TOOL_ID ? "claude-code-cli" : st.id;
    cb.dataset.cliId = `tool.${cliToolId}.switch`;
    cb.dataset.cliLabel = `${st.name} connection`;
    cb.checked = !!st.applied;
    cb.disabled = enabledIds.size > 0 && !enabledIds.has(st.id);
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);

    cb.addEventListener("change", async () => {
      cb.disabled = true;
      clog("info", `${st.name}: ${cb.checked ? "connect" : "restore"}`, { tool: st.id });
      if (cb.checked) {
        if (!defaultModel) {
          toast("No model is available for this key.", "bad");
          cb.checked = false;
          cb.disabled = false;
          return;
        }
        const modelNames = models.map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
        const res = await cizi.applyTool(st.id, { model: defaultModel, models: modelNames });
        if (res.ok) toast(`${st.name} connected.`, "good");
        else {
          toast(clientMessage(res.error || "Could not connect this tool."), "bad");
          cb.checked = false;
        }
      } else {
        const res = await cizi.revertTool(st.id);
        if (res.ok && !res.applied) {
          toast(res.restored ? `${st.name} restored.` : `${st.name} disconnected.`, "good");
        }
        else {
          toast(clientMessage(res.error || "Could not restore this tool."), "bad");
          cb.checked = true;
        }
      }
      cb.disabled = false;
      const r = await cizi.listTools();
      if (r.ok) renderTools(r.data);
      loadLogs();
    });

    row.appendChild(info);
    row.appendChild(sw);
    list.appendChild(row);
  }

  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No matching local tools were found.";
    list.appendChild(empty);
  }
}

function getDefaultModel(models) {
  const names = (models || []).map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  if (TEMPLATES?.defaultCombo && names.includes(TEMPLATES.defaultCombo)) return TEMPLATES.defaultCombo;
  if (names.includes("Opus-4.8")) return "Opus-4.8";
  return names[0] || "Opus-4.8";
}

function logTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

async function loadLogs() {
  if (!document.getElementById("log-list")) return;
  const res = await cizi.getLogs(200);
  if (!res.ok) return;
  renderLogs(res.data?.entries || []);
}

function renderLogs(entries) {
  const box = document.getElementById("log-list");
  if (!box) return;
  const filter = document.getElementById("log-level-filter")?.value || "";
  const rows = (filter ? entries.filter((e) => e.level === filter) : entries).slice().reverse();
  if (!rows.length) {
    box.innerHTML = '<div class="log-empty muted tiny">No activity yet.</div>';
    return;
  }
  box.innerHTML = rows.map((e) => `<div class="log-row log-${escapeHtml(e.level)}">
      <span class="log-ts">${escapeHtml(logTime(e.ts))}</span>
      <span class="log-badge log-badge-${escapeHtml(e.level)}">${escapeHtml(String(e.level || "").toUpperCase())}</span>
      <span class="log-scope">${escapeHtml(e.scope || "")}</span>
      <span class="log-msg">${escapeHtml(e.message || "")}</span>
    </div>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function startLogAutoRefresh() {
  stopLogAutoRefresh();
  const live = document.getElementById("log-live");
  if (live && !live.checked) return;
  if (!document.getElementById("log-list")) return;
  LOG_TIMER = setInterval(loadLogs, 3000);
}

function stopLogAutoRefresh() {
  if (LOG_TIMER) {
    clearInterval(LOG_TIMER);
    LOG_TIMER = null;
  }
}

function renderUpdateState(state) {
  const banner = $("update-banner");
  const msg = $("update-message");
  const install = $("update-install");
  const visible = ["available", "downloading", "installing", "ready", "error"].includes(state?.status);
  banner.classList.toggle("hidden", !visible);
  install.classList.toggle("hidden", state?.status !== "ready");
  msg.textContent = state?.message || "";
}

async function refreshUpdateState() {
  const res = await cizi.getUpdateState();
  if (res.ok) renderUpdateState(res.data);
}

$("login-btn").addEventListener("click", doLogin);
$("login-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});
$("logout-btn").addEventListener("click", async () => {
  clog("info", "Signed out");
  stopLogAutoRefresh();
  await cizi.logout();
  show("login");
});
$("period-select").addEventListener("change", (e) => loadUsage(e.target.value));
$("usage-refresh").addEventListener("click", async () => {
  const btn = $("usage-refresh");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Refreshing...";
  try {
    await refreshDashboardData();
    toast("Usage refreshed.", "good");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
});

if (document.getElementById("log-refresh")) $("log-refresh").addEventListener("click", loadLogs);
if (document.getElementById("log-level-filter")) $("log-level-filter").addEventListener("change", loadLogs);
if (document.getElementById("log-open")) $("log-open").addEventListener("click", async () => { await cizi.openLogFile(); });
if (document.getElementById("log-clear")) $("log-clear").addEventListener("click", async () => { await cizi.clearLogs(); await loadLogs(); });
if (document.getElementById("log-live")) {
  $("log-live").addEventListener("change", (e) => {
    if (e.target.checked) startLogAutoRefresh();
    else stopLogAutoRefresh();
  });
}

$("update-check").addEventListener("click", async () => {
  const res = await cizi.checkForUpdates();
  if (res.ok) {
    renderUpdateState(res.data);
    if (["current", "skipped"].includes(res.data?.status)) toast(res.data.message, "good");
  } else {
    toast(clientMessage(res.error || "Update check failed."), "bad");
  }
});
$("update-install").addEventListener("click", async () => {
  const res = await cizi.installUpdate();
  if (!res.ok) toast(clientMessage(res.error || "Update could not be installed."), "bad");
});
cizi.onUpdateState(renderUpdateState);
if (cizi.onClaudeCodeInstallState) cizi.onClaudeCodeInstallState(updateClaudeInstallFeedback);
if (window.ciziCliUi?.handle && cizi.onCliRequest && cizi.cliReady) {
  cizi.onCliRequest((request) => window.ciziCliUi.handle(request));
  cizi.cliReady();
}

(async function boot() {
  const sess = await cizi.getSession();
  if (sess.ok && sess.data?.loggedIn) {
    await enterDashboard();
  } else {
    show("login");
    await refreshUpdateState();
  }
})();
