const path = require("path");
const { app } = require("electron");
const lifecycle = require("./claudeLifecycle");

const TASK_NAME = "Cizi Code Claude Reconcile";
const TASK_ARGUMENTS = "--cizi-reconcile-active-tools";
const TASK_DESCRIPTION = "Periodically verifies every Cizi Code tool integration, repairs enabled configurations, and restores disabled ones.";
const TASK_SCHEMA_VERSION = 1;
const TASK_POLL_MINUTES = 15;

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function expectedExecutable() {
  return path.resolve(process.execPath);
}

function taskPayload(executablePath = expectedExecutable()) {
  const resolved = path.resolve(executablePath);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskName: TASK_NAME,
    executablePath: resolved,
    workingDirectory: path.dirname(resolved),
    arguments: TASK_ARGUMENTS,
    description: TASK_DESCRIPTION,
  };
}

function payloadPreamble() {
  return [
    "$ErrorActionPreference='Stop'",
    "$payload=$env:CIZI_RECONCILE_TASK|ConvertFrom-Json -ErrorAction Stop",
    `if($null -eq $payload -or [int]$payload.schemaVersion -ne ${TASK_SCHEMA_VERSION}){throw 'CIZI_RECONCILE_TASK_PAYLOAD_INVALID'}`,
    `$expectedName='${TASK_NAME}'`,
    `$expectedArgs='${TASK_ARGUMENTS}'`,
    "if([string]$payload.taskName -cne $expectedName -or [string]$payload.arguments -cne $expectedArgs){throw 'CIZI_RECONCILE_TASK_PAYLOAD_INVALID'}",
    "$exe=[IO.Path]::GetFullPath([string]$payload.executablePath)",
    "$work=[IO.Path]::GetFullPath([string]$payload.workingDirectory)",
    "if(!(Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetDirectoryName($exe) -ine $work){throw 'CIZI_RECONCILE_EXECUTABLE_INVALID'}",
    "$task=Get-ScheduledTask -TaskName $expectedName -ErrorAction SilentlyContinue",
    "$matches=$false",
    "if($null -ne $task){$actions=@($task.Actions);$matches=$actions.Count -eq 1 -and [IO.Path]::GetFullPath([string]$actions[0].Execute) -ieq $exe -and ([string]$actions[0].Arguments).Trim() -ceq $expectedArgs}",
  ].join("\n");
}

function queryTaskScript() {
  return [
    payloadPreamble(),
    "$state=if($null -eq $task){'absent'}elseif($matches){'current'}else{'conflict'}",
    "[pscustomobject]@{exists=$null -ne $task;current=$matches;state=$state;taskName=$expectedName}|ConvertTo-Json -Compress",
  ].join("\n");
}

function ensureTaskScript() {
  return [
    payloadPreamble(),
    "if($null -ne $task -and -not $matches){throw 'CIZI_RECONCILE_TASK_CONFLICT'}",
    "$created=$null -eq $task",
    "$action=New-ScheduledTaskAction -Execute $exe -Argument $expectedArgs -WorkingDirectory $work",
    "$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$logon=New-ScheduledTaskTrigger -AtLogOn -User $user",
    "$logon.Delay='PT1M'",
    `$poll=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${TASK_POLL_MINUTES}) -RepetitionInterval (New-TimeSpan -Minutes ${TASK_POLL_MINUTES}) -RepetitionDuration (New-TimeSpan -Days 3650)`,
    "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $expectedName -Action $action -Trigger @($logon,$poll) -Settings $settings -Principal $principal -Description ([string]$payload.description) -Force -ErrorAction Stop|Out-Null",
    "$after=Get-ScheduledTask -TaskName $expectedName -ErrorAction Stop",
    "$actions=@($after.Actions)",
    "$verified=$actions.Count -eq 1 -and [IO.Path]::GetFullPath([string]$actions[0].Execute) -ieq $exe -and ([string]$actions[0].Arguments).Trim() -ceq $expectedArgs",
    "if(-not $verified){throw 'CIZI_RECONCILE_TASK_VERIFY_FAILED'}",
    "[pscustomobject]@{exists=$true;current=$true;created=$created;taskName=$expectedName}|ConvertTo-Json -Compress",
  ].join("\n");
}

