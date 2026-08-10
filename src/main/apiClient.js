// Thin HTTP client for the Cizi Code gateway. Uses the customer's API key.
// Only holder-scoped endpoints are called from the desktop app.
let log;
try {
  log = require("./logger");
} catch {
  log = { info() {}, error() {} };
}

const DEFAULT_BASE_URL = process.env.CIZI_ACCOUNT_BASE_URL || process.env.CIZI_GATEWAY_BASE_URL || "https://cizicode.me";
const TOOL_BASE_URL = process.env.CIZI_TOOL_BASE_URL || process.env.CIZI_GATEWAY_BASE_URL || "https://lotpik.cizicode.me";
const BRAND_ERROR = "Cizi Code could not complete the request.";
const TEMPORARY_ERROR = "Cizi Code is temporarily unavailable.";
const LIMIT_ERROR = "Your Cizi Code usage limit has been reached.";
const AUTH_ERROR = "This API key could not be verified.";

const PROVIDER_LEAK_RE = /(command\s*code|commandcode|deepseek|qwen|anthropic|claude|openai|gemini|google|xai|grok|mistral|provider|upstream|gateway|backend|model endpoint|\/v1\/models)/i;

function normalizeBase(baseUrl) {
  let b = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (b && !/^https?:\/\//i.test(b)) {
    if (b.startsWith("localhost") || b.startsWith("127.0.0.1") || b.startsWith("192.168.") || b.startsWith("10.")) {
      b = `http://${b}`;
    } else {
      b = `https://${b}`;
    }
  }
  return b;
}

function sanitizeErrorMessage(message, status) {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();

  if (status === 401 || status === 403 || /invalid.*key|unauthorized|forbidden|api key/.test(lower)) {
    return AUTH_ERROR;
  }

  if (status === 429 || /limit|quota|usage allowance|insufficient/.test(lower)) {
    return LIMIT_ERROR;
  }

  if (status === 408 || status === 409 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504) {
    return TEMPORARY_ERROR;
  }

  if (!raw || PROVIDER_LEAK_RE.test(raw) || raw.includes("{") || raw.includes("}")) {
    return BRAND_ERROR;
  }

  return raw;
}

async function call(baseUrl, apiKey, pathName, { method = "GET", query } = {}) {
  const base = normalizeBase(baseUrl || DEFAULT_BASE_URL);
  let url = `${base}${pathName}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }

  const t0 = Date.now();
  log.info("api", `${method} ${pathName}${query ? "?" + new URLSearchParams(query).toString() : ""}`);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON responses are handled below with a generic message.
  }

  const ms = Date.now() - t0;
  if (res.ok) {
    log.info("api", `${res.status} ${pathName} (${ms}ms)`);
  } else {
    log.error("api", `${res.status} ${pathName} (${ms}ms)`);
  }

  if (!res.ok) {
    const rawMessage = typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : typeof body?.error?.message === "string"
          ? body.error.message
          : `Request failed (${res.status})`;
    const message = sanitizeErrorMessage(rawMessage, res.status);
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    err.rawMessage = rawMessage;
    throw err;
  }

  return body;
}

async function getMe(baseUrl, apiKey) {
  return call(baseUrl, apiKey, "/api/me");
}

async function getUsage(baseUrl, apiKey, period = "30d") {
  return call(baseUrl, apiKey, "/api/usage/me", { query: { period } });
}

async function getTemplates(baseUrl, apiKey) {
  return call(baseUrl, apiKey, "/api/cli-tools/templates");
}

// The gateway's own model list. `/api/me` only names the models the key may
// call; this endpoint is what the tools themselves read, and it is the only
// place that says which models actually have a `[1m]` variant. Claude Desktop
// documents the same rule: an inferenceModels entry must use the exact id
// returned here. Callers treat a failure as "no extra information" rather than
// an error, so a gateway that does not expose it still configures.
async function getGatewayModels(baseUrl, apiKey) {
  const body = await call(baseUrl, apiKey, "/v1/models");
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((entry) => String(entry?.id || "").trim()).filter(Boolean);
}

module.exports = {
  DEFAULT_BASE_URL,
  TOOL_BASE_URL,
  getMe,
  getUsage,
  getTemplates,
  getGatewayModels,
  normalizeBase,
  sanitizeErrorMessage,
};
