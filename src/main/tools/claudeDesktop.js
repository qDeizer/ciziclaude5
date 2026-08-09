const lifecycle = require("./claudeLifecycle");
const runtimeHost = require("./claudeDesktopRuntimeHost");
const packageIdentity = require("./claudePackageIdentity");
const overlay = require("./claudeDesktopTranslation");
const legacy = require("./claudeDesktopLegacy");
const reconcileTask = require("./claudeReconcileTask");
const integrationLock = require("./integrationLock");
const log = require("../logger");
const credential = require("./claudeDesktopCredential");
const stateStore = require("./claudeDesktopStateStore");
const policy = require("./claudeDesktopPolicy");
const configLibrary = require("./claudeDesktopConfigLibrary");
const { createSurfaceManager } = require("./claudeDesktopSurface");
const {
  STATE_SCHEMA_VERSION,
  CONFIG_KEYS,
  withV1,
  claudeGatewayRoot,
  desktopModels,
  buildPolicyConfig,
  buildConfigLibraryConfig,
  assertDirectGatewayConfig,
  CONFIG_LIBRARY_SURFACE,
  buildMainState,
  overlayState,
} = require("./claudeDesktopContract");

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createDefaultAdapters() {
  return {
    features: {
      // Gateway configuration stays bootstrap-free. Shortcut sessions use
      // verified runtime console branding; the signed overlay remains an
      // optional legacy/direct-mode fallback.
      translation: true,
      configurationSurface: CONFIG_LIBRARY_SURFACE,
    },
    runtime: {
      getStatus: () => lifecycle.getRuntimeStatus("claude-desktop"),
      launchOriginal: (appUserModelId) => lifecycle.launchAppUserModelId(appUserModelId),
      launchChat: (appUserModelId) => lifecycle.launchClaudeNewChat(appUserModelId),
      launchCiziRuntime: (appUserModelId) => runtimeHost.launchCiziRuntime(appUserModelId),
    },
    policy: {
      machineBlock: policy.machinePolicyBlock,
      capture: policy.capturePolicySnapshot,
      restore: policy.restorePolicySnapshot,
      apply: policy.applyPolicyConfig,
      verify: policy.verifyPolicyConfig,
      cleanupOwnedOrphans: policy.cleanupOwnedPolicyOrphans,
    },
    configLibrary: {
      capture: configLibrary.capture,
      restore: configLibrary.restore,
      matches: configLibrary.matches,
      apply: configLibrary.apply,
      verify: configLibrary.verify,
    },
    helper: {
      capture: credential.captureOwnedFiles,
      restore: credential.restoreOwnedFiles,
      ensure: credential.ensureCredentialHelper,
      provision: credential.provisionCredential,
      isCurrent: credential.credentialHelperIsCurrent,
      preflight: credential.preflightCredentialHelper,
      path: credential.helperPath,
    },
    overlay,
    legacy,
    reconcileTask,
    operationLock: {
      acquire: (operation) => integrationLock.acquire("claude-desktop", operation),
    },
    state: {
      read: stateStore.readState,
      write: stateStore.writeState,
      readBaseline: stateStore.readBaseline,
      writeBaseline: stateStore.writeBaseline,
      remove: stateStore.remove,
      hasBaseline: stateStore.hasBaseline,
    },
    identity: packageIdentity,
    now: () => new Date().toISOString(),
  };
}

function mergeAdapters(overrides = {}) {
  const defaults = createDefaultAdapters();
  return {
    ...defaults,
    ...overrides,
    features: { ...defaults.features, ...(overrides.features || {}) },
    runtime: { ...defaults.runtime, ...(overrides.runtime || {}) },
    policy: { ...defaults.policy, ...(overrides.policy || {}) },
    configLibrary: { ...defaults.configLibrary, ...(overrides.configLibrary || {}) },
    helper: { ...defaults.helper, ...(overrides.helper || {}) },
    reconcileTask: { ...defaults.reconcileTask, ...(overrides.reconcileTask || {}) },
    operationLock: { ...defaults.operationLock, ...(overrides.operationLock || {}) },
    state: { ...defaults.state, ...(overrides.state || {}) },
    identity: { ...defaults.identity, ...(overrides.identity || {}) },
  };
}

