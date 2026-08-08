// Local, authenticated transport between scripts/cizi-cli.cjs and the
// renderer. This module only transports constrained UI requests; it does not
// know how to login, apply tools, or perform any application action itself.
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { app } = require("electron");

const STATE_FILE_NAME = "cli-bridge.json";
const MAX_REQUEST_BYTES = 64 * 1024;
const RENDERER_TIMEOUT_MS = 15000;
const LONG_RENDERER_TIMEOUT_MS = 5 * 60 * 1000;

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, error: "Response could not be serialized." });
  }
}

class CliBridge {
  constructor({ getWindow, log }) {
    this.getWindow = getWindow;
    this.log = log;
    this.server = null;
    this.statePath = null;
    this.state = null;
    this.rendererSender = null;
    this.pending = new Map();
  }

  async start() {
    if (this.server) return this.state;
    this.statePath = path.join(app.getPath("userData"), STATE_FILE_NAME);
    this.state = {
      version: 1,
      host: "127.0.0.1",
      token: crypto.randomBytes(32).toString("hex"),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };

    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, this.state.host);
    });

    const address = this.server.address();
    this.state.port = typeof address === "object" && address ? address.port : null;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, `${safeJson(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
    this.log.info("cli", `CLI bridge listening on ${this.state.host}:${this.state.port}`);
    return this.state;
  }

  markRendererReady(sender) {
    const win = this.getWindow();
    if (!win || sender !== win.webContents) return;
    this.rendererSender = sender;
    this.log.info("cli", "Renderer UI bridge ready");
  }

  markRendererUnavailable(sender) {
    if (!sender || sender === this.rendererSender) this.rendererSender = null;
  }

  handleRendererResponse(sender, response) {
    const win = this.getWindow();
    if (!win || sender !== win.webContents) return;
    const pending = this.pending.get(response?.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.data);
    else pending.reject(new Error(String(response.error || "Renderer UI action failed.")));
  }

  handleSocket(socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    let closed = false;
    const reply = (payload) => {
      if (closed || socket.destroyed) return;
      socket.write(`${safeJson(payload)}\n`, () => socket.end());
    };
    socket.on("close", () => { closed = true; });
    socket.on("error", () => { closed = true; });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        reply({ ok: false, error: "CLI request is too large." });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = "";
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        reply({ ok: false, error: "CLI request must be valid JSON." });
        return;
      }
      this.dispatch(request).then((data) => reply({ ok: true, data })).catch((error) => {
        this.log.warn("cli", `CLI request failed: ${error.message}`);
        reply({ ok: false, error: error.message || "CLI request failed." });
      });
    });
  }

  async dispatch(request) {
    if (!request || request.token !== this.state?.token) throw new Error("CLI authentication failed.");
    if (request.type === "ping") {
      return { bridge: "ready", pid: process.pid, rendererReady: !!this.rendererSender };
    }
    this.log.info("cli", `Renderer UI request: ${request.type}`, { id: request.id || null });
    return this.requestRenderer(request);
  }

  async requestRenderer(request) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error("Cizi Code window is not available.");
    if (!this.rendererSender || this.rendererSender.isDestroyed()) {
      throw new Error("Cizi Code UI is still loading; retry shortly.");
    }
    const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    const payload = { ...request, requestId };
    return new Promise((resolve, reject) => {
      const timeoutMs = request?.type === "click" && request?.id === "claude-code-cli.install"
        ? LONG_RENDERER_TIMEOUT_MS
        : RENDERER_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Renderer UI action timed out."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        win.webContents.send("cizi:cliRequest", payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CLI bridge stopped."));
    }
    this.pending.clear();
    if (this.server) this.server.close();
    this.server = null;
    if (this.statePath && this.state) {
      try {
        const current = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        if (current.token === this.state.token) fs.rmSync(this.statePath, { force: true });
      } catch {
        // The state file may already be gone after an interrupted shutdown.
      }
    }
    this.state = null;
    this.rendererSender = null;
  }
}

module.exports = { CliBridge, STATE_FILE_NAME };
