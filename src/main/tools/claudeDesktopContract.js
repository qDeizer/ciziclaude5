// Pure contract for the Claude Desktop integration. Keeping policy/state
// construction free of Electron, registry and filesystem access makes the
// ON/OFF orchestrator smaller and lets tests prove exactly what Cizi owns.
//
// Every key below is a real Claude Desktop managed-config key, checked against
// the app's own config schema. That check removed four keys an earlier version
// wrote:
//
//   disableBundledSkillsAndWorkflows -> no such key (the real one is
//                                       `disableBundledSkills`)
//   disableClaudeAiSignIn            -> no such key; that setting *is*
//                                       `disableDeploymentModeChooser`
//   disableClaudeDeepLinks           -> no such key (the real one is
//                                       `disableDeepLinkRegistration`)
//   secureVmFeaturesEnabled          -> first-party deployments only, not
//                                       valid on a gateway deployment
//
// Two more real keys are deliberately left alone rather than forced on:
// `toolSearchEnabled` makes sessions send experimental anthropic-beta headers
// and fields that a strict gateway answers with HTTP 400, and `autoModeEnabled`
// needs a model with safety-classifier support. Both default to off in the app;
// Cizi does not override that.

// 7: the managed surface writes only verified keys, and model entries assert
// 1M support per model instead of for everything.
const {
  capabilityFor,
  tierFor,
  CLAUDE_TIERS,
  claudeDesktopShowsEffort,
} = require("../../renderer/modelCapabilities");

const STATE_SCHEMA_VERSION = 7;
const DIRECT_GATEWAY_MODE = "direct-gateway";
const CONFIG_LIBRARY_SURFACE = "config-library";

// The surfaces Cizi turns on. Anything not listed keeps Claude Desktop's own
// default, which is the only behaviour we can promise still works.
const MANAGED_FEATURES = Object.freeze({
  chatTabEnabled: true,
  chatAdvancedFileAnalysisEnabled: true,
  coworkTabEnabled: true,
  isClaudeCodeForDesktopEnabled: true,
  isDesktopExtensionEnabled: true,
});

const CONNECTION_KEYS = Object.freeze([
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
]);

// Keys earlier Cizi builds wrote. They are still captured and still cleaned up
// so an upgrade removes them from the user's machine instead of leaving unknown
// values behind in the Claude policy key.
const RETIRED_KEYS = Object.freeze([
  "autoModeEnabled",
  "toolSearchEnabled",
  "secureVmFeaturesEnabled",
  "disableBundledSkillsAndWorkflows",
  "disableClaudeAiSignIn",
  "disableClaudeDeepLinks",
]);

const CONFIG_KEYS = Object.freeze([
  ...CONNECTION_KEYS,
  ...Object.keys(MANAGED_FEATURES),
  ...RETIRED_KEYS,
]);

function withV1(base) {
  const normalized = String(base || "").trim().replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function claudeGatewayRoot(base) {
  const normalized = String(base || "").trim().replace(/\/+$/, "");
  return normalized.replace(/\/v1$/i, "");
}

// Claude Desktop's model list. Per its own schema:
//   name                - must be the exact id the gateway's /v1/models returns
//   anthropicFamilyTier - lets bare aliases ("opus") resolve to this entry
//   isFamilyDefault     - picks the winner when several entries share a tier,
//                         and is only meaningful alongside a tier
//   supports1m          - a capability assertion about the deployment
//   prefer1m            - only affects the default (first) entry, and only when
//                         supports1m is set
//   labelOverride       - display only, for ids the picker cannot name itself
function normalizedModels(values) {
  const candidates = [values?.model, ...(Array.isArray(values?.models) ? values.models : [])].filter(Boolean);
  const profiles = new Map((values?.modelProfiles || []).map((profile) => [String(profile?.name || ""), profile]));
  const seen = new Set();
  const seenTiers = new Set();
  return candidates.map((value, index) => {
    const name = typeof value === "string" ? value.trim() : String(value?.name || "").trim();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const profile = profiles.get(name) || capabilityFor(value, "claude-code");
    const tier = CLAUDE_TIERS.includes(profile.tier) ? profile.tier : tierFor(value);
    const isFamilyDefault = Boolean(tier) && !seenTiers.has(tier);
    if (tier) seenTiers.add(tier);
    // Claude Desktop attaches the effort/thinking picker only to model ids it
    // recognises, and there is no config key to override that. When the gateway
    // publishes such an id for this model, that is the one the entry has to
    // carry; the branded name then moves to labelOverride so the picker still
    // reads "Opus 5". Never invented - only ever an id the gateway serves.
    const effortName = profile.desktopEffortName && profile.desktopEffortName !== name
      ? profile.desktopEffortName
      : null;
    return {
      name: effortName || name,
      ...(effortName ? { labelOverride: name } : {}),
      ...(CLAUDE_TIERS.includes(tier) ? { tier, isFamilyDefault } : {}),
      supports1m: profile.supports1m === true,
      // The picker only honours prefer1m on the default entry, so asserting it
      // anywhere else is noise in the config the user has to read.
      prefer1m: index === 0 && profile.supports1m === true,
      showsEffortPicker: claudeDesktopShowsEffort(effortName || name),
    };
  }).filter(Boolean);
}

function inferenceModel(model) {
  const tier = CLAUDE_TIERS.includes(model.tier)
    ? model.tier
    : CLAUDE_TIERS.includes(model.anthropicFamilyTier) ? model.anthropicFamilyTier : "";
  return {
    name: model.name,
    ...(model.labelOverride && model.labelOverride !== model.name ? { labelOverride: model.labelOverride } : {}),
    ...(tier ? { anthropicFamilyTier: tier, isFamilyDefault: model.isFamilyDefault === true } : {}),
    supports1m: model.supports1m === true,
    ...(model.prefer1m === true ? { prefer1m: true } : {}),
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
    ...Object.fromEntries(Object.entries(MANAGED_FEATURES).map(([key, on]) => [key, String(on)])),
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
    ...MANAGED_FEATURES,
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
  CONNECTION_KEYS,
  MANAGED_FEATURES,
  RETIRED_KEYS,
  withV1,
  claudeGatewayRoot,
  normalizedModels,
  desktopModels,
  inferenceModel,
  buildPolicyConfig,
  buildConfigLibraryConfig,
  assertDirectGatewayConfig,
  normalizedGateway,
  validCiziModels,
  buildMainState,
  brandingState,
};
