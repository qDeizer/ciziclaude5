const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const lifecycle = require("./claudeLifecycle");
const credential = require("./claudeDesktopCredential");
const {
  CONFIG_KEYS,
  withV1,
  normalizedGateway,
  validCiziModels,
} = require("./claudeDesktopContract");

const execFileAsync = promisify(execFile);
const POLICY_KEY = "HKCU\\SOFTWARE\\Policies\\Claude";
const MACHINE_POLICY_KEY = "HKLM\\SOFTWARE\\Policies\\Claude";
const MACHINE_POLICIES_PARENT = "HKLM\\SOFTWARE\\Policies";
const REGISTRY_TYPES = new Set([
  "REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD",
  "REG_MULTI_SZ", "REG_BINARY", "REG_NONE",
]);

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function registryValueNames(output) {
  const names = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s+(REG_[A-Z_]+)(?:\s+.*)?$/i);
    if (match && REGISTRY_TYPES.has(match[2].toUpperCase())) names.push(match[1].trim());
  }
  return names;
}

async function machinePolicyBlock({ execFileFn = execFileAsync } = {}) {
  try {
    const result = await execFileFn("reg.exe", ["query", MACHINE_POLICY_KEY], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 64 * 1024,
    });
    const allowed = new Set(["disableautoupdates", "autoupdaterenforcementhours"]);
    const conflicting = registryValueNames(result?.stdout || result)
      .filter((name) => !allowed.has(String(name).toLowerCase()));
    return conflicting.length ? { blocked: true, keys: conflicting } : { blocked: false };
  } catch (error) {
    // reg.exe returns exit code 1 for a missing key. Confirm that its parent
    // is readable before treating this as "no machine policy"; any other
    // failure remains fail-closed.
    if (Number(error?.code) === 1) {
      try {
        await execFileFn("reg.exe", ["query", MACHINE_POLICIES_PARENT], {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 64 * 1024,
        });
        return { blocked: false };
      } catch { /* fail closed below */ }
    }
    return { blocked: true, keys: [], error: error.message || "Machine policy could not be read." };
  }
}

function emptyManagedPolicy(keyExisted) {
  return {
    keyExisted: !!keyExisted,
    values: Object.fromEntries(CONFIG_KEYS.map((name) => [name, { existed: false }])),
  };
}

async function capturePolicySnapshotPowerShell(runPowerShellFn) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$names=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CIZI_REG_NAMES))|ConvertFrom-Json",
    "$root=[Microsoft.Win32.Registry]::CurrentUser",
    "$key=$root.OpenSubKey('SOFTWARE\\Policies\\Claude',$false)",
    "$keyExisted=$null -ne $key",
    "$rows=@()",
    "try{foreach($name in @($names)){",
    "$actualName=if($null -ne $key){@($key.GetValueNames())|Where-Object{[string]::Equals([string]$_,[string]$name,[StringComparison]::OrdinalIgnoreCase)}|Select-Object -First 1}else{$null}",
    "if($null -eq $actualName){$rows+=[pscustomobject]@{name=[string]$name;existed=$false};continue}",
    "$kind=$key.GetValueKind([string]$actualName).ToString()",
    "$value=$key.GetValue([string]$actualName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "switch($kind){",
    "'String'{$type='REG_SZ';$encoding='string';$data=[string]$value}",
    "'ExpandString'{$type='REG_EXPAND_SZ';$encoding='string';$data=[string]$value}",
    "'DWord'{$type='REG_DWORD';$encoding='number';$data=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$value),0).ToString()}",
    "'QWord'{$type='REG_QWORD';$encoding='number';$data=[BitConverter]::ToUInt64([BitConverter]::GetBytes([long]$value),0).ToString()}",
    "'MultiString'{$type='REG_MULTI_SZ';$encoding='string-array';$data=@([string[]]$value)}",
    "'Binary'{$type='REG_BINARY';$encoding='base64';$data=[Convert]::ToBase64String([byte[]]$value)}",
    "'None'{$type='REG_NONE';$encoding='base64';$data=[Convert]::ToBase64String([byte[]]$value)}",
    "default{throw \"Unsupported registry value kind: $kind\"}",
    "}",
    "$rows+=[pscustomobject]@{name=[string]$name;registryName=[string]$actualName;existed=$true;type=$type;encoding=$encoding;data=$data}",
    "}}finally{if($null -ne $key){$key.Dispose()}}",
    "[pscustomobject]@{keyExisted=$keyExisted;values=@($rows)}|ConvertTo-Json -Compress -Depth 6",
  ].join("\n");
  const names = Buffer.from(JSON.stringify(CONFIG_KEYS), "utf8").toString("base64");
  const output = await runPowerShellFn(script, { timeout: 180000, env: { CIZI_REG_NAMES: names } });
  const captured = JSON.parse(output);
  const values = Object.fromEntries(CONFIG_KEYS.map((name) => [name, { existed: false }]));
  for (const row of captured.values || []) {
    if (CONFIG_KEYS.includes(row.name)) values[row.name] = row.existed ? row : { existed: false };
  }
  return { keyExisted: !!captured.keyExisted, values };
}

