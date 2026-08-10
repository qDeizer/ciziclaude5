"use strict";

const fs = require("fs");
const path = require("path");
const { codedError } = require("./fsx");

// Tek sorumluluk: kurulu resmi Claude Desktop paketini bulmak ve kimligini
// dogrulamak. Yama uretimi ve uygulama bu modulun isi degildir.

const EXPECTED_PUBLISHER_FRAGMENT = "Anthropic";
const EXPECTED_FAMILY_NAME = "Claude_pzs8sxrjxfjjc";

function createClaudePackageService({ powershell, logger }) {
  async function detect() {
    // MSIX paketleri KULLANICI BASINA kayitlidir. Onarim gorevi SYSTEM olarak
    // calistigi icin kendi baglaminda Claude'u gormez; o durumda -AllUsers ile
    // makine genelindeki kayda bakilir (yonetici/SYSTEM hakki gerektirir).
    // Kurulum dizini makine genelinde ayni oldugu icin yama yolu degismez.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$p=Get-AppxPackage -Name Claude | Where-Object {$_.Status -eq 'Ok'} | Sort-Object Version -Descending | Select-Object -First 1",
      "if($null -eq $p){",
      "  try{$p=Get-AppxPackage -AllUsers -Name Claude -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1}catch{$p=$null}",
      "}",
      "if($null -eq $p){'null'}else{[pscustomobject]@{",
      "Name=[string]$p.Name;Version=[string]$p.Version;PackageFullName=[string]$p.PackageFullName;",
      "PackageFamilyName=[string]$p.PackageFamilyName;Publisher=[string]$p.Publisher;",
      "InstallLocation=[string]$p.InstallLocation;Status=[string]$p.Status",
      "}|ConvertTo-Json -Compress}",
    ].join("\n");

    const output = await powershell.run(script, { timeoutMs: 30000 });
    if (!output || output === "null") {
      throw codedError("CLAUDE_NOT_INSTALLED", "Kurulu bir Claude Desktop paketi bulunamadi.");
    }

    let raw;
    try {
      raw = JSON.parse(output);
    } catch (cause) {
      throw codedError("CLAUDE_QUERY_INVALID", "Windows gecersiz bir paket bilgisi dondurdu.", cause);
    }

    const info = {
      name: String(raw.Name || ""),
      version: String(raw.Version || ""),
      packageFullName: String(raw.PackageFullName || ""),
      packageFamilyName: String(raw.PackageFamilyName || ""),
      publisher: String(raw.Publisher || ""),
      installLocation: String(raw.InstallLocation || ""),
      status: String(raw.Status || ""),
    };

    assertIdentity(info);
    logger.info("claude-package", "Kurulu Claude Desktop paketi dogrulandi", {
      version: info.version,
      packageFullName: info.packageFullName,
    });
    return Object.freeze(info);
  }

  function assertIdentity(info) {
    if (info.name !== "Claude" || info.packageFamilyName !== EXPECTED_FAMILY_NAME) {
      throw codedError("CLAUDE_IDENTITY_INVALID", "Paket kimligi resmi Claude Desktop ile uyusmuyor.");
    }
    if (!info.publisher.includes(EXPECTED_PUBLISHER_FRAGMENT)) {
      throw codedError("CLAUDE_PUBLISHER_INVALID", "Paket yayimcisi Anthropic degil; yama uretilmeyecek.");
    }
    if (!/^\d+(?:\.\d+){2,3}$/.test(info.version)) {
      throw codedError("CLAUDE_VERSION_INVALID", "Paket surumu okunamadi.");
    }
    if (!info.installLocation || !fs.existsSync(info.installLocation)) {
      throw codedError("CLAUDE_INSTALL_LOCATION_MISSING", "Paketin kurulum dizini bulunamadi.");
    }
    const appDirectory = path.join(info.installLocation, "app");
    if (!fs.existsSync(appDirectory)) {
      throw codedError("CLAUDE_LAYOUT_UNEXPECTED", "Paket icinde beklenen 'app' dizini yok.");
    }
    return info;
  }

  return { detect, assertIdentity };
}

module.exports = { createClaudePackageService, EXPECTED_FAMILY_NAME, EXPECTED_PUBLISHER_FRAGMENT };
