function $(id) {
  const el = document.getElementById(id);
  if (!el) console.error("Missing element:", id);
  return el;
}

var cizi = window.cizi;
var TEMPLATES = null;
var CLAUDE_CLI_STATUS = { installed: false, command: null, version: null };
var CLAUDE_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var CLAUDE_STATE = { cli: { installed: false, applied: false }, desktop: { installed: false, applied: false }, connected: false, installedProducts: [] };
var CLAUDE_PROGRESS = { phase: "idle", message: "", details: null };
var CLAUDE_INSTALL_BUTTON = null;
var CLAUDE_SELECTED_MODEL = null;
var CODEX_CLI_STATUS = { installed: false, command: null, version: null };
var CODEX_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var CODEX_DESKTOP_STATUS = { installed: false, version: null, packageFullName: null };
var CODEX_DESKTOP_INSTALL_STATE = { status: "idle", percent: 0, message: "" };
var CODEX_CONFIG_STATE = { applied: false, model: null, path: null };
var CODEX_SELECTED_MODEL = null;
var ME = null;
var LOG_TIMER = null;
var LAST_USAGE_REFRESH = null;
const CLAUDE_CODE_CLI_TOOL_ID = "claude-code";
const CLAUDE_CODE_CLI_NAME = "Claude Code CLI";
const CODEX_CLI_TOOL_ID = "codex";
const CODEX_CLI_NAME = "Codex CLI";
const CLAUDE_DESKTOP_NAME = "Claude Desktop";
const CODEX_DESKTOP_NAME = "ChatGPT Desktop";
var FIRST_RELEASE_TOOLS = [CLAUDE_CODE_CLI_TOOL_ID, CODEX_CLI_TOOL_ID];

// The key's own model list decides which local products it may configure.
const { modelNames, modelsForTool, toolIsUnlocked, toolIsGated } = window.ciziModelFamilies;

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
  const [toolsRes, claudeRes, codexRes] = await Promise.all([cizi.listTools(), cizi.getClaudeState(), cizi.getCodexState()]);
  // One call reports both Claude products and whether the pair is connected.
  CLAUDE_STATE = claudeRes?.ok
    ? (claudeRes.data || CLAUDE_STATE)
    : { cli: { installed: false, applied: false }, desktop: { installed: false, applied: false }, connected: false, installedProducts: [] };
  CLAUDE_CLI_STATUS = CLAUDE_STATE.cli || { installed: false };
  // One call reports both Codex products and the shared config they read.
  const codex = codexRes?.ok ? (codexRes.data || {}) : {};
  CODEX_CLI_STATUS = codex.cli || { installed: false };
  CODEX_DESKTOP_STATUS = codex.desktop || { installed: false };
  CODEX_CONFIG_STATE = { ...(codex.config || { applied: false }), path: codex.configPath || null };
  // The model box follows what the shared config actually says, so the UI never
  // claims a model that Codex is not really using.
  if (CODEX_CONFIG_STATE.applied && CODEX_CONFIG_STATE.model) CODEX_SELECTED_MODEL = CODEX_CONFIG_STATE.model;
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

function updateCodexDesktopInstallFeedback(state) {
  CODEX_DESKTOP_INSTALL_STATE = { ...CODEX_DESKTOP_INSTALL_STATE, ...(state || {}) };
  renderCliInstallActivity(CODEX_DESKTOP_INSTALL_STATE, "codex-desktop");
}

const INSTALL_ACTIVITY_TARGETS = {
  claude: { box: "claude-cli-install-activity", name: CLAUDE_CODE_CLI_NAME },
  "claude-desktop": { box: "claude-desktop-install-activity", name: CLAUDE_DESKTOP_NAME },
  codex: { box: "codex-cli-install-activity", name: CODEX_CLI_NAME },
  "codex-desktop": { box: "codex-desktop-install-activity", name: CODEX_DESKTOP_NAME },
};

// While a Claude Desktop installation is running the button is the part of the
// row the user watches, so it names the phase the installer is really in rather
// than claiming "Kuruluyor" for the whole download.
const CLAUDE_INSTALL_BUTTON_LABELS = {
  starting: "Hazırlanıyor...",
  downloading: "İndiriliyor...",
  "verifying-signature": "İmza doğrulanıyor...",
  installing: "Kuruluyor...",
  verifying: "Doğrulanıyor...",
};

// Claude Desktop reports progress as (phase, message, details) from its own
// transplanted engine. This maps that onto the activity panel the other tools
// already use, so every long operation looks the same to the user.
// The activity panel styles itself from `status`, so the phase has to be mapped
// onto it rather than flattened to "installing". Reporting the download as
// "installing" is what left the bar with no measurable step: the panel treats a
// download percentage and an install percentage differently, and the download —
// the only phase that has a real percentage — was never labelled as one.
const CLAUDE_PROGRESS_STATUS = {
  starting: "checking",
  downloading: "downloading",
  "verifying-signature": "verifying",
  installing: "installing",
  verifying: "verifying",
  uninstalling: "installing",
  configuring: "installing",
  authenticating: "installing",
  translating: "installing",
  restoring: "installing",
  stopping: "installing",
  repairing: "installing",
};

