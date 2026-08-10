// Claude arayuz markalamasinin onarim gorevi.
//
// NEDEN AYRI BIR GOREV
// Zaten bir "Cizi Code Claude Reconcile" gorevi var, ama o KULLANICI olarak ve
// RunLevel Limited ile calisir - oyle olmasi gerekir, cunku isi kullanicinin
// kendi HKCU ayarlarini denetlemek. Markalama ise WindowsApps altina yazar ve
// yonetici hakki ister. Ikisini tek goreve sikistirmak, ya politika denetimini
// yanlis kullanici kovanina yazardi ya da markalamayi yetkisiz birakirdi.
// Bu yuzden markalama kendi gorevine sahiptir: SYSTEM, RunLevel Highest.
//
// NEDEN ELECTRON GUI DEGIL
// Gorev, uygulamanin kendi Electron ikilisini ELECTRON_RUN_AS_NODE=1 ile duz
// Node olarak calistirir ve yalnizca repair.js'i yurutur. Pencere acilmaz,
// oturum gerekmez. SYSTEM olarak bir GUI uygulamasi baslatmak session 0'da
// zaten guvenilir degildir.
//
// TETIKLEYICILER - dortu birlikte
//   1) AppX dagitim olayi (400/855): guncelleme aninda, gecikmesiz
//   2) Acilis:                       kapaliyken gelen guncellemeyi yakalar
//   3) Oturum acma:                  kullaniciya donmeden once
//   4) Periyodik (15 dk):            olay kacirilirsa son emniyet
// Genis tetikleme zararsizdir cunku repair.js karari dosya hash'ine gore verir.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const lifecycle = require("./claudeLifecycle");
const log = require("../logger");

const TASK_NAME = "Cizi Code Claude Branding Repair";
const TASK_DESCRIPTION = "Restores Cizi Code's Claude Desktop interface labels after a Claude update, even while Cizi Code is closed.";
const TASK_SCHEMA_VERSION = 1;
const POLL_MINUTES = 15;
const EVENT_DELAY = "PT30S";
const EVENT_LOG = "Microsoft-Windows-AppXDeploymentServer/Operational";
const EVENT_PROVIDER = "Microsoft-Windows-AppXDeployment-Server";
const EVENT_IDS = [400, 855];

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Paketlenmis uygulamada kaynaklar app.asar icindedir; arsiv icinden dosya yolu
// vermek disaridan calisan bir surec icin guvenilir degil. Bu yuzden markalama
// motoru asarUnpack ile disari alinir ve gorev o gercek dizini kullanir.
// Gelistirme ortaminda dosyalar zaten disaridadir.
// baseDirectory disaridan verilebilir: aksi halde bu esleme yalnizca gercek bir
// paketlenmis kurulumda dogrulanabilir olurdu.
function repairScriptPath(baseDirectory = __dirname) {
  const packed = path.join(baseDirectory, "claudeBranding", "repair.js");
  const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== packed && fs.existsSync(unpacked)) return unpacked;
  return packed;
}

function taskPayload({ workRoot, executablePath = process.execPath, scriptPath = repairScriptPath() } = {}) {
  const resolvedExecutable = path.resolve(executablePath);
  const resolvedScript = path.resolve(scriptPath);
  const resolvedWorkRoot = path.resolve(workRoot);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskName: TASK_NAME,
    executablePath: resolvedExecutable,
    scriptPath: resolvedScript,
    workRoot: resolvedWorkRoot,
    logPath: path.join(resolvedWorkRoot, "repair-task.log"),
    description: TASK_DESCRIPTION,
  };
}

