// Renderer-owned UI automation for the local CLI bridge.
// The CLI never calls application services directly: every mutating command
// resolves a visible control and dispatches the same DOM event as a user.
(function installCliUi() {
  const CONTROL_SELECTOR = [
    "[data-cli-id]",
    "button",
    "input",
    "select",
    "textarea",
    '[role="button"]',
    '[role="switch"]',
    '[role="checkbox"]',
  ].join(",");

  function normalize(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function maskSecrets(value) {
    return String(value || "")
      .replace(/sk-cizi-[A-Za-z0-9_-]+/gi, "sk-cizi-••••")
      .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••");
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.hidden || element.closest(".hidden")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function cliId(element) {
    return normalize(element?.dataset?.cliId || element?.id || "");
  }

  function controlElements() {
    const seen = new Set();
    return Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter((element) => {
      const id = cliId(element);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function labelFor(element) {
    const explicit = element.getAttribute("aria-label") || element.getAttribute("title") || element.dataset.cliLabel;
    if (explicit) return normalize(explicit);
    const row = element.closest(".tool-row");
    const rowName = row?.querySelector(".tool-name")?.textContent;
    if (rowName) return normalize(rowName);
    const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    if (label) return normalize(label.textContent);
    if (element.tagName === "SELECT") return normalize(element.previousElementSibling?.textContent || element.id);
    return normalize(element.textContent || element.placeholder || element.name || element.id);
  }

  function controlKind(element) {
    if (element.matches('input[type="checkbox"], [role="switch"]')) return "switch";
    if (element.matches('input[type="radio"], [role="checkbox"]')) return "checkbox";
    if (element.matches("select")) return "list";
    if (element.matches("textarea")) return "textarea";
    if (element.matches("input")) return "input";
    if (element.matches('button, [role="button"]')) return "button";
    return "control";
  }

  function describe(element) {
    const kind = controlKind(element);
    const entry = {
      id: cliId(element),
      kind,
      label: labelFor(element),
      enabled: !element.disabled,
      visible: isVisible(element),
    };
    if (kind === "switch" || kind === "checkbox") entry.checked = !!element.checked;
    if (kind === "input" || kind === "textarea") {
      entry.inputType = element.type || "text";
      entry.placeholder = normalize(element.placeholder);
      entry.value = element.type === "password" || /key|token|secret/i.test(`${element.id} ${element.name}`)
        ? (element.value ? "••••" : "")
        : String(element.value || "");
    }
    if (kind === "list") {
      entry.value = String(element.value || "");
      entry.options = Array.from(element.options || []).map((option) => ({
        value: String(option.value),
        label: normalize(option.textContent),
        selected: !!option.selected,
      }));
    }
    return entry;
  }

  function snapshot() {
    const loginVisible = isVisible(document.getElementById("login-view"));
    const dashboardVisible = isVisible(document.getElementById("dash-view"));
    return {
      view: dashboardVisible ? "dashboard" : loginVisible ? "login" : "unknown",
      text: maskSecrets(normalize(document.body?.innerText || document.body?.textContent || "")),
      interactive: controlElements().filter(isVisible).map(describe),
      capturedAt: new Date().toISOString(),
    };
  }

  function resolve(id) {
    const wanted = normalize(id);
    if (!wanted) throw new Error("CLI control id is required.");
    const element = controlElements().find((candidate) => cliId(candidate) === wanted);
    if (!element) throw new Error(`UI control '${wanted}' was not found.`);
    if (!isVisible(element)) throw new Error(`UI control '${wanted}' is not visible.`);
    if (element.disabled) throw new Error(`UI control '${wanted}' is disabled.`);
    return element;
  }

  function waitForPaint() {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  async function waitForLongClick(element) {
    const timeoutMs = Number(element.dataset.cliAwaitTimeout || 5 * 60 * 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Install success replaces the old control; failure re-enables it.
      if (!element.isConnected || !element.disabled) return;
      await waitForPaint();
    }
    throw new Error(`UI control '${cliId(element)}' did not finish in time.`);
  }

  async function click(request) {
    const element = resolve(request.id);
    const kind = controlKind(element);
    const isClickable = element.matches('button, input[type="checkbox"], input[type="radio"], [role="button"]');
    if (!isClickable || !["button", "switch", "checkbox"].includes(kind)) {
      throw new Error(`UI control '${request.id}' is not clickable; use its list or input command.`);
    }
    element.focus({ preventScroll: true });
    element.click();
    if (element.dataset.cliAwait === "long") await waitForLongClick(element);
    await waitForPaint();
    return { action: "click", id: cliId(element), snapshot: snapshot() };
  }

  async function setSwitch(request) {
    const element = resolve(request.id);
    if (controlKind(element) !== "switch") throw new Error(`UI control '${request.id}' is not a switch.`);
    const raw = String(request.value == null ? "" : request.value).toLowerCase();
    if (!["on", "off", "true", "false", "1", "0"].includes(raw)) {
      throw new Error("Switch value must be on or off.");
    }
    const desired = ["on", "true", "1"].includes(raw);
    let clicked = false;
    if (!!element.checked !== desired) {
      element.focus({ preventScroll: true });
      element.click();
      clicked = true;
      await waitForPaint();
    }
    return { action: "switch", id: cliId(element), value: !!element.checked, clicked, snapshot: snapshot() };
  }

  async function select(request) {
    const element = resolve(request.id);
    if (controlKind(element) !== "list") throw new Error(`UI control '${request.id}' is not a list.`);
    const value = String(request.value == null ? "" : request.value);
    if (!Array.from(element.options || []).some((option) => String(option.value) === value)) {
      throw new Error(`List option '${value}' is not available for '${request.id}'.`);
    }
    element.focus({ preventScroll: true });
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForPaint();
    return { action: "select", id: cliId(element), value: element.value, snapshot: snapshot() };
  }

  async function fill(request) {
    const element = resolve(request.id);
    if (!["input", "textarea"].includes(controlKind(element))) throw new Error(`UI control '${request.id}' is not editable.`);
    const value = String(request.value == null ? "" : request.value);
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.focus({ preventScroll: true });
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForPaint();
    return { action: "fill", id: cliId(element), valueProvided: value.length > 0, snapshot: snapshot() };
  }

  async function press(request) {
    const element = resolve(request.id);
    const key = normalize(request.key);
    if (!key) throw new Error("A keyboard key is required.");
    element.focus({ preventScroll: true });
    for (const type of ["keydown", "keyup"]) {
      element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    }
    await waitForPaint();
    return { action: "press", id: cliId(element), key, snapshot: snapshot() };
  }

  async function handle(request) {
    switch (String(request?.type || "snapshot")) {
      case "snapshot":
      case "screen":
        return snapshot();
      case "click":
        return click(request);
      case "switch":
        return setSwitch(request);
      case "select":
        return select(request);
      case "fill":
        return fill(request);
      case "press":
        return press(request);
      default:
        throw new Error(`Unknown renderer UI action '${request.type}'.`);
    }
  }

  window.ciziCliUi = { handle, snapshot };
})();
