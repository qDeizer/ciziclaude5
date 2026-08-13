// Cizi Code arayüzü.
//
// YERLEŞİM FİKRİ: ürün başına KART. Bir kart o ürün hakkındaki her şeyi taşır —
// durumu, tek satır olgusu, anahtarı, eylemleri ve o an süren işin ilerlemesi.
// Önceki tasarımda ilerleme kutuları listenin altındaydı ve hangi satıra ait
// oldukları belirsizdi; artık ilerleme ait olduğu kartın içinde doğar ve biter.
//
// TEK İLERLEME KANALI: ana süreçten gelen her uzun iş (anahtar çevirme, kurulum,
// indirme, kaldırma) aynı biçimi kullanır — { scope, percent, message, done }.
// Böylece ekranda dört farklı ilerleme çizimi yerine bir tane var.

function $(id) {
  const el = document.getElementById(id);
  if (!el) console.error("Missing element:", id);
  return el;
}

// `cizi` BİLEREK yeniden bildirilmiyor: contextBridge onu global olarak tanımlar
// ve aynı adı `const` ile bildirmek betiği "Identifier 'cizi' has already been
// declared" ile yükleme anında düşürür — ekran da varsayılan giriş görünümünde
// takılı kalır. Köprü doğrudan global olarak kullanılır.
const {
  modelName,
  desktopClients,
  modelsForTool,
  accessibleToolIds,
  capabilityToolForModel,
} = window.ciziToolAccess;
// Aynı modül ana sürecin yapılandırmayı kurarken kullandığı modül: ekran ile
// diskteki dosya bir modeli farklı anlatamaz.
const { capabilityFor, displayModelName } = window.ciziModelCapabilities;

// Anahtar kimlikleri, ana sürecin bildirdiği gibi. Claude Code CLI ve Claude
// Desktop iki ayrı anahtar: ortak ayar dosyaları yok, biri çalışmazsa diğeri
// çalışmaya devam eder. Codex tek anahtar: iki ürünü de aynı config.toml okuyor.
const CLAUDE_CODE = "claude-code";
const CLAUDE_DESKTOP = "claude-desktop";
const CODEX = "codex";
const CODEX_CLI_PRODUCT = "codex-cli";
const CODEX_DESKTOP_PRODUCT = "codex-desktop";
const SWITCH_IDS = [CLAUDE_CODE, CLAUDE_DESKTOP, CODEX];

const NAMES = {
  [CLAUDE_CODE]: "Claude Code CLI",
  [CLAUDE_DESKTOP]: "Claude Desktop",
  [CODEX]: "Codex (CLI + ChatGPT Desktop)",
  [CODEX_CLI_PRODUCT]: "Codex CLI",
  [CODEX_DESKTOP_PRODUCT]: "ChatGPT Desktop",
};

let TEMPLATES = null;
let ME = null;
let CLAUDE_STATE = { cli: { installed: false }, desktop: { installed: false } };
let CODEX_STATE = { cli: { installed: false }, desktop: { installed: false }, config: { applied: false } };
let LAST_REFRESH = null;
let LAST_TOOL_STATUSES = [];
let LAST_USAGE_SERIES = [];
let CURRENT_SCREEN = "dashboard";
let SELECTED_TOOL_ID = null;
let CONNECTION_MAP = null;
let QUOTA_VIEW = { percent: 100, unlimited: true, label: "∞" };
let HAS_ANIMATED_USAGE_TANK = false;
let HAS_PRESENTED_CONNECTION_MAP = false;
let USAGE_CHART_ANIMATION_FRAME = null;

const USAGE_TANK_ENTRY_MS = 1400;
const USAGE_CHART_ENTRY_MS = 1100;

// ----------------------------------------------------------------- yardımcı

function toast(message, kind = "") {
  const element = $("toast");
  element.textContent = message;
  element.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 4200);
}

function clog(level, message, meta) {
  try { cizi.clientLog(level, message, meta); } catch { /* günlük arayüzü bozmaz */ }
}

// Ana süreçten gelen hata metni kullanıcıya gösterilmeden önce süzülür: içinde
// sağlayıcı adı ya da uç nokta geçen bir mesaj kullanıcıya ait bilgi değildir.
function clientMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "Cizi Code bu isteği tamamlayamadı.";
  if (/[{}]/.test(text) || /(command\s*code|commandcode|deepseek|qwen|provider|upstream|backend|model endpoint|\/v1\/models)/i.test(text)) {
    return "Cizi Code bu isteği tamamlayamadı.";
  }
  return text;
}

function contextLabel(tokens) {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}K`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function token(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("dash-view").classList.toggle("hidden", view !== "dash");
}

function showAppScreen(screen, selectedToolId = null) {
  const previous = CURRENT_SCREEN;
  CURRENT_SCREEN = screen === "config" ? "config" : "dashboard";
  if (selectedToolId && SWITCH_IDS.includes(selectedToolId)) SELECTED_TOOL_ID = selectedToolId;
  const returningToDashboard = previous === "config" && CURRENT_SCREEN === "dashboard";

  // Yapılandırma sırasında araç durumu değiştiğinde harita arka planda yeniden
  // çizilebilir. Panele dönmeden önce doğrudan son hâline sabitle; kullanıcı boş
  // araç kolonunu, uzayan kabloları veya yeniden dolan kartları görmesin.
  if (returningToDashboard) CONNECTION_MAP?.finish?.();
  $("dashboard-screen").classList.toggle("hidden", CURRENT_SCREEN !== "dashboard");
  $("config-screen").classList.toggle("hidden", CURRENT_SCREEN !== "config");
  for (const [id, active] of [["screen-dashboard", CURRENT_SCREEN === "dashboard"], ["screen-config", CURRENT_SCREEN === "config"]]) {
    const tab = $(id);
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-pressed", String(active));
  }
  if (CURRENT_SCREEN === "config") renderConfigDetail();

  // Ekranlar yan yana duruyormuş gibi kayarak girer: panel soldan, yapılandırma
  // sağdan. Yön, gidilen ekranın sekme sırasındaki yerinden gelir.
  if (previous !== CURRENT_SCREEN && !returningToDashboard) {
    const entering = $(CURRENT_SCREEN === "config" ? "config-screen" : "dashboard-screen");
    const direction = CURRENT_SCREEN === "config" ? "enter-right" : "enter-left";
    entering.classList.remove("enter-right", "enter-left");
    void entering.offsetWidth; // animasyonu yeniden tetiklemek için reflow
    entering.classList.add(direction);
  }

  requestAnimationFrame(() => {
    if (CURRENT_SCREEN === "dashboard") CONNECTION_MAP?.layout?.();
    drawChart(LAST_USAGE_SERIES);
  });
}

// ---------------------------------------------------------------- ilerleme
//
// scope = kartın ya da ürün şeridinin kimliği. Bir kart yeniden çizildiğinde
// ilerleme kaybolmasın diye durum burada tutulur, DOM'da değil.
const PROGRESS = new Map();
const ACTIVE_OPERATIONS = new Set();

function beginOperation(scope) {
  if (ACTIVE_OPERATIONS.has(scope)) {
    toast("Bu ürün üzerinde başka bir işlem sürüyor.", "warn");
    return false;
  }
  ACTIVE_OPERATIONS.add(scope);
  return true;
}

function endOperation(scope) {
  ACTIVE_OPERATIONS.delete(scope);
}

function setProgress(scope, next) {
  if (!scope) return;
  const current = PROGRESS.get(scope) || {};
  const merged = { ...current, ...next };
  if (merged.done) {
    // Bitmiş bir iş kısa süre görünür kalır: kullanıcı "tamamlandı"yı görsün,
    // sonra kart sadeleşsin.
    PROGRESS.set(scope, merged);
    paintLane(scope);
    clearTimeout(current.timer);
    const visibleMs = merged.failed ? 8000 : 3200;
    merged.timer = setTimeout(() => { PROGRESS.delete(scope); paintLane(scope); }, visibleMs);
    return;
  }
  clearTimeout(current.timer);
  PROGRESS.set(scope, merged);
  paintLane(scope);
}

function clearProgress(scope) {
  const current = PROGRESS.get(scope);
  if (current?.timer) clearTimeout(current.timer);
  PROGRESS.delete(scope);
  paintLane(scope);
}

function paintLane(scope) {
  const lane = document.querySelector(`[data-lane="${scope}"]`);
  if (!lane) return;
  const state = PROGRESS.get(scope);
  lane.hidden = !state;
  if (!state) return;

  const percent = Number(state.percent);
  // Some installers genuinely report a numeric 0%. Keep that distinct from an
  // unknown percentage, which remains an honest indeterminate animation.
  const measurable = Number.isFinite(percent) && (percent > 0 || state.determinate === true);
  lane.querySelector(".lane-label").textContent = state.label || "Çalışıyor";
  lane.querySelector(".lane-pct").textContent = state.failed
    ? "durdu"
    : measurable ? `%${Math.round(Math.min(100, percent))}` : "";
  lane.querySelector(".lane-detail").textContent = state.message || "";

  const fill = lane.querySelector(".lane-fill");
  fill.className = "lane-fill";
  if (state.failed) {
    fill.classList.add("failed");
  } else if (measurable) {
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (state.done) fill.classList.add("done");
  } else {
    // Ölçülemeyen adımda yüzde uydurulmaz.
    fill.classList.add("indeterminate");
  }
}

function laneElement(scope) {
  const lane = document.createElement("div");
  lane.className = "lane";
  lane.dataset.lane = scope;
  lane.hidden = true;
  lane.innerHTML = '<div class="lane-head"><span class="lane-label"></span><span class="lane-pct num"></span></div>'
    + '<div class="lane-track"><span class="lane-fill"></span></div>'
    + '<div class="lane-detail"></div>';
  return lane;
}

// Ana süreçteki üç eski kurulum kanalı ile yeni tek kanal aynı biçime çevrilir,
// böylece çizim yolu tektir.
function adoptInstallState(scope, label, phaseLabels = {}) {
  return (state) => setProgress(scope, {
    label: phaseLabels[String(state?.phase || "")] || label,
    percent: state?.percent,
    determinate: state?.determinate === true,
    message: state?.message || "",
    done: state?.status === "installed",
    failed: state?.status === "error",
  });
}

// ------------------------------------------------------------------- giriş

async function doLogin() {
  const errorElement = $("login-error");
  errorElement.classList.add("hidden");
  const key = ($("login-key").value || "").trim();
  if (!key) {
    errorElement.textContent = "API anahtarı gerekli.";
    errorElement.classList.remove("hidden");
    return;
  }
  const button = $("login-btn");
  button.disabled = true;
  button.textContent = "Giriş yapılıyor...";
  const result = await cizi.login(key);
  button.disabled = false;
  button.textContent = "Giriş Yap";
  if (!result?.ok) {
    errorElement.textContent = clientMessage(result?.error || "Giriş yapılamadı.");
    errorElement.classList.remove("hidden");
    return;
  }
  await enterDashboard();
}

async function enterDashboard() {
  show("dash");
  showAppScreen("dashboard");
  const session = await cizi.getSession();
  if (session.ok && session.data?.gateway) $("conn-base").textContent = session.data.gateway;
  await refreshAll();
  await refreshUpdateState();
}

async function refreshAll() {
  await loadAccount();
  await loadUsage($("period-select").value);
  await loadTools();
  LAST_REFRESH = new Date();
  renderLastRefresh();
}

async function loadAccount() {
  const result = await cizi.getMe();
  if (!result.ok) {
    toast(clientMessage(result.error || "Hesap bilgileri yüklenemedi."), "bad");
    return;
  }
  ME = result.data;
  renderQuota(ME);
  renderModels(ME.combos || []);
}

function renderQuota(me) {
  const remaining = me.remainingPercent;
  const unlimited = remaining == null || !Number.isFinite(Number(remaining));
  const percent = unlimited ? 100 : Math.max(0, Math.min(100, Math.round(Number(remaining))));
  const label = unlimited ? "∞" : `%${percent}`;
  QUOTA_VIEW = { percent, unlimited, label };
  $("quota-pct").textContent = label;
  const fill = $("quota-fill");
  fill.style.width = `${percent}%`;
  fill.className = `meter-fill${!unlimited && percent <= 10 ? " bad" : !unlimited && percent <= 30 ? " warn" : ""}`;
  $("quota-meter").title = unlimited
    ? "Planınız şu an sınırsız."
    : `Kullanım hakkınızın %${percent}'i kaldı.`;

  const limit = $("limit-msg");
  limit.textContent = me.isLimitReached ? (me.limitMessage || "Cizi Code kullanım sınırınıza ulaşıldı.") : "";
  limit.classList.toggle("hidden", !me.isLimitReached);
  updateUsageTank();
}

