// Ownership boundary for Anthropic's main Claude Desktop package.
//
// Cizi Code may configure policies and install/remove its own overlay package,
// but it never owns, removes, unregisters, or replaces the main Claude MSIX.
// Keep this module dependency-free so lifecycle code and tests share the same
// definition of the package that must survive Connect, Disconnect, and Cizi
// uninstallation.

const CLAUDE_MAIN_PACKAGE_NAME = "Claude";
const CLAUDE_MAIN_PACKAGE_FAMILY = "Claude_pzs8sxrjxfjjc";
const CLAUDE_MAIN_APP_ID = `${CLAUDE_MAIN_PACKAGE_FAMILY}!Claude`;

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mainPackageIdentity(status) {
  if (!status?.installed) return null;
  const packageFullName = safeString(status.PackageFullName);
  const packageFamilyName = safeString(status.PackageFamilyName);
  const publisher = safeString(status.Publisher);
  const version = safeString(status.Version);
  const installLocation = safeString(status.InstallLocation);
  const installKind = safeString(status.InstallKind || status.installKind) || "msix";
  const validMsix = installKind === "msix" && packageFamilyName === CLAUDE_MAIN_PACKAGE_FAMILY;
  const validSquirrel = installKind === "squirrel" && packageFamilyName === "AnthropicClaude"
    && publisher === "Anthropic PBC" && safeString(status.asar || status.Asar)
    && safeString(status.executable || status.Executable);
  if (!packageFullName || (!validMsix && !validSquirrel) || !publisher || !version || !installLocation) {
    const error = new Error("Claude Desktop package identity could not be verified. No changes were made.");
    error.code = "CLAUDE_MAIN_PACKAGE_IDENTITY_INVALID";
    throw error;
  }
  return Object.freeze({
    name: CLAUDE_MAIN_PACKAGE_NAME,
    packageFullName,
    packageFamilyName,
    publisher,
    version,
    installLocation,
    appUserModelId: CLAUDE_MAIN_APP_ID,
    installKind,
    executable: safeString(status.executable || status.Executable),
    asar: safeString(status.asar || status.Asar),
  });
}

function sameMainPackage(before, after) {
  if (!before || !after) return before === after;
  return before.packageFullName === after.packageFullName
    && before.packageFamilyName === after.packageFamilyName
    && before.publisher === after.publisher
    && before.version === after.version
    && before.installLocation === after.installLocation
    && before.appUserModelId === after.appUserModelId
    && before.installKind === after.installKind
    && before.executable === after.executable
    && before.asar === after.asar;
}

function assertMainPackagePreserved(before, afterStatus, operation) {
  if (!before) return null;
  const after = mainPackageIdentity(afterStatus);
  if (!sameMainPackage(before, after)) {
    const error = new Error("Claude Desktop changed while Cizi Code was updating its integration. The main package was not modified further.");
    error.code = "CLAUDE_MAIN_PACKAGE_CHANGED";
    error.operation = safeString(operation) || "unknown";
    throw error;
  }
  return after;
}

function isMainClaudePackage(candidate) {
  const family = safeString(candidate?.packageFamilyName || candidate?.PackageFamilyName);
  const fullName = safeString(candidate?.packageFullName || candidate?.PackageFullName);
  return family === CLAUDE_MAIN_PACKAGE_FAMILY
    || new RegExp(`^${CLAUDE_MAIN_PACKAGE_NAME}_[^_]+_[^_]+__pzs8sxrjxfjjc$`, "i").test(fullName);
}

function assertOverlayRemovalAllowed(candidate) {
  if (!candidate || typeof candidate !== "object" || isMainClaudePackage(candidate)) {
    const error = new Error("Cizi Code will not remove the main Claude Desktop package.");
    error.code = "CLAUDE_MAIN_PACKAGE_REMOVAL_BLOCKED";
    throw error;
  }
  const packageFullName = safeString(candidate.packageFullName || candidate.PackageFullName);
  if (!packageFullName) {
    const error = new Error("The Cizi overlay package identity is missing.");
    error.code = "CLAUDE_OVERLAY_PACKAGE_IDENTITY_INVALID";
    throw error;
  }
  return packageFullName;
}

async function removeOverlayPackage(candidate, removePackageFn) {
  const packageFullName = assertOverlayRemovalAllowed(candidate);
  if (typeof removePackageFn !== "function") {
    const error = new Error("The Cizi overlay removal adapter is unavailable.");
    error.code = "CLAUDE_OVERLAY_REMOVAL_UNAVAILABLE";
    throw error;
  }
  await removePackageFn(packageFullName);
  return { removed: true, packageFullName };
}

module.exports = {
  CLAUDE_MAIN_PACKAGE_NAME,
  CLAUDE_MAIN_PACKAGE_FAMILY,
  CLAUDE_MAIN_APP_ID,
  mainPackageIdentity,
  sameMainPackage,
  assertMainPackagePreserved,
  isMainClaudePackage,
  assertOverlayRemovalAllowed,
  removeOverlayPackage,
};
