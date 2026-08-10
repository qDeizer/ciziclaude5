"use strict";

const { codedError } = require("./fsx");

// Tek sorumluluk: resmi Claude Desktop paketini baslatmak ve calisip
// calismadigini bildirmek. Baska hicbir uygulamaya dokunmaz.

function createAppLauncher({ logger, powershell }) {
  async function appUserModelId(packageInfo) {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$m=Get-AppxPackageManifest -Package $env:CIZI_LAB_PACKAGE",
      "$id=[string]@($m.Package.Applications.Application)[0].Id",
      "if([string]::IsNullOrWhiteSpace($id)){throw 'APP_ID_NOT_FOUND'}",
      "$id",
    ].join("\n");
    const applicationId = String(
      await powershell.run(script, {
        timeoutMs: 30000,
        env: { CIZI_LAB_PACKAGE: packageInfo.packageFullName },
      }),
    ).trim();
    if (!applicationId) throw codedError("APP_ID_NOT_FOUND", "Claude uygulama kimligi bulunamadi.");
    return `${packageInfo.packageFamilyName}!${applicationId}`;
  }

  async function launch(packageInfo) {
    const aumid = await appUserModelId(packageInfo);
    await powershell.run(
      "$ErrorActionPreference='Stop';Start-Process -FilePath ('shell:AppsFolder\\' + $env:CIZI_LAB_AUMID)",
      { timeoutMs: 30000, env: { CIZI_LAB_AUMID: aumid } },
    );
    logger.success("launcher", "Claude Desktop baslatildi", { appUserModelId: aumid });
    return { launched: true, appUserModelId: aumid };
  }

  return { launch, appUserModelId };
}

module.exports = { createAppLauncher };
