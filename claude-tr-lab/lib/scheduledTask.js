"use strict";

const path = require("path");
const { codedError } = require("./fsx");

// Tek sorumluluk: "Claude guncellenince yamayi geri koy" gorevini Windows'a
// kaydetmek / durumunu bildirmek / kaldirmak.
//
// KATMAN 2 (paralel koruyucu). Katman 3 bizim baslaticimizdir.
//
// Tetikleyiciler:
//   1) Olay: Claude/MSIX dagitimi tamamlandiginda (dogrulandi bu makinede)
//        Log      Microsoft-Windows-AppXDeploymentServer/Operational
//        Provider Microsoft-Windows-AppXDeployment-Server
//        Olay 400 "Deployment Add operation on Package Claude_..."
//        Olay 855 "...is updating to Claude_<yeni surum>..."
//   2) Sistem acilisi  - makine kapaliyken gelen guncellemeler icin
//   3) Oturum acilisi  - kullanici baglaminda ilk kontrol
//   4) Periyodik       - olay kacarsa guvenlik agi
//
// SYSTEM olarak calisir: UAC istemi cikmaz, kullanici oturum acmasa da calisir,
// Cizi Code kapali olsa da calisir. SYSTEM'in yalnizca DOSYA yamasi yapmasi
// onemli - gateway modu HKCU'dadir ve SYSTEM'in HKCU'su kullanicinin degildir.
// Neyse ki guncelleme gateway modunu silmiyor, sadece dosyalari siliyor.

const TASK_NAME = "Cizi Claude TR Repair";
const TASK_PATH = "\\";
const POLL_MINUTES = 15;
const EVENT_DELAY = "PT30S";
const APPX_LOG = "Microsoft-Windows-AppXDeploymentServer/Operational";
const APPX_PROVIDER = "Microsoft-Windows-AppXDeployment-Server";
const EVENT_IDS = [400, 855];

function subscriptionXml() {
  const ids = EVENT_IDS.map((id) => `EventID=${id}`).join(" or ");
  const select = `*[System[Provider[@Name='${APPX_PROVIDER}'] and (${ids})]]`;
  return `<QueryList><Query Id="0" Path="${APPX_LOG}">`
    + `<Select Path="${APPX_LOG}">${select}</Select></Query></QueryList>`;
}