// Gorev eylemi: env degiskeni ile Electron'u Node moduna alip repair.js'i
// calistirir ve ciktisini log dosyasina ekler. Zamanlanmis gorevler env
// degiskeni tasiyamadigi icin cmd.exe sarmalayici kullanilir.
//
// NEDEN DISK'TE BIR .cmd DOSYASI DEGIL
// Komutu userData altina bir .cmd olarak yazip gorevden onu cagirmak alintilama
// derdini bitirirdi - ama o dosya kullanicinin yazabildigi bir yerde durur ve
// gorev SYSTEM olarak calisir. Kullanici hakkiyla calisan herhangi bir surec o
// dosyayi degistirip SYSTEM'de kod calistirabilirdi. Gorev tanimi ise yalnizca
// yonetici tarafindan degistirilebilir; bu yuzden komut gorev tanimi icinde
// kalir.
//
// NEDEN /s
// cmd.exe'nin /c ile dis tirnaklari ne zaman soyacagi, tirnak sayisina ve
// icerige bagli karmasik bir kurala tabidir; birden fazla tirnakli yol iceren bu
// komut o kuralda belirsiz kalir. /s davranisi kesindir: ilk ve son tirnak her
// zaman soyulur, kalan kisim aynen calistirilir.
// ELECTRON_NO_ASAR neden burada da veriliyor: repair.js kendi icinde
// process.noAsar kurar, ama ortam degiskenini surec BASLAMADAN once vermek daha
// guvenlidir - asar yamasi calisma zamaninda kurulur ve onu hic kurmamak, sonradan
// devre disi birakmaktan saglamdir. Ikisi birlikte, betigin nasil calistirildigina
// bakmaksizin dogru davranisi garanti eder.
function actionArguments(payload) {
  const quoted = (value) => `"${value}"`;
  const command = "set ELECTRON_RUN_AS_NODE=1&& set ELECTRON_NO_ASAR=1&& "
    + `${quoted(payload.executablePath)} ${quoted(payload.scriptPath)}`
    + ` --work-root ${quoted(payload.workRoot)} >> ${quoted(payload.logPath)} 2>&1`;
  return `/s /c "${command}"`;
}

function eventSubscription() {
  const conditions = EVENT_IDS.map((id) => `EventID=${id}`).join(" or ");
  const query = `*[System[Provider[@Name='${EVENT_PROVIDER}'] and (${conditions})]]`;
  return "<QueryList>"
    + `<Query Id="0" Path="${EVENT_LOG}">`
    + `<Select Path="${EVENT_LOG}">${query}</Select>`
    + "</Query></QueryList>";
}

function payloadPreamble() {
  return [
    "$ErrorActionPreference='Stop'",
    "$payload=$env:CIZI_BRANDING_TASK|ConvertFrom-Json -ErrorAction Stop",
    `if($null -eq $payload -or [int]$payload.schemaVersion -ne ${TASK_SCHEMA_VERSION}){throw 'CIZI_BRANDING_TASK_PAYLOAD_INVALID'}`,
    `$expectedName='${TASK_NAME}'`,
    "if([string]$payload.taskName -cne $expectedName){throw 'CIZI_BRANDING_TASK_PAYLOAD_INVALID'}",
    "$exe=[IO.Path]::GetFullPath([string]$payload.executablePath)",
    "$script=[IO.Path]::GetFullPath([string]$payload.scriptPath)",
    "if(!(Test-Path -LiteralPath $exe -PathType Leaf)){throw 'CIZI_BRANDING_EXECUTABLE_INVALID'}",
    "if(!(Test-Path -LiteralPath $script -PathType Leaf)){throw 'CIZI_BRANDING_SCRIPT_INVALID'}",
    "$expectedArgs=[string]$env:CIZI_BRANDING_ARGS",
    "$task=Get-ScheduledTask -TaskName $expectedName -ErrorAction SilentlyContinue",
    "$isCurrent=$false",
    "if($null -ne $task){$acts=@($task.Actions);$isCurrent=$acts.Count -eq 1 -and ([string]$acts[0].Arguments).Trim() -ceq $expectedArgs.Trim()}",
  ].join("\n");
}

function queryScript() {
  return [
    payloadPreamble(),
    "$state=if($null -eq $task){'absent'}elseif($isCurrent){'current'}else{'conflict'}",
    "[pscustomobject]@{exists=$null -ne $task;current=$isCurrent;state=$state;taskName=$expectedName}|ConvertTo-Json -Compress",
  ].join("\n");
}

