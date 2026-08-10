// Pure contract for the Claude Desktop integration. Keeping policy/state
// construction free of Electron, registry and filesystem access makes the
// ON/OFF orchestrator smaller and lets tests prove exactly what Cizi owns.

// 6: model entries now carry 1M/default metadata and the managed surface owns
// the Chat and advanced-analysis feature switches as well as the gateway.
const { capabilityFor } = require("./modelCapabilities");

const STATE_SCHEMA_VERSION = 6;
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
  "chatTabEnabled",
  "chatAdvancedFileAnalysisEnabled",
  "isDesktopExtensionEnabled",
  "autoModeEnabled",
  "toolSearchEnabled",
  "disableBundledSkillsAndWorkflows",
  "disableClaudeAiSignIn",
  "disableClaudeDeepLinks",
  "isClaudeCodeForDesktopEnabled",
  "coworkTabEnabled",
  "secureVmFeaturesEnabled",
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
  const profiles = new Map((values?.modelProfiles || []).map((profile) => [String(profile?.name || ""), profile]));
  const seen = new Set();
  const seenTiers = new Set();
  return candidates.map((value, index) => {
    const name = typeof value === "string" ? value.trim() : String(value?.name || "").trim();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const explicitTier = typeof value === "object" ? String(value.tier || value.anthropicFamilyTier || "").toLowerCase() : "";
    const inferredTier = ["opus", "sonnet", "haiku", "fable"].find((candidate) =>
      new RegExp(`(^|[^a-z0-9])${candidate}([^a-z0-9]|$)`, "i").test(name));
    const tier = explicitTier || inferredTier || "";
    const profile = profiles.get(name) || capabilityFor(value, "claude-code");
    const familyDefault = index === 0 || (tier && !seenTiers.has(tier));
    if (tier) seenTiers.add(tier);
    return {
      name,
      labelOverride: name,
      ...(["opus", "sonnet", "haiku", "fable"].includes(tier) ? { tier } : {}),
      supports1m: profile.supports1m,
      prefer1m: profile.supports1m,
      isFamilyDefault: Boolean(familyDefault),
    };
  }).filter(Boolean);
}

function inferenceModel(model) {
  return {
    name: model.name,
    labelOverride: model.labelOverride || model.name,
    ...(model.tier ? { anthropicFamilyTier: model.tier } : {}),
    // Schema-5 state records predate these fields. Missing values migrate to
    // the new 1M/default contract during the next verified repair.
    supports1m: model.supports1m !== false,
    prefer1m: model.prefer1m !== false,
    isFamilyDefault: model.isFamilyDefault !== false,
  };
}

function desktopModels(values) {
  return normalizedModels(values);
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
    inferenceModels: JSON.stringify(models.map(inferenceModel)),
    modelDiscoveryEnabled: "false",
    disableDeploymentModeChooser: "true",
    chatTabEnabled: "true",
    chatAdvancedFileAnalysisEnabled: "true",
    isDesktopExtensionEnabled: "true",
    autoModeEnabled: "true",
    toolSearchEnabled: "true",
    disableBundledSkillsAndWorkflows: "false",
    disableClaudeAiSignIn: "false",
    disableClaudeDeepLinks: "false",
    isClaudeCodeForDesktopEnabled: "true",
    coworkTabEnabled: "true",
    secureVmFeaturesEnabled: "true",
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
    inferenceModels: models.map(inferenceModel),
    disableDeploymentModeChooser: true,
    chatTabEnabled: true,
    chatAdvancedFileAnalysisEnabled: true,
    isDesktopExtensionEnabled: true,
    autoModeEnabled: true,
    toolSearchEnabled: true,
    disableBundledSkillsAndWorkflows: false,
    disableClaudeAiSignIn: false,
    disableClaudeDeepLinks: false,
    isClaudeCodeForDesktopEnabled: true,
    coworkTabEnabled: true,
    secureVmFeaturesEnabled: true,
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