function updateClaudeProgress(progress) {
  CLAUDE_PROGRESS = progress || { phase: "idle", message: "", details: null };
  const phase = String(CLAUDE_PROGRESS.phase || "");
  const percent = CLAUDE_PROGRESS.details && Number.isFinite(Number(CLAUDE_PROGRESS.details.percent))
    ? Number(CLAUDE_PROGRESS.details.percent)
    : null;
  if (CLAUDE_INSTALL_BUTTON && CLAUDE_INSTALL_BUTTON_LABELS[phase]) {
    // The download is minutes long, so its percentage goes on the button too —
    // that is the control the user is looking at while they wait.
    CLAUDE_INSTALL_BUTTON.textContent = phase === "downloading" && percent !== null
      ? `İndiriliyor %${Math.round(percent)}`
      : CLAUDE_INSTALL_BUTTON_LABELS[phase];
  }
  const active = Boolean(phase) && phase !== "idle" && phase !== "complete" && Boolean(CLAUDE_PROGRESS.message);
  const failed = phase === "error";
  renderCliInstallActivity({
    status: failed ? "error"
      : phase === "complete" ? "installed"
        : active ? (CLAUDE_PROGRESS_STATUS[phase] || "installing") : "idle",
    phase,
    percent: failed ? null : phase === "complete" ? 100 : percent,
    message: CLAUDE_PROGRESS.message || "",
    operations: active || failed || phase === "complete"
      ? [{
        id: "claude-desktop",
        label: claudePhaseLabel(phase),
        status: failed ? "error" : phase === "complete" ? "done" : "running",
        percent: failed ? null : phase === "complete" ? 100 : percent,
        detail: CLAUDE_PROGRESS.message || "",
      }]
      : [],
  }, "claude-desktop");
}

function claudePhaseLabel(phase) {
  const labels = {
    starting: "Kuruluma hazırlanılıyor",
    downloading: "Claude Desktop indiriliyor",
    "verifying-signature": "Dijital imza doğrulanıyor",
    installing: "Claude Desktop kuruluyor",
    verifying: "Kurulum doğrulanıyor",
    uninstalling: "Claude Desktop kaldırılıyor",
    configuring: "Ayarlar uygulanıyor",
    authenticating: "Kimlik doğrulama hazırlanıyor",
    translating: "Arayüz paketi kontrol ediliyor",
    restoring: "Önceki ayarlara dönülüyor",
    stopping: "Claude Desktop kapatılıyor",
    repairing: "Ayarlar yenileniyor",
    complete: "Tamamlandı",
    error: "İşlem tamamlanamadı",
  };
  return labels[phase] || "Claude Desktop işlemi";
}