function renderLastRefresh() {
  const text = LAST_REFRESH
    ? `Son yenileme ${LAST_REFRESH.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "Henüz yenilenmedi";
  const dashboardLabel = $("usage-updated");
  const configLabel = $("config-usage-updated");
  if (dashboardLabel) dashboardLabel.textContent = text;
  if (configLabel) configLabel.textContent = LAST_REFRESH ? "Hesap hareketi güncel" : "Henüz hareket verisi yok";
}

function renderModels(models) {
  const box = $("model-chips");
  box.innerHTML = "";
  if (!models.length) {
    const chip = document.createElement("div");
    chip.className = "chip empty";
    chip.textContent = "Henüz model yok";
    box.appendChild(chip);
    return;
  }
  for (const model of models) {
    // Araç sözleşmesi model adından tahmin edilmez; profilin sunucudan gelen
    // desktopClients alanı hangi enumun kullanılacağını söyler.
    const toolId = capabilityToolForModel(model) || CODEX;
    const profile = capabilityFor(model, toolId);
    const chip = document.createElement("div");
    chip.className = "chip";
    // Ekranda tire yerine boşluk: "Opus 5". Yapılandırmaya yazılan ad değişmez.
    chip.append(document.createTextNode(`${displayModelName(profile.name)} `));
    const meta = document.createElement("span");
    meta.className = "chip-meta";
    meta.textContent = contextLabel(profile.contextWindowTokens);
    chip.appendChild(meta);
    chip.title = `${profile.name} · ${profile.contextWindowTokens.toLocaleString("tr-TR")} token bağlam`
      + ` · düşünme seviyeleri: ${profile.reasoningLevels.join(", ")}`;
    box.appendChild(chip);
  }
}

async function loadUsage(period) {
  const result = await cizi.getUsage(period);
  if (!result.ok) {
    toast(clientMessage(result.error || "Kullanım eğilimi yüklenemedi."), "bad");
    return;
  }
  const payload = result.data;
  const raw = payload?.chart || payload?.usage?.chart || payload?.data?.chart || [];
  const series = Array.isArray(raw) ? raw : [];
  LAST_USAGE_SERIES = series;
  // Eğilim çubuklarının hangi alandan geldiği sunucu sürümüne göre değişiyor.
  // Hangi alanın okunduğu kaydedilir, böylece "grafik boş" durumunun sebebi
  // tahmin edilmek zorunda kalmaz.
  clog("debug", "Kullanım eğilimi çizildi", {
    period,
    points: series.length,
    positive: series.filter((point) => chartValue(point) > 0).length,
    sampleKeys: series.length ? Object.keys(series[0]).slice(0, 8) : [],
  });
  drawChart(series, { animateDashboard: true });
}

function chartValue(point) {
  const value = Number(point?.percent ?? point?.usagePercent ?? point?.remainingPercent
    ?? point?.tokens ?? point?.totalLimitTokens ?? point?.totalTokens ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function drawChart(data, { animateDashboard = false } = {}) {
  const dashboardCanvas = $("usage-chart");
  const configCanvas = $("config-usage-chart");
  if (dashboardCanvas) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animateDashboard && CURRENT_SCREEN === "dashboard" && !reducedMotion) {
      animateUsageChart(dashboardCanvas, data);
    } else {
      cancelAnimationFrame(USAGE_CHART_ANIMATION_FRAME);
      USAGE_CHART_ANIMATION_FRAME = null;
      drawUsageChart(dashboardCanvas, data);
    }
  }
  if (configCanvas) drawConfigUsageChart(configCanvas, data);
}

function animateUsageChart(canvas, data) {
  cancelAnimationFrame(USAGE_CHART_ANIMATION_FRAME);
  USAGE_CHART_ANIMATION_FRAME = null;
  const hasUsage = data.length && data.some((point) => chartValue(point) > 0);
  if (!hasUsage) {
    drawUsageChart(canvas, data);
    return;
  }

  const startedAt = performance.now();
  const paintFrame = (now) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / USAGE_CHART_ENTRY_MS));
    // Hızlı başlar, son yüzdeye yaklaşırken yumuşar; kablo akışının mevcut
    // cubic-bezier karakterine yakın ama tuval üzerinde hesaplanabilir bir eğri.
    const eased = 1 - Math.pow(1 - progress, 3);
    drawUsageChart(canvas, data, eased);
    if (progress < 1) {
      USAGE_CHART_ANIMATION_FRAME = requestAnimationFrame(paintFrame);
    } else {
      USAGE_CHART_ANIMATION_FRAME = null;
    }
  };
  USAGE_CHART_ANIMATION_FRAME = requestAnimationFrame(paintFrame);
}

function drawConfigUsageChart(canvas, data) {
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight || 120;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = data.map(chartValue);
  if (!data.length || values.every((value) => value <= 0)) {
    ctx.strokeStyle = token("--line-strong");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(18, height / 2);
    ctx.lineTo(width - 18, height / 2);
    ctx.stroke();
    ctx.fillStyle = token("--ink-soft");
    ctx.font = `12px ${token("--font") || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.fillText("Henüz yeterli hareket yok", width / 2, height / 2 - 14);
    return;
  }

  const pad = { left: 12, right: 12, top: 12, bottom: 12 };
  const innerWidth = Math.max(1, width - pad.left - pad.right);
  const innerHeight = Math.max(1, height - pad.top - pad.bottom);
  const max = Math.max(1, ...values);
  const denominator = Math.max(1, values.length - 1);
  const points = values.map((value, index) => ({
    x: pad.left + (index / denominator) * innerWidth,
    y: pad.top + innerHeight - (value / max) * innerHeight,
  }));

  ctx.save();
  ctx.strokeStyle = token("--line");
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 6]);
  for (let index = 1; index <= 2; index += 1) {
    const y = pad.top + (innerHeight * index) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }
  ctx.restore();

  const trace = () => {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const midpoint = (previous.x + current.x) / 2;
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, current.y, current.x, current.y);
    }
  };

  const fill = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  fill.addColorStop(0, "rgb(255 142 37 / 34%)");
  fill.addColorStop(0.72, "rgb(249 115 22 / 8%)");
  fill.addColorStop(1, "rgb(249 115 22 / 0%)");
  ctx.beginPath();
  trace();
  ctx.lineTo(points[points.length - 1].x, height - pad.bottom);
  ctx.lineTo(points[0].x, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  trace();
  ctx.strokeStyle = token("--usage-flow");
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgb(249 115 22 / 38%)";
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  let lastActiveIndex = values.length - 1;
  while (lastActiveIndex > 0 && values[lastActiveIndex] <= 0) lastActiveIndex -= 1;
  const endpoint = points[lastActiveIndex];
  ctx.beginPath();
  ctx.arc(endpoint.x, endpoint.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = token("--usage-flow");
  ctx.fill();
  ctx.beginPath();
  ctx.arc(endpoint.x, endpoint.y, 7, 0, Math.PI * 2);
  ctx.strokeStyle = "rgb(255 142 37 / 28%)";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawUsageChart(canvas, data, entranceProgress = 1) {
  // Panel grafiği günlük yoğunluğu sütunlarla değil, kabloların akış dilini
  // sürdüren bir alan çizgisiyle anlatır. Doğrudan yüzde gelmeyen eski sunucu
  // sürümlerinde değerler en yoğun güne göre normalize edilir.
  $("usage-chart-tooltip")?.classList.add("hidden");
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight || 104;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = chartPercentageValues(data);
  const soft = token("--ink-soft");
  if (!data.length || values.every((value) => value <= 0)) {
    canvas.__usageChartMeta = null;
    canvas.setAttribute("aria-label", "Seçili dönem için kullanım hareketi yok");
    $("usage-chart-tooltip")?.classList.add("hidden");
    ctx.fillStyle = soft;
    ctx.font = `12px ${token("--font") || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.fillText("Bu dönem için henüz kullanım hareketi yok.", width / 2, height / 2);
    return;
  }

  const pad = { left: 36, right: 18, top: 38, bottom: 34 };
  const innerWidth = Math.max(1, width - pad.left - pad.right);
  const innerHeight = Math.max(1, height - pad.top - pad.bottom);
  const denominator = Math.max(1, values.length - 1);
  const progress = Math.max(0, Math.min(1, entranceProgress));
  const animatedValues = values.map((value, index) => {
    const pointDelay = (index / denominator) * .38;
    const localProgress = Math.max(0, Math.min(1, (progress - pointDelay) / (1 - pointDelay)));
    const easedPoint = 1 - Math.pow(1 - localProgress, 3);
    return value * easedPoint;
  });
  const points = animatedValues.map((value, index) => ({
    x: pad.left + (index / denominator) * innerWidth,
    y: pad.top + innerHeight - (value / 100) * innerHeight,
  }));

  ctx.save();
  ctx.strokeStyle = token("--line");
  ctx.fillStyle = token("--ink-dim");
  ctx.font = `9px ${token("--mono") || "monospace"}`;
  ctx.textAlign = "right";
  ctx.setLineDash([3, 6]);
  for (const percentage of [25, 50, 75]) {
    const y = pad.top + innerHeight - (percentage / 100) * innerHeight;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`%${percentage}`, pad.left - 7, y + 3);
  }
  ctx.restore();

  const trace = () => {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const midpoint = (previous.x + current.x) / 2;
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, current.y, current.x, current.y);
    }
  };

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left - 10, 0, Math.max(1, innerWidth * progress + 12), height);
  ctx.clip();

  const fill = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  fill.addColorStop(0, "rgb(255 142 37 / 38%)");
  fill.addColorStop(0.68, "rgb(249 115 22 / 9%)");
  fill.addColorStop(1, "rgb(249 115 22 / 0%)");
  ctx.beginPath();
  trace();
  ctx.lineTo(points[points.length - 1].x, height - pad.bottom);
  ctx.lineTo(points[0].x, height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  trace();
  ctx.strokeStyle = token("--usage-flow");
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgb(249 115 22 / 42%)";
  ctx.shadowBlur = 9;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();

  values.forEach((value, index) => {
    const revealAt = (index / denominator) * .72;
    if (progress < revealAt) return;
    const point = points[index];
    ctx.beginPath();
    ctx.arc(point.x, point.y, value > 0 ? 3.3 : 1.8, 0, Math.PI * 2);
    ctx.fillStyle = value > 0 ? token("--usage-flow") : token("--line-strong");
    ctx.fill();

    const pointSpacing = innerWidth / denominator;
    const canLabelZero = value <= 0 && pointSpacing >= 24;
    if (value <= 0 && !canLabelZero) return;
    const labelY = Math.max(13, point.y - (index % 2 === 0 ? 11 : 20));
    ctx.fillStyle = value > 0 ? token("--usage-flow") : token("--ink-dim");
    ctx.font = `${value > 0 ? "600" : "400"} 10px ${token("--mono") || "monospace"}`;
    ctx.textAlign = "center";
    ctx.fillText(`%${formatUsagePercentage(animatedValues[index])}`, point.x, labelY);
  });

  ctx.fillStyle = soft;
  ctx.textAlign = "center";
  ctx.font = `10px ${token("--mono") || "monospace"}`;
  const maxDayLabels = Math.max(2, Math.floor(innerWidth / 82));
  const step = Math.max(1, Math.ceil(data.length / maxDayLabels));
  data.forEach((point, index) => {
    if (index % step !== 0 && index !== data.length - 1) return;
    ctx.fillText(localizeChartDay(point?.label, index), points[index].x, height - 11);
  });

  if (progress >= 1) {
    canvas.__usageChartMeta = { data, values, points, pad, width, height };
    canvas.setAttribute("aria-label", `Günlük kullanım yüzdeleri: ${data.map((point, index) => (
      `${localizeChartDay(point?.label, index)} yüzde ${formatUsagePercentage(values[index])}`
    )).join(", ")}`);
    bindUsageChartInteraction(canvas);
  } else {
    canvas.__usageChartMeta = null;
  }
}

function chartPercentageValues(data) {
  const raw = data.map(chartValue);
  const rawMax = Math.max(0, ...raw);
  return data.map((point, index) => {
    const direct = Number(point?.percent ?? point?.usagePercent);
    const percentage = Number.isFinite(direct)
      ? direct
      : rawMax > 0 ? (raw[index] / rawMax) * 100 : 0;
    return Math.max(0, Math.min(100, percentage));
  });
}

function formatUsagePercentage(value) {
  if (!Number.isFinite(value)) return "0";
  return value > 0 && value < 1 ? value.toFixed(1) : String(Math.round(value));
}

function localizeChartDay(label, index) {
  const value = String(label || "").trim();
  const englishMonth = value.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (englishMonth) {
    const months = { Jan: "Oca", Feb: "Şub", Mar: "Mar", Apr: "Nis", May: "May", Jun: "Haz", Jul: "Tem", Aug: "Ağu", Sep: "Eyl", Oct: "Eki", Nov: "Kas", Dec: "Ara" };
    return `${englishMonth[2]} ${months[englishMonth[1]] || englishMonth[1]}`;
  }
  const date = new Date(value);
  if (value && Number.isFinite(date.getTime())) {
    return date.toLocaleDateString("tr-TR", { day: "numeric", month: "short" }).replace(".", "");
  }
  return value || `${index + 1}. gün`;
}

function bindUsageChartInteraction(canvas) {
  if (canvas.__usageInteractionBound) return;
  canvas.__usageInteractionBound = true;

  canvas.addEventListener("pointermove", (event) => {
    const meta = canvas.__usageChartMeta;
    const tooltip = $("usage-chart-tooltip");
    if (!meta || !tooltip || !meta.points.length) return;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const index = meta.points.reduce((closest, point, pointIndex) => (
      Math.abs(point.x - pointerX) < Math.abs(meta.points[closest].x - pointerX) ? pointIndex : closest
    ), 0);
    const point = meta.points[index];
    const valueLabel = $("usage-tooltip-value");
    const dayLabel = $("usage-tooltip-day");
    if (valueLabel) valueLabel.textContent = `%${formatUsagePercentage(meta.values[index])}`;
    if (dayLabel) dayLabel.textContent = localizeChartDay(meta.data[index]?.label, index);
    tooltip.style.left = `${Math.max(54, Math.min(meta.width - 54, point.x))}px`;
    tooltip.style.top = `${Math.max(54, point.y)}px`;
    tooltip.classList.remove("hidden");
  });

  canvas.addEventListener("pointerleave", () => $("usage-chart-tooltip")?.classList.add("hidden"));
}

// ------------------------------------------------------ bağlantı haritası

const TOOL_ICON_SVG = {
  cli: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5 9 12l-4 4.5M12.5 16.5h6"/></svg>',
  app: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><path d="M3.5 9h17M8.5 9v10.5"/></svg>',
};

function localToolInstalled(toolId) {
  if (toolId === CLAUDE_CODE) {
    return CLAUDE_STATE.cli?.installed === true || (CLAUDE_STATE.cli?.editorExtensions || []).length > 0;
  }
  if (toolId === CLAUDE_DESKTOP) return CLAUDE_STATE.desktop?.installed === true;
  if (toolId === CODEX) {
    return CODEX_STATE.cli?.installed === true
      || CODEX_STATE.desktop?.installed === true
      || (CODEX_STATE.cli?.editorExtensions || []).length > 0;
  }
  return false;
}

function dashboardProductInstalled(toolKey) {
  if (toolKey === CLAUDE_CODE) {
    return CLAUDE_STATE.cli?.installed === true || (CLAUDE_STATE.cli?.editorExtensions || []).length > 0;
  }
  if (toolKey === CLAUDE_DESKTOP) return CLAUDE_STATE.desktop?.installed === true;
  if (toolKey === CODEX_CLI_PRODUCT) {
    return CODEX_STATE.cli?.installed === true || (CODEX_STATE.cli?.editorExtensions || []).length > 0;
  }
  if (toolKey === CODEX_DESKTOP_PRODUCT) return CODEX_STATE.desktop?.installed === true;
  return false;
}

function dashboardConnectionState(tool, status) {
  if (!dashboardProductInstalled(tool.key)) return "absent";
  const configured = status?.blocked !== true
    && status?.applied === true
    && status?.desiredEnabled !== false;
  return configured ? "active" : "installed";
}

function dashboardToolNodes(offeredIds) {
  const nodes = [];
  if (offeredIds.includes(CLAUDE_CODE)) {
    nodes.push({ key: CLAUDE_CODE, switchId: CLAUDE_CODE, name: NAMES[CLAUDE_CODE], icon: "cli" });
  }
  if (offeredIds.includes(CLAUDE_DESKTOP)) {
    nodes.push({ key: CLAUDE_DESKTOP, switchId: CLAUDE_DESKTOP, name: NAMES[CLAUDE_DESKTOP], icon: "app" });
  }
  if (offeredIds.includes(CODEX)) {
    nodes.push({ key: CODEX_CLI_PRODUCT, switchId: CODEX, name: NAMES[CODEX_CLI_PRODUCT], icon: "cli" });
    nodes.push({ key: CODEX_DESKTOP_PRODUCT, switchId: CODEX, name: NAMES[CODEX_DESKTOP_PRODUCT], icon: "app" });
  }
  return nodes;
}

// İki tam periyotluk sinüs. Genişlik tankın iki katı olduğu için -%50'lik
// öteleme dikişsiz döngü verir; öğe döndürülmez ve kart dışına iz bırakmaz.
const WAVE_SVG = '<svg viewBox="0 0 240 20" preserveAspectRatio="none" aria-hidden="true">'
  + '<path fill="currentColor" d="M0 10 C15 2 45 2 60 10 C75 18 105 18 120 10'
  + ' C135 2 165 2 180 10 C195 18 225 18 240 10 L240 20 L0 20 Z"/></svg>';

function tankElements() {
  const liquid = document.createElement("span");
  liquid.className = "tank-liquid";
  const wave = document.createElement("span");
  wave.className = "tank-wave";
  wave.innerHTML = WAVE_SVG;
  liquid.append(wave);

  const brand = document.createElement("span");
  brand.className = "tank-brand";
  const logo = document.createElement("img");
  logo.className = "tank-logo";
  logo.src = "../../assets/logo.png";
  logo.alt = "";
  const brandText = document.createElement("span");
  brandText.textContent = "Cizi Code";
  brand.append(logo, brandText);

  const value = document.createElement("span");
  value.className = "tank-value";
  return [liquid, brand, value];
}

function updateUsageTank({ animateFromEmpty = false, animationDelayMs = 0 } = {}) {
  const configGauge = $("config-usage-gauge");
  const providers = [document.querySelector("#connection-map .cbh__card--provider")].filter(Boolean);
  if (!providers.length && !configGauge) return;
  const { percent, unlimited, label } = QUOTA_VIEW;
  // Etiket ile görsel seviye aynı değeri anlatır: %100 tankı gerçekten tam
  // doldurur. Sınırlar dış kaynaktan beklenmedik bir değer gelmesine karşıdır.
  const quotaLevel = Math.max(0, Math.min(100, percent));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimateFromEmpty = animateFromEmpty && !HAS_ANIMATED_USAGE_TANK && !reducedMotion;
  if (animateFromEmpty && !HAS_ANIMATED_USAGE_TANK) HAS_ANIMATED_USAGE_TANK = true;
  const title = unlimited ? "Planınız şu an sınırsız." : `Kullanım hakkınızın %${percent}'i kaldı.`;

  for (const provider of providers) {
    provider.classList.remove("usage-warn", "usage-bad");
    provider.classList.toggle("usage-unlimited", unlimited);
    if (!unlimited && percent <= 10) provider.classList.add("usage-bad");
    else if (!unlimited && percent <= 30) provider.classList.add("usage-warn");
    provider.style.setProperty("--quota-level", `${quotaLevel}%`);
    provider.title = title;
    provider.setAttribute("aria-label", title);
    const value = provider.querySelector(".tank-value");
    if (value) value.textContent = label;

    if (shouldAnimateFromEmpty) {
      const safeDelayMs = Math.max(0, Number(animationDelayMs) || 0);
      provider.style.setProperty("--tank-entry-duration", `${USAGE_TANK_ENTRY_MS}ms`);
      provider.style.setProperty("--tank-entry-delay", `${safeDelayMs}ms`);
      provider.classList.add("usage-tank-entering");
      setTimeout(() => {
        provider.classList.remove("usage-tank-entering");
        provider.style.removeProperty("--tank-entry-duration");
        provider.style.removeProperty("--tank-entry-delay");
      }, safeDelayMs + USAGE_TANK_ENTRY_MS + 100);
    }
  }

  if (configGauge) {
    configGauge.classList.remove("usage-warn", "usage-bad");
    configGauge.classList.toggle("usage-unlimited", unlimited);
    if (!unlimited && percent <= 10) configGauge.classList.add("usage-bad");
    else if (!unlimited && percent <= 30) configGauge.classList.add("usage-warn");
    configGauge.style.setProperty("--quota-progress", quotaLevel);
    configGauge.title = title;
    configGauge.setAttribute("aria-label", title);
    if (unlimited) {
      configGauge.removeAttribute("aria-valuenow");
      configGauge.setAttribute("aria-valuetext", "Sınırsız kullanım");
    } else {
      configGauge.setAttribute("aria-valuenow", String(percent));
      configGauge.setAttribute("aria-valuetext", `%${percent} kaldı`);
    }
    const gaugeValue = $("config-gauge-value");
    const quotaNote = $("config-quota-note");
    if (gaugeValue) gaugeValue.textContent = label;
    if (quotaNote) quotaNote.textContent = unlimited
      ? "Sınırsız kullanım alanı"
      : percent <= 0 ? "Kullanım hakkı tükendi"
        : percent <= 30 ? "Kalan hak azalıyor" : "Kullanıma hazır";
  }
}

function renderConnectionMap() {
  const root = $("connection-map");
  if (!root || typeof window.CiziBaglantiHaritasi !== "function") return;
  const models = Array.isArray(TEMPLATES?.combos)
    ? TEMPLATES.combos
    : Array.isArray(ME?.combos) ? ME.combos : [];
  const offered = accessibleToolIds(models);
  const byStatus = new Map(LAST_TOOL_STATUSES.map((status) => [status.id, status]));
  const tools = dashboardToolNodes(offered).map((tool) => ({
    ...tool,
    state: dashboardConnectionState(tool, byStatus.get(tool.switchId)),
  }));
  const toolIndex = new Map(tools.map((tool, index) => [tool.key, index]));
  // Sunucu her modele erişim sözleşmesini (`desktopClients`) iliştirmiyor.
  // Hesapta yedi model varken üçünde bu alan dolu geliyor; kalanlar hiçbir
  // yerel araca bağlanmıyor. Hepsine "Erişilebilir" demek, arayüzün arkasını
  // dolduramadığı bir söz vermesi olurdu.
  const clientsPerModel = models.map((model) => desktopClients(model));
  const links = [];
  models.forEach((model, modelIndex) => {
    for (const client of clientsPerModel[modelIndex]) {
      const keys = client === CODEX ? [CODEX_CLI_PRODUCT, CODEX_DESKTOP_PRODUCT] : [client];
      for (const key of keys) {
        if (toolIndex.has(key)) links.push([modelIndex, toolIndex.get(key)]);
      }
    }
  });

  const animateEntry = !HAS_PRESENTED_CONNECTION_MAP && CURRENT_SCREEN === "dashboard";
  CONNECTION_MAP = CONNECTION_MAP?.destroy?.() || null;
  const connectionMap = new window.CiziBaglantiHaritasi(root, {
    autoplay: animateEntry,
    speed: 1.55,
    // Enerji akışı üç kat yavaş: hız kabloyu bir ışık şeridine çeviriyordu.
    pulseSpeed: 63,
    // Hem gerçek düz parçayı hem Bézier'in yatay kontrol kollarını kısalt.
    // Yalnızca lead değerlerini azaltmak, eğrinin gözle hâlâ uzun süre düz
    // ilerlemesine yol açıyordu.
    leadOut: 6,
    leadIn: 11,
    bendMin: 18,
    bendRatio: 0.5,
    data: {
      provider: { name: "Cizi Code", status: "", icon: "cloud" },
      energyEnabled: !ME?.isLimitReached && (QUOTA_VIEW.unlimited || QUOTA_VIEW.percent > 0),
      models: models.map((model, index) => ({
        name: displayModelName(modelName(model)),
        meta: clientsPerModel[index].length ? "Erişilebilir" : "Araç yok",
      })),
      tools: tools.map((tool) => ({ name: tool.name, icon: tool.icon, state: tool.state })),
      links: links.map(([model, tool]) => ({ model, tool, state: tools[tool]?.state || "absent" })),
    },
  });
  CONNECTION_MAP = connectionMap;
  if (animateEntry) {
    HAS_PRESENTED_CONNECTION_MAP = true;
  } else {
    // Yenileme ve yapılandırma dönüşlerinde giriş koreografisini tekrarlama.
    // Bileşenin ilk ölçümü tamamlandıktan sonra tek karede yerleşmiş hâle geçer.
    requestAnimationFrame(() => {
      if (CONNECTION_MAP !== connectionMap) return;
      connectionMap.layout();
      connectionMap.finish();
    });
  }

  const titles = root.querySelectorAll(".cbh__coltitle");
  if (titles[0]) titles[0].textContent = "Kalan kullanım";
  if (titles[1]) titles[1].textContent = "Erişilebilir modeller";
  if (titles[2]) titles[2].textContent = "Araçlar";

  const provider = root.querySelector(".cbh__card--provider");
  if (provider) {
    provider.append(...tankElements());
    const providerEntryDelay = Number(CONNECTION_MAP.t?.providerIn || 0)
      / Math.max(0.1, Number(CONNECTION_MAP.o?.speed || 1));
    updateUsageTank({ animateFromEmpty: animateEntry, animationDelayMs: providerEntryDelay });
  }

  CONNECTION_MAP.modelCards.forEach((modelCard, index) => {
    if (clientsPerModel[index]?.length) return;
    modelCard.classList.add("is-unlinked");
    modelCard.querySelector(".cbh__dot")?.classList.add("cbh__dot--muted");
    modelCard.title = "Bu model hesabınızda hiçbir yerel araca tanımlı değil.";
  });

  // Kablo uçlarındaki pinler animasyonun ortasında (1.8 sn) doğuyor ve o anki
  // ölçüme göre yerleşiyor. Kolon genişlikleri ise daha geç kesinleşiyor:
  // grafik çizilince dikey kaydırma çubuğu geliyor, yazı tipi sonra yükleniyor.
  // Ölçüm tazelenmezse pin kartın kenarına değil "Erişilebilir" yazısının
  // üstüne düşüyor. Animasyon oturduğunda son bir kez ölçülür.
  const relayout = () => CONNECTION_MAP?.layout?.();
  root.addEventListener("cbh:settled", relayout, { once: true });
  requestAnimationFrame(() => requestAnimationFrame(relayout));
  document.fonts?.ready?.then(relayout);

  CONNECTION_MAP.toolCards.forEach((toolCard, index) => {
    const tool = tools[index];
    if (!tool) return;
    toolCard.tabIndex = 0;
    toolCard.role = "button";
    toolCard.dataset.cliId = `screen.config.${tool.key}`;
    toolCard.dataset.cliLabel = `${tool.name} yapılandırmasını aç`;
    toolCard.classList.add(`is-tool-${tool.state}`);
    const stateLabel = tool.state === "active"
      ? "Kurulu ve yapılandırılmış"
      : tool.state === "installed" ? "Kurulu, yapılandırılmamış" : "Kurulu değil";
    toolCard.title = `${stateLabel} · ${tool.name} yapılandırma ekranını aç`;
    toolCard.setAttribute("aria-label", `${tool.name}: ${stateLabel}. Yapılandırmayı aç`);
    const dot = toolCard.querySelector(".cbh__dot");
    if (dot && tool.state !== "active") dot.classList.add("cbh__dot--muted");
    const open = () => showAppScreen("config", tool.switchId);
    toolCard.addEventListener("click", open);
    toolCard.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function integrationStatusText(toolId, status) {
  if (!localToolInstalled(toolId)) return { text: "Kurulu değil", tone: "is-absent" };
  if (status?.blocked) return { text: "Dikkat gerekiyor", tone: "is-attention" };
  if (status?.applied && status?.desiredEnabled !== false) return { text: "Bağlı", tone: "is-on" };
  return { text: "Bağlı değil", tone: "" };
}

function renderConfigRail(offered, byStatus) {
  const rail = $("config-tool-list");
  if (!rail) return;
  rail.innerHTML = "";
  for (const toolId of offered) {
    const selected = SELECTED_TOOL_ID === toolId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `config-tool${selected ? " is-selected" : ""}`;
    button.dataset.cliId = `config.tool.${toolId}`;
    button.dataset.cliLabel = `${NAMES[toolId]} yapılandırmasını seç`;
    button.setAttribute("aria-pressed", String(selected));

    const icon = document.createElement("span");
    icon.className = "config-tool-icon";
    icon.innerHTML = TOOL_ICON_SVG[toolId === CLAUDE_CODE ? "cli" : "app"];
    const name = document.createElement("span");
    name.className = "config-tool-name";
    name.textContent = NAMES[toolId];
    const detail = integrationStatusText(toolId, byStatus.get(toolId));
    const state = document.createElement("span");
    state.className = `config-tool-status ${detail.tone}`;
    state.textContent = detail.text;

    button.append(icon, name, state);
    button.addEventListener("click", () => showAppScreen("config", toolId));
    rail.appendChild(button);
  }
}

function emptyState(title, detail) {
  const element = document.createElement("div");
  element.className = "empty-state";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("span");
  text.textContent = detail;
  element.append(heading, text);
  return element;
}

function renderConfigDetail() {
  const list = $("tools-list");
  if (!list) return;
  const models = TEMPLATES?.combos || [];
  const offered = accessibleToolIds(models);
  const byStatus = new Map(LAST_TOOL_STATUSES.map((status) => [status.id, status]));
  if (!SELECTED_TOOL_ID || !offered.includes(SELECTED_TOOL_ID)) SELECTED_TOOL_ID = offered[0] || null;
  renderConfigRail(offered, byStatus);
  list.innerHTML = "";

  if (!SELECTED_TOOL_ID) {
    $("config-context-label").textContent = "Araç yok";
    list.appendChild(emptyState(
      "Yapılandırılabilir araç yok",
      models.length
        ? "Hesabınızdaki modeller yerel bir araca bağlanmıyor. Yeni bir araç eklendiğinde burada görünür."
        : "Bu profile henüz model tanımlanmamış. Yenile'ye basarak hesabınızı tekrar okuyabilirsiniz.",
    ));
    return;
  }

  $("config-context-label").textContent = NAMES[SELECTED_TOOL_ID];
  const status = byStatus.get(SELECTED_TOOL_ID);
  if (!status) {
    list.appendChild(emptyState(NAMES[SELECTED_TOOL_ID], "Araç durumu henüz okunamadı. Yenile'ye basın."));
    return;
  }
  list.appendChild(CARDS[SELECTED_TOOL_ID](status, modelsForTool(models, SELECTED_TOOL_ID)));
  for (const scope of PROGRESS.keys()) paintLane(scope);
}

// -------------------------------------------------------------- durum okuma

async function loadTools() {
  const [tools, claude, codex] = await Promise.all([cizi.listTools(), cizi.getClaudeState(), cizi.getCodexState()]);
  CLAUDE_STATE = claude?.ok ? (claude.data || CLAUDE_STATE) : { cli: { installed: false }, desktop: { installed: false } };
  CODEX_STATE = codex?.ok ? (codex.data || CODEX_STATE) : CODEX_STATE;
  TEMPLATES = { combos: Array.isArray(ME?.combos) ? ME.combos : [] };
  LAST_TOOL_STATUSES = tools.ok ? (tools.data || []) : [];
  renderTools(tools.ok ? tools.data : []);
}

// Bir anahtarın tek okuması: hem görünen etiket hem sol kenar şeridi buradan.
// Niyet anahtarın gösterdiği şey; `applied` karşılaştırıldığı olgu. Aradaki
// fark saklanmaz, adı konur.
function switchState({ desiredEnabled, applied, restorable, installed, blocked, blockReason }) {
  if (blocked) return { key: "attention", label: "Dikkat", note: blockReason || "Bu bağlantı şu an denetlenemiyor." };
  if (!installed) return { key: "absent", label: "Kurulu değil", note: "Bağlamak için önce ürünü kurun." };
  if (desiredEnabled && applied) return { key: "on", label: "Bağlı", note: null };
  if (desiredEnabled && !applied) {
    return { key: "working", label: "Tamamlanacak", note: "Bağlantı açık tutuluyor; eksik ayarlar otomatik yeniden uygulanacak." };
  }
  if (!desiredEnabled && (applied || restorable)) {
    return { key: "working", label: "Kapatma sürüyor", note: "Orijinal ayarlarınız hâlâ yedekte; geri yükleme tamamlanacak." };
  }
  return { key: "off", label: "Kapalı", note: null };
}

function modelSummary(models, toolId) {
  const profiles = (models || []).map((model) => capabilityFor(model, toolId));
  if (!profiles.length) return { text: "uyumlu model yok", title: "Bu araç için uygun model bulunamadı" };
  const thinking = toolId === CLAUDE_CODE ? "thinking" : "effort";
  const windows = profiles.map((profile) => profile.contextWindowTokens);
  const smallest = Math.min(...windows);
  const largest = Math.max(...windows);
  const windowLabel = smallest === largest ? contextLabel(largest) : `${contextLabel(smallest)}–${contextLabel(largest)}`;
  return {
    text: `${profiles.length} model · ${windowLabel} · ${thinking}`,
    title: `${profiles.map((profile) => displayModelName(profile.name)).join(", ")}`
      + ` — hepsi otomatik eklenir, ${thinking} seviyesi modelin desteklediği aralıktan seçilir`,
  };
}

// ------------------------------------------------------------------ parçalar

function button({ label, className = "ghost tiny-btn", cliId, cliLabel, title, onClick, long }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  if (cliId) element.dataset.cliId = cliId;
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

async function runButtonAction(event, action) {
  const target = event.currentTarget;
  target.disabled = true;
  try {
    return await action();
  } finally {
    // Async DOM events clear `currentTarget` after the first await. Keeping the
    // actual element also remains safe when a status refresh replaced the card.
    if (target.isConnected) target.disabled = false;
  }
}

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  const { root, menu, toggle } = openMenu;
  menu.hidden = true;
  menu.style.removeProperty("left");
  menu.style.removeProperty("top");
  menu.style.removeProperty("right");
  menu.style.removeProperty("bottom");
  menu.style.removeProperty("max-height");
  if (root.isConnected) root.appendChild(menu);
  else menu.remove();
  toggle.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.root.contains(event.target) && !openMenu.menu.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
// Pencere odağı kaybettiğinde menü KAPANIR.
//
// Bunun bedeli yaşanarak öğrenildi: açık bırakılan bir kaldırma menüsü,
// "Seçilenleri kaldır" düğmesi ekranda duran silahlı bir yıkıcı eylemdir.
// Kullanıcı başka bir pencereye geçip saatler sonra döndüğünde o düğmenin ne
// yaptığını hatırlamak zorunda kalmamalı. Yıkıcı bir eylem yalnızca kullanıcının
// o an baktığı ekranda durabilir.
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("visibilitychange", () => { if (document.hidden) closeMenu(); });

function positionMenu(menu, toggle, menuAlign) {
  const viewportGap = 8;
  const anchorGap = 6;
  const anchor = toggle.getBoundingClientRect();
  menu.classList.remove("menu-up");
  menu.style.maxHeight = "";
  menu.style.left = `${viewportGap}px`;
  menu.style.top = `${viewportGap}px`;
  menu.style.right = "auto";
  menu.style.bottom = "auto";

  const natural = menu.getBoundingClientRect();
  const roomBelow = window.innerHeight - anchor.bottom - anchorGap - viewportGap;
  const roomAbove = anchor.top - anchorGap - viewportGap;
  const opensAbove = natural.height > roomBelow && roomAbove > roomBelow;
  const availableHeight = opensAbove ? roomAbove : roomBelow;
  menu.style.maxHeight = `${Math.min(window.innerHeight - viewportGap * 2, Math.max(120, availableHeight))}px`;

  const bounded = menu.getBoundingClientRect();
  const preferredLeft = menuAlign === "right" ? anchor.right - bounded.width : anchor.left;
  const left = Math.min(
    window.innerWidth - bounded.width - viewportGap,
    Math.max(viewportGap, preferredLeft),
  );
  const preferredTop = opensAbove
    ? anchor.top - anchorGap - bounded.height
    : anchor.bottom + anchorGap;
  const top = Math.min(
    window.innerHeight - bounded.height - viewportGap,
    Math.max(viewportGap, preferredTop),
  );
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

// Bölünmüş düğme: ana eylem + açılır ok. Ana düğme CLI köprüsünün bildiği
// kimliği taşır, böylece "cizi-cli click <id>" davranışı değişmez.
function splitButton({ main, menuAlign = "left", onOpen }) {
  const root = document.createElement("div");
  root.className = "split";
  const mainButton = button({ ...main, className: `${main.className || "ghost tiny-btn"} split-main` });
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost tiny-btn split-toggle";
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5" /></svg>';
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.dataset.cliId = `${main.cliId}.more`;
  toggle.dataset.cliLabel = `${main.cliLabel || main.label} seçenekleri`;
  toggle.title = "Diğer seçenekler";

  const menu = document.createElement("div");
  menu.className = `menu${menuAlign === "right" ? " menu-right" : ""}`;
  menu.hidden = true;

  toggle.addEventListener("click", async (event) => {
    event.stopPropagation();
    const wasOpen = openMenu?.menu === menu;
    closeMenu();
    if (wasOpen) return;
    menu.innerHTML = '<div class="menu-note">Hazırlanıyor...</div>';
    document.body.appendChild(menu);
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    openMenu = { root, menu, toggle };
    positionMenu(menu, toggle, menuAlign);
    await onOpen(menu);
    if (openMenu?.menu !== menu || !toggle.isConnected) return;
    positionMenu(menu, toggle, menuAlign);
  });

  root.append(mainButton, toggle, menu);
  return { root, mainButton };
}

function menuItem({ label, hint, cliId, disabled, onClick }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item";
  item.disabled = Boolean(disabled);
  if (cliId) item.dataset.cliId = cliId;
  item.dataset.cliLabel = label;
  const strong = document.createElement("strong");
  strong.textContent = label;
  item.appendChild(strong);
  if (hint) {
    const span = document.createElement("span");
    span.textContent = hint;
    item.appendChild(span);
  }
  if (onClick) {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMenu();
      onClick(event);
    });
  }
  return item;
}

// ----------------------------------------------------- kaldırma menüsü (madde 3)
//
// Kategoriler radyo düğmesi gibi davranır ama tik göstermez: seçili olan tam
// opak, tıklanan SAYDAMLAŞIR ve üstü çizilir — yani silinmeyecek. Kilitli olan
// baştan saydamdır ve tıklanamaz; sebebi altında yazar.
const REMOVAL_SELECTION = new Map();

function selectionFor(productId, plan) {
  if (!REMOVAL_SELECTION.has(productId)) {
    REMOVAL_SELECTION.set(productId, new Set(
      plan.categories.filter((category) => category.selectedByDefault).map((category) => category.id),
    ));
  }
  const selection = REMOVAL_SELECTION.get(productId);
  // Plan yeniden okunduğunda kaybolmuş kategoriler seçimden düşer.
  const valid = new Set(plan.categories.map((category) => category.id));
  for (const id of [...selection]) if (!valid.has(id)) selection.delete(id);
  return selection;
}

async function buildRemovalMenu(productId, menu, cliPrefix = productId) {
  const result = await cizi.planProductRemoval(productId);
  menu.innerHTML = "";
  if (!result.ok) {
    menu.innerHTML = `<div class="menu-note">${clientMessage(result.error || "Kaldırma planı alınamadı.")}</div>`;
    return;
  }
  const plan = result.data;
  if (!plan.categories.length) {
    menu.innerHTML = '<div class="menu-note">Bu bilgisayarda silinecek bir iz bulunamadı.</div>';
    return;
  }
  const selection = selectionFor(productId, plan);

  const total = document.createElement("span");
  total.className = "cat-size";

  const paintTotal = () => {
    const bytes = plan.categories
      .filter((category) => selection.has(category.id))
      .reduce((sum, category) => sum + (category.bytes || 0), 0);
    total.textContent = bytes > 0 ? `${formatBytes(bytes)} boşalacak` : "";
  };

  for (const category of plan.categories) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cat";
    row.dataset.cliId = `${cliPrefix}.category.${category.id}`;
    row.dataset.cliLabel = category.label;

    const name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = category.label;
    const size = document.createElement("span");
    size.className = "cat-size";
    row.append(name, size);

    const paint = () => {
      const on = selection.has(category.id) && !category.locked;
      row.classList.toggle("off", !on && !category.locked);
      row.classList.toggle("locked", Boolean(category.locked));
      size.textContent = category.locked
        ? "korunur"
        : `${category.bytesApproximate ? "≈ " : ""}${formatBytes(category.bytes)}`;
      row.title = category.locked
        ? category.lockReason || ""
        : category.paths.map((item) => item.path).concat(category.actions.map((item) => item.label)).join("\n");
    };

    if (category.locked) {
      row.disabled = true;
    } else {
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (selection.has(category.id)) selection.delete(category.id);
        else selection.add(category.id);
        paint();
        paintTotal();
      });
    }
    paint();
    menu.appendChild(row);
  }

  if (plan.protected?.length) {
    const note = document.createElement("div");
    note.className = "menu-note";
    note.textContent = `Korunur: ${plan.protected.map((item) => item.reason).join(" · ")}`;
    menu.appendChild(note);
  }
  // Başka bir paket yöneticisinin (WinGet, kod düzenleyici) sahiplendiği
  // kurulumlar. Birden fazla olabilir; hepsi ayrı ayrı söylenir.
  for (const external of plan.external?.all || (plan.external ? [plan.external] : [])) {
    const note = document.createElement("div");
    note.className = "menu-note";
    note.textContent = `${external.label} — Cizi Code buna dokunmaz`
      + `${external.reason ? ` (${external.reason})` : ""}. Kaldırmak için: ${external.command}`;
    menu.appendChild(note);
  }

  const foot = document.createElement("div");
  foot.className = "menu-foot";
  foot.appendChild(button({
    label: "Seçilenleri kaldır",
    className: "primary tiny-btn",
    cliId: `${cliPrefix}.remove-selected`,
    cliLabel: `${NAMES[productId] || productId} seçilenleri kaldır`,
    long: true,
    onClick: () => {
      closeMenu();
      runRemoval(productId, [...selection]);
    },
  }));
  paintTotal();
  foot.appendChild(total);
  menu.appendChild(foot);
}

function removalConfirmText(productName, plan, selectedIds) {
  const chosen = plan.categories.filter((category) => selectedIds.includes(category.id) && !category.locked);
  const skipped = plan.categories.filter((category) => !selectedIds.includes(category.id) && !category.locked);
  const total = chosen.reduce((sum, category) => sum + (category.bytes || 0), 0);
  const removesApplication = chosen.some((category) => category.id === "app");
  // Onay metni ilk satırda en ağır sonucu söyler: uygulamanın kendisi gidiyor mu
  // ve ne kadar veri siliniyor. Yalnızca kategori adlarını listelemek, "hepsi
  // seçili" durumunda ne kadar büyük bir işlem olduğunu görünmez bırakıyor.
  const lines = [
    removesApplication
      ? `${productName} BİLGİSAYARINIZDAN KALDIRILACAK.`
      : `${productName} verilerinin bir kısmı silinecek.`,
    total > 0 ? `Silinecek veri: ${formatBytes(total)}` : "",
    "",
  ].filter((line, index) => line !== "" || index === 2);
  if (chosen.length) {
    lines.push("SİLİNECEK:");
    for (const category of chosen) {
      lines.push(`  • ${category.label}${category.bytes ? ` (${formatBytes(category.bytes)})` : ""}`);
    }
    lines.push("");
  } else {
    lines.push("Hiçbir kategori seçilmedi.", "");
    return lines.join("\n");
  }
  if (skipped.length) {
    lines.push("KORUNACAK (siz seçmediniz):", ...skipped.map((category) => `  • ${category.label}`), "");
  }
  const locked = plan.categories.filter((category) => category.locked);
  if (locked.length) {
    lines.push("KORUNACAK (başka ürün kullanıyor):", ...locked.map((category) => `  • ${category.label}`), "");
  }
  for (const external of plan.external?.all || (plan.external ? [plan.external] : [])) {
    lines.push(`DOKUNULMAZ — ${external.label}`, `  kaldırmak için: ${external.command}`, "");
  }
  lines.push(removesApplication
    ? "Bu işlem GERİ ALINAMAZ. Sohbet geçmişiniz ve uygulama verisi kurtarılamaz.\n\nDevam edilsin mi?"
    : "Bu işlem geri alınamaz. Devam edilsin mi?");
  return lines.join("\n");
}

async function runRemoval(productId, categories) {
  const name = NAMES[productId] || productId;
  const planResult = await cizi.planProductRemoval(productId);
  if (!planResult.ok) {
    toast(clientMessage(planResult.error || "Kaldırma planı alınamadı."), "bad");
    return;
  }
  const plan = planResult.data;
  if (!plan.categories.length) {
    toast(`${name} için silinecek bir iz bulunamadı.`, "warn");
    return;
  }
  const selected = Array.isArray(categories) && categories.length
    ? categories
    : plan.categories.filter((category) => category.selectedByDefault).map((category) => category.id);
  if (!selected.length) {
    toast("Hiçbir kategori seçilmedi.", "warn");
    return;
  }
  if (!confirm(removalConfirmText(name, plan, selected))) return;
  if (!beginOperation(productId)) return;

  try {
    setProgress(productId, { label: `${name} kaldırılıyor`, percent: null, message: "Başlatılıyor...", done: false, failed: false });
    clog("info", `${name} kaldırılıyor`, { categories: selected });
    const result = await cizi.removeProduct(productId, selected);
    if (!result.ok) {
      setProgress(productId, { label: `${name} kaldırılamadı`, message: clientMessage(result.error), failed: true, done: true });
      toast(clientMessage(result.error || "Kaldırma tamamlanamadı."), "bad");
      return;
    }
    const data = result.data || {};
    const remaining = (data.stillExists || []).length;
    setProgress(productId, {
      label: `${name} kaldırıldı`,
      percent: 100,
      message: remaining ? `${remaining} öğe silinemedi.` : `${data.removed?.length || 0} öğe silindi.`,
      done: true,
    });
    toast(remaining
      ? `${name} kısmen kaldırıldı; ${remaining} öğe silinemedi.`
      : `${name} kaldırıldı.`, remaining ? "warn" : "good");
    await loadTools();
  } finally {
    endOperation(productId);
  }
}

// --------------------------------------------------------------- kurulum

async function runInstall({ scope, name, call }) {
  if (!beginOperation(scope)) return;
  try {
    setProgress(scope, { label: `${name} kuruluyor`, percent: null, message: "Resmî yükleyici hazırlanıyor...", done: false, failed: false });
    clog("info", `${name} kurulumu başlatıldı`, { scope });
    let result;
    try { result = await call(); } catch (error) { result = { ok: false, error: error?.message }; }
    if (result?.ok) {
      setProgress(scope, { label: `${name} kuruldu`, percent: 100, message: "", done: true });
      toast(`${name} kuruldu.`, "good");
      await loadTools();
      return;
    }
    const message = clientMessage(result?.error || `${name} kurulamadı.`);
    setProgress(scope, { label: `${name} kurulamadı`, message, failed: true, done: true });
    toast(message, "bad");
  } finally {
    endOperation(scope);
  }
}

async function runDownloadOnly({ scope, name, call }) {
  if (!beginOperation(scope)) return;
  try {
    setProgress(scope, { label: `${name} yükleyicisi indiriliyor`, percent: null, message: "", done: false, failed: false });
    let result;
    try { result = await call(); } catch (error) { result = { ok: false, error: error?.message }; }
    if (!result?.ok) {
      const message = clientMessage(result?.error || "Yükleyici indirilemedi.");
      setProgress(scope, { label: "İndirme tamamlanamadı", message, failed: true, done: true });
      toast(message, "bad");
      return;
    }
    const data = result.data || {};
    setProgress(scope, { label: "Yükleyici indirildi", percent: 100, message: data.path || "", done: true });
    toast(`Yükleyici indirildi. ${data.runHint || ""}`.trim(), "good");
    if (data.path) await cizi.revealPath(data.path);
  } finally {
    endOperation(scope);
  }
}

// ------------------------------------------------------------- anahtar akışı
//
// Claude Desktop açıksa ana süreç bunu hata değil SORU olarak bildiriyor; bir
// kez onay isteyip tekrar denemek, anahtarın ölü görünmesini engelleyen şey.
async function toggleSwitch(checkbox, { switchId, models }) {
  const turningOn = checkbox.checked;
  const name = NAMES[switchId] || switchId;
  if (!beginOperation(switchId)) {
    checkbox.checked = !turningOn;
    return;
  }
  checkbox.disabled = true;
  try {
    if (turningOn && !models.map(modelName).filter(Boolean).length) {
      toast("Bu anahtar için uygun model bulunamadı.", "bad");
      checkbox.checked = false;
      return;
    }

    const attempt = (closeRunning) => (turningOn
      ? cizi.applyTool(switchId, closeRunning)
      : cizi.revertTool(switchId, closeRunning));

    clog("info", `${name}: ${turningOn ? "bağlanıyor" : "geri alınıyor"}`, { tool: switchId });
    let result = await attempt(false);
    if (!result.ok && result.code === "PROCESS_RUNNING_CONFIRMATION_REQUIRED") {
      const proceed = confirm(turningOn
        ? "Claude Desktop şu an açık.\n\nAyarların uygulanabilmesi için kapatılması gerekiyor. Kapatılsın mı?"
        : "Claude Desktop şu an açık.\n\nÖnceki ayarlarınızın geri yüklenebilmesi için kapatılması gerekiyor. Kapatılsın mı?");
      if (proceed) result = await attempt(true);
      else {
        clearProgress(switchId);
        checkbox.checked = !turningOn;
        return;
      }
    }

    if (result.ok) {
      const count = result.data?.modelCount || models.map(modelName).filter(Boolean).length;
      toast(turningOn ? `${name} bağlandı; ${count} model eklendi.` : `${name} bağlantısı kaldırıldı; önceki ayarlarınız geri yüklendi.`, "good");
    } else {
      toast(clientMessage(result.error || `${name} ayarlanamadı.`), "bad");
      if (turningOn) checkbox.checked = false;
    }
    await loadTools();
  } finally {
    checkbox.disabled = false;
    endOperation(switchId);
  }
}

// ------------------------------------------------------------------- kartlar

function card({ switchId, title, state, fact, models, family, actions, extra }) {
  const root = document.createElement("div");
  root.className = `card state-${state.key}`;
  root.dataset.toolId = switchId;

  const head = document.createElement("div");
  head.className = "card-head";
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.innerHTML = TOOL_ICON_SVG[switchId === CLAUDE_CODE ? "cli" : "app"];
  head.appendChild(icon);
  const titleBox = document.createElement("div");
  titleBox.className = "card-title";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const pill = document.createElement("span");
  pill.className = `pill pill-${state.key}`;
  pill.textContent = state.label;
  if (state.note) pill.title = state.note;
  titleBox.append(heading, pill);

  const right = document.createElement("div");
  right.className = "card-head-right";
  const summary = modelSummary(models, family);
  const summaryElement = document.createElement("span");
  summaryElement.className = "card-models";
  summaryElement.textContent = summary.text;
  summaryElement.title = summary.title;
  right.appendChild(summaryElement);

  const switchLabel = document.createElement("label");
  switchLabel.className = "switch";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.cliId = `tool.${switchId}.switch`;
  checkbox.dataset.cliLabel = `${title} bağlantısı`;
  checkbox.dataset.cliAwait = "long";
  checkbox.dataset.cliAwaitTimeout = String(10 * 60 * 1000);
  checkbox.checked = state.desiredEnabled === true;
  checkbox.disabled = state.switchDisabled === true;
  if (state.switchTitle) switchLabel.title = state.switchTitle;
  const slider = document.createElement("span");
  slider.className = "slider";
  switchLabel.append(checkbox, slider);
  checkbox.addEventListener("change", () => toggleSwitch(checkbox, { switchId, models }));
  right.appendChild(switchLabel);

  head.append(titleBox, right);
  root.appendChild(head);

  const factElement = document.createElement("p");
  factElement.className = "card-fact";
  factElement.textContent = state.note || fact;
  root.appendChild(factElement);

  if (actions?.childNodes.length) root.appendChild(actions);
  root.appendChild(laneElement(switchId));
  if (extra) root.appendChild(extra);
  return root;
}

// Kurulu olmayan ürün için: [İndir ve Kur ▾] + [Resmî site]
// Açılır listede tek bir şey var — "sadece indir, manuel kurulum".
function installActions({ productId, name, install, downloadOnly, site, siteLabel = "Resmî site", downloadHint }) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const { root } = splitButton({
    main: {
      label: "İndir ve Kur",
      className: "primary tiny-btn",
      cliId: `${productId}.install`,
      cliLabel: `${name} kur`,
      long: true,
      onClick: install,
    },
    onOpen: (menu) => {
      menu.innerHTML = "";
      menu.appendChild(menuItem({
        label: "Sadece indir (manuel kurulum)",
        hint: downloadHint || "Yükleyici indirilenler klasörüne konur, çalıştırılmaz.",
        cliId: `${productId}.download-only`,
        disabled: !downloadOnly,
        onClick: downloadOnly || (() => {}),
      }));
      if (!downloadOnly) {
        const note = document.createElement("div");
        note.className = "menu-note";
        note.textContent = "Bu ürün Microsoft Store üzerinden kurulur; indirilebilir bir dosyası yok.";
        menu.appendChild(note);
      }
      return Promise.resolve();
    },
  });
  actions.appendChild(root);
  actions.appendChild(button({
    label: siteLabel, cliId: `${productId}.official-site`, cliLabel: `${name} resmî sayfası`, onClick: site,
  }));
  return actions;
}

// Kurulu ürün için kaldırma: [Kökten Kaldır ▾]
// Ana düğme varsayılan kategorilerle kaldırır (CLI davranışı korunur), ok
// kategori listesini açar.
// `cliPrefix` ürün kimliğinden ayrı tutulur: Claude Code CLI'nin arka uçtaki
// kimliği "claude-code" (anahtarla aynı), ama CLI köprüsünün belgelenmiş düğme
// kimliği "claude-code-cli.purge". Kimlikleri eşitlemek dışarıdaki sözleşmeyi
// bozardı.
function removeSplit(productId, cliPrefix = productId) {
  const name = NAMES[productId] || productId;
  const { root } = splitButton({
    main: {
      label: "Kökten Kaldır",
      className: "ghost tiny-btn danger",
      cliId: `${cliPrefix}.purge`,
      cliLabel: `${name} kökten kaldır`,
      long: true,
      onClick: () => runRemoval(productId, null),
    },
    menuAlign: "right",
    onOpen: (menu) => buildRemovalMenu(productId, menu, cliPrefix),
  });
  return root;
}

// Düzenleyici kimlikleri klasör adlarından gelir (`.vscode` → "vscode"); ekranda
// ürünün kendi adı yazmalı.
const EDITOR_NAMES = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  "vscode-oss": "VSCodium",
  "vscode-server": "VS Code (uzak)",
  "vscode-portable": "VS Code (taşınabilir)",
  cursor: "Cursor",
  "cursor-server": "Cursor (uzak)",
  windsurf: "Windsurf",
  trae: "Trae",
};

function editorName(key) {
  return EDITOR_NAMES[String(key || "").toLowerCase()] || String(key || "düzenleyici");
}

function editorNames(items) {
  return [...new Set((items || []).map((item) => editorName(item.editor || item)))].join(", ");
}

function claudeCodeFact(cli) {
  const editors = (cli.editorExtensions || []);
  const hasStandalone = cli.installed === true;
  if (!hasStandalone && editors.length) {
    return `Bağımsız CLI kurulu değil · ${editorName(editors[0]?.editor) || "VS Code"} eklentisinde Claude Code var (${editors[0]?.version || "bilinmiyor"}) — anahtar açıldığında eklenti de Cizi Code'a bağlanır · resmî yükleyiciyle bağımsız kurulum ekleyebilirsiniz`;
  }
  if (!hasStandalone) return "Kurulu değil · resmî yükleyiciyle kurulur";
  const where = `Kurulu · ${cli.version || cli.command}`;
  if (editors.length) return `${where} · ayrıca ${editorNames(editors)} eklentisi var — aynı ayar dosyası ikisini de yapılandırır`;
  return where;
}

function claudeCodeCard(status, models) {
  const cli = CLAUDE_STATE.cli || { installed: false };
  const hasStandalone = cli.installed === true;
  const hasEditorExtension = (cli.editorExtensions || []).length > 0;
  const canToggle = hasStandalone || hasEditorExtension;
  const desiredEnabled = status.desiredEnabled == null ? status.applied === true : status.desiredEnabled === true;
  const visibleDesiredEnabled = canToggle && desiredEnabled;
  const state = {
    ...switchState({
      desiredEnabled: visibleDesiredEnabled,
      applied: status.applied === true,
      restorable: status.restorable === true,
      installed: canToggle,
      blocked: false,
    }),
    desiredEnabled: visibleDesiredEnabled,
    switchDisabled: !canToggle,
    switchTitle: canToggle ? null : "Önce Claude Code CLI kurun",
  };

  const actions = document.createElement("div");
  actions.className = "actions";
  if (hasStandalone) {
    actions.appendChild(button({
      label: "Aç", cliId: "claude-code-cli.open", cliLabel: "Claude Code CLI aç",
      onClick: async (event) => {
        const result = await runButtonAction(event, () => cizi.openClaudeCodeCli());
        toast(result.ok ? "Claude Code CLI başlatıldı." : clientMessage(result.error), result.ok ? "good" : "bad");
      },
    }));
    actions.appendChild(removeSplit(CLAUDE_CODE, "claude-code-cli"));
  }
  if (!hasStandalone) {
    actions.append(...installActions({
      productId: "claude-code-cli",
      name: NAMES[CLAUDE_CODE],
      install: () => runInstall({ scope: CLAUDE_CODE, name: NAMES[CLAUDE_CODE], call: () => cizi.installClaudeCode() }),
      downloadOnly: () => runDownloadOnly({ scope: CLAUDE_CODE, name: NAMES[CLAUDE_CODE], call: () => cizi.downloadClaudeCode() }),
      site: async () => {
        const result = await cizi.openClaudeCodeSite();
        if (!result.ok) toast(clientMessage(result.error), "bad");
      },
    }).childNodes);
  }

  return card({
    switchId: CLAUDE_CODE,
    title: NAMES[CLAUDE_CODE],
    state,
    fact: claudeCodeFact(cli),
    models,
    family: CLAUDE_CODE,
    actions,
  });
}

function claudeDesktopCard(status, models) {
  const desktop = CLAUDE_STATE.desktop || { installed: false };
  const desiredEnabled = status.desiredEnabled == null ? status.applied === true : status.desiredEnabled === true;
  const visibleDesiredEnabled = desktop.installed === true && desiredEnabled;
  const blocked = status.blocked === true || desktop.blocked === true;
  const state = {
    ...switchState({
      desiredEnabled: visibleDesiredEnabled,
      applied: status.applied === true,
      restorable: status.restorable === true,
      installed: desktop.installed === true,
      blocked,
      blockReason: status.blockReason || desktop.blockReason,
    }),
    desiredEnabled: visibleDesiredEnabled,
    switchDisabled: !desktop.installed || blocked,
    switchTitle: desktop.installed ? null : "Önce Claude Desktop kurun",
  };

  const version = desktop.version || "bilinmiyor";
  const fact = !desktop.installed
    ? "Kurulu değil · resmî Claude paketiyle kurulur"
    : desktop.needsRefresh ? `Kurulu · sürüm ${version} · ayarlar yenilenmeli`
      : desktop.running ? `Kurulu · sürüm ${version} · şu an açık`
        : `Kurulu · sürüm ${version}`;
  // Claude Desktop'ın içindeki Claude Code sekmesi CLI ile aynı çekirdeği ve
  // aynı ~/.claude/settings.json'u okuyor. İki anahtarın yazdığı yerler ayrı ama
  // burada buluşuyorlar; kullanıcı bunu ekranda görmeli.
  const embedded = status.applied === true && CLAUDE_STATE.cli?.applied !== true
    ? " · içindeki Claude Code sekmesi için CLI anahtarını da açın"
    : "";

  const actions = document.createElement("div");
  actions.className = "actions";
  if (!desktop.installed) {
    actions.append(...installActions({
      productId: CLAUDE_DESKTOP,
      name: NAMES[CLAUDE_DESKTOP],
      install: () => runInstall({ scope: CLAUDE_DESKTOP, name: NAMES[CLAUDE_DESKTOP], call: () => cizi.installClaudeDesktop() }),
      downloadOnly: () => runDownloadOnly({ scope: CLAUDE_DESKTOP, name: NAMES[CLAUDE_DESKTOP], call: () => cizi.downloadClaudeDesktop() }),
      downloadHint: "Paket imzası doğrulanır, indirilenler klasörüne konur; kurulumu siz başlatırsınız.",
      site: async () => {
        const result = await cizi.openExternal("https://claude.ai/download");
        if (!result.ok) toast(clientMessage(result.error), "bad");
      },
    }).childNodes);
  } else {
    actions.appendChild(button({
      label: "Aç", cliId: "claude-desktop.open", cliLabel: "Claude Desktop aç",
      onClick: async (event) => {
        const result = await runButtonAction(event, () => cizi.launchClaudeDesktop());
        toast(result.ok ? "Claude Desktop açıldı." : clientMessage(result.error), result.ok ? "good" : "bad");
      },
    }));
    if (status.applied || desktop.needsRefresh) {
      actions.appendChild(button({
        label: "Onar", cliId: "claude-desktop.repair", cliLabel: "Claude Desktop onar", long: true,
        title: "Claude güncellemesinden sonra Cizi Code ayarlarını ve Türkçe arayüz çevirisini yeniden uygular",
        onClick: async (event) => {
          const target = event.currentTarget;
          target.disabled = true;
          setProgress(CLAUDE_DESKTOP, { label: "Ayarlar yenileniyor", percent: null, message: "", done: false, failed: false });
          const result = await cizi.repairClaudeDesktop();
          target.disabled = false;
          if (result.ok && result.data?.reconciled) {
            setProgress(CLAUDE_DESKTOP, { label: "Ayarlar yenilendi", percent: 100, done: true });
            toast("Claude Desktop ayarları yenilendi.", "good");
          } else {
            const message = result.ok
              ? (result.data?.reason === "running" ? "Önce Claude Desktop'ı kapatın." : "Onarım tamamlanamadı.")
              : clientMessage(result.error);
            setProgress(CLAUDE_DESKTOP, { label: "Onarım tamamlanamadı", message, failed: true, done: true });
            toast(message, "bad");
          }
          await loadTools();
        },
      }));
    }
    if (desktop.running) {
      actions.appendChild(button({
        label: "Kapat", cliId: "claude-desktop.stop", cliLabel: "Claude Desktop kapat",
        title: "Ayar değiştirmeden önce Claude Desktop tamamen kapatılmalıdır",
        onClick: async (event) => {
          event.currentTarget.disabled = true;
          const result = await cizi.stopClaudeDesktop();
          toast(result.ok ? "Claude Desktop kapatıldı." : clientMessage(result.error), result.ok ? "good" : "bad");
          await loadTools();
        },
      }));
    }
    actions.appendChild(removeSplit(CLAUDE_DESKTOP));
  }

  return card({
    switchId: CLAUDE_DESKTOP,
    title: NAMES[CLAUDE_DESKTOP],
    state,
    fact: `${fact}${embedded}`,
    models,
    family: CLAUDE_CODE,
    actions,
  });
}

// Codex kartı: TEK anahtar, iki ürün. ChatGPT Desktop ve Codex CLI aynı
// codex-cli çekirdeğini çalıştırıp aynı ~/.codex/config.toml'u okuyor, bu yüzden
// tek dosyayı yapılandırmak ikisini de bağlar. Kaldırma ise ürün başına ayrıdır.
function codexCard(status, models) {
  const cli = CODEX_STATE.cli || { installed: false };
  const desktop = CODEX_STATE.desktop || { installed: false };
  // Eklenti de bir Codex kurulumudur: yalnızca o varsa bile anahtar açılabilmeli.
  const extensions = cli.editorExtensions || [];
  const anyInstalled = Boolean(cli.installed || desktop.installed || extensions.length);
  const desiredEnabled = status.desiredEnabled == null ? status.applied === true : status.desiredEnabled === true;
  const visibleDesiredEnabled = anyInstalled && desiredEnabled;
  const state = {
    ...switchState({
      desiredEnabled: visibleDesiredEnabled,
      applied: status.applied === true,
      restorable: status.restorable === true,
      installed: anyInstalled,
      blocked: status.blocked === true,
      blockReason: status.blockReason,
    }),
    desiredEnabled: visibleDesiredEnabled,
    switchDisabled: !anyInstalled,
    switchTitle: anyInstalled ? null : "Önce ChatGPT Desktop veya Codex CLI kurun",
  };

  const codexCliFact = () => {
    const hasStandalone = cli.installed === true;
    if (!hasStandalone && extensions.length) {
      return `Bağımsız CLI kurulu değil · ${editorName(extensions[0]?.editor) || "VS Code"} eklentisinde Codex var (${extensions[0]?.version || "bilinmiyor"}) — anahtar aynı config.toml üzerinden eklentiyi de bağlar · bağımsız CLI ekleyebilirsiniz`;
    }
    if (hasStandalone && cli.installation !== "vscode-extension") return `Kurulu · ${cli.version || cli.command}`;
    if (!hasStandalone) return "Kurulu değil · resmî yükleyiciyle kurulur";
    return `Kurulu · ${cli.version || cli.command}`;
  };

  const codexCliActions = document.createElement("div");
  codexCliActions.className = "actions";
  if (cli.installed) {
    codexCliActions.appendChild(button({
      label: "Aç", cliId: "codex-cli.open", cliLabel: "Codex CLI aç",
      onClick: async (event) => {
        const result = await runButtonAction(event, () => cizi.openCodexCli(status.applied === true));
        toast(result.ok
          ? (status.applied ? "Codex CLI Cizi Code bağlantısıyla açıldı." : "Codex CLI kendi ayarlarıyla açıldı.")
          : clientMessage(result.error), result.ok ? "good" : "bad");
      },
    }));
    codexCliActions.appendChild(removeSplit(CODEX_CLI_PRODUCT));
  }
  if (!cli.installed) {
    codexCliActions.append(...installActions({
      productId: CODEX_CLI_PRODUCT,
      name: NAMES[CODEX_CLI_PRODUCT],
      install: () => runInstall({ scope: CODEX_CLI_PRODUCT, name: NAMES[CODEX_CLI_PRODUCT], call: () => cizi.installCodexCli() }),
      downloadOnly: () => runDownloadOnly({ scope: CODEX_CLI_PRODUCT, name: NAMES[CODEX_CLI_PRODUCT], call: () => cizi.downloadCodexCli() }),
      site: async () => {
        const result = await cizi.openCodexCliSite();
        if (!result.ok) toast(clientMessage(result.error), "bad");
      },
    }).childNodes);
  }

  const lanes = document.createElement("div");
  lanes.className = "lanes";

  // Bir ürün şeridi: adı, tek satır olgusu, kendi eylemleri ve kendi ilerleme
  // şeridi. Codex CLI kurulurken ChatGPT Desktop şeridinin ilerlemesi ayrı kalır.
  const productLane = ({ productId, fact, actions }) => {
    const row = document.createElement("div");
    row.className = "product";
    const name = document.createElement("div");
    name.className = "product-name";
    name.textContent = NAMES[productId];
    const factElement = document.createElement("div");
    factElement.className = "product-fact";
    factElement.textContent = fact;
    row.append(name, actions, factElement);
    const wrapper = document.createElement("div");
    wrapper.append(row, laneElement(productId));
    return wrapper;
  };

  const desktopActions = document.createElement("div");
  desktopActions.className = "actions";
  if (desktop.installed) {
    desktopActions.appendChild(button({
      label: "Aç", cliId: "codex-desktop.open", cliLabel: "ChatGPT Desktop aç",
      onClick: async (event) => {
        const result = await runButtonAction(event, () => cizi.openCodexDesktop());
        toast(result.ok ? "ChatGPT Desktop açıldı." : clientMessage(result.error), result.ok ? "good" : "bad");
      },
    }));
    desktopActions.appendChild(removeSplit(CODEX_DESKTOP_PRODUCT));
  } else {
    desktopActions.append(...installActions({
      productId: CODEX_DESKTOP_PRODUCT,
      name: NAMES[CODEX_DESKTOP_PRODUCT],
      siteLabel: "Mağaza sayfası",
      install: () => runInstall({ scope: CODEX_DESKTOP_PRODUCT, name: NAMES[CODEX_DESKTOP_PRODUCT], call: () => cizi.installCodexDesktop() }),
      // Microsoft Store kurulumunun indirilebilir bir dosyası yok; menü bunu
      // söyler, sessizce çalışmayan bir düğme göstermez.
      downloadOnly: null,
      site: async () => {
        const result = await cizi.openCodexDesktopStore();
        if (!result.ok) toast(clientMessage(result.error), "bad");
      },
    }).childNodes);
  }

  lanes.append(
    productLane({
      productId: CODEX_DESKTOP_PRODUCT,
      fact: desktop.installed ? `Kurulu · sürüm ${desktop.version || "bilinmiyor"}` : "Kurulu değil · Microsoft Store'dan kurulur",
      actions: desktopActions,
    }),
    productLane({
      productId: CODEX_CLI_PRODUCT,
      fact: codexCliFact(),
      actions: codexCliActions,
    }),
  );

  // Üçüncü yüzey: kod düzenleyici eklentisi. Kurmayı/kaldırmayı düzenleyici
  // yapıyor, o yüzden bizim düğmemiz yok — ama aynı config.toml'u okuduğu için
  // anahtarın onu da kapsadığı söylenmeli.
  if (extensions.length) {
    const row = document.createElement("div");
    row.className = "product";
    const name = document.createElement("div");
    name.className = "product-name";
    name.textContent = `Codex — ${editorNames(extensions)} eklentisi`;
    const fact = document.createElement("div");
    fact.className = "product-fact";
    const active = extensions.find((item) => item.active !== false) || extensions[0];
    fact.textContent = `Kurulu · ${active.version || "sürüm bilinmiyor"} · düzenleyici yönetiyor`
      + " · aynı ayar dosyası bunu da yapılandırır";
    const note = document.createElement("div");
    note.className = "product-fact";
    row.append(name, fact);
    const wrapper = document.createElement("div");
    wrapper.append(row);
    // WSL modu açıksa eklenti config.toml'u WSL'in İÇİNDEN okuyor; bizim
    // Windows tarafına yazdığımız dosya oraya ulaşmaz. Bunu söylememek,
    // "Bağlı" derken aslında bağlı olmayan bir kurulum bırakmak olurdu.
    if ((cli.wslEditors || []).length) {
      note.textContent = `Dikkat: ${editorNames(cli.wslEditors)} içinde Codex WSL'de çalışacak şekilde ayarlı.`
        + " O modda ayarlar WSL'in kendi ~/.codex klasöründen okunur; bu anahtar oraya yazmaz."
        + " WSL içinde Cizi Code'u ayrıca yapılandırmanız gerekir.";
      note.style.color = "var(--warn)";
      wrapper.append(note);
    }
    lanes.append(wrapper);
  }

  return card({
    switchId: CODEX,
    title: "Codex (CLI + ChatGPT Desktop)",
    state,
    fact: state.key === "on"
      ? `Tek ayar dosyası ikisini de yönetiyor (${CODEX_STATE.configPath || "~/.codex/config.toml"})`
      : "Tek anahtar ChatGPT Desktop ve Codex CLI'yi birlikte Cizi Code'a bağlar",
    models,
    family: CODEX,
    actions: document.createElement("div"),
    extra: lanes,
  });
}

const CARDS = {
  [CLAUDE_CODE]: claudeCodeCard,
  [CLAUDE_DESKTOP]: claudeDesktopCard,
  [CODEX]: codexCard,
};

function renderTools(statuses) {
  closeMenu();
  LAST_TOOL_STATUSES = Array.isArray(statuses) ? statuses : [];
  const models = TEMPLATES?.combos || [];
  const offered = accessibleToolIds(models);
  if (!SELECTED_TOOL_ID || !offered.includes(SELECTED_TOOL_ID)) SELECTED_TOOL_ID = offered[0] || null;
  renderConnectionMap();
  renderConfigDetail();
}

// ---------------------------------------------------------------- güncelleme

function renderUpdateState(state) {
  const visible = ["available", "downloading", "installing", "ready", "error"].includes(state?.status);
  $("update-banner").classList.toggle("hidden", !visible);
  $("update-install").classList.toggle("hidden", state?.status !== "ready");
  $("update-message").textContent = state?.message || "";
}

async function refreshUpdateState() {
  const result = await cizi.getUpdateState();
  if (result.ok) renderUpdateState(result.data);
}

// -------------------------------------------------------------------- olaylar

$("login-btn").addEventListener("click", doLogin);
$("login-key").addEventListener("keydown", (event) => { if (event.key === "Enter") doLogin(); });

$("screen-dashboard").addEventListener("click", () => showAppScreen("dashboard"));
$("screen-config").addEventListener("click", () => showAppScreen("config"));

$("logout-btn").addEventListener("click", async () => {
  clog("info", "Çıkış yapıldı");
  await cizi.logout();
  show("login");
});

$("period-select").addEventListener("change", (event) => loadUsage(event.target.value));

$("usage-refresh").addEventListener("click", async () => {
  const target = $("usage-refresh");
  const label = target.querySelector("span");
  const original = label?.textContent || "Yenile";
  target.disabled = true;
  if (label) label.textContent = "Yenileniyor";
  try {
    await refreshAll();
    toast("Bilgiler yenilendi.", "good");
  } finally {
    if (label) label.textContent = original;
    target.disabled = false;
  }
});

$("tool-reconcile-all").addEventListener("click", async () => {
  const target = $("tool-reconcile-all");
  const original = target.textContent;
  target.disabled = true;
  target.textContent = "Doğrulanıyor...";
  try {
    const result = await cizi.reconcileTools();
    if (!result.ok) {
      toast(clientMessage(result.error || "Bağlantılar doğrulanamadı."), "bad");
      return;
    }
    await loadTools();
    const report = result.data || {};
    const message = report.failed
      ? `${report.failed} bağlantı doğrulanamadı.`
      : report.pending
        ? `${report.repaired || 0} bağlantı düzeltildi; ${report.pending} işlem güvenli koşulları bekliyor.`
        : report.repaired
          ? `${report.repaired} bağlantı otomatik düzeltildi.`
          : "Tüm bağlantılar doğrulandı.";
    toast(message, report.failed ? "bad" : report.pending ? "warn" : "good");
  } finally {
    target.textContent = original;
    target.disabled = false;
  }
});

$("update-check").addEventListener("click", async () => {
  const result = await cizi.checkForUpdates();
  if (!result.ok) {
    toast(clientMessage(result.error || "Güncelleme denetimi başarısız."), "bad");
    return;
  }
  renderUpdateState(result.data);
  if (["current", "skipped"].includes(result.data?.status)) toast(result.data.message, "good");
});

$("update-install").addEventListener("click", async () => {
  const result = await cizi.installUpdate();
  if (!result.ok) toast(clientMessage(result.error || "Güncelleme kurulamadı."), "bad");
});

window.addEventListener("resize", () => {
  clearTimeout(window.__ciziChartTimer);
  window.__ciziChartTimer = setTimeout(() => {
    CONNECTION_MAP?.layout?.();
    drawChart(LAST_USAGE_SERIES);
  }, 180);
});

// Anahtar çevirmenin adımları. Şeridin başlığı adımı söyler, mesajı ayrıntıyı.
const SWITCH_PHASE_LABELS = {
  precheck: "Ürün ve ayarlar denetleniyor",
  models: "Modeller hazırlanıyor",
  backup: "Mevcut ayarlarınız yedekleniyor",
  apply: "Ayarlar uygulanıyor",
  verify: "Yazılanlar doğrulanıyor",
  restore: "Orijinal ayarlar geri yükleniyor",
  removing: "Kaldırılıyor",
  done: "Tamamlandı",
};

const CLAUDE_PHASE_LABELS = {
  starting: "Kuruluma hazırlanılıyor",
  downloading: "Claude Desktop indiriliyor",
  "verifying-signature": "Dijital imza doğrulanıyor",
  installing: "Claude Desktop kuruluyor",
  verifying: "Kurulum doğrulanıyor",
  uninstalling: "Claude Desktop kaldırılıyor",
  configuring: "Ayarlar uygulanıyor",
  authenticating: "Kimlik doğrulama hazırlanıyor",
  translating: "Türkçe arayüz çevirisi uygulanıyor",
  restoring: "Önceki ayarlara dönülüyor",
  stopping: "Claude Desktop kapatılıyor",
  repairing: "Ayarlar yenileniyor",
  complete: "Tamamlandı",
  error: "İşlem tamamlanamadı",
};

const CODEX_CLI_INSTALL_PHASE_LABELS = {
  idle: "Codex CLI kurulumu",
  checking: "Codex CLI aranıyor",
  detecting: "Codex CLI aranıyor",
  download: "Codex CLI indiriliyor",
  downloading: "Codex CLI indiriliyor",
  install: "Codex CLI kuruluyor",
  installing: "Codex CLI kuruluyor",
  verify: "Codex CLI doğrulanıyor",
  verifying: "Codex CLI doğrulanıyor",
  complete: "Codex CLI kuruldu",
  error: "Codex CLI kurulamadı",
};

const CODEX_DESKTOP_INSTALL_PHASE_LABELS = {
  idle: "ChatGPT Desktop kurulumu",
  checking: "ChatGPT Desktop aranıyor",
  detecting: "ChatGPT Desktop aranıyor",
  download: "ChatGPT Desktop indiriliyor",
  downloading: "ChatGPT Desktop indiriliyor",
  install: "ChatGPT Desktop kuruluyor",
  installing: "ChatGPT Desktop kuruluyor",
  verify: "ChatGPT Desktop doğrulanıyor",
  verifying: "ChatGPT Desktop doğrulanıyor",
  complete: "ChatGPT Desktop kuruldu",
  error: "ChatGPT Desktop kurulamadı",
};

const CLAUDE_CODE_INSTALL_PHASE_LABELS = {
  detecting: "Claude Code CLI aranıyor",
  download: "Claude Code CLI indiriliyor",
  install: "Claude Code CLI kuruluyor",
  verify: "Claude Code CLI kurulumu doğrulanıyor",
  complete: "Claude Code CLI kuruldu",
  error: "Claude Code CLI kurulamadı",
};

cizi.onUpdateState(renderUpdateState);
// Dört ayrı ilerleme kaynağı tek çizim yoluna bağlanır.
cizi.onProgress?.((event) => setProgress(event?.scope, {
  label: SWITCH_PHASE_LABELS[event?.phase] || NAMES[event?.scope] || "Çalışıyor",
  percent: event?.percent,
  message: event?.message,
  done: event?.done === true,
  failed: Boolean(event?.error),
}));
cizi.onClaudeCodeInstallState?.(adoptInstallState(CLAUDE_CODE, "Claude Code CLI kurulumu", CLAUDE_CODE_INSTALL_PHASE_LABELS));
cizi.onCodexCliInstallState?.(adoptInstallState(CODEX_CLI_PRODUCT, "Codex CLI kurulumu", CODEX_CLI_INSTALL_PHASE_LABELS));
cizi.onCodexDesktopInstallState?.(adoptInstallState(CODEX_DESKTOP_PRODUCT, "ChatGPT Desktop kurulumu", CODEX_DESKTOP_INSTALL_PHASE_LABELS));
cizi.onClaudeProgress?.((progress) => {
  const phase = String(progress?.phase || "");
  if (!phase || phase === "idle") {
    clearProgress(CLAUDE_DESKTOP);
    return;
  }
  setProgress(CLAUDE_DESKTOP, {
    label: CLAUDE_PHASE_LABELS[phase] || "Claude Desktop işlemi",
    percent: Number.isFinite(Number(progress?.details?.percent)) ? Number(progress.details.percent) : null,
    message: progress?.message || "",
    done: phase === "complete",
    failed: phase === "error",
  });
});

if (window.ciziCliUi?.handle && cizi.onCliRequest && cizi.cliReady) {
  cizi.onCliRequest((request) => window.ciziCliUi.handle(request));
  cizi.cliReady();
}

(async function boot() {
  const session = await cizi.getSession();
  if (session.ok && session.data?.loggedIn) await enterDashboard();
  else {
    show("login");
    await refreshUpdateState();
  }
})();