async function capturePolicySnapshot({
  execFileFn = execFileAsync,
  runPowerShellFn = lifecycle.runPowerShell,
} = {}) {
  let output;
  try {
    const result = await execFileFn("reg.exe", ["query", POLICY_KEY], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 64 * 1024,
    });
    output = result?.stdout || result;
  } catch (error) {
    if (Number(error?.code) === 1) return emptyManagedPolicy(false);
    throw codedError("CLAUDE_POLICY_CAPTURE_FAILED", "Claude's user policy could not be read.", error);
  }
  const managed = new Set(CONFIG_KEYS.map((name) => name.toLowerCase()));
  const hasManagedValues = registryValueNames(output)
    .some((name) => managed.has(String(name).toLowerCase()));
  if (!hasManagedValues) return emptyManagedPolicy(true);
  // Exact value kinds and byte representations matter when a pre-existing
  // managed value is present. Keep the exact .NET registry snapshot for this
  // rare preservation path, but avoid PowerShell entirely for the normal
  // no-policy launcher path.
  return capturePolicySnapshotPowerShell(runPowerShellFn);
}

function validateExactRegistryValue(record, managedName) {
  if (!record || !REGISTRY_TYPES.has(record.type)) {
    throw codedError("BACKUP_INVALID", `Unsupported registry value type for ${managedName}.`);
  }
  if (record.registryName
      && String(record.registryName).toLowerCase() !== String(managedName).toLowerCase()) {
    throw codedError("BACKUP_INVALID", `Registry snapshot name mismatch for ${managedName}.`);
  }
  const encodingFor = {
    REG_SZ: "string", REG_EXPAND_SZ: "string", REG_DWORD: "number", REG_QWORD: "number",
    REG_MULTI_SZ: "string-array", REG_BINARY: "base64", REG_NONE: "base64",
  };
  if (record.encoding !== encodingFor[record.type]) throw codedError("BACKUP_INVALID", "Registry snapshot encoding is invalid.");
  if (record.encoding === "string-array") {
    if (!Array.isArray(record.data) || record.data.some((item) => typeof item !== "string")) {
      throw codedError("BACKUP_INVALID", "REG_MULTI_SZ snapshot data is invalid.");
    }
  } else if (typeof record.data !== "string") {
    throw codedError("BACKUP_INVALID", "Registry snapshot data is invalid.");
  }
  if (record.encoding === "number" && !/^\d+$/.test(record.data)) {
    throw codedError("BACKUP_INVALID", "Numeric registry snapshot data is invalid.");
  }
}

function policyFromBaseline(snapshot) {
  if (snapshot?.policy?.values) return snapshot.policy;
  if (snapshot?.values) return { keyExisted: !!snapshot.keyExisted, values: snapshot.values };
  throw codedError("BACKUP_INVALID", "Claude Desktop's original policy backup is incomplete.");
}

function policySnapshotsEqual(expectedSnapshot, actualSnapshot) {
  let expected;
  let actual;
  try {
    expected = policyFromBaseline(expectedSnapshot);
    actual = policyFromBaseline(actualSnapshot);
  } catch { return false; }
  // If the key did not exist originally, another program may legitimately add
  // an unrelated value while Cizi is active. Managed values must still match,
  // but that concurrent key must not be deleted merely to reproduce absence.
  if (expected.keyExisted && !actual.keyExisted) return false;
  for (const name of CONFIG_KEYS) {
    const left = expected.values?.[name] || { existed: false };
    const right = actual.values?.[name] || { existed: false };
    if (!!left.existed !== !!right.existed) return false;
    if (!left.existed) continue;
    const normalize = (row) => ({
      type: row.type || "REG_SZ",
      encoding: row.encoding || "legacy",
      registryName: String(row.registryName || name).toLowerCase(),
      data: row.data,
    });
    if (JSON.stringify(normalize(left)) !== JSON.stringify(normalize(right))) return false;
  }
  return true;
}

