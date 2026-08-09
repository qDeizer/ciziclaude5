function $(id) {
  const el = document.getElementById(id);
  if (!el) console.error("Missing element:", id);
  return el;
}

var cizi = window.cizi;
var TEMPLATES = null;
var CLAUDE_CLI_STATUS = { installed: false, command: null, version: null };
var CLAUDE_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var CODEX_CLI_STATUS = { installed: false, command: null, version: null };
var CODEX_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var CODEX_SELECTED_MODEL = "gpt-5.6-luna";
var ME = null;
var LOG_TIMER = null;
var LAST_USAGE_REFRESH = null;
const CLAUDE_CODE_CLI_TOOL_ID = "claude-code";
const CLAUDE_CODE_CLI_NAME = "Claude Code CLI";
const CODEX_CLI_TOOL_ID = "codex";
const CODEX_CLI_NAME = "Codex CLI";
var FIRST_RELEASE_TOOLS = [CLAUDE_CODE_CLI_TOOL_ID, CODEX_CLI_TOOL_ID];

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
  const [toolsRes, claudeRes, codexRes] = await Promise.all([cizi.listTools(), cizi.getClaudeCodeStatus(), cizi.getCodexCliStatus()]);
  CLAUDE_CLI_STATUS = claudeRes?.ok ? (claudeRes.data || { installed: false }) : { installed: false };
  CODEX_CLI_STATUS = codexRes?.ok ? (codexRes.data || { installed: false }) : { installed: false };
  TEMPLATES = buildDefaultTemplates();
  renderTools(toolsRes.ok ? toolsRes.data : []);
}

function buildDefaultTemplates() {
  const combos = Array.isArray(ME?.combos) ? ME.combos : [];
  const names = combos.map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  return {
    combos,
    defaultCombo: names.includes("Opus-4.8") ? "Opus-4.8" : names[0],
    tools: [{ id: CLAUDE_CODE_CLI_TOOL_ID, enabled: true }, { id: CODEX_CLI_TOOL_ID, enabled: true }],
  };
}

function updateClaudeInstallFeedback(state) {
  CLAUDE_INSTALL_STATE = { ...CLAUDE_INSTALL_STATE, ...(state || {}) };
  renderCliInstallActivity(CLAUDE_INSTALL_STATE, "claude");
}

function updateCodexInstallFeedback(state) {
  CODEX_INSTALL_STATE = { ...CODEX_INSTALL_STATE, ...(state || {}) };
  renderCliInstallActivity(CODEX_INSTALL_STATE, "codex");
}