function createClaudeDesktopBackend(overrides = {}) {
  const adapters = mergeAdapters(overrides);
  const surface = createSurfaceManager(adapters);
  let operation = null;

  async function exclusive(name, task) {
    if (operation) throw codedError("TOOL_OPERATION_IN_PROGRESS", `Claude Desktop ${operation} is already in progress.`);
    operation = name;
    let release = null;
    try {
      release = await adapters.operationLock.acquire(name);
      return await task();
    } finally {
      try { release?.(); } finally { operation = null; }
    }
  }

  // The integration record can exist and still be unreadable (a corrupt file, or
  // secure storage that can no longer decrypt what an earlier session wrote).
  // That is not the same as "off": the machine may well still be configured, so
  // every caller has to decide deliberately what to do about it.
  function readStateRecord() {
    try { return { state: adapters.state.read(), unreadable: false }; }
    catch (error) {
      if (error?.code !== "CLAUDE_STATE_UNREADABLE") throw error;
      return { state: null, unreadable: true };
    }
  }

  // Only turning the switch off may act on an unreadable record, because a
  // restore puts the captured original back. Configuring on top of one would
  // capture the already-configured machine as if it were the user's original.
  function refuseUnreadableState(unreadable) {
    if (!unreadable) return;
    throw codedError(
      "CLAUDE_STATE_UNREADABLE",
      "Claude Desktop's integration record is unreadable. Turn the switch off to restore the saved original settings.",
    );
  }

  async function requireMainRuntime() {
    const runtime = await adapters.runtime.getStatus();
    if (runtime.detectionError) throw codedError("CLAUDE_DESKTOP_DETECTION_FAILED", "Cizi Code could not verify Claude Desktop.");
    if (!runtime.installed) throw codedError("INSTALL_REQUIRED", "Claude Desktop is not installed.");
    if (runtime.processScanOk === false) throw codedError("PROCESS_SCAN_FAILED", "Cizi Code could not safely inspect Claude Desktop processes.");
    return { runtime, main: adapters.identity.mainPackageIdentity(runtime) };
  }

  async function configure(values, models, main, onProgress, previousState = null, {
    runtimeBranding = false,
  } = {}) {
    onProgress("configuring", "Configuring the original Claude Desktop package...");
    const resolvedHelper = adapters.helper.ensure();
    const configurationSurface = previousState?.configurationSurface
      || adapters.features.configurationSurface;
    const config = assertDirectGatewayConfig(configurationSurface === CONFIG_LIBRARY_SURFACE
      ? buildConfigLibraryConfig(values, models, resolvedHelper)
      : buildPolicyConfig(values, models, resolvedHelper));
    if (configurationSurface === CONFIG_LIBRARY_SURFACE) {
      adapters.configLibrary.apply(config);
      if (!adapters.configLibrary.verify(config)) {
        throw codedError("CLAUDE_CONFIG_LIBRARY_VERIFY_FAILED", "Claude Desktop gateway settings could not be verified.");
      }
    } else {
      await adapters.policy.apply(config);
      if (!await adapters.policy.verify(config)) {
        throw codedError("CLAUDE_POLICY_VERIFY_FAILED", "Claude Desktop gateway settings could not be verified.");
      }
    }
    onProgress("authenticating", "Preparing Claude Desktop authentication...");
    await adapters.helper.provision(resolvedHelper, values.apiKey);
    await adapters.helper.preflight(resolvedHelper);
    let translation = runtimeBranding ? {
      status: "active",
      installed: false,
      package: null,
      mode: "runtime-devtools",
      message: "Cizi Code branding will be injected at runtime when Claude starts.",
    } : {
      status: "inactive",
      installed: false,
      package: null,
      mode: "none",
      message: "Direct gateway mode leaves the Claude interface unchanged.",
    };
    if (!runtimeBranding && adapters.features.translation) {
      onProgress("translating", "Checking the optional Turkish interface package for this Claude version...");
      translation = await adapters.overlay.ensureForMain(main, { state: previousState });
      if (translation?.status !== "active" || !translation?.package) {
        throw codedError(
          "CLAUDE_TRANSLATION_UNAVAILABLE",
          "A verified Turkish interface package is not available for this Claude Desktop version yet.",
        );
      }
    }
    return { config, translation };
  }

  async function applyUnlocked(values, onProgress = () => {}, { sessionMode = false } = {}) {
    const block = await adapters.policy.machineBlock();
    if (block.blocked) throw codedError("MACHINE_POLICY_BLOCK", "Claude Desktop is managed by a machine policy. Cizi Code will not override it.");
    const { runtime, main } = await requireMainRuntime();
    if (runtime.running) throw codedError("PROCESS_RUNNING", "Claude Desktop must be closed before changing this setting.");
    const models = desktopModels(values);
    if (!models.length) {
      throw codedError("CLAUDE_DESKTOP_MODEL_REQUIRED", "Select an available model before enabling Claude Desktop.");
    }

    // Shortcut sessions are deliberately transient and never create, update,
    // inspect, or remove the persistent update-reconcile task. This keeps the
    // launcher independent of stale development/legacy task definitions.
    const reconcileTaskBefore = sessionMode
      ? { exists: false, current: true, taskName: "Cizi Code Claude Reconcile" }
      : await adapters.reconcileTask.getStatus();
    if (!sessionMode && reconcileTaskBefore.exists && !reconcileTaskBefore.current) {
      throw codedError("CLAUDE_RECONCILE_TASK_CONFLICT", "A different scheduled task is using Cizi Code's Claude update-monitor name.");
    }
    const { state: previousState, unreadable } = readStateRecord();
    refuseUnreadableState(unreadable);
    const wasActive = previousState?.active === true;
    if (!wasActive) await adapters.policy.cleanupOwnedOrphans(values.base);
    if (adapters.features.configurationSurface === CONFIG_LIBRARY_SURFACE) {
      const userPolicy = await adapters.policy.capture();
      const conflicting = Object.values(userPolicy?.values || {}).some((value) => value?.existed);
      if (conflicting) {
        throw codedError(
          "USER_POLICY_BLOCK",
          "Claude Desktop already has a user policy. Cizi Code did not override it.",
        );
      }
    }
    let baseline = adapters.state.readBaseline();
    if (wasActive && !baseline) throw codedError("REPAIR_REQUIRED", "Claude Desktop's original settings backup is missing; repair is required.");
    if (!wasActive) {
      // A completed OFF removes the baseline along with the state, so a baseline
      // that is still here means the previous OFF never finished. Capturing a
      // new one would record the already-configured machine as the user's
      // original settings and lose them for good; the switch has to be turned
      // off first, which now restores from the baseline that is still stored.
      if (baseline) {
        throw codedError(
          "CLAUDE_DESKTOP_DISCONNECT_PENDING",
          "Claude Desktop still has saved original settings from an unfinished disconnect. Turn the switch off once to restore them, then connect again.",
        );
      }
      baseline = { ...(await surface.capture()), takenAt: adapters.now() };
      adapters.state.writeBaseline(baseline);
    }
    const rollbackSurface = wasActive ? await surface.capture() : baseline;
    let translation = null;
    let reconcileTaskResult = null;
    try {
      ({ translation } = await configure(
        values,
        models,
        main,
        onProgress,
        previousState,
        { runtimeBranding: sessionMode },
      ));
      const after = await adapters.runtime.getStatus();
      adapters.identity.assertMainPackagePreserved(main, after, "apply");
      const nextState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        backend: "original-package",
        active: true,
        sessionMode,
        phase: "on",
        baseUrl: claudeGatewayRoot(values.base),
        models,
        configurationSurface: adapters.features.configurationSurface,
        brandingMode: translation.mode
          || (translation.status === "active" ? "version-matched-overlay" : "none"),
        mainPackage: buildMainState(main),
        translationStatus: translation.status,
        translationMessage: translation.message || null,
        overlay: overlayState(translation),
        activatedAt: previousState?.activatedAt || adapters.now(),
        lastVerifiedAt: adapters.now(),
      };
      adapters.state.write(nextState);
      reconcileTaskResult = sessionMode
        ? { current: true, removed: false, skipped: "transient-session" }
        : await adapters.reconcileTask.ensure();
      try {
        adapters.legacy.cleanupLegacy({ baseline });
      } catch (migrationError) {
        adapters.state.write({ ...nextState, phase: "degraded", lastErrorCode: "CLAUDE_LEGACY_MIGRATION_FAILED" });
        throw codedError("CLAUDE_LEGACY_MIGRATION_FAILED", "Claude Desktop was connected, but old Cizi launcher files could not be removed.");
      }
      let launched = true;
      let launchErrorCode = null;
      try {
        if (sessionMode) await adapters.runtime.launchCiziRuntime(main.appUserModelId);
        else await adapters.runtime.launchChat(main.appUserModelId);
      } catch (launchError) {
        // A shortcut session is useful only when both gateway configuration
        // and runtime branding were applied. Let the outer transaction restore
        // the captured surface instead of leaving a partially started session.
        if (sessionMode) throw launchError;
        launched = false;
        launchErrorCode = String(launchError?.code || "CLAUDE_DESKTOP_LAUNCH_FAILED");
        adapters.state.write({ ...nextState, lastLaunchErrorCode: launchErrorCode });
      }
      return {
        ok: true,
        applied: true,
        configured: true,
        hasBackup: true,
        backend: "original-package",
        appUserModelId: main.appUserModelId,
        launched,
        ...(launchErrorCode ? { launchErrorCode } : {}),
        automaticUpdateReconcile: sessionMode ? false : reconcileTaskResult.current !== false,
        sessionMode,
        translationStatus: translation.status,
        translationMessage: translation.message || null,
        brandingStatus: translation.status === "active" ? "active" : "inactive",
      };
    } catch (error) {
      // A migration error happens after the original backend has committed;
      // keep it active/degraded so a UI retry can finish idempotent cleanup.
      if (error.code === "CLAUDE_LEGACY_MIGRATION_FAILED") throw error;
      let rollbackError = null;
      try {
        await surface.restore(rollbackSurface);
        if (!sessionMode && !reconcileTaskBefore.exists) await adapters.reconcileTask.remove();
        if (translation?.installedByOperation && (!wasActive || !previousState?.overlay)) {
          await adapters.overlay.removeForState({ overlay: overlayState(translation) });
        }
      } catch (failure) { rollbackError = failure; }
      if (wasActive) {
        adapters.state.write({
          ...previousState,
          active: true,
          phase: rollbackError ? "repair-required" : "degraded",
          lastErrorCode: String(error.code || "CLAUDE_DESKTOP_APPLY_FAILED"),
          ...(rollbackError ? { rollbackErrorCode: String(rollbackError.code || "ROLLBACK_FAILED") } : {}),
        });
      } else if (!rollbackError) adapters.state.remove();
      else adapters.state.write({
        schemaVersion: STATE_SCHEMA_VERSION,
        backend: "original-package",
        active: false,
        phase: "repair-required",
        lastErrorCode: String(error.code || "CLAUDE_DESKTOP_APPLY_FAILED"),
        rollbackErrorCode: String(rollbackError.code || "ROLLBACK_FAILED"),
      });
      throw error;
    }
  }

  async function revertUnlocked() {
    const { state, unreadable } = readStateRecord();
    const baseline = adapters.state.readBaseline();
    // The baseline is what says there is something to put back. A state record
    // that is missing, inactive or unreadable is not proof the machine is clean:
    // the record can be lost while the configuration it describes is still
    // applied, and refusing to restore there is what leaves a switch that reads
    // "off" over a still-configured Claude Desktop.
    if (!state?.active && !baseline) {
      await adapters.reconcileTask.remove();
      adapters.legacy.cleanupLegacy({ baseline });
      return { ok: true, applied: false, restored: false, alreadyOff: true };
    }
    if (!baseline) throw codedError("REPAIR_REQUIRED", "Claude Desktop's original settings backup is missing; repair is required.");
    const runtime = await adapters.runtime.getStatus();
    if (runtime.processScanOk === false) throw codedError("PROCESS_SCAN_FAILED", "Cizi Code could not safely inspect Claude Desktop processes.");
    if (runtime.running) throw codedError("PROCESS_RUNNING", "Claude Desktop must be closed before restoring its previous configuration.");
    const main = runtime.installed ? adapters.identity.mainPackageIdentity(runtime) : null;
    const rollbackSurface = await surface.capture();
    let overlayRemoved = false;
    let reconcileTaskRemoved = false;
    try {
      const taskRemoval = await adapters.reconcileTask.remove();
      reconcileTaskRemoved = !!taskRemoval?.removed;
      await surface.restoreAndVerify(baseline);
      if (state?.overlay) {
        const removal = await adapters.overlay.removeForState(state);
        overlayRemoved = !!removal?.removed;
      }
      if (main) {
        const after = await adapters.runtime.getStatus();
        adapters.identity.assertMainPackagePreserved(main, after, "revert");
      }
      adapters.legacy.cleanupLegacy({ baseline });
      adapters.state.write({ schemaVersion: STATE_SCHEMA_VERSION, backend: "original-package", active: false, phase: "off" });
      adapters.state.remove();
      return { ok: true, applied: false, restored: true, installed: !!runtime.installed };
    } catch (error) {
      let rollbackError = null;
      try {
        await surface.restore(rollbackSurface);
        if (overlayRemoved && main && state?.translationStatus === "active") await adapters.overlay.ensureForMain(main);
        if (reconcileTaskRemoved && !state?.sessionMode) await adapters.reconcileTask.ensure();
      } catch (failure) { rollbackError = failure; }
      // A record that could not be read must not be rebuilt from guesses; the
      // baseline is still on disk, so a later attempt can restore from it.
      adapters.state.write({
        ...(state || { schemaVersion: STATE_SCHEMA_VERSION, backend: "original-package" }),
        active: true,
        phase: rollbackError || unreadable ? "repair-required" : "degraded",
        lastErrorCode: String(error.code || "CLAUDE_DESKTOP_REVERT_FAILED"),
        ...(rollbackError ? { rollbackErrorCode: String(rollbackError.code || "ROLLBACK_FAILED") } : {}),
      });
      throw error;
    }
  }

  async function policyConfigured(state) {
    if (!state?.active || !adapters.helper.isCurrent()) return false;
    if (state.configurationSurface === CONFIG_LIBRARY_SURFACE) {
      return adapters.configLibrary.verify(
        buildConfigLibraryConfig({ base: state.baseUrl }, state.models || [], adapters.helper.path()),
      );
    }
    return adapters.policy.verify(buildPolicyConfig({ base: state.baseUrl }, state.models || [], adapters.helper.path()));
  }

  async function getStatus(expectedBase) {
    const runtime = await adapters.runtime.getStatus();
    const { state, unreadable } = readStateRecord();
    const hasBaseline = adapters.state.hasBaseline();
    // Orphans are only cleared when nothing is applied and nothing is left to
    // restore. Both surfaces are swept, so an entry Cizi Code owns can never
    // outlive its integration on one of them while the other is kept tidy.
    if (!state?.active && !unreadable && !hasBaseline && !operation) {
      await adapters.policy.cleanupOwnedOrphans(expectedBase);
      if (adapters.features.configurationSurface === CONFIG_LIBRARY_SURFACE
          && typeof adapters.configLibrary.cleanupOwned === "function") {
        adapters.configLibrary.cleanupOwned();
      }
    }
    const block = await adapters.policy.machineBlock();
    // A baseline on disk means the user's original settings are still parked
    // somewhere else, so there is something the switch has to be able to put
    // back - whatever the state record does or does not say. A completed OFF
    // deletes the baseline with the state, so this can never read "on" over a
    // machine that is genuinely clean.
    const applied = state?.active === true || hasBaseline;
    const configured = applied && await policyConfigured(state);
    let automaticUpdateReconcile = !applied || state?.sessionMode === true;
    let reconcileTaskStatusError = null;
    if (applied && !state?.sessionMode) {
      try { automaticUpdateReconcile = await adapters.reconcileTask.isCurrent(); }
      catch (error) { reconcileTaskStatusError = error; automaticUpdateReconcile = false; }
    }
    let translationStatus = applied ? (state?.translationStatus || "pending") : "inactive";
    let overlayInstalled = false;
    let overlayStatusError = null;
    if (state?.brandingMode === "version-matched-overlay" || !applied) {
      try {
        const currentOverlay = await adapters.overlay.queryInstalledOverlay();
        overlayInstalled = !!currentOverlay;
        if (applied && state?.translationStatus === "active") {
          const matches = currentOverlay
            && currentOverlay.packageFullName === state.overlay?.packageFullName
            && currentOverlay.publisher === state.overlay?.publisher
            && currentOverlay.version === runtime.Version;
          if (!matches) translationStatus = "error";
        }
      } catch (error) {
        overlayStatusError = error;
        if (applied) translationStatus = "error";
      }
    }
    const packageChanged = !!(applied && runtime.installed && state?.mainPackage
      && (state.mainPackage.packageFullName !== runtime.PackageFullName
        || state.mainPackage.version !== runtime.Version));
    const needsRefresh = !!(applied && runtime.installed
      && (!configured
        || (!state?.sessionMode && !automaticUpdateReconcile)
        || packageChanged
        || translationStatus === "error"
        || unreadable
        || !state
        || state.phase === "degraded"));
    const detectionState = runtime.detectionError ? "unknown" : "known";
    const processState = runtime.processScanOk === false ? "unknown" : "known";
    const blocked = !!block.blocked || detectionState === "unknown" || processState === "unknown";
    return {
      id: "claude-desktop",
      name: "Claude Desktop",
      apiType: "anthropic",
      installed: !!runtime.installed,
      running: !!runtime.running,
      processCount: runtime.processCount || 0,
      version: runtime.Version || null,
      applied,
      sessionMode: applied && state?.sessionMode === true,
      configured,
      hasBackup: adapters.state.hasBaseline(),
      needsRefresh,
      automaticUpdateReconcile,
      backend: "original-package",
      appUserModelId: packageIdentity.CLAUDE_MAIN_APP_ID,
      translationStatus,
      translationMessage: applied ? (state?.translationMessage || (translationStatus === "error" ? "The Turkish interface package needs repair." : null)) : null,
      brandingStatus: applied
        && ["version-matched-overlay", "runtime-devtools"].includes(state?.brandingMode)
        ? "active" : "inactive",
      overlayInstalled,
      phase: unreadable || (applied && !state) ? "repair-required" : (state?.phase || (applied ? "on" : "off")),
      detectionState,
      processState,
      errorCode: detectionState === "unknown" ? "CLAUDE_DESKTOP_DETECTION_FAILED"
        : processState === "unknown" ? "PROCESS_SCAN_FAILED"
          : unreadable ? "CLAUDE_STATE_UNREADABLE"
          : reconcileTaskStatusError ? String(reconcileTaskStatusError.code || "CLAUDE_RECONCILE_TASK_STATUS_FAILED")
          : overlayStatusError ? "CLAUDE_OVERLAY_STATUS_FAILED" : null,
      blocked,
      blockReason: block.blocked ? "Machine policy"
        : detectionState === "unknown" ? "Cizi Code could not verify Claude Desktop. Try again."
          : processState === "unknown" ? "Claude Desktop process status could not be verified safely. Try again." : null,
      expectedBase: expectedBase ? withV1(expectedBase) : undefined,
    };
  }

  async function reconcileUnlocked(onProgress = () => {}) {
    const { state, unreadable } = readStateRecord();
    refuseUnreadableState(unreadable);
    const baseline = adapters.state.readBaseline();
    if (!state?.active) {
      await adapters.policy.cleanupOwnedOrphans(state?.baseUrl);
      await adapters.reconcileTask.remove();
      const runtime = await adapters.runtime.getStatus();
      if (runtime.installed && !runtime.running && runtime.processScanOk !== false
          && typeof adapters.overlay.removeOwnedOrphanForMain === "function") {
        const main = adapters.identity.mainPackageIdentity(runtime);
        await adapters.overlay.removeOwnedOrphanForMain(main);
      }
      const cleaned = adapters.legacy.cleanupLegacy({ baseline });
      return { reconciled: false, reason: "inactive", legacyCleanup: cleaned };
    }
    const { runtime, main } = await requireMainRuntime();
    if (runtime.running) return { reconciled: false, reason: "running", pending: true };
    if (!baseline) throw codedError("REPAIR_REQUIRED", "Claude Desktop's original settings backup is missing; repair is required.");
    const reconcileTaskBefore = await adapters.reconcileTask.getStatus();
    if (reconcileTaskBefore.exists && !reconcileTaskBefore.current) {
      throw codedError("CLAUDE_RECONCILE_TASK_CONFLICT", "A different scheduled task is using Cizi Code's Claude update-monitor name.");
    }
    const rollbackSurface = await surface.capture();
    let reconcileTaskResult = null;
    try {
      const values = { base: state.baseUrl };
      const { translation } = await configure(
        values,
        state.models || [],
        main,
        onProgress,
        state,
        { runtimeBranding: state.sessionMode === true || state.brandingMode === "runtime-devtools" },
      );
      const after = await adapters.runtime.getStatus();
      adapters.identity.assertMainPackagePreserved(main, after, "reconcile");
      const nextState = {
        ...state,
        schemaVersion: STATE_SCHEMA_VERSION,
        backend: "original-package",
        active: true,
        phase: "on",
        mainPackage: buildMainState(main),
        translationStatus: translation.status,
        translationMessage: translation.message || null,
        brandingMode: translation.mode
          || (translation.status === "active" ? "version-matched-overlay" : "none"),
        overlay: overlayState(translation),
        lastVerifiedAt: adapters.now(),
        lastErrorCode: undefined,
        rollbackErrorCode: undefined,
      };
      adapters.state.write(nextState);
      reconcileTaskResult = await adapters.reconcileTask.ensure();
      adapters.legacy.cleanupLegacy({ baseline });
      return {
        reconciled: true,
        version: main.version,
        translationStatus: translation.status,
        automaticUpdateReconcile: reconcileTaskResult.current !== false,
      };
    } catch (error) {
      let rollbackError = null;
      try {
        await surface.restore(rollbackSurface);
        if (!reconcileTaskBefore.exists) await adapters.reconcileTask.remove();
      } catch (failure) { rollbackError = failure; }
      adapters.state.write({
        ...state,
        active: true,
        phase: rollbackError ? "repair-required" : "degraded",
        lastErrorCode: String(error.code || "CLAUDE_DESKTOP_RECONCILE_FAILED"),
        ...(rollbackError ? { rollbackErrorCode: String(rollbackError.code || "ROLLBACK_FAILED") } : {}),
      });
      return { reconciled: false, reason: "refresh-failed", pending: true, errorCode: String(error.code || "CLAUDE_DESKTOP_RECONCILE_FAILED") };
    }
  }

  async function launchUnlocked(onProgress = () => {}) {
    const { state, unreadable } = readStateRecord();
    // Launching an unreadable integration would start Claude against settings
    // nothing can describe any more; the switch has to be cycled first.
    refuseUnreadableState(unreadable);
    const runtime = await adapters.runtime.getStatus();
    if (!runtime.installed) throw codedError("INSTALL_REQUIRED", "Claude Desktop is not installed.");
    if (state?.active && !runtime.running) await reconcileUnlocked(onProgress);
    const latest = readStateRecord().state || state;
    if (latest?.active && latest.brandingMode === "runtime-devtools") {
      await adapters.runtime.launchCiziRuntime(packageIdentity.CLAUDE_MAIN_APP_ID);
    } else if (latest?.active) await adapters.runtime.launchChat(packageIdentity.CLAUDE_MAIN_APP_ID);
    else await adapters.runtime.launchOriginal(packageIdentity.CLAUDE_MAIN_APP_ID);
    return {
      launched: true,
      backend: "original-package",
      appUserModelId: packageIdentity.CLAUDE_MAIN_APP_ID,
      launchTarget: latest?.brandingMode === "runtime-devtools"
        ? "runtime-branded-application"
        : latest?.active ? "new-chat" : "application",
      translationStatus: latest?.active ? (latest.translationStatus || "pending") : "inactive",
    };
  }

  return {
    apply: (values, onProgress) => exclusive("connect", () => applyUnlocked(values, onProgress)),
    beginSession: (values, onProgress) => exclusive(
      "session-start",
      () => applyUnlocked(values, onProgress, { sessionMode: true }),
    ),
    revert: () => exclusive("disconnect", revertUnlocked),
    reconcile: (onProgress) => exclusive("repair", () => reconcileUnlocked(onProgress)),
    launch: (onProgress) => exclusive("launch", () => launchUnlocked(onProgress)),
    getStatus,
    readState: adapters.state.read,
  };
}

const backend = createClaudeDesktopBackend();

module.exports = {
  ...backend,
  STATE_SCHEMA_VERSION,
  CONFIG_KEYS,
  withV1,
  capturePolicySnapshot: policy.capturePolicySnapshot,
  restorePolicySnapshot: policy.restorePolicySnapshot,
  policySnapshotsEqual: policy.policySnapshotsEqual,
  buildPolicyConfig,
  cleanupOwnedPolicyOrphans: policy.cleanupOwnedPolicyOrphans,
  captureOwnedFiles: credential.captureOwnedFiles,
  restoreOwnedFiles: credential.restoreOwnedFiles,
  ownedFilesEqual: credential.ownedFilesEqual,
  bundledCredentialHelperPath: credential.bundledCredentialHelperPath,
  createClaudeDesktopBackend,
};