async function restorePolicySnapshot(snapshot, {
  execFileFn = execFileAsync,
  runPowerShellFn = lifecycle.runPowerShell,
} = {}) {
  const policy = policyFromBaseline(snapshot);
  const rows = [];
  for (const name of CONFIG_KEYS) {
    const prior = policy.values?.[name];
    if (!prior || !prior.existed) rows.push({ name, existed: false });
    else {
      // Old schema-1 snapshots used reg.exe textual values. Continue to restore
      // those without weakening validation for all newly-created snapshots.
      if (!prior.encoding) rows.push({ name, existed: true, type: prior.type || "REG_SZ", encoding: "legacy", data: String(prior.data || "") });
      else {
        validateExactRegistryValue(prior, name);
        rows.push({ name, ...prior, existed: true });
      }
    }
  }
  if (rows.every((row) => !row.existed)) {
    await deleteRegistryValues(CONFIG_KEYS, { execFileFn });
    const verified = await capturePolicySnapshot({ execFileFn, runPowerShellFn });
    if (CONFIG_KEYS.some((name) => verified.values?.[name]?.existed)) {
      throw codedError("CLAUDE_POLICY_RESTORE_FAILED", "Claude's original user policy could not be restored.");
    }
    // An empty key is inert. Do not invoke PowerShell merely to reproduce key
    // absence, and never delete a key that another program may have populated.
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CIZI_REG_VALUES))|ConvertFrom-Json",
    "$root=[Microsoft.Win32.Registry]::CurrentUser;$sub='SOFTWARE\\Policies\\Claude';$key=$root.OpenSubKey($sub,$true)",
    "try{if($env:CIZI_REG_KEY_EXISTED -eq '1' -and $null -eq $key){$key=$root.CreateSubKey($sub,$true)};foreach($row in @($rows)){",
    "if(-not [bool]$row.existed){if($null -ne $key){$key.DeleteValue([string]$row.name,$false)};continue}",
    "if($null -eq $key){$key=$root.CreateSubKey($sub,$true)}",
    "switch([string]$row.type){",
    "'REG_SZ'{$kind=[Microsoft.Win32.RegistryValueKind]::String;$value=[string]$row.data}",
    "'REG_EXPAND_SZ'{$kind=[Microsoft.Win32.RegistryValueKind]::ExpandString;$value=[string]$row.data}",
    "'REG_DWORD'{$kind=[Microsoft.Win32.RegistryValueKind]::DWord;$unsigned=[Convert]::ToUInt32([string]$row.data);$value=[BitConverter]::ToInt32([BitConverter]::GetBytes($unsigned),0)}",
    "'REG_QWORD'{$kind=[Microsoft.Win32.RegistryValueKind]::QWord;$unsigned=[Convert]::ToUInt64([string]$row.data);$value=[BitConverter]::ToInt64([BitConverter]::GetBytes($unsigned),0)}",
    "'REG_MULTI_SZ'{$kind=[Microsoft.Win32.RegistryValueKind]::MultiString;$value=[string[]]@($row.data)}",
    "'REG_BINARY'{$kind=[Microsoft.Win32.RegistryValueKind]::Binary;$value=[Convert]::FromBase64String([string]$row.data)}",
    "'REG_NONE'{$kind=[Microsoft.Win32.RegistryValueKind]::None;$value=[Convert]::FromBase64String([string]$row.data)}",
    "default{throw \"Unsupported registry value type: $($row.type)\"}",
    "}",
    "$target=if($row.registryName){[string]$row.registryName}else{[string]$row.name};$key.SetValue($target,$value,$kind)",
    "}}finally{if($null -ne $key){$key.Dispose()}}",
  ].join("\n");
  const values = Buffer.from(JSON.stringify(rows), "utf8").toString("base64");
  await runPowerShellFn(script, {
    timeout: 180000,
    env: { CIZI_REG_VALUES: values, CIZI_REG_KEY_EXISTED: policy.keyExisted ? "1" : "0" },
  });
  if (!policy.keyExisted) {
    const removeEmpty = "$k='Registry::HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Claude';if(Test-Path $k){$i=Get-Item $k;$c=@(Get-ChildItem $k -ErrorAction SilentlyContinue);if(@($i.Property).Count -eq 0 -and $c.Count -eq 0){Remove-Item $k -Force}}";
    try { await runPowerShellFn(removeEmpty, { timeout: 10000 }); } catch { /* empty key is inert */ }
  }
}


