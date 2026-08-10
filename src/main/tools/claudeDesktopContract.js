// Pure contract for the Claude Desktop integration. Keeping policy/state
// construction free of Electron, registry and filesystem access makes the
// ON/OFF orchestrator smaller and lets tests prove exactly what Cizi owns.

// 5: the MSIX overlay package was replaced by in-place file branding, so the
// record now stores which files were patched instead of an overlay identity.
const STATE_SCHEMA_VERSION = 5;
const DIRECT_GATEWAY_MODE = "direct-gateway";
const CONFIG_LIBRARY_SURFACE = "config-library";
const CONFIG_KEYS = Object.freeze([
  "inferenceProvider",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayAuthScheme",
  "inferenceGatewayApiKey",
  "inferenceCredentialKind",
  "inferenceCredentialHelper",
  "inferenceCredentialHelperTtlSec",
  "inferenceModels",
  "modelDiscoveryEnabled",
  "disableDeploymentModeChooser",
  "isClaudeCodeForDesktopEnabled",
  "coworkTabEnabled",
]);

function withV1(base) {
  const normalized = String(base || "").trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function claudeGatewayRoot(base) {
  const normalized = String(base || "").trim().replace(/\/+$/, "");
  return normalized.replace(/\/v1$/i, "");
}

function normalizedModels(values) {
  const candidates = [values?.model, ...(Array.isArray(values?.models) ? values.models : [])].filter(Boolean);
  const seen = new Set();
  return candidates.map((value) => {
    const name = typeof value === "string" ? value.trim() : String(value?.name || "").trim();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const tier = typeof value === "object" ? String(value.tier || value.anthropicFamilyTier || "").toLowerCase() : "";
    return { name, ...( ["opus", "sonnet", "haiku"].includes(tier) ? { tier } : {}) };
  }).filter(Boolean);
}

function desktopModels(values) {
  const models = normalizedModels(values);
  return models.length ? [models[0]] : [];
}

function buildPolicyConfig(values, models, resolvedHelperPath) {
  if (!resolvedHelperPath) throw new Error("Claude credential-helper path is required.");
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: claudeGatewayRoot(values.base),
    inferenceGatewayAuthScheme: "bearer",
    inferenceCredentialKind: "helper-script",
    inferenceCredentialHelper: resolvedHelperPath,
    inferenceCredentialHelperTtlSec: "300",
    inferenceModels: JSON.stringify(models),
    modelDiscoveryEnabled: "false",
    disableDeploymentModeChooser: "true",
    isClaudeCodeForDesktopEnabled: "true",
    coworkTabEnabled: "true",
  };
}

function buildConfigLibraryConfig(values, models, resolvedHelperPath) {
  if (!resolvedHelperPath) throw new Error("Claude credential-helper path is required.");
  return {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "helper-script",
    inferenceCredentialHelper: resolvedHelperPath,
    inferenceCredentialHelperTtlSec: 300,
    inferenceCredentialHelperTimeoutSec: 60,
    inferenceGatewayBaseUrl: claudeGatewayRoot(values.base),
    inferenceGatewayAuthScheme: "bearer",
    modelDiscoveryEnabled: false,
    inferenceModels: models.map((model) => ({ name: model.name, ...(model.tier ? { anthropicFamilyTier: model.tier } : {}) })),
  };
}

function assertDirectGatewayConfig(config) {
  const forbidden = ["bootstrapEnabled", "bootstrapUrl", "bootstrapOidc", "deploymentDisplayName"];
  if (forbidden.some((key) => Object.hasOwn(config || {}, key))) {
    throw new Error("Direct Claude gateway config must not contain bootstrap fields.");
  }
  return config;
}

function normalizedGateway(value) {
  return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function validCiziModels(value) {
  try {
    const models = JSON.parse(String(value || ""));
    return Array.isArray(models) && models.length > 0
      && models.every((item) => item && typeof item === "object" && typeof item.name === "string" && item.name.trim());
  } catch { return false; }
}

function buildMainState(main) {
  return {
    packageFullName: main.packageFullName,
    packageFamilyName: main.packageFamilyName,
    publisher: main.publisher,
    version: main.version,
    installLocation: main.installLocation,
    appUserModelId: main.appUserModelId,
    installKind: main.installKind,
    executable: main.executable,
    asar: main.asar,
  };
}

// What the switch has to remember about branding: which Claude build was
// patched and how many files it touched. Nothing here is used to decide whether
// the patch is still in place - that decision is always made by hashing the
// files on disk, so a stale record can never make the switch report success over
// an updated Claude.
function brandingState(result) {
  if (!result || result.status !== "active" || !result.package) return null;
  return {
    mode: result.mode || "file-branding",
    packageFullName: result.package.packageFullName,
    version: result.package.version,
    installKind: result.package.installKind || "msix",
    files: Number(result.files) || 0,
  };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  DIRECT_GATEWAY_MODE,
  CONFIG_LIBRARY_SURFACE,
  CONFIG_KEYS,
  withV1,
  claudeGatewayRoot,
  normalizedModels,
  desktopModels,
  buildPolicyConfig,
  buildConfigLibraryConfig,
  assertDirectGatewayConfig,
  normalizedGateway,
  validCiziModels,
  buildMainState,
  brandingState,
};