function renderCliInstallActivity(state, cli) {
  const target = INSTALL_ACTIVITY_TARGETS[cli] || INSTALL_ACTIVITY_TARGETS.claude;
  const cliName = target.name;
  const box = document.getElementById(target.box);
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

function button({ label, className, cliId, cliLabel, title, onClick, long }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.dataset.cliId = cliId;
  element.dataset.cliLabel = cliLabel || label;
  if (title) element.title = title;
  if (long) {
    element.dataset.cliAwait = "long";
    element.dataset.cliAwaitTimeout = String(15 * 60 * 1000);
  }
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

// Model ids come from the gateway. The two documented defaults stay as a
// fallback for keys whose model list has not loaded yet, and whatever the
// shared config currently names is always offered so the UI can display the
// real state rather than silently switching the user to something else.
function codexModelIds(models) {
  const names = (models || []).map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  const fallback = names.length ? [] : ["gpt-5.6-luna", "gpt-5.6-terra"];
  const current = [CODEX_CONFIG_STATE.model, CODEX_SELECTED_MODEL].filter(Boolean);
  return [...new Set([...names, ...fallback, ...current])];
}

const CODEX_PREFERRED_MODEL = "gpt-5.6-luna";

// What the model box should start on. The connected config wins, because that
// is what Codex is really using. Otherwise the documented Codex default is
// preferred over the account's first model, which may well be a model that
// belongs to a different tool.
function codexDefaultModel(models) {
  const ids = codexModelIds(models);
  if (CODEX_CONFIG_STATE.applied && CODEX_CONFIG_STATE.model && ids.includes(CODEX_CONFIG_STATE.model)) return CODEX_CONFIG_STATE.model;
  if (CODEX_SELECTED_MODEL && ids.includes(CODEX_SELECTED_MODEL)) return CODEX_SELECTED_MODEL;
  if (ids.includes(CODEX_PREFERRED_MODEL)) return CODEX_PREFERRED_MODEL;
  return ids.find((id) => /^gpt-/i.test(id)) || ids[0] || null;
}

// The shared-folder note below is a Codex-only concept: its two products read
// one config file, so a removal has to say whether that file survives. Claude's
// two products share nothing, and its plan carries no `sharedRemovable` flag —
// the note is skipped entirely rather than defaulting to the "other Codex
// product" wording it used to fall through to.
function describeRemovalPlan(plan, productName) {
  const removeList = (plan?.remove || []).map((item) => `  • ${item.path}\n    (${item.reason})`).join("\n");
  const preserveList = (plan?.preserve || []).map((item) => `  • ${item.path}\n    (${item.reason})`).join("\n");
  const lines = [`${productName} kökten kaldırılacak.`, ""];
  if (removeList) lines.push("SİLİNECEK:", removeList, "");
  if (preserveList) lines.push("KORUNACAK:", preserveList, "");
  if (plan?.sharedRemovable === true) {
    lines.push("Bu bilgisayarda başka Codex ürünü kalmıyor, bu yüzden ortak Codex klasörü de silinecek.");
    lines.push("Bu klasörde oturum bilgileri, sohbet geçmişi ve ayarlar bulunur.", "");
  } else if (plan?.sharedRemovable === false) {
    lines.push("Diğer Codex ürünü kurulu olduğu için ortak klasöre ve ayar dosyasına dokunulmayacak.", "");
  }
  lines.push("Devam edilsin mi?");
  return lines.join("\n");
}

// One product line inside the Codex row: install when missing, open/remove when
// present. Both products use the same shape so the two stay comparable.
function codexProductBlock({ name, idPrefix, status, detail, installLabel, onInstall, onOpen, onRemove, onSite, siteLabel, feedback }) {
  const block = document.createElement("div");
  block.className = "codex-product";

  const head = document.createElement("div");
  head.className = "codex-product-info";
  const title = document.createElement("div");
  title.className = "codex-product-name";
  title.textContent = name;
  const sub = document.createElement("div");
  sub.className = "tool-sub";
  sub.textContent = detail;
  head.appendChild(title);
  head.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "tool-actions-buttons";

  if (status.installed) {
    actions.appendChild(button({
      label: "Aç", className: "ghost tiny-btn", cliId: `${idPrefix}.open`, cliLabel: `${name} aç`, onClick: onOpen,
    }));
    actions.appendChild(button({
      label: "Kökten Kaldır", className: "ghost tiny-btn danger", cliId: `${idPrefix}.purge`,
      cliLabel: `${name} kökten kaldır`, onClick: onRemove,
    }));
  } else {
    actions.appendChild(button({
      label: installLabel, className: "primary tiny-btn", cliId: `${idPrefix}.install`,
      cliLabel: `${name} kur`, long: true, onClick: onInstall,
    }));
    actions.appendChild(button({
      label: siteLabel, className: "ghost tiny-btn", cliId: `${idPrefix}.official-site`,
      cliLabel: `${name} resmî sayfası`, onClick: onSite,
    }));
  }

  block.appendChild(head);
  block.appendChild(actions);
  void feedback;
  return block;
}

// The Claude row. Unlike Codex, the two Claude products share no config file:
// the CLI is configured through ~/.claude/settings.json and the desktop app
// through its own managed surface. The single switch is honest about that — it
// connects both as one unit, and the main process rolls the first back if the
// second refuses.
function renderClaudeRow(st, models) {
  const row = document.createElement("div");
  row.className = "tool-row codex-row";

  const cli = CLAUDE_STATE.cli || { installed: false };
  const desktop = CLAUDE_STATE.desktop || { installed: false };
  const anyInstalled = Boolean(cli.installed || desktop.installed);
  const connected = CLAUDE_STATE.connected === true;

  const info = document.createElement("div");
  info.className = "tool-info";
  const name = document.createElement("div");
  name.className = "tool-name";
  name.textContent = "Claude (Code CLI + Desktop)";
  const sub = document.createElement("div");
  sub.className = "tool-sub";
  sub.textContent = CLAUDE_STATE.blockReason
    ? CLAUDE_STATE.blockReason
    : connected
      ? "Bağlı — tek anahtar kurulu olan Claude ürünlerini birlikte yönetiyor"
      : CLAUDE_STATE.partial
        ? "Yarım bağlantı algılandı — anahtarı kapatıp yeniden açın"
        : anyInstalled
          ? "Tek anahtar Claude Code CLI ve Claude Desktop'ı birlikte Cizi Code'a bağlar"
          : "Bağlamak için önce en az bir Claude ürünü kurun";
  info.appendChild(name);
  info.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "tool-actions";

  const modelSelect = document.createElement("select");
  modelSelect.className = "tool-model";
  modelSelect.dataset.cliId = "tool.claude.model";
  modelSelect.dataset.cliLabel = "Claude modeli";
  const names = (models || []).map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean);
  const selected = CLAUDE_SELECTED_MODEL && names.includes(CLAUDE_SELECTED_MODEL)
    ? CLAUDE_SELECTED_MODEL
    : getDefaultModel(models);
  CLAUDE_SELECTED_MODEL = selected;
  for (const modelId of names.length ? names : [selected].filter(Boolean)) {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    option.selected = modelId === selected;
    modelSelect.appendChild(option);
  }
  // Claude Desktop pins one model at a time, so changing it means reconnecting.
  modelSelect.disabled = connected;
  modelSelect.title = connected ? "Modeli değiştirmek için önce bağlantıyı kapatın" : "";
  modelSelect.addEventListener("change", () => { CLAUDE_SELECTED_MODEL = modelSelect.value; });
  actions.appendChild(modelSelect);

  const sw = document.createElement("label");
  sw.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.cliId = "tool.claude.switch";
  cb.dataset.cliLabel = "Claude bağlantısı";
  cb.dataset.cliAwait = "long";
  cb.dataset.cliAwaitTimeout = String(10 * 60 * 1000);
  cb.checked = connected;
  cb.disabled = !anyInstalled || CLAUDE_STATE.canConnect === false;
  if (!anyInstalled) sw.title = "Önce Claude Code CLI veya Claude Desktop kurun";
  const slider = document.createElement("span");
  slider.className = "slider";
  sw.appendChild(cb);
  sw.appendChild(slider);
  actions.appendChild(sw);

  cb.addEventListener("change", async () => {
    cb.disabled = true;
    const turningOn = cb.checked;
    clog("info", `Claude: ${turningOn ? "bağlanıyor" : "geri alınıyor"}`, { tool: st.id });
    // Claude Desktop reads its managed configuration once at startup, so it has
    // to be closed for the switch to change anything — and it opens itself right
    // after being installed, which is exactly when the switch is first used.
    // The main process reports that as a question rather than a failure; asking
    // and retrying once is what makes the switch work instead of appearing dead.
    const runWithRestartPrompt = async (attempt) => {
      let result = await attempt(false);
      if (!result.ok && result.code === "PROCESS_RUNNING_CONFIRMATION_REQUIRED") {
        const proceed = confirm(turningOn
          ? "Claude Desktop şu an açık.\n\nAyarların uygulanabilmesi için kapatılması gerekiyor. Kapatılsın mı?"
          : "Claude Desktop şu an açık.\n\nÖnceki ayarlarınızın geri yüklenebilmesi için kapatılması gerekiyor. Kapatılsın mı?");
        if (!proceed) return { ok: false, cancelled: true };
        result = await attempt(true);
      }
      return result;
    };

    let res;
    if (turningOn) {
      if (!CLAUDE_SELECTED_MODEL) {
        toast("Bu anahtar için model bulunamadı.", "bad");
        cb.checked = false;
        cb.disabled = false;
        return;
      }
      res = await runWithRestartPrompt((closeRunning) =>
        cizi.connectClaude(CLAUDE_SELECTED_MODEL, names, closeRunning));
      if (res.ok) {
        const products = res.data?.connectedProducts || [];
        toast(products.includes("desktop")
          ? "Claude bağlandı. Claude Desktop yeni ayarlarla açıldı."
          : "Claude Code CLI bağlandı.", "good");
      } else {
        if (!res.cancelled) toast(clientMessage(res.error || "Claude bağlanamadı."), "bad");
        cb.checked = false;
      }
    } else {
      res = await runWithRestartPrompt((closeRunning) => cizi.disconnectClaude(closeRunning));
      if (res.ok) toast("Claude bağlantısı kaldırıldı; önceki ayarlarınız geri yüklendi.", "good");
      else {
        if (!res.cancelled) toast(clientMessage(res.error || "Claude bağlantısı geri alınamadı."), "bad");
        cb.checked = true;
      }
    }
    cb.disabled = false;
    await loadTemplatesAndTools();
    loadLogs();
  });

  row.appendChild(info);
  row.appendChild(actions);

  const products = document.createElement("div");
  products.className = "codex-products";

  products.appendChild(codexProductBlock({
    name: CLAUDE_CODE_CLI_NAME,
    idPrefix: "claude-code-cli",
    status: cli,
    detail: cli.installed
      ? `Kurulu · ${cli.version || cli.command}`
      : "Kurulu değil · resmî yükleyiciyle kurulur",
    installLabel: "İndir ve Kur",
    siteLabel: "Resmî site",
    onInstall: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      target.textContent = "Kuruluyor...";
      updateClaudeInstallFeedback({ status: "starting", percent: 0, message: "Resmî Claude Code yükleyicisi başlatılıyor...", operations: [] });
      let res;
      try { res = await cizi.installClaudeCode(); } catch (error) { res = { ok: false, error: error?.message || "Claude Code CLI kurulamadı." }; }
      if (res.ok && res.data?.installed) {
        updateClaudeInstallFeedback({ status: "installed", percent: 100, message: "Claude Code CLI kuruldu." });
        toast("Claude Code CLI kuruldu.", "good");
        await loadTemplatesAndTools();
        setTimeout(() => updateClaudeInstallFeedback({ status: "idle", percent: 0, message: "", operations: [] }), 2500);
      } else {
        target.disabled = false;
        target.textContent = "İndir ve Kur";
        updateClaudeInstallFeedback({ status: "error", message: res.error || "Claude Code CLI kurulamadı." });
        toast(clientMessage(res.error || "Claude Code CLI kurulamadı."), "bad");
      }
    },
    onSite: async () => {
      const res = await cizi.openClaudeCodeSite();
      if (!res.ok) toast(clientMessage(res.error || "Resmî site açılamadı."), "bad");
    },
    onOpen: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      const res = await cizi.openClaudeCodeCli();
      target.disabled = false;
      if (res.ok) toast("Claude Code CLI başlatıldı.", "good");
      else toast(clientMessage(res.error || "Claude Code CLI başlatılamadı."), "bad");
    },
    onRemove: async (event) => {
      const target = event.currentTarget;
      if (!confirm("Claude Code CLI kökten kaldırılacak. Claude Desktop korunur. Devam edilsin mi?")) return;
      target.disabled = true;
      target.textContent = "Kaldırılıyor...";
      clog("info", "Claude Code CLI kökten kaldırılıyor");
      const res = await cizi.uninstallClaudeCode();
      if (res.ok && !(res.data?.stillExists || []).length) {
        toast("Claude Code CLI kaldırıldı.", "good");
        clog("success", "Claude Code CLI kökten kaldırıldı");
      } else {
        toast(clientMessage(res.error || "Kaldırma kısmen tamamlandı."), "bad");
        clog("warning", "Claude Code CLI kaldırma kısmen tamamlandı");
      }
      await loadTemplatesAndTools();
    },
  }));

  products.appendChild(claudeDesktopBlock(desktop, connected));
  row.appendChild(products);
  return row;
}