function ensureScript() {
  return [
    payloadPreamble(),
    "if($null -ne $task -and -not $isCurrent){",
    // Ayni ada sahip ama farkli bir eylem tasiyan gorev bizim onceki
    // surumumuz olabilir. Sahipligi ad ve eylem sekliyle dogrulanabildigi icin
    // guncellenmesi guvenlidir; -Force zaten uzerine yazar.
    "  Write-Verbose 'updating existing task'",
    "}",
    "$created=$null -eq $task",
    "$action=New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $expectedArgs",
    "$boot=New-ScheduledTaskTrigger -AtStartup",
    "$logon=New-ScheduledTaskTrigger -AtLogOn",
    `$poll=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${POLL_MINUTES}) -RepetitionInterval (New-TimeSpan -Minutes ${POLL_MINUTES}) -RepetitionDuration (New-TimeSpan -Days 3650)`,
    // Olay tetikleyicisi PowerShell cmdlet'i ile uretilemez; CIM sinifi kullanilir.
    "$eventClass=Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler",
    "$event=New-CimInstance -CimClass $eventClass -ClientOnly",
    "$event.Enabled=$true",
    `$event.Delay='${EVENT_DELAY}'`,
    "$event.Subscription=[string]$env:CIZI_BRANDING_SUBSCRIPTION",
    "$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "$principal=New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "Register-ScheduledTask -TaskName $expectedName -Action $action -Trigger @($event,$boot,$logon,$poll) -Settings $settings -Principal $principal -Description ([string]$payload.description) -Force -ErrorAction Stop|Out-Null",
    "$after=Get-ScheduledTask -TaskName $expectedName -ErrorAction Stop",
    "$acts=@($after.Actions)",
    "$verified=$acts.Count -eq 1 -and ([string]$acts[0].Arguments).Trim() -ceq $expectedArgs.Trim()",
    "$triggerTypes=@($after.Triggers|ForEach-Object{$_.CimClass.CimClassName})",
    "if(-not $verified){throw 'CIZI_BRANDING_TASK_VERIFY_FAILED'}",
    "if($triggerTypes -notcontains 'MSFT_TaskEventTrigger'){throw 'CIZI_BRANDING_EVENT_TRIGGER_MISSING'}",
    "[pscustomobject]@{exists=$true;current=$true;created=$created;taskName=$expectedName;triggers=$triggerTypes}|ConvertTo-Json -Compress",
  ].join("\n");
}

function removeScript() {
  return [
    payloadPreamble(),
    "if($null -eq $task){[pscustomobject]@{removed=$false;taskName=$expectedName}|ConvertTo-Json -Compress;return}",
    "$task|Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop",
    "$remaining=Get-ScheduledTask -TaskName $expectedName -ErrorAction SilentlyContinue",
    "if($null -ne $remaining){throw 'CIZI_BRANDING_TASK_REMOVE_FAILED'}",
    "[pscustomobject]@{removed=$true;taskName=$expectedName}|ConvertTo-Json -Compress",
  ].join("\n");
}

function parseResult(output, fallbackCode) {
  try {
    const value = JSON.parse(String(output || "").trim());
    if (!value || Array.isArray(value) || value.taskName !== TASK_NAME) throw new Error("invalid result");
    return value;
  } catch (cause) {
    throw codedError(fallbackCode, "Windows returned an invalid Claude branding-monitor status.", cause);
  }
}

