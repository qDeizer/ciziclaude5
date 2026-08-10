"use strict";

const fs = require("fs");
const path = require("path");
const { codedError, ensureDir, readJsonIfExists, writeJsonAtomic } = require("./fsx");

// Tek sorumluluk: Claude Desktop'i test amaciyla gateway moduna almak.
//
// Neden bu lab'in icinde: yamalanan etiketler (ornegin sol alttaki saglayici
// adi) yalnizca aktif saglayici 'gateway' iken render edilir. Yamayi
// dogrulayabilmek icin bu on kosula ihtiyacimiz var. Bu lab bagimsiz
// calisabilmeli, bu yuzden on kosulu kendisi kurar.
//
// Gateway modu HKCU altinda bir politika anahtaridir. HKCU olmasina ragmen
// YONETICI GEREKTIRIR: Windows, HKCU\SOFTWARE\Policies alt agacini standart
// kullaniciya kapatir (politikanin amaci da bu). Yani dosya yamasi gibi bu adim
// da yukseltilmis bir terminal ister.
//
// Mevcut politika varsa once yedeklenir ve 'gateway-off' ile aynen geri yuklenir.

const POLICY_PATH = "HKCU:\\SOFTWARE\\Policies\\Claude";
const MACHINE_POLICY_PATH = "HKLM:\\SOFTWARE\\Policies\\Claude";

// Bu lab'in yazdigi degerler. 'gateway-off' yalnizca bunlari geri alir.
const MANAGED_VALUES = [
  "inferenceProvider",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayAuthScheme",
  "inferenceGatewayApiKey",
  "inferenceModels",
  "modelDiscoveryEnabled",
];