// Claude Desktop needs a repair action the other products do not: a Claude
// update replaces the managed configuration, and the transplanted engine
// re-applies it in one transaction.
function claudeDesktopBlock(desktop, connected) {
  const block = document.createElement("div");
  block.className = "codex-product";

  const head = document.createElement("div");
  head.className = "codex-product-info";
  const title = document.createElement("div");
  title.className = "codex-product-name";
  title.textContent = CLAUDE_DESKTOP_NAME;
  const sub = document.createElement("div");
  sub.className = "tool-sub";
  sub.textContent = !desktop.installed
    ? "Kurulu değil · resmî Claude paketiyle kurulur"
    : desktop.needsRefresh
      ? `Kurulu · sürüm ${desktop.version || "bilinmiyor"} · ayarlar yenilenmeli`
      : desktop.running
        ? `Kurulu · sürüm ${desktop.version || "bilinmiyor"} · şu an açık`
        : `Kurulu · sürüm ${desktop.version || "bilinmiyor"}`;
  head.appendChild(title);
  head.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "tool-actions-buttons";

  if (!desktop.installed) {
    actions.appendChild(button({
      label: "İndir ve Kur", className: "primary tiny-btn", cliId: "claude-desktop.install",
      cliLabel: "Claude Desktop kur", long: true,
      onClick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        // The package is a quarter of a gigabyte: most of the wait is the
        // download, so the button must not claim it is already installing.
        CLAUDE_INSTALL_BUTTON = target;
        target.textContent = "Hazırlanıyor...";
        updateClaudeProgress({ phase: "starting", message: "Claude Desktop kurulumu başlatılıyor...", details: null });
        let res;
        try { res = await cizi.installClaudeDesktop(); } catch (error) { res = { ok: false, error: error?.message || "Claude Desktop kurulamadı." }; }
        CLAUDE_INSTALL_BUTTON = null;
        if (res.ok) {
          updateClaudeProgress({ phase: "complete", message: "Claude Desktop kuruldu.", details: null });
          toast("Claude Desktop kuruldu.", "good");
          clog("success", "Claude Desktop kuruldu");
          await loadTemplatesAndTools();
          setTimeout(() => updateClaudeProgress({ phase: "idle", message: "", details: null }), 2500);
        } else {
          target.disabled = false;
          target.textContent = "İndir ve Kur";
          updateClaudeProgress({ phase: "error", message: res.error || "Claude Desktop kurulamadı.", details: null });
          toast(clientMessage(res.error || "Claude Desktop kurulamadı."), "bad");
        }
      },
    }));
    actions.appendChild(button({
      label: "Resmî site", className: "ghost tiny-btn", cliId: "claude-desktop.official-site",
      cliLabel: "Claude Desktop resmî sayfası",
      onClick: async () => {
        const res = await cizi.openExternal("https://claude.ai/download");
        if (!res.ok) toast(clientMessage(res.error || "Resmî site açılamadı."), "bad");
      },
    }));
  } else {
    actions.appendChild(button({
      label: "Aç", className: "ghost tiny-btn", cliId: "claude-desktop.open", cliLabel: "Claude Desktop aç",
      onClick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        const res = await cizi.launchClaudeDesktop();
        target.disabled = false;
        if (res.ok) toast("Claude Desktop açıldı.", "good");
        else toast(clientMessage(res.error || "Claude Desktop açılamadı."), "bad");
      },
    }));
    if (connected || desktop.needsRefresh) {
      actions.appendChild(button({
        label: "Onar", className: "ghost tiny-btn", cliId: "claude-desktop.repair", cliLabel: "Claude Desktop onar",
        long: true, title: "Claude güncellemesinden sonra Cizi Code ayarlarını yeniden uygular",
        onClick: async (event) => {
          const target = event.currentTarget;
          target.disabled = true;
          target.textContent = "Onarılıyor...";
          const res = await cizi.repairClaudeDesktop();
          target.disabled = false;
          target.textContent = "Onar";
          if (res.ok && res.data?.reconciled) toast("Claude Desktop ayarları yenilendi.", "good");
          else if (res.ok) toast(res.data?.reason === "running" ? "Önce Claude Desktop'ı kapatın." : "Onarım tamamlanamadı.", "bad");
          else toast(clientMessage(res.error || "Onarım başarısız."), "bad");
          await loadTemplatesAndTools();
        },
      }));
    }
    if (desktop.running) {
      actions.appendChild(button({
        label: "Kapat", className: "ghost tiny-btn", cliId: "claude-desktop.stop", cliLabel: "Claude Desktop kapat",
        title: "Ayar değiştirmeden önce Claude Desktop tamamen kapatılmalıdır",
        onClick: async (event) => {
          const target = event.currentTarget;
          target.disabled = true;
          const res = await cizi.stopClaudeDesktop();
          target.disabled = false;
          if (res.ok) toast("Claude Desktop kapatıldı.", "good");
          else toast(clientMessage(res.error || "Claude Desktop kapatılamadı."), "bad");
          await loadTemplatesAndTools();
        },
      }));
    }
    // The other products all offer a root removal; Claude Desktop lost it in the
    // port. It previews exactly what would be deleted before anything happens.
    actions.appendChild(button({
      label: "Kökten Kaldır", className: "ghost tiny-btn danger", cliId: "claude-desktop.purge",
      cliLabel: "Claude Desktop kökten kaldır", long: true,
      onClick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        const planRes = await cizi.planClaudeDesktopUninstall();
        if (!planRes.ok) {
          target.disabled = false;
          toast(clientMessage(planRes.error || "Kaldırma planı alınamadı."), "bad");
          return;
        }
        if (!confirm(describeRemovalPlan(planRes.data, CLAUDE_DESKTOP_NAME))) {
          target.disabled = false;
          return;
        }
        target.textContent = "Kaldırılıyor...";
        updateClaudeProgress({ phase: "uninstalling", message: "Claude Desktop kaldırılıyor...", details: null });
        const res = await cizi.uninstallClaudeDesktop(true);
        target.disabled = false;
        target.textContent = "Kökten Kaldır";
        if (res.ok) {
          updateClaudeProgress({ phase: "complete", message: "Claude Desktop kaldırıldı.", details: null });
          const remaining = res.data?.remainingDirectories?.length || 0;
          toast(remaining
            ? `Claude Desktop kaldırıldı. ${remaining} klasör silinemedi.`
            : "Claude Desktop kökten kaldırıldı.", remaining ? "warn" : "good");
          clog("success", "Claude Desktop kökten kaldırıldı");
          setTimeout(() => updateClaudeProgress({ phase: "idle", message: "", details: null }), 2500);
        } else {
          updateClaudeProgress({ phase: "error", message: res.error || "Claude Desktop kaldırılamadı.", details: null });
          toast(clientMessage(res.error || "Claude Desktop kaldırılamadı."), "bad");
        }
        await loadTemplatesAndTools();
      },
    }));
  }

  block.appendChild(head);
  block.appendChild(actions);
  return block;
}

