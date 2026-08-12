"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { codedError } = require("./fsx");

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(codedError("ELEVATION_TIMEOUT", "Yonetici islemi zaman asimina ugradi.")); }, timeoutMs);
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(codedError("ELEVATION_FAILED", stderr.trim() || `PowerShell exited with ${code}.`)); });
  });
}

// Starts a separate Electron-as-Node child only for the protected write. This
// lets Cizi Code remain a normal user application until WindowsApps access is
// actually needed.
function createElevationRunner({ executablePath = process.execPath, workerPath = path.join(__dirname, "elevatedWorker.js") } = {}) {
  async function run(operation, main, workRoot) {
    const resultPath = path.join(os.tmpdir(), `cizi-claude-elevation-${process.pid}-${Date.now()}.json`);
    const request = Buffer.from(JSON.stringify({ operation, main, workRoot, resultPath }), "utf8").toString("base64");
    const args = Buffer.from(JSON.stringify([workerPath, request]), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$exe='${executablePath.replace(/'/g, "''")}'`,
      `$argsJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${args}'))|ConvertFrom-Json`,
      "try { $p=Start-Process -FilePath $env:COMSPEC -Verb RunAs -PassThru -WindowStyle Hidden -ArgumentList @('/d','/s','/c', ('set ELECTRON_RUN_AS_NODE=1&& \"' + $exe + '\" \"' + $argsJson[0] + '\" \"' + $argsJson[1] + '\"')) -Wait -ErrorAction Stop } catch { exit 1223 }",
      "exit $p.ExitCode",
    ].join(";");
    let launchError = null;
    try {
      await runPowerShell(script, 180000);
    } catch (error) {
      launchError = error?.code === "ELEVATION_FAILED" && /1223/.test(error.message)
        ? codedError("ELEVATION_CANCELLED", "Yonetici izni onaylanmadi; Claude Desktop ayarlari degistirilmedi.")
        : error;
    }
    // SIRA ONEMLI: sonuc dosyasi, PowerShell hata verse de once okunur.
    //
    // Yukseltilmis is basarisiz oldugunda cocuk surec 0'dan farkli bir kodla
    // cikar, yani PowerShell de hata verir. Once ona bakip cikmak, isin gercek
    // sebebini (dosyaya yazilmis kod ve mesaj) atip yerine "PowerShell exited
    // with 1" koyuyordu - kullanicinin de gelistiricinin de eline hicbir sey
    // gecmiyordu. Islem hic baslamadiysa dosya zaten yoktur ve baslatma hatasi
    // bildirilir.
    let report = null;
    try { report = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch { report = null; }
    finally { try { fs.unlinkSync(resultPath); } catch {} }
    if (report && !report.ok) {
      throw codedError(report.code || "ELEVATED_BRANDING_FAILED", report.message || "Yonetici islemi tamamlanamadi.");
    }
    if (launchError) throw launchError;
    if (!report) throw codedError("ELEVATION_RESULT_MISSING", "Yonetici isleminin sonucu okunamadi.");
    return report.result;
  }
  return { run };
}

module.exports = { createElevationRunner };