function createScheduledTaskService({ logger, powershell, elevation, labRoot, nodePath }) {
  const cliPath = path.join(labRoot, "cli.js");
  const taskArguments = `"${cliPath}" reconcile --yes`;
  const logPath = path.join(labRoot, "work", "repair-task.log");

  function actionCommand() {
    // cmd /c ile sarilir: cikti bir log dosyasina yazilsin, gorev sessiz kalmasin.
    return {
      execute: process.env.COMSPEC || "cmd.exe",
      argument: `/c ""${nodePath}" ${taskArguments} >> "${logPath}" 2>&1"`,
    };
  }

  async function status() {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$name=[string]$env:CIZI_TASK_NAME",
      "$t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue",
      "if($null -eq $t){'null';exit}",
      "$i=Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue",
      "$act=@($t.Actions)[0]",
      "$trg=@($t.Triggers)|ForEach-Object{$_.CimClass.CimClassName}",
      "[pscustomobject]@{",
      "state=[string]$t.State",
      "userId=[string]$t.Principal.UserId",
      "runLevel=[string]$t.Principal.RunLevel",
      "execute=[string]$act.Execute",
      "arguments=[string]$act.Arguments",
      "triggers=@($trg)",
      "lastRunTime=[string]$i.LastRunTime",
      "lastResult=[string]$i.LastTaskResult",
      "nextRunTime=[string]$i.NextRunTime",
      "}|ConvertTo-Json -Compress -Depth 4",
    ].join("\n");
    const output = await powershell.run(script, {
      timeoutMs: 30000,
      env: { CIZI_TASK_NAME: TASK_NAME },
    });
    if (!output || output === "null") return { exists: false, taskName: TASK_NAME };
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (cause) {
      throw codedError("TASK_STATUS_INVALID", "Gorev durumu okunamadi.", cause);
    }
    const expected = actionCommand();
    const current = String(parsed.arguments || "") === expected.argument
      && String(parsed.userId || "").toUpperCase().includes("SYSTEM");
    return { exists: true, current, taskName: TASK_NAME, ...parsed };
  }

  async function install() {
    await elevation.assertElevated("Onarim gorevini kaydetmek");
    const action = actionCommand();
    const script = [
      "$ErrorActionPreference='Stop'",
      "$name=[string]$env:CIZI_TASK_NAME",
      "$exe=[string]$env:CIZI_TASK_EXE",
      "$args=[string]$env:CIZI_TASK_ARGS",
      "$sub=[string]$env:CIZI_TASK_SUB",
      "$act=New-ScheduledTaskAction -Execute $exe -Argument $args",
      // 1) olay tetikleyicisi
      "$cls=Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger",
      "$evt=New-CimInstance -CimClass $cls -ClientOnly",
      "$evt.Enabled=$true",
      "$evt.Subscription=$sub",
      `$evt.Delay='${EVENT_DELAY}'`,
      // 2-4) acilis, oturum acilisi, periyodik
      "$boot=New-ScheduledTaskTrigger -AtStartup",
      "$logon=New-ScheduledTaskTrigger -AtLogOn",
      `$poll=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${POLL_MINUTES}) -RepetitionInterval (New-TimeSpan -Minutes ${POLL_MINUTES}) -RepetitionDuration (New-TimeSpan -Days 3650)`,
      "$principal=New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\\SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
      "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)",
      "Register-ScheduledTask -TaskName $name -Action $act -Trigger @($evt,$boot,$logon,$poll) -Principal $principal -Settings $settings -Description 'Claude Desktop guncellendiginde Turkce yamayi geri koyar (Cizi Claude TR)' -Force -ErrorAction Stop | Out-Null",
      "'ok'",
    ].join("\n");

    const output = await powershell.run(script, {
      timeoutMs: 60000,
      env: {
        CIZI_TASK_NAME: TASK_NAME,
        CIZI_TASK_EXE: action.execute,
        CIZI_TASK_ARGS: action.argument,
        CIZI_TASK_SUB: subscriptionXml(),
      },
    });
    if (String(output).trim() !== "ok") {
      throw codedError("TASK_INSTALL_FAILED", "Onarim gorevi kaydedilemedi.");
    }
    const after = await status();
    if (!after.exists || !after.current) {
      throw codedError("TASK_INSTALL_UNVERIFIED", "Gorev kaydedildi ama dogrulanamadi.");
    }
    logger.success("task", "Onarim gorevi kaydedildi", {
      taskName: TASK_NAME,
      runsAs: after.userId,
      triggers: after.triggers,
      eventIds: EVENT_IDS,
      pollMinutes: POLL_MINUTES,
    });
    return { installed: true, ...after };
  }

  async function remove() {
    await elevation.assertElevated("Onarim gorevini kaldirmak");
    const before = await status();
    if (!before.exists) {
      logger.info("task", "Onarim gorevi zaten yok", { taskName: TASK_NAME });
      return { removed: false, taskName: TASK_NAME };
    }
    await powershell.run(
      "$ErrorActionPreference='Stop';"
      + "Unregister-ScheduledTask -TaskName ([string]$env:CIZI_TASK_NAME) -Confirm:$false -ErrorAction Stop",
      { timeoutMs: 30000, env: { CIZI_TASK_NAME: TASK_NAME } },
    );
    const after = await status();
    if (after.exists) throw codedError("TASK_REMOVE_FAILED", "Onarim gorevi kaldirilamadi.");
    logger.success("task", "GERI ALMA: onarim gorevi kaldirildi", { taskName: TASK_NAME });
    return { removed: true, taskName: TASK_NAME };
  }

  async function runNow() {
    await elevation.assertElevated("Onarim gorevini elle tetiklemek");
    await powershell.run(
      "$ErrorActionPreference='Stop';"
      + "Start-ScheduledTask -TaskName ([string]$env:CIZI_TASK_NAME) -ErrorAction Stop",
      { timeoutMs: 30000, env: { CIZI_TASK_NAME: TASK_NAME } },
    );
    logger.info("task", "Onarim gorevi elle tetiklendi", { taskName: TASK_NAME });
    return { started: true, taskName: TASK_NAME, logPath };
  }

  return { install, remove, status, runNow, TASK_NAME, logPath, subscriptionXml };
}

module.exports = {
  createScheduledTaskService,
  TASK_NAME,
  TASK_PATH,
  POLL_MINUTES,
  EVENT_IDS,
  APPX_LOG,
  APPX_PROVIDER,
};