// The Codex row. ChatGPT Desktop and the Codex CLI run the same codex-cli core
// and read the same ~/.codex/config.toml, so a single switch configures both.
function renderCodexRow(st, models) {
  const row = document.createElement("div");
  row.className = "tool-row codex-row";

  const info = document.createElement("div");
  info.className = "tool-info";
  const name = document.createElement("div");
  name.className = "tool-name";
  name.textContent = st.name;
  const sub = document.createElement("div");
  sub.className = "tool-sub";
  const anyInstalled = CODEX_DESKTOP_STATUS.installed || CODEX_CLI_STATUS.installed;
  sub.textContent = st.applied
    ? `Bağlı — tek ayar dosyası ikisini de yönetiyor (${CODEX_CONFIG_STATE.path || "~/.codex/config.toml"})`
    : anyInstalled
      ? "Tek anahtar ChatGPT Desktop ve Codex CLI'yi birlikte Cizi Code'a bağlar"
      : "Bağlamak için önce en az bir Codex ürünü kurun";
  info.appendChild(name);
  info.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "tool-actions";

  const modelSelect = document.createElement("select");
  modelSelect.className = "tool-model";
  modelSelect.dataset.cliId = "tool.codex.model";
  modelSelect.dataset.cliLabel = "Codex modeli";
  const selected = codexDefaultModel(models);
  CODEX_SELECTED_MODEL = selected;
  for (const modelId of codexModelIds(models)) {
    const option = document.createElement("option");
    option.value = modelId;
    option.textContent = modelId;
    option.selected = modelId === selected;
    modelSelect.appendChild(option);
  }
  modelSelect.addEventListener("change", async () => {
    CODEX_SELECTED_MODEL = modelSelect.value;
    // While connected the model lives in the shared config, so the change is
    // written straight through; both products pick it up on next start.
    if (!st.applied) return;
    modelSelect.disabled = true;
    const res = await cizi.setCodexModel(modelSelect.value);
    modelSelect.disabled = false;
    if (!res.ok) {
      toast(clientMessage(res.error || "Model değiştirilemedi."), "bad");
      return;
    }
    clog("info", `Codex modeli ${modelSelect.value} olarak ayarlandı`);
    toast(res.data?.restartRequired
      ? `Model ${modelSelect.value}. ChatGPT Desktop'ı yeniden başlatıp yeni bir Codex sohbeti açın.`
      : `Model ${modelSelect.value}.`, "good");
    await loadTemplatesAndTools();
  });
  actions.appendChild(modelSelect);

  const sw = document.createElement("label");
  sw.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.cliId = "tool.codex.switch";
  cb.dataset.cliLabel = "Codex bağlantısı";
  cb.checked = !!st.applied;
  cb.disabled = !anyInstalled;
  if (!anyInstalled) sw.title = "Önce ChatGPT Desktop veya Codex CLI kurun";
  const slider = document.createElement("span");
  slider.className = "slider";
  sw.appendChild(cb);
  sw.appendChild(slider);
  actions.appendChild(sw);

  cb.addEventListener("change", async () => {
    cb.disabled = true;
    const turningOn = cb.checked;
    clog("info", `Codex: ${turningOn ? "bağlanıyor" : "geri alınıyor"}`, { tool: st.id });
    if (turningOn) {
      const model = CODEX_SELECTED_MODEL;
      if (!model) {
        toast("Bu anahtar için model bulunamadı.", "bad");
        cb.checked = false;
        cb.disabled = false;
        return;
      }
      const res = await cizi.applyTool(st.id, { model, models: codexModelIds(models) });
      if (res.ok) {
        toast(CODEX_DESKTOP_STATUS.installed
          ? "Codex bağlandı. ChatGPT Desktop'ı yeniden başlatıp yeni bir Codex sohbeti açın."
          : "Codex bağlandı.", "good");
      } else {
        toast(clientMessage(res.error || "Codex bağlanamadı."), "bad");
        cb.checked = false;
      }
    } else {
      const res = await cizi.revertTool(st.id);
      if (res.ok && !res.data?.applied) toast("Codex bağlantısı kaldırıldı; diğer ayarlarınız korundu.", "good");
      else {
        toast(clientMessage(res.error || "Codex bağlantısı geri alınamadı."), "bad");
        cb.checked = true;
      }
    }
    cb.disabled = false;
    await loadTemplatesAndTools();
    loadLogs();
  });

  row.appendChild(info);
  row.appendChild(actions);

  const products = document.createElement("div");
  products.className = "codex-products";

  products.appendChild(codexProductBlock({
    name: CODEX_DESKTOP_NAME,
    idPrefix: "codex-desktop",
    status: CODEX_DESKTOP_STATUS,
    detail: CODEX_DESKTOP_STATUS.installed
      ? `Kurulu · sürüm ${CODEX_DESKTOP_STATUS.version || "bilinmiyor"}`
      : "Kurulu değil · Microsoft Store'dan kurulur",
    installLabel: "İndir ve Kur",
    siteLabel: "Mağaza sayfası",
    onInstall: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      target.textContent = "Kuruluyor...";
      updateCodexDesktopInstallFeedback({ status: "starting", percent: null, message: "Microsoft Store kurulumu başlatılıyor...", operations: [] });
      let res;
      try { res = await cizi.installCodexDesktop(); } catch (error) { res = { ok: false, error: error?.message || "ChatGPT Desktop kurulamadı." }; }
      if (res.ok && res.data?.installed) {
        updateCodexDesktopInstallFeedback({ status: "installed", percent: 100, message: "ChatGPT Desktop kuruldu." });
        toast("ChatGPT Desktop kuruldu.", "good");
        clog("success", "ChatGPT Desktop kuruldu");
        await loadTemplatesAndTools();
        setTimeout(() => updateCodexDesktopInstallFeedback({ status: "idle", percent: null, message: "", operations: [] }), 2500);
      } else {
        target.disabled = false;
        target.textContent = "İndir ve Kur";
        updateCodexDesktopInstallFeedback({ status: "error", message: res.error || "ChatGPT Desktop kurulamadı." });
        toast(clientMessage(res.error || "ChatGPT Desktop kurulamadı."), "bad");
      }
    },
    onSite: async () => {
      const res = await cizi.openCodexDesktopStore();
      if (!res.ok) toast(clientMessage(res.error || "Mağaza sayfası açılamadı."), "bad");
    },
    onOpen: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      const res = await cizi.openCodexDesktop();
      target.disabled = false;
      if (res.ok) toast("ChatGPT Desktop açıldı.", "good");
      else toast(clientMessage(res.error || "ChatGPT Desktop açılamadı."), "bad");
    },
    onRemove: async (event) => {
      const target = event.currentTarget;
      const planRes = await cizi.planCodexDesktopUninstall();
      if (!planRes.ok) {
        toast(clientMessage(planRes.error || "Kaldırma planı hazırlanamadı."), "bad");
        return;
      }
      const plan = planRes.data;
      if (!confirm(describeRemovalPlan(plan, CODEX_DESKTOP_NAME))) return;
      target.disabled = true;
      target.textContent = "Kaldırılıyor...";
      clog("info", "ChatGPT Desktop kökten kaldırılıyor", { sharedRemovable: plan.sharedRemovable });
      const res = await cizi.uninstallCodexDesktop(plan.sharedRemovable === true);
      if (res.ok && res.data?.ok) {
        toast("ChatGPT Desktop kaldırıldı.", "good");
        clog("success", "ChatGPT Desktop kökten kaldırıldı");
      } else {
        toast(clientMessage(res.error || "Kaldırma kısmen tamamlandı."), "bad");
        clog("warning", "ChatGPT Desktop kaldırma kısmen tamamlandı");
      }
      await loadTemplatesAndTools();
    },
  }));

  products.appendChild(codexProductBlock({
    name: CODEX_CLI_NAME,
    idPrefix: "codex-cli",
    status: CODEX_CLI_STATUS,
    detail: CODEX_CLI_STATUS.installed
      ? `Kurulu · ${CODEX_CLI_STATUS.version || CODEX_CLI_STATUS.command}`
      : "Kurulu değil · resmî yükleyiciyle kurulur",
    installLabel: "İndir ve Kur",
    siteLabel: "Resmî site",
    onInstall: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      target.textContent = "Kuruluyor...";
      updateCodexInstallFeedback({ status: "starting", percent: null, message: "Resmî Codex yükleyicisi başlatılıyor...", operations: [] });
      let res;
      try { res = await cizi.installCodexCli(); } catch (error) { res = { ok: false, error: error?.message || "Codex CLI kurulamadı." }; }
      if (res.ok && res.data?.installed) {
        updateCodexInstallFeedback({ status: "installed", percent: 100, message: "Codex CLI kuruldu." });
        toast("Codex CLI kuruldu.", "good");
        await loadTemplatesAndTools();
        setTimeout(() => updateCodexInstallFeedback({ status: "idle", percent: null, message: "", operations: [] }), 2500);
      } else {
        target.disabled = false;
        target.textContent = "İndir ve Kur";
        updateCodexInstallFeedback({ status: "error", message: res.error || "Codex CLI kurulamadı." });
        toast(clientMessage(res.error || "Codex CLI kurulamadı."), "bad");
      }
    },
    onSite: async () => {
      const res = await cizi.openCodexCliSite();
      if (!res.ok) toast(clientMessage(res.error || "Resmî site açılamadı."), "bad");
    },
    onOpen: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      const res = await cizi.openCodexCli(CODEX_SELECTED_MODEL, !!st.applied);
      target.disabled = false;
      if (res.ok) toast(st.applied ? "Codex CLI Cizi Code bağlantısıyla açıldı." : "Codex CLI kendi ayarlarıyla açıldı.", "good");
      else toast(clientMessage(res.error || "Codex CLI başlatılamadı."), "bad");
    },
    onRemove: async (event) => {
      const target = event.currentTarget;
      const planRes = await cizi.planCodexCliUninstall();
      if (!planRes.ok) {
        toast(clientMessage(planRes.error || "Kaldırma planı hazırlanamadı."), "bad");
        return;
      }
      const plan = planRes.data;
      if (!confirm(describeRemovalPlan(plan, CODEX_CLI_NAME))) return;
      target.disabled = true;
      target.textContent = "Kaldırılıyor...";
      clog("info", "Codex CLI kökten kaldırılıyor", { sharedRemovable: plan.sharedRemovable });
      const res = await cizi.uninstallCodexCli(plan.sharedRemovable === true);
      if (res.ok && res.data?.ok) {
        toast("Codex CLI kaldırıldı.", "good");
        clog("success", "Codex CLI kökten kaldırıldı");
      } else {
        toast(clientMessage(res.error || "Kaldırma kısmen tamamlandı."), "bad");
        clog("warning", "Codex CLI kaldırma kısmen tamamlandı");
      }
      await loadTemplatesAndTools();
    },
  }));

  row.appendChild(products);
  return row;
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
    .filter((id) => FIRST_RELEASE_TOOLS.includes(id))
    // The key's own model families decide which products it may configure.
    .filter((id) => !toolIsGated(id) || toolIsUnlocked(models, id));
  const defaultModel = getDefaultModel(models);

  if (!offered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = modelNames(models).length
      ? "Bu anahtarın modelleri hiçbir yerel araçla eşleşmiyor."
      : "No command-line tool is available for this key.";
    list.appendChild(empty);
    return;
  }

  for (const st of statuses) {
    if (!offered.includes(st.id)) continue;

    // Claude and Codex are each one switch over two products, so their rows are
    // built on their own instead of through the single-tool layout. Each row
    // only ever sees the models of its own family.
    if (st.id === CODEX_CLI_TOOL_ID) {
      list.appendChild(renderCodexRow(st, modelsForTool(models, CODEX_CLI_TOOL_ID)));
      continue;
    }
    if (st.id === CLAUDE_CODE_CLI_TOOL_ID) {
      list.appendChild(renderClaudeRow(st, modelsForTool(models, CLAUDE_CODE_CLI_TOOL_ID)));
      continue;
    }

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
      ? `${st.name} is connected to Cizi Code`
      : st.hasBackup
        ? "Turn on to reconnect, or leave off to keep your previous settings"
        : `Turn on to prepare ${st.name} automatically`;

    info.appendChild(name);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "tool-actions";
    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.cliId = `tool.${st.id}.switch`;
    cb.dataset.cliLabel = `${st.name} connection`;
    cb.checked = !!st.applied;
    cb.disabled = enabledIds.size > 0 && !enabledIds.has(st.id);
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(cb);
    sw.appendChild(slider);
    actions.appendChild(sw);
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
if (cizi.onCodexDesktopInstallState) cizi.onCodexDesktopInstallState(updateCodexDesktopInstallFeedback);
if (cizi.onClaudeProgress) cizi.onClaudeProgress(updateClaudeProgress);
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
