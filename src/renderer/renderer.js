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
  [CODEX_CLI_PRODUCT]: "Codex CLI",
  [CODEX_DESKTOP_PRODUCT]: "ChatGPT Desktop",
};

let TEMPLATES = null;
let ME = null;
let CLAUDE_STATE = { cli: { installed: false }, desktop: { installed: false } };
let CODEX_STATE = { cli: { installed: false }, desktop: { installed: false }, config: { applied: false } };
let LAST_REFRESH = null;

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
  $("quota-pct").textContent = unlimited ? "∞" : `%${percent}`;
  const fill = $("quota-fill");
  fill.style.width = `${percent}%`;
  fill.className = `meter-fill${!unlimited && percent <= 10 ? " bad" : !unlimited && percent <= 30 ? " warn" : ""}`;
  $("quota-meter").title = unlimited
    ? "Planınız şu an sınırsız."
    : `Kullanım hakkınızın %${percent}'i kaldı.`;

  const limit = $("limit-msg");
  limit.textContent = me.isLimitReached ? (me.limitMessage || "Cizi Code kullanım sınırınıza ulaşıldı.") : "";
  limit.classList.toggle("hidden", !me.isLimitReached);
}

function renderLastRefresh() {
  $("usage-updated").textContent = LAST_REFRESH
    ? `Son yenileme ${LAST_REFRESH.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "Henüz yenilenmedi";
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
  // Eğilim çubuklarının hangi alandan geldiği sunucu sürümüne göre değişiyor.
  // Hangi alanın okunduğu kaydedilir, böylece "grafik boş" durumunun sebebi
  // tahmin edilmek zorunda kalmaz.
  clog("debug", "Kullanım eğilimi çizildi", {
    period,
    points: series.length,
    positive: series.filter((point) => chartValue(point) > 0).length,
    sampleKeys: series.length ? Object.keys(series[0]).slice(0, 8) : [],
  });
  drawChart(series);
}

function chartValue(point) {
  const value = Number(point?.percent ?? point?.usagePercent ?? point?.remainingPercent
    ?? point?.tokens ?? point?.totalLimitTokens ?? point?.totalTokens ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function drawChart(data) {
  const canvas = $("usage-chart");
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const height = 150;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const values = data.map(chartValue);
  const soft = token("--ink-soft");
  if (!data.length || values.every((value) => value <= 0)) {
    ctx.fillStyle = soft;
    ctx.font = `12px ${token("--font") || "sans-serif"}`;
    ctx.textAlign = "center";
    ctx.fillText("Bu dönem için henüz kullanım verisi yok.", width / 2, height / 2);
    return;
  }

  const pad = { left: 2, right: 2, top: 8, bottom: 18 };
  const max = Math.max(1, ...values);
  const barWidth = (width - pad.left - pad.right) / data.length;
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, token("--pine"));
  gradient.addColorStop(1, token("--teal"));

  // Kullanımı olmayan gün de bir gündür: sıfır değerler 1 piksellik bir iz
  // bırakır. Hiç çizmemek, tek günlük kullanımı olan bir hesapta grafiği bozuk
  // gibi gösteriyordu.
  values.forEach((value, index) => {
    const scaled = (value / max) * (height - pad.top - pad.bottom);
    const barHeight = Math.max(scaled, 1);
    const x = pad.left + index * barWidth;
    const y = height - pad.bottom - barHeight;
    ctx.fillStyle = value > 0 ? gradient : token("--line");
    const w = Math.max(1, barWidth - 3);
    const r = Math.min(3, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + barHeight, r);
    ctx.arcTo(x + w, y + barHeight, x, y + barHeight, r);
    ctx.arcTo(x, y + barHeight, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  });

  ctx.fillStyle = soft;
  ctx.textAlign = "left";
  ctx.font = `10px ${token("--mono") || "monospace"}`;
  const step = Math.max(1, Math.ceil(data.length / 6));
  data.forEach((point, index) => {
    if (index % step !== 0 && index !== data.length - 1) return;
    ctx.fillText(String(point.label || ""), pad.left + index * barWidth, height - 5);
  });
}

// -------------------------------------------------------------- durum okuma

async function loadTools() {
  const [tools, claude, codex] = await Promise.all([cizi.listTools(), cizi.getClaudeState(), cizi.getCodexState()]);
  CLAUDE_STATE = claude?.ok ? (claude.data || CLAUDE_STATE) : { cli: { installed: false }, desktop: { installed: false } };
  CODEX_STATE = codex?.ok ? (codex.data || CODEX_STATE) : CODEX_STATE;
  TEMPLATES = { combos: Array.isArray(ME?.combos) ? ME.combos : [] };
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
  openMenu.menu.hidden = true;
  openMenu.toggle.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.root.contains(event.target)) closeMenu();
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
document.addEventListener("visibilitychange", () => { if (document.hidden) closeMenu(); });

// Bölünmüş düğme: ana eylem + açılır ok. Ana düğme CLI köprüsünün bildiği
// kimliği taşır, böylece "cizi-cli click <id>" davranışı değişmez.
function splitButton({ main, menuAlign = "left", onOpen }) {
  const root = document.createElement("div");
  root.className = "split";
  const mainButton = button({ ...main, className: `${main.className || "ghost tiny-btn"} split-main` });
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "split-toggle";
  toggle.textContent = "▾";
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
    menu.hidden = false;
    menu.classList.remove("menu-up");
    toggle.setAttribute("aria-expanded", "true");
    openMenu = { root, menu, toggle };
    await onOpen(menu);
    // Alt kenara yakın bir kartta menü pencerenin dışına taşar; o zaman yukarı
    // doğru açılır. Ölçüm içerik yazıldıktan sonra yapılır, yoksa yükseklik
    // henüz bilinmez.
    menu.style.maxHeight = "";
    const below = menu.getBoundingClientRect();
    if (below.bottom > window.innerHeight - 8) {
      menu.classList.add("menu-up");
      // Yukarı açılan menü de üstten taşabilir; kalan boşluğa sığdırılır ve
      // gerisi kendi içinde kaydırılır. Aksi halde ilk satır okunamıyor.
      const above = menu.getBoundingClientRect();
      if (above.top < 8) menu.style.maxHeight = `${Math.max(140, above.bottom - 12)}px`;
    }
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

  const heading = document.createElement("div");
  heading.className = "menu-note";
  heading.style.borderTop = "none";
  heading.style.marginTop = "0";
  heading.textContent = "Nelerin silineceğini seçin. Tıkladığınız kategori saydamlaşır — o silinmez.";
  menu.appendChild(heading);

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
    const hint = document.createElement("span");
    hint.className = "cat-hint";
    row.append(name, size, hint);

    const paint = () => {
      const on = selection.has(category.id) && !category.locked;
      row.classList.toggle("off", !on && !category.locked);
      row.classList.toggle("locked", Boolean(category.locked));
      size.textContent = category.locked
        ? "korunur"
        : `${category.bytesApproximate ? "≈ " : ""}${formatBytes(category.bytes)}`;
      const count = category.paths.length + category.actions.length;
      hint.textContent = category.locked
        ? category.lockReason || "Başka bir ürün bu dosyaları kullanıyor."
        : `${category.hint} · ${count} öğe`;
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

  const head = document.createElement("div");
  head.className = "card-head";
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
  const list = $("tools-list");
  closeMenu();
  list.innerHTML = "";

  const models = TEMPLATES?.combos || [];
  // Sunucunun her model profiline yazdığı desktopClients alanı tek erişim
  // kaynağıdır. Model adı, aile anahtar kelimesi veya yerel allow-list yoktur.
  const offered = accessibleToolIds(models);

  if (!offered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = models.map(modelName).filter(Boolean).length
      ? "Sunucu bu profil için erişilebilir bir yerel araç bildirmedi."
      : "Bu anahtar için yerel araç bulunmuyor.";
    list.appendChild(empty);
    return;
  }

  const byId = new Map((statuses || []).map((status) => [status.id, status]));
  for (const switchId of offered) {
    const status = byId.get(switchId);
    if (!status) continue;
    list.appendChild(CARDS[switchId](status, modelsForTool(models, switchId)));
  }

  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Eşleşen yerel araç bulunamadı.";
    list.appendChild(empty);
  }
  // Kart yeniden çizildiğinde süren bir iş varsa şeridi geri boya.
  for (const scope of PROGRESS.keys()) paintLane(scope);
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

$("logout-btn").addEventListener("click", async () => {
  clog("info", "Çıkış yapıldı");
  await cizi.logout();
  show("login");
});

$("period-select").addEventListener("change", (event) => loadUsage(event.target.value));

$("usage-refresh").addEventListener("click", async () => {
  const target = $("usage-refresh");
  const original = target.textContent;
  target.disabled = true;
  target.textContent = "Yenileniyor...";
  try {
    await refreshAll();
    toast("Bilgiler yenilendi.", "good");
  } finally {
    target.textContent = original;
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
  window.__ciziChartTimer = setTimeout(() => loadUsage($("period-select").value), 200);
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
