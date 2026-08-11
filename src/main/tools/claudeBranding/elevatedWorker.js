"use strict";

// This file is deliberately small: it is started only by the UAC-approved
// child and performs the protected file operation. The desktop process keeps
// ownership of the rest of the switch transaction.
const fs = require("fs");
const path = require("path");
const branding = require("../claudeDesktopBranding");

function writeResult(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

async function main() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing elevated Claude branding request.");
  const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const engine = branding.createBrandingEngine({ workRoot: request.workRoot });
  let result;
  if (request.operation === "ensure") {
    const packageInfo = branding.toPackageInfo(request.main);
    const outcome = await engine.reconcileService.ensurePatched(packageInfo, engine.dictionary, { confirm: true });
    if (!outcome.verification?.allPatched) throw new Error("Claude branding could not be verified.");
    result = { changed: !!outcome.changed, files: outcome.verification.files.length };
  } else if (request.operation === "restore") {
    const resultValue = await engine.applyService.restore(branding.toPackageInfo(request.main), { confirm: true });
    result = { restored: !!resultValue.restored, reason: resultValue.reason || null, files: resultValue.files || [] };
  } else {
    throw new Error("Unknown elevated Claude branding operation.");
  }
  writeResult(request.resultPath, { ok: true, result });
}

main().catch((error) => {
  const encoded = process.argv[2];
  try {
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    writeResult(request.resultPath, { ok: false, code: error?.code || "ELEVATED_BRANDING_FAILED", message: String(error?.message || error) });
  } catch { /* the caller reports a missing result */ }
  process.exitCode = 1;
});
