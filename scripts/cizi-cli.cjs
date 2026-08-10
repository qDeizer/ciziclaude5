#!/usr/bin/env node
// Cizi Code CLI. It starts/attaches to the desktop app, reads the renderer
// screen, and asks the renderer to perform constrained DOM-level actions.
// No command here calls login, tool, or gateway services directly.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP_DIR = path.resolve(__dirname, "..");
const STATE_PATH = process.env.CIZI_CLI_STATE || path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Cizi Code",
  "cli-bridge.json"
);
const CONNECT_TIMEOUT_MS = 2500;
const START_TIMEOUT_MS = 15000;
const LONG_ACTION_TIMEOUT_MS = 10 * 60 * 1000;

function maskSecrets(value) {
  if (typeof value === "string") {
    return value
      .replace(/sk-cizi-[A-Za-z0-9_-]+/gi, "sk-cizi-••••")
      .replace(/(api[_ -]?key|token|secret)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2••••");
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item)]));
  }
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(maskSecrets(value), null, 2)}\n`);
}

function usage() {
  return {
    ok: true,
    data: {
      commands: {
        screen: "Read visible renderer text and interactive controls.",
        list: "List visible renderer buttons, switches, lists, and inputs.",
        click: "click <id> — dispatch one real DOM click on a visible control.",
        switch: "switch <id> on|off — click a visible switch only when its state differs.",
        select: "select <id> <value> — change a visible select and dispatch change.",
        fill: "fill <id> <value> — fill a visible input and dispatch input/change.",
        press: "press <id> <key> — dispatch a keyboard action to a visible control.",
      },
      examples: [
        "cizi-cli screen",
        "cizi-cli list",
        "cizi-cli click login-btn",
        "cizi-cli switch tool.claude.switch on",
        "cizi-cli switch tool.codex.switch on",
        "cizi-cli click tool.reconcile-all",
        "cizi-cli click codex-desktop.install",
        "cizi-cli click codex-desktop.purge",
        "cizi-cli click claude-desktop.install",
        "cizi-cli click claude-desktop.purge",
        "cizi-cli select period-select 7d",
      ],
      guarantee: "Mutating commands resolve and trigger the renderer UI control; they do not call application services directly.",
    },
  };
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!state?.host || !state?.port || !state?.token) return null;
    return state;
  } catch {
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(state, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: state.host, port: state.port });
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    // Installs and root removals run an official third-party installer or the
    // Windows package manager, so they get the long timeout.
    const LONG_ACTIONS = [
      "claude-code-cli.install", "claude-code-cli.purge",
      // Claude Desktop is the longest of them all: a quarter-gigabyte download
      // followed by an elevated package registration.
      "claude-desktop.install", "claude-desktop.purge",
      "codex-cli.install", "codex-cli.purge",
      "codex-desktop.install", "codex-desktop.purge",
      "tool.reconcile-all",
      "tool.claude.switch",
    ];
    const timeoutMs = ["click", "switch"].includes(payload?.type) && LONG_ACTIONS.includes(payload?.id)
      ? LONG_ACTION_TIMEOUT_MS
      : CONNECT_TIMEOUT_MS;
    socket.setTimeout(timeoutMs, () => finish(new Error("Cizi Code CLI bridge timed out.")));
    socket.setEncoding("utf8");
    socket.on("error", (error) => finish(new Error(`Cizi Code app is not reachable: ${error.message}`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        finish(null, JSON.parse(line));
      } catch {
        finish(new Error("Cizi Code returned invalid CLI JSON."));
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...payload, token: state.token })}\n`);
    });
  });
}

function launchApp() {
  if (process.env.CIZI_CLI_NO_START === "1") return;
  let electronPath = process.env.CIZI_ELECTRON;
  if (!electronPath) {
    try { electronPath = require("electron"); } catch { electronPath = "electron"; }
  }
  const child = spawn(electronPath, [APP_DIR, "--cizi-cli"], {
    cwd: APP_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function connectToApp() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let launched = false;
  let lastError = null;
  while (Date.now() < deadline) {
    const state = readState();
    if (state) {
      try {
        const ping = await request(state, { type: "ping" });
        if (ping?.ok && ping.data?.rendererReady) return state;
        lastError = new Error(ping?.error || "Cizi Code UI is still loading.");
      } catch (error) {
        lastError = error;
      }
    }
    if (!launched) {
      launchApp();
      launched = true;
    }
    await wait(250);
  }
  throw lastError || new Error("Cizi Code app did not start the CLI bridge.");
}

function parseArgs(argv) {
  const args = argv.slice();
  if (args[0] === "--json") args.shift();
  const command = args.shift() || "screen";
  if (command === "help" || command === "--help" || command === "-h") return { command: "help", args };
  if (command === "inspect") return { command: "screen", args };
  return { command, args };
}

function commandPayload(command, args) {
  switch (command) {
    case "screen": return { type: "snapshot" };
    case "list": return { type: "snapshot" };
    case "click": return { type: "click", id: args[0] };
    case "switch": return { type: "switch", id: args[0], value: args[1] };
    case "select": return { type: "select", id: args[0], value: args[1] };
    case "fill": return { type: "fill", id: args[0], value: args.slice(1).join(" ") };
    case "press": return { type: "press", id: args[0], key: args[1] };
    default: throw new Error(`Unknown CLI command '${command}'. Use help for commands.`);
  }
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    output(usage());
    return;
  }
  const payload = commandPayload(command, args);
  if (["click", "switch", "select", "fill", "press"].includes(command) && !payload.id) {
    throw new Error(`The ${command} command requires a renderer control id.`);
  }
  if (command === "switch" && !payload.value) throw new Error("The switch command requires on or off.");
  if (command === "select" && payload.value == null) throw new Error("The select command requires a value.");
  if (command === "press" && !payload.key) throw new Error("The press command requires a key.");

  const state = await connectToApp();
  const response = await request(state, payload);
  if (command === "list" && response?.ok && response.data) {
    response.data = {
      view: response.data.view,
      text: response.data.text,
      interactive: response.data.interactive,
      capturedAt: response.data.capturedAt,
    };
  }
  output(response);
  if (!response?.ok) process.exitCode = 1;
}

main().catch((error) => {
  output({ ok: false, error: maskSecrets(error?.message || String(error)) });
  process.exitCode = 1;
});
