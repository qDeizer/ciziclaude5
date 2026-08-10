"use strict";

const { codedError } = require("./fsx");

// Tek sorumluluk: Claude DESKTOP sureclerini dogru sekilde tespit etmek.
//
// DIKKAT - isim yeterli degil: Claude Code CLI'nin calistirilabiliri de
// 'claude.exe'. Yani `Get-Process -Name claude` Claude Code'u da yakalar.
// Ada gore kapatmak kullanicinin Claude Code oturumunu oldurebilir.
// Bu yuzden tespit HER ZAMAN calistirilabilirin YOLUNA gore yapilir.
//
// Ikinci onemli ayrim: "Claude Desktop acik mi" ile "YAMALAYACAGIMIZ klasor
// kullanimda mi" ayni sey degil. MSIX guncellemesi yeni surumu yeni bir klasore
// kurar; calisan ornek ESKI klasoru kullanmaya devam eder ve yeni surum ancak
// bir sonraki baslatmada devreye girer. Guncellemeden sonra hedef klasorde
// okuyucu yoktur, yani Claude acikken yeni klasoru yamalamak guvenlidir.

function normaliseRoot(installLocation) {
  return String(installLocation || "").replace(/[\\/]+$/, "");
}

function createClaudeProcess({ powershell, logger }) {
  // Verilen kurulum dizini altindan calisan TUM surecler (Claude.exe,
  // cowork-svc.exe vb.). Yol okunamayan surecler sessizce atlanir.
  async function processesUnder(installLocation) {
    const root = normaliseRoot(installLocation);
    if (!root) return [];
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$root=[string]$env:CIZI_ROOT",
      "$list=@(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {",
      "  $p=$null; try { $p=$_.Path } catch { $p=$null }",
      "  if($p -and $p.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase)){",
      "    [pscustomobject]@{id=$_.Id;name=[string]$_.ProcessName;path=[string]$p}}})",
      "if($list.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject @($list) -Compress}",
    ].join("\n");
    const output = await powershell.run(script, {
      timeoutMs: 30000,
      env: { CIZI_ROOT: `${root}\\` },
    });
    const text = String(output || "").trim();
    if (!text || text === "[]") return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (cause) {
      throw codedError("PROCESS_QUERY_INVALID", "Surec listesi okunamadi.", cause);
    }
  }

  // Hedef klasor kullanimda mi? Yama/geri alma icin belirleyici kontrol budur.
  async function runsFrom(installLocation) {
    const processes = await processesUnder(installLocation);
    return {
      runsFromTarget: processes.length > 0,
      processes,
      paths: processes.map((item) => item.path),
    };
  }

  // Yalnizca hedef klasorden calisan surecleri kapatir. Ada gore DEGIL, yola
  // gore secildikleri icin Claude Code CLI gibi ayni adli surecler etkilenmez.
  async function closeDesktop(installLocation, { confirm = false, forceAfterMs = 8000 } = {}) {
    // Once "yapilacak bir sey var mi" sorulur. Kapatilacak surec yoksa onaya
    // gerek yoktur ve komut basariyla doner - cagiranlar bunu bir kontrol
    // sorgusu olarak kullanabilir.
    const before = await processesUnder(installLocation);
    if (!before.length) return { closed: false, reason: "NOT_RUNNING", processes: [] };
    if (confirm !== true) {
      throw codedError("CONFIRMATION_REQUIRED", "Claude Desktop acik; kapatmak icin acik onay gerekiyor.");
    }

    const ids = before.map((item) => item.id).join(",");
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$ids=[string]$env:CIZI_PIDS -split ','",
      "foreach($id in $ids){ if($id){ Stop-Process -Id ([int]$id) -ErrorAction SilentlyContinue } }",
      `Start-Sleep -Milliseconds ${Math.max(500, Number(forceAfterMs) || 8000)}`,
      "foreach($id in $ids){ if($id){ Stop-Process -Id ([int]$id) -Force -ErrorAction SilentlyContinue } }",
      "'ok'",
    ].join("\n");
    await powershell.run(script, { timeoutMs: 60000, env: { CIZI_PIDS: ids } });

    const after = await processesUnder(installLocation);
    if (after.length) {
      throw codedError(
        "CLAUDE_CLOSE_FAILED",
        `Claude Desktop kapatilamadi (${after.length} surec halen calisiyor).`,
      );
    }
    logger?.success("process", "Claude Desktop kapatildi (yalnizca hedef klasorden calisan surecler)", {
      closedProcesses: before.map((item) => `${item.name}#${item.id}`),
    });
    return { closed: true, processes: before };
  }

  return { processesUnder, runsFrom, closeDesktop };
}

module.exports = { createClaudeProcess };