function removeTaskScript() {
  return [
    payloadPreamble(),
    "if($null -eq $task){[pscustomobject]@{removed=$false;taskName=$expectedName}|ConvertTo-Json -Compress;return}",
    "if(-not $matches){throw 'CIZI_RECONCILE_TASK_OWNERSHIP_UNVERIFIED'}",
    "$task|Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop",
    "$remaining=Get-ScheduledTask -TaskName $expectedName -ErrorAction SilentlyContinue",
    "if($null -ne $remaining){throw 'CIZI_RECONCILE_TASK_REMOVE_FAILED'}",
    "[pscustomobject]@{removed=$true;taskName=$expectedName}|ConvertTo-Json -Compress",
  ].join("\n");
}

function parseResult(output, fallbackCode) {
  try {
    const value = JSON.parse(String(output || "").trim());
    if (!value || Array.isArray(value) || value.taskName !== TASK_NAME) throw new Error("invalid result");
    return value;
  } catch (cause) {
    throw codedError(fallbackCode, "Windows returned an invalid Claude update-monitor status.", cause);
  }
}

async function run(script, code, { runPowerShellFn = lifecycle.runPowerShell, executablePath = expectedExecutable() } = {}) {
  try {
    const output = await runPowerShellFn(script, {
      env: { CIZI_RECONCILE_TASK: JSON.stringify(taskPayload(executablePath)) },
      timeout: 30000,
      maxBuffer: 128 * 1024,
    });
    return parseResult(output, code);
  } catch (cause) {
    if (cause?.code && String(cause.code).startsWith("CLAUDE_RECONCILE_")) throw cause;
    const detail = [cause?.message, cause?.stdout, cause?.stderr].filter(Boolean).join("\n");
    const known = [
      ["CIZI_RECONCILE_TASK_CONFLICT", "CLAUDE_RECONCILE_TASK_CONFLICT", "A different scheduled task is using Cizi Code's Claude update-monitor name."],
      ["CIZI_RECONCILE_TASK_OWNERSHIP_UNVERIFIED", "CLAUDE_RECONCILE_TASK_OWNERSHIP_UNVERIFIED", "Cizi Code could not verify ownership of the Claude update monitor."],
      ["CIZI_RECONCILE_TASK_VERIFY_FAILED", "CLAUDE_RECONCILE_TASK_VERIFY_FAILED", "Windows did not preserve the Claude update monitor correctly."],
      ["CIZI_RECONCILE_TASK_REMOVE_FAILED", "CLAUDE_RECONCILE_TASK_REMOVE_FAILED", "Windows did not remove the Claude update monitor."],
      ["CIZI_RECONCILE_EXECUTABLE_INVALID", "CLAUDE_RECONCILE_EXECUTABLE_INVALID", "The installed Cizi Code executable could not be verified for automatic Claude updates."],
    ];
    for (const [marker, mappedCode, message] of known) {
      if (detail.includes(marker)) throw codedError(mappedCode, message, cause);
    }
    throw codedError(code, "Cizi Code could not manage the automatic Claude update monitor.", cause);
  }
}

async function getStatus(options = {}) {
  if (app?.isPackaged !== true && !options.allowDevelopment) {
    return { exists: false, current: true, state: "development", taskName: TASK_NAME };
  }
  return run(queryTaskScript(), "CLAUDE_RECONCILE_TASK_STATUS_FAILED", options);
}

async function ensure(options = {}) {
  if (app?.isPackaged !== true && !options.allowDevelopment) {
    return { exists: false, current: false, created: false, skipped: "development", taskName: TASK_NAME };
  }
  return run(ensureTaskScript(), "CLAUDE_RECONCILE_TASK_CREATE_FAILED", options);
}

async function remove(options = {}) {
  if (app?.isPackaged !== true && !options.allowDevelopment) {
    return { removed: false, skipped: "development", taskName: TASK_NAME };
  }
  return run(removeTaskScript(), "CLAUDE_RECONCILE_TASK_REMOVE_FAILED", options);
}

async function isCurrent(options = {}) {
  if (app?.isPackaged !== true && !options.allowDevelopment) return true;
  return !!(await getStatus(options)).current;
}

module.exports = {
  TASK_NAME,
  TASK_POLL_MINUTES,
  TASK_ARGUMENTS,
  TASK_DESCRIPTION,
  TASK_SCHEMA_VERSION,
  taskPayload,
  queryTaskScript,
  ensureTaskScript,
  removeTaskScript,
  parseResult,
  getStatus,
  ensure,
  remove,
  isCurrent,
};
