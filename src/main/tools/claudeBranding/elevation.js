"use strict";

const { codedError } = require("./fsx");

// Tek sorumluluk: yukseltilmis (yonetici) haklarla calisip calismadigimizi
// bildirmek. Iki yerde gerekiyor:
//   - WindowsApps altindaki dosyalari yamalamak
//   - HKCU\SOFTWARE\Policies altina yazmak (Policies alt agaci standart
//     kullaniciya kapalidir; HKCU olmasi yaniltici)

function createElevation({ powershell }) {
  async function isElevated() {
    const output = await powershell.run(
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())"
      + ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    );
    return String(output).trim().toLowerCase() === "true";
  }

  async function assertElevated(what) {
    if (await isElevated()) return true;
    throw codedError(
      "ELEVATION_REQUIRED",
      `${what} icin yonetici hakki gerekiyor. Yonetici olarak acilmis bir terminalde tekrar dene.`,
    );
  }

  return { isElevated, assertElevated };
}

module.exports = { createElevation };