const KNOWN_FAILURES = [
  ["CIZI_BRANDING_TASK_PAYLOAD_INVALID", "CLAUDE_BRANDING_TASK_PAYLOAD_INVALID", "Cizi Code could not describe the Claude branding monitor safely."],
  ["CIZI_BRANDING_EXECUTABLE_INVALID", "CLAUDE_BRANDING_TASK_EXECUTABLE_INVALID", "The installed Cizi Code executable could not be verified for the Claude branding monitor."],
  ["CIZI_BRANDING_SCRIPT_INVALID", "CLAUDE_BRANDING_TASK_SCRIPT_MISSING", "Cizi Code's Claude branding repair script is missing from the installation."],
  ["CIZI_BRANDING_TASK_VERIFY_FAILED", "CLAUDE_BRANDING_TASK_VERIFY_FAILED", "Windows did not preserve the Claude branding monitor correctly."],
  ["CIZI_BRANDING_EVENT_TRIGGER_MISSING", "CLAUDE_BRANDING_TASK_EVENT_TRIGGER_MISSING", "The Claude branding monitor was created without its update trigger."],
  ["CIZI_BRANDING_TASK_REMOVE_FAILED", "CLAUDE_BRANDING_TASK_REMOVE_FAILED", "Windows did not remove the Claude branding monitor."],
];

async function run(script, code, options = {}) {
  const payload = taskPayload(options);
  const runPowerShellFn = options.runPowerShellFn || lifecycle.runPowerShell;
  try {
    const output = await runPowerShellFn(script, {
      env: {
        CIZI_BRANDING_TASK: JSON.stringify(payload),
        CIZI_BRANDING_ARGS: actionArguments(payload),
        CIZI_BRANDING_SUBSCRIPTION: eventSubscription(),
      },
      timeout: 60000,
      maxBuffer: 256 * 1024,
    });
    return parseResult(output, code);
  } catch (cause) {
    if (cause?.code && String(cause.code).startsWith("CLAUDE_BRANDING_")) throw cause;
    const detail = [cause?.message, cause?.stdout, cause?.stderr].filter(Boolean).join("\n");
    for (const [marker, mappedCode, message] of KNOWN_FAILURES) {
      if (detail.includes(marker)) throw codedError(mappedCode, message, cause);
    }
    throw codedError(code, "Cizi Code could not manage the Claude branding monitor.", cause);
  }
}

// Gelistirme ortaminda gorev kurulmaz: process.execPath gelistirici makinesinin
// electron.exe'sini gosterir ve makinede kalici bir SYSTEM gorevi birakmak
// istenmez. Uretimde bu kontrol devre disidir.
function developmentSkip(options) {
  return app?.isPackaged !== true && !options.allowDevelopment;
}

async function getStatus(options = {}) {
  if (developmentSkip(options)) return { exists: false, current: true, state: "development", taskName: TASK_NAME };
  return run(queryScript(), "CLAUDE_BRANDING_TASK_STATUS_FAILED", options);
}

async function ensure(options = {}) {
  if (developmentSkip(options)) return { exists: false, current: false, created: false, skipped: "development", taskName: TASK_NAME };
  const result = await run(ensureScript(), "CLAUDE_BRANDING_TASK_CREATE_FAILED", options);
  log.success("claude-branding", "Claude guncelleme izleyicisi kuruldu", {
    taskName: TASK_NAME,
    created: result.created === true,
    triggers: result.triggers || null,
  });
  return result;
}

async function remove(options = {}) {
  if (developmentSkip(options)) return { removed: false, skipped: "development", taskName: TASK_NAME };
  const result = await run(removeScript(), "CLAUDE_BRANDING_TASK_REMOVE_FAILED", options);
  if (result.removed) log.info("claude-branding", "Claude guncelleme izleyicisi kaldirildi", { taskName: TASK_NAME });
  return result;
}

async function isCurrent(options = {}) {
  if (developmentSkip(options)) return true;
  return !!(await getStatus(options)).current;
}

module.exports = {
  TASK_NAME,
  TASK_DESCRIPTION,
  TASK_SCHEMA_VERSION,
  POLL_MINUTES,
  EVENT_IDS,
  taskPayload,
  actionArguments,
  eventSubscription,
  repairScriptPath,
  queryScript,
  ensureScript,
  removeScript,
  parseResult,
  getStatus,
  ensure,
  remove,
  isCurrent,
};