function renderCliInstallActivity(state, cli) {
  const isCodex = cli === "codex";
  const cliName = isCodex ? CODEX_CLI_NAME : CLAUDE_CODE_CLI_NAME;
  const box = document.getElementById(isCodex ? "codex-cli-install-activity" : "claude-cli-install-activity");
  if (!box) return;
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  const visible = operations.length > 0 && state?.status !== "idle";
  box.classList.toggle("hidden", !visible);
  if (!visible) return;

  box.innerHTML = "";
  const header = document.createElement("div");
  header.className = "cli-activity-head";
  const title = document.createElement("strong");
  title.textContent = `${cliName} installation activity`;
  const overall = document.createElement("span");
  overall.className = "cli-activity-overall";
  const overallPercent = Number(state?.percent);
  const hasOverallPercent = state?.percent != null && Number.isFinite(overallPercent) && (overallPercent > 0 || state?.status === "installed");
  overall.textContent = hasOverallPercent ? `${Math.round(overallPercent)}%` : "...";
  const pulse = document.createElement("span");
  pulse.className = `cli-activity-pulse ${["installing", "downloading", "verifying", "checking"].includes(state?.status) || (state?.percent >= 0 && state?.percent < 100) ? "" : "hidden"}`;
  pulse.textContent = "● live";
  pulse.title = "Installer is still running";
  header.appendChild(title);
  header.appendChild(overall);
  header.appendChild(pulse);
  box.appendChild(header);

  const message = document.createElement("div");
  message.className = "cli-activity-message";
  message.textContent = state?.message || "Working...";
  box.appendChild(message);
  const hint = document.createElement("div");
  hint.className = "cli-activity-hint";
  if ((state?.status === "installing" || state?.phase === "install") && state?.percent >= 90) {
    hint.textContent = "Bu aşama 1–2 dk sürebilir — pencereyi kapatmayın, işlem arka planda sürüyor.";
  } else if (state?.status === "error") {
    hint.textContent = "";
  } else if (["installing", "downloading", "verifying"].includes(state?.status)) {
    hint.textContent = "Arka planda çalışıyor — lütfen bekleyin.";
  } else {
    hint.textContent = "";
  }
  if (hint.textContent) box.appendChild(hint);

  const rawActive = [...operations].find((o) => o.status === "running") || operations[operations.length - 1];
  const stepPercent = Number(rawActive?.percent);
  // A zero emitted by a third-party installer is not download progress.  It is
  // shown as indeterminate until a measurable byte/step percentage is known.
  const hasStepPercent = rawActive?.percent != null && Number.isFinite(stepPercent) && (stepPercent > 0 || rawActive?.status === "done");
  const statusClass = state?.status === "error" ? "cli-operation-error" : state?.status === "installed" ? "cli-operation-done" : "";
  const stepLabel = rawActive?.label || (state?.phase === "download" ? "Download official installer" : state?.phase === "install" ? "Run official installer" : state?.phase === "verify" ? `Verify ${cliName}` : `${cliName} installation`);
  const detailText = (rawActive?.detail || state?.message || "Working...").trim();

  const single = document.createElement("div");
  single.className = `cli-operation ${statusClass}`.trim();

  const stepRow = document.createElement("div");
  stepRow.className = "cli-step";
  stepRow.textContent = stepLabel;
  single.appendChild(stepRow);

  const rowHead = document.createElement("div");
  rowHead.className = "cli-operation-head";
  const label = document.createElement("span");
  label.className = "cli-operation-label";
  label.textContent = hasStepPercent ? "Step progress" : "Installation status";
  const percent = document.createElement("span");
  percent.className = "cli-operation-percent";
  percent.textContent = hasStepPercent ? `${Math.round(stepPercent)}%` : (state?.status === "error" ? "—" : "...");
  rowHead.appendChild(label);
  rowHead.appendChild(percent);
  single.appendChild(rowHead);

  const track = document.createElement("div");
  track.className = "cli-operation-track";
  const fill = document.createElement("span");
  fill.className = "cli-operation-fill";
  if (state?.status === "error") fill.classList.add("cli-operation-fill-error");
  if (hasStepPercent) fill.style.width = `${Math.max(0, Math.min(100, stepPercent))}%`;
  else fill.classList.add("indeterminate");
  track.appendChild(fill);
  single.appendChild(track);

  const detail = document.createElement("div");
  detail.className = "cli-operation-detail";
  detail.textContent = detailText;
  single.appendChild(detail);
  box.appendChild(single);
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
  install.dataset.cliAwaitTimeout = String(10 * 60 * 1000);
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
      setTimeout(() => {
        updateClaudeInstallFeedback({ status: "idle", percent: 0, message: "", operations: [] });
      }, 2500);
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

function renderCodexInstallActions(row, info) {
  const actions = document.createElement("div");
  actions.className = "tool-actions tool-install-actions";
  const buttons = document.createElement("div");
  buttons.className = "tool-actions-buttons";
  const install = document.createElement("button");
  install.type = "button";
  install.className = "primary tiny-btn";
  install.dataset.cliId = "codex-cli.install";
  install.dataset.cliLabel = "Install Codex CLI";
  install.dataset.cliAwait = "long";
  install.dataset.cliAwaitTimeout = String(10 * 60 * 1000);
  install.textContent = "İndir ve Kur";
  const site = document.createElement("button");
  site.type = "button";
  site.className = "ghost tiny-btn";
  site.dataset.cliId = "codex-cli.official-site";
  site.dataset.cliLabel = "Open official Codex CLI site";
  site.textContent = "Resmi indirme sitesi";
  install.addEventListener("click", async () => {
    install.disabled = true;
    site.disabled = true;
    install.textContent = "Kuruluyor...";
    updateCodexInstallFeedback({ status: "starting", percent: 0, message: "Resmî Codex yükleyicisi başlatılıyor..." });
    let res;
    try { res = await cizi.installCodexCli(); } catch (error) { res = { ok: false, error: error?.message || "Codex CLI kurulamadı." }; }
    if (res.ok && res.data?.installed) {
      CODEX_CLI_STATUS = res.data;
      updateCodexInstallFeedback({ status: "installed", percent: 100, message: "Codex CLI kuruldu." });
      toast("Codex CLI kuruldu.", "good");
      await loadTemplatesAndTools();
      setTimeout(() => updateCodexInstallFeedback({ status: "idle", percent: 0, message: "", operations: [] }), 2500);
    } else {
      install.disabled = false;
      site.disabled = false;
      install.textContent = "İndir ve Kur";
      updateCodexInstallFeedback({ status: "error", message: res.error || "Codex CLI kurulamadı." });
      toast(clientMessage(res.error || "Codex CLI kurulamadı."), "bad");
    }
  });
  site.addEventListener("click", async () => {
    const res = await cizi.openCodexCliSite();
    if (!res.ok) toast(clientMessage(res.error || "Resmî indirme sitesi açılamadı."), "bad");
  });
  buttons.appendChild(install);
  buttons.appendChild(site);
  actions.appendChild(buttons);
  row.appendChild(info);
  row.appendChild(actions);
}

function codexModelIds(models) {
  const names = (models || []).map((m) => typeof m === "string" ? m : m?.name).filter(Boolean);
  return [...new Set(["gpt-5.6-luna", "gpt-5.6-terra", ...names])];
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
    empty.textContent = "No command-line tool is available for this key.";
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
    const managedCliName = st.id === CODEX_CLI_TOOL_ID ? CODEX_CLI_NAME : CLAUDE_CODE_CLI_NAME;
    const managedCliStatus = st.id === CODEX_CLI_TOOL_ID ? CODEX_CLI_STATUS : st.id === CLAUDE_CODE_CLI_TOOL_ID ? CLAUDE_CLI_STATUS : null;
    sub.textContent = st.applied
      ? `${managedCliName} is connected to Cizi Code`
      : managedCliStatus?.installed
        ? `Kurulu: ${managedCliStatus.version || managedCliStatus.command || managedCliName}`
      : st.hasBackup
        ? "Turn on to reconnect, or leave off to keep your previous settings"
        : `Turn on to prepare ${managedCliName} automatically`;

    info.appendChild(name);
    info.appendChild(sub);

    if (st.id === CLAUDE_CODE_CLI_TOOL_ID && !CLAUDE_CLI_STATUS.installed) {
      sub.textContent = CLAUDE_CLI_STATUS.message || `${CLAUDE_CODE_CLI_NAME} is not installed on this computer.`;
      renderClaudeInstallActions(row, info);
      list.appendChild(row);
      continue;
    }
    if (st.id === CODEX_CLI_TOOL_ID && !CODEX_CLI_STATUS.installed) {
      sub.textContent = CODEX_CLI_STATUS.message || `${CODEX_CLI_NAME} is not installed on this computer.`;
      renderCodexInstallActions(row, info);
      list.appendChild(row);
      continue;
    }
    const actions = document.createElement("div");
    actions.className = "tool-actions";
    if (st.id === CODEX_CLI_TOOL_ID) {
      const modelSelect = document.createElement("select");
      modelSelect.className = "tool-model";
      modelSelect.dataset.cliId = "tool.codex-cli.model";
      modelSelect.dataset.cliLabel = "Codex model";
      for (const modelId of codexModelIds(models)) {
        const option = document.createElement("option");
        option.value = modelId;
        option.textContent = modelId;
        option.selected = modelId === CODEX_SELECTED_MODEL;
        modelSelect.appendChild(option);
      }
      modelSelect.addEventListener("change", () => { CODEX_SELECTED_MODEL = modelSelect.value; });
      actions.appendChild(modelSelect);
    }
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const cliToolId = st.id === CLAUDE_CODE_CLI_TOOL_ID ? "claude-code-cli" : st.id === CODEX_CLI_TOOL_ID ? "codex-cli" : st.id;
    cb.dataset.cliId = `tool.${cliToolId}.switch`;
    cb.dataset.cliLabel = `${st.name} connection`;
    cb.checked = !!st.applied;
    cb.disabled = enabledIds.size > 0 && !enabledIds.has(st.id);
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);
    actions.appendChild(sw);
    if (st.id === CODEX_CLI_TOOL_ID && CODEX_CLI_STATUS.installed) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ghost tiny-btn";
      openBtn.dataset.cliId = "codex-cli.open";
      openBtn.dataset.cliLabel = "Open Codex CLI";
      openBtn.textContent = "Aç";
      openBtn.title = st.applied ? "Codex'i Cizi Code profiliyle aç" : "Önce Cizi Code bağlantısını açın";
      openBtn.title = st.applied ? "Open Codex CLI with the Cizi Code profile" : "Open Codex CLI with its default settings";
      openBtn.addEventListener("click", async () => {
        openBtn.disabled = true;
        const res = await cizi.openCodexCli(CODEX_SELECTED_MODEL, !!st.applied);
        if (res.ok && !st.applied) {
          toast("Codex CLI opened with default settings.", "good");
          openBtn.disabled = false;
          return;
        }
        if (res.ok) toast("Codex CLI Cizi Code profiliyle başlatıldı.", "good");
        else toast(clientMessage(res.error || "Codex CLI başlatılamadı."), "bad");
        openBtn.disabled = false;
      });
      actions.appendChild(openBtn);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ghost tiny-btn danger";
      removeBtn.dataset.cliId = "codex-cli.purge";
      removeBtn.dataset.cliLabel = "Kökten Kaldır Codex CLI";
      removeBtn.textContent = "Kökten Kaldır";
      removeBtn.title = "Yalnızca bağımsız Codex CLI kurulumunu ve Cizi Code profilini kaldırır";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("Bağımsız Codex CLI ve Cizi Code profili kaldırılacak. Codex Desktop ve ChatGPT korunur. Devam edilsin mi?")) return;
        removeBtn.disabled = true;
        openBtn.disabled = true;
        removeBtn.textContent = "Kaldırılıyor...";
        clog("info", "Codex CLI kökten kaldırılıyor");
        const res = await cizi.uninstallCodexCli();
        if (res.ok) {
          toast("Codex CLI kaldırıldı; masaüstü uygulamaları korunuyor.", "good");
          clog("success", "Codex CLI kökten kaldırıldı");
        } else {
          toast(clientMessage(res.error || "Kökten kaldırma kısmen tamamlandı."), "bad");
          clog("warning", "Codex CLI kökten kaldırma kısmen tamamlandı");
        }
        await loadTemplatesAndTools();
      });
      actions.appendChild(removeBtn);
    }
    if (st.id === CLAUDE_CODE_CLI_TOOL_ID && CLAUDE_CLI_STATUS.installed) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "ghost tiny-btn";
      openBtn.dataset.cliId = "claude-code-cli.open";
      openBtn.dataset.cliLabel = "Open Claude Code CLI";
      openBtn.textContent = "Aç";
      openBtn.addEventListener("click", async () => {
        openBtn.disabled = true;
        const res = await cizi.openClaudeCodeCli();
        if (res.ok) toast("Claude Code CLI başlatıldı.", "good");
        else toast(clientMessage(res.error || "Claude Code CLI başlatılamadı."), "bad");
        openBtn.disabled = false;
      });
      actions.appendChild(openBtn);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ghost tiny-btn danger";
      removeBtn.dataset.cliId = "claude-code-cli.purge";
      removeBtn.dataset.cliLabel = "Kökten Kaldır Claude Code CLI";
      removeBtn.textContent = "Kökten Kaldır";
      removeBtn.title = "Claude Code CLI izlerini kökten siler";
      removeBtn.addEventListener("click", async () => {
        if (!confirm("Claude Code CLI kökten kaldırılacak. Devam edilsin mi?")) return;
        removeBtn.disabled = true;
        openBtn.disabled = true;
        removeBtn.textContent = "Kaldırılıyor...";
        clog("info", "Claude Code CLI kökten kaldırılıyor");
        const res = await cizi.uninstallClaudeCode();
        if (res.ok) {
          const n = res.data?.removed?.length || 0;
          const still = res.data?.stillExists?.length || 0;
          if (still > 0) {
            toast(`Kaldırıldı (${n} öğe) ama ${still} iz kaldı — yeniden deneyin.`, "bad");
            clog("warn", `Kökten kaldırma kısmen tamamlandı: ${still} iz kaldı`);
          } else {
            toast(`Claude Code CLI kaldırıldı (${n} öğe).`, "good");
            clog("success", `Claude Code CLI kökten kaldırıldı (${n} öğe)`);
          }
        } else {
          toast(clientMessage(res.error || "Kökten kaldırma başarısız."), "bad");
          clog("error", clientMessage(res.error || "Kökten kaldırma başarısız."));
        }
        removeBtn.disabled = false;
        openBtn.disabled = false;
        removeBtn.textContent = "Kökten Kaldır";
        await loadTemplatesAndTools();
      });
      actions.appendChild(removeBtn);
    }
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      clog("info", `${st.name}: ${cb.checked ? "connect" : "restore"}`, { tool: st.id });
      if (cb.checked) {
        if (st.id !== CODEX_CLI_TOOL_ID && !defaultModel) {
          toast("No model is available for this key.", "bad");
          cb.checked = false;
          cb.disabled = false;
          return;
        }
        const modelNames = st.id === CODEX_CLI_TOOL_ID
          ? codexModelIds(models)
          : models.map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
        const selectedModel = st.id === CODEX_CLI_TOOL_ID ? CODEX_SELECTED_MODEL : defaultModel;
        const res = await cizi.applyTool(st.id, { model: selectedModel, models: modelNames });
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
    row.appendChild(actions);
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
if (cizi.onCodexCliInstallState) cizi.onCodexCliInstallState(updateCodexInstallFeedback);
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