async function applyPolicyConfig(config) {
  // Use reg.exe argument arrays. Values are data arguments, never PowerShell
  // source, so endpoint/model text cannot become executable input.
  try {
    await execFileAsync("reg.exe", ["delete", POLICY_KEY, "/v", "inferenceGatewayApiKey", "/f"], { windowsHide: true, timeout: 10000 });
  } catch { /* already absent */ }
  for (const [name, value] of Object.entries(config)) {
    await execFileAsync("reg.exe", ["add", POLICY_KEY, "/v", name, "/t", "REG_SZ", "/d", String(value), "/f"], {
      windowsHide: true,
      timeout: 10000,
    });
  }
}

async function deleteRegistryValues(names, { execFileFn = execFileAsync } = {}) {
  for (const name of [...new Set(names)]) {
    try {
      await execFileFn("reg.exe", ["delete", POLICY_KEY, "/v", name, "/f"], { windowsHide: true, timeout: 10000 });
    } catch { /* final capture below distinguishes concurrent removal from failure */ }
  }
}

function sameWindowsPath(left, right) {
  if (!left || !right) return false;
  return path.win32.resolve(String(left)).toLowerCase() === path.win32.resolve(String(right)).toLowerCase();
}


async function cleanupOwnedPolicyOrphans(expectedBase, {
  capturePolicySnapshotFn = capturePolicySnapshot,
  deleteRegistryValuesFn = deleteRegistryValues,
  ownedHelperPath = credential.helperPath(),
} = {}) {
  const current = await capturePolicySnapshotFn();
  const values = current.values || {};
  const helper = values.inferenceCredentialHelper;
  const ownedHelper = helper?.existed && helper.type === "REG_SZ"
    && sameWindowsPath(helper.data, ownedHelperPath);
  const allowedBases = new Set([
    normalizedGateway("https://lotpik.cizicode.me/v1"),
    expectedBase ? normalizedGateway(withV1(expectedBase)) : null,
  ].filter(Boolean));
  const base = values.inferenceGatewayBaseUrl;
  const ownedBase = base?.existed && base.type === "REG_SZ"
    && allowedBases.has(normalizedGateway(base.data));
  const remove = new Set();
  if (ownedBase) remove.add("inferenceGatewayBaseUrl");
  if (ownedHelper) {
    remove.add("inferenceCredentialHelper");
    const exactCompanions = {
      inferenceProvider: "gateway",
      inferenceGatewayAuthScheme: "bearer",
      inferenceCredentialKind: "helper-script",
      inferenceCredentialHelperTtlSec: "300",
      modelDiscoveryEnabled: "false",
      disableDeploymentModeChooser: "true",
      isClaudeCodeForDesktopEnabled: "true",
      coworkTabEnabled: "true",
    };
    for (const [name, expected] of Object.entries(exactCompanions)) {
      const value = values[name];
      if (value?.existed && value.type === "REG_SZ" && value.data === expected) remove.add(name);
    }
    if (values.inferenceModels?.existed && values.inferenceModels.type === "REG_SZ"
        && validCiziModels(values.inferenceModels.data)) remove.add("inferenceModels");
  }
  if (!remove.size) return { cleaned: false, removed: [] };
  await deleteRegistryValuesFn([...remove]);
  const after = await capturePolicySnapshotFn();
  const remaining = [...remove].filter((name) => after.values?.[name]?.existed);
  if (remaining.length) {
    throw codedError("CLAUDE_LEGACY_POLICY_CLEANUP_FAILED", "Old Cizi Code Claude policy values could not be removed safely.");
  }
  return { cleaned: true, removed: [...remove].sort() };
}

async function verifyPolicyConfig(config, { capturePolicySnapshotFn = capturePolicySnapshot } = {}) {
  const current = await capturePolicySnapshotFn();
  for (const [name, expected] of Object.entries(config)) {
    const value = current.values?.[name];
    if (!value?.existed || value.type !== "REG_SZ" || value.data !== String(expected)) return false;
  }
  return current.values?.inferenceGatewayApiKey?.existed !== true;
}

module.exports = {
  machinePolicyBlock,
  capturePolicySnapshot,
  restorePolicySnapshot,
  policySnapshotsEqual,
  applyPolicyConfig,
  cleanupOwnedPolicyOrphans,
  verifyPolicyConfig,
};