function createGatewayModeService({ logger, powershell, elevation, workRoot }) {
  function backupPath() {
    return path.join(workRoot, "gateway-policy-backup.json");
  }

  async function readPolicy(registryPath = POLICY_PATH) {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$p=[string]$env:CIZI_LAB_POLICY_PATH",
      "if(-not (Test-Path -LiteralPath $p)){'null'}",
      "else{",
      "$k=Get-Item -LiteralPath $p",
      "$o=[ordered]@{}",
      "foreach($n in $k.GetValueNames()){$o[$n]=[string](Get-ItemProperty -LiteralPath $p -Name $n).$n}",
      "if($o.Count -eq 0){'{}'}else{[pscustomobject]$o|ConvertTo-Json -Compress}",
      "}",
    ].join("\n");
    const output = await powershell.run(script, {
      timeoutMs: 20000,
      env: { CIZI_LAB_POLICY_PATH: registryPath },
    });
    if (!output || output === "null") return null;
    try {
      return JSON.parse(output);
    } catch (cause) {
      throw codedError("POLICY_READ_INVALID", "Claude politika anahtari okunamadi.", cause);
    }
  }

  async function assertNoMachinePolicy() {
    const machine = await readPolicy(MACHINE_POLICY_PATH);
    if (machine && Object.keys(machine).length) {
      throw codedError(
        "MACHINE_POLICY_PRESENT",
        "Makine düzeyinde bir Claude politikası var; bu lab onu geçersiz kılmaz.",
      );
    }
  }

  async function writeValues(values) {
    const names = Object.keys(values);
    const environment = { CIZI_LAB_NAMES: names.join("|") };
    names.forEach((name, index) => { environment[`CIZI_LAB_V${index}`] = String(values[name]); });
    const script = [
      "$ErrorActionPreference='Stop'",
      `if(-not (Test-Path -LiteralPath '${POLICY_PATH}')){New-Item -Path '${POLICY_PATH}' -Force | Out-Null}`,
      "$names=[string]$env:CIZI_LAB_NAMES -split '\\|'",
      "for($i=0;$i -lt $names.Count;$i++){",
      "$n=$names[$i];$v=[string](Get-Item -LiteralPath (\"env:CIZI_LAB_V$i\")).Value;",
      `New-ItemProperty -LiteralPath '${POLICY_PATH}' -Name $n -Value $v -PropertyType String -Force | Out-Null}`,
      "'ok'",
    ].join("\n");
    const output = await powershell.run(script, { timeoutMs: 30000, env: environment });
    if (String(output).trim() !== "ok") {
      throw codedError("POLICY_WRITE_FAILED", "Gateway politikası yazılamadı.");
    }
  }

  async function removeValues(names) {
    if (!names.length) return;
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$names=[string]$env:CIZI_LAB_NAMES -split '\\|'",
      `foreach($n in $names){Remove-ItemProperty -LiteralPath '${POLICY_PATH}' -Name $n -Force -ErrorAction SilentlyContinue}`,
      `$k=Get-Item -LiteralPath '${POLICY_PATH}' -ErrorAction SilentlyContinue`,
      `if($k -and $k.GetValueNames().Count -eq 0 -and $k.SubKeyCount -eq 0){Remove-Item -LiteralPath '${POLICY_PATH}' -Force}`,
      "'ok'",
    ].join("\n");
    await powershell.run(script, { timeoutMs: 30000, env: { CIZI_LAB_NAMES: names.join("|") } });
  }

  async function enable({ baseUrl, apiKey = null, model = null } = {}) {
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      throw codedError("BASE_URL_REQUIRED", "Gateway modu icin gecerli bir --base-url gerekiyor (ornek: http://127.0.0.1:8080).");
    }
    await elevation.assertElevated("Claude gateway politikasini yazmak");
    await assertNoMachinePolicy();

    const existing = await readPolicy();
    ensureDir(workRoot);
    if (!fs.existsSync(backupPath())) {
      writeJsonAtomic(backupPath(), {
        schemaVersion: 1,
        capturedPolicy: existing,
        note: "Bu lab gateway modunu ilk kez acmadan onceki HKCU Claude politikasi. gateway-off bunu geri yukler.",
      });
      logger.success("gateway", "Onceki Claude politikasi yedeklendi", {
        hadPolicy: existing !== null,
        valueCount: existing ? Object.keys(existing).length : 0,
      });
    } else {
      logger.info("gateway", "Yedek zaten var; uzerine yazilmadi", { backupPath: backupPath() });
    }

    const values = {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: baseUrl,
      inferenceGatewayAuthScheme: "bearer",
      modelDiscoveryEnabled: model ? "false" : "true",
    };
    if (apiKey) values.inferenceGatewayApiKey = apiKey;
    if (model) values.inferenceModels = JSON.stringify([{ name: model }]);

    await writeValues(values);
    const after = await readPolicy();
    if (after?.inferenceProvider !== "gateway") {
      throw codedError("GATEWAY_MODE_UNVERIFIED", "Gateway modu yazildi ama dogrulanamadi.");
    }
    logger.success("gateway", "Claude gateway moduna alindi", {
      baseUrl,
      apiKey: apiKey || null,
      model: model || null,
      writtenValues: Object.keys(values),
    });
    return { enabled: true, values: Object.keys(values), policy: after };
  }

  async function disable() {
    const backup = readJsonIfExists(backupPath());
    const current = await readPolicy();
    if (current) await elevation.assertElevated("Claude gateway politikasini kaldirmak");
    if (!current) {
      logger.info("gateway", "Gateway politikasi zaten yok", {});
      return { disabled: true, restored: false };
    }

    // Yalnizca bu lab'in yazdigi degerler kaldirilir; kullanicinin kendi
    // degerlerine dokunulmaz.
    const ours = MANAGED_VALUES.filter((name) => Object.prototype.hasOwnProperty.call(current, name));
    await removeValues(ours);

    let restored = false;
    if (backup?.capturedPolicy && Object.keys(backup.capturedPolicy).length) {
      await writeValues(backup.capturedPolicy);
      restored = true;
      logger.success("gateway", "GERI ALMA: onceki Claude politikasi geri yuklendi", {
        valueCount: Object.keys(backup.capturedPolicy).length,
      });
    } else {
      logger.success("gateway", "GERI ALMA: bu lab'in yazdigi gateway degerleri kaldirildi", {
        removed: ours,
      });
    }

    const after = await readPolicy();
    return { disabled: true, restored, removed: ours, policy: after };
  }

  async function status() {
    const [policy, machine] = await Promise.all([readPolicy(), readPolicy(MACHINE_POLICY_PATH)]);
    const provider = policy?.inferenceProvider || null;
    return {
      registryPath: POLICY_PATH,
      active: provider === "gateway",
      provider,
      baseUrl: policy?.inferenceGatewayBaseUrl || null,
      valueCount: policy ? Object.keys(policy).length : 0,
      machinePolicyPresent: !!(machine && Object.keys(machine).length),
      backupPresent: fs.existsSync(backupPath()),
    };
  }

  return { enable, disable, status, readPolicy, backupPath };
}

module.exports = { createGatewayModeService, POLICY_PATH, MANAGED_VALUES };
