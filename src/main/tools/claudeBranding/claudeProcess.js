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
//
// Ucuncu ayrim: UYGULAMA sureci ile paketin kendi WINDOWS SERVISI ayni sey
// degil. Claude'un MSIX paketi 'CoworkVMService' adiyla LocalSystem altinda,
// otomatik baslangicla calisan bir servis kaydeder ve ikilisi tam da
// yamaladigimiz klasorun icindedir (app\resources\cowork-svc.exe). Yani Claude
// Desktop kapaliyken bile hedef klasorden calisan bir surec vardir - ustelik
// kullanicinin kapatabilecegi bir surec degildir.
//
// Bu surec "klasor kullanimda" sayilirsa anahtar HICBIR makinede acilamaz:
// kullanici Claude'u kapatir, yine ayni hatayi alir. Yamalanan dosyalar i18n
// kataloglari ve arayuz paketidir; bir servis ikilisi asla hedef degildir ve
// servisin o dosyalari acik tutmasi icin de bir sebep yoktur. Dosyayi gercekten
// kilitli tutan bir surec olsaydi zaten yazma anINDA hata alinir ve applyService
// yedekten geri donerdi - yani bu ayrim guvenligi degil, yalnizca gereksiz bir
// reddi kaldirir.

function normaliseRoot(installLocation) {
  return String(installLocation || "").replace(/[\\/]+$/, "");
}

function normalisePath(value) {
  return String(value || "").trim().toLowerCase();
}

// Win32_Service.PathName komut satiridir: tirnakli olabilir ve arguman
// tasiyabilir. Karsilastirilacak olan yalnizca ikilinin yoludur.
function serviceImagePath(pathName) {
  const raw = String(pathName || "").trim();
  if (!raw) return "";
  if (raw.startsWith("\"")) {
    const end = raw.indexOf("\"", 1);
    return end > 1 ? raw.slice(1, end) : raw.slice(1);
  }
  const match = /^(.*?\.exe)(?:\s|$)/i.exec(raw);
  return match ? match[1] : raw;
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

  // Kurulum klasoru altindan calisan bir ikiliyi calistiran WINDOWS SERVISLERI.
  //
  // Neden surec listesinden degil de servis kaydindan okunuyor: Get-Process bir
  // SYSTEM surecinin yolunu yalnizca yonetici baglaminda verir. Yani ayni
  // makinede yetkisiz tarama servisi hic gormez, yukseltilmis tarama gorur -
  // ve yama tam da yukseltilmis baglamda calisir. Win32_Service ise her
  // kullaniciya okunur, dolayisiyla siniflandirma iki baglamda da ayni sonucu
  // verir.
  async function servicesUnder(installLocation) {
    const root = normaliseRoot(installLocation);
    if (!root) return [];
    // CimCmdlets modulu bu makinelerde zaman zaman yuklenemiyor; projenin geri
    // kalaninda oldugu gibi WMI dogrudan System.Management uzerinden sorulur.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$searcher=New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId,Name,PathName,State FROM Win32_Service')",
      "$list=@(@($searcher.Get())|ForEach-Object{[pscustomobject]@{id=[int]$_.ProcessId;name=[string]$_.Name;state=[string]$_.State;image=[string]$_.PathName}})",
      "if($list.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject @($list) -Compress}",
    ].join("\n");
    let parsed;
    try {
      const output = await powershell.run(script, { timeoutMs: 30000 });
      const text = String(output || "").trim();
      if (!text || text === "[]") return [];
      parsed = JSON.parse(text);
    } catch (cause) {
      // Servis kaydi okunamadiysa hicbir surec "servis" diye ayiklanmaz: kapali
      // tarafa duserek eski, kati davranis korunur.
      logger?.warning("process", "Servis kaydi okunamadi; hedef klasordeki tum surecler engelleyici sayilacak", {
        error: String(cause?.message || cause),
      });
      return [];
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const prefix = normalisePath(`${root}\\`);
    return rows
      .map((item) => ({
        id: Number(item?.id) || 0,
        name: String(item?.name || ""),
        state: String(item?.state || ""),
        image: serviceImagePath(item?.image),
      }))
      .filter((item) => item.image && normalisePath(item.image).startsWith(prefix));
  }

  // Hedef klasor kullanimda mi? Yama/geri alma icin belirleyici kontrol budur.
  // Paketin kendi servisleri "kullanimda" saymaz; ayrimin gerekcesi dosyanin
  // basindaki nottadir.
  async function runsFrom(installLocation) {
    const processes = await processesUnder(installLocation);
    const services = await servicesUnder(installLocation);
    const servicePids = new Set(services.map((item) => item.id).filter((id) => id > 0));
    const serviceImages = new Set(services.map((item) => normalisePath(item.image)));
    // Hem PID hem yol ile eslesilir: servis iki sorgu arasinda yeniden
    // baslarsa PID degisir, ikilinin yolu degismez.
    const isService = (item) => servicePids.has(Number(item.id)) || serviceImages.has(normalisePath(item.path));
    const blocking = processes.filter((item) => !isService(item));
    const serviceProcesses = processes.filter(isService);
    if (serviceProcesses.length && !blocking.length) {
      logger?.info("process", "Hedef klasorde yalnizca paketin Windows servisi calisiyor; yama engellenmedi", {
        services: serviceProcesses.map((item) => `${item.name}#${item.id}`),
      });
    }
    return {
      runsFromTarget: blocking.length > 0,
      processes: blocking,
      paths: blocking.map((item) => item.path),
      services,
      serviceProcesses,
      allProcesses: processes,
    };
  }

  // Yalnizca hedef klasorden calisan surecleri kapatir. Ada gore DEGIL, yola
  // gore secildikleri icin Claude Code CLI gibi ayni adli surecler etkilenmez.
  // Paketin Windows servisi de kapsam disidir: onu durdurmak Windows'un isidir,
  // uygulamayi kapatmakla ilgisi yoktur ve zaten kendiliginden geri baslar.
  async function closeDesktop(installLocation, { confirm = false, forceAfterMs = 8000 } = {}) {
    // Once "yapilacak bir sey var mi" sorulur. Kapatilacak surec yoksa onaya
    // gerek yoktur ve komut basariyla doner - cagiranlar bunu bir kontrol
    // sorgusu olarak kullanabilir.
    const before = (await runsFrom(installLocation)).processes;
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

    const after = (await runsFrom(installLocation)).processes;
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

  return { processesUnder, servicesUnder, runsFrom, closeDesktop };
}

module.exports = { createClaudeProcess };
