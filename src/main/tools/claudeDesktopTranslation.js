const overlay = require("./claudeDesktopOverlay");

function unsupportedSquirrelError() {
  const error = new Error(
    "Bu Claude Desktop kurulumu resmi uygulama dosyalarına dokunmadan Cizi Code arayüz katmanını desteklemiyor.",
  );
  error.code = "CLAUDE_SQUIRREL_OVERLAY_UNSUPPORTED";
  return error;
}

async function ensureForMain(main, options) {
  if (main?.installKind === "squirrel") throw unsupportedSquirrelError();
  return overlay.ensureForMain(main, options);
}

async function removeForState(state) {
  if (state?.mainPackage?.installKind === "squirrel") return { removed: false, unsupported: true };
  return overlay.removeForState(state);
}

async function queryInstalledOverlay() {
  return overlay.queryInstalledOverlay();
}

async function removeOwnedOrphanForMain(main, options) {
  if (main?.installKind === "squirrel") return { removed: false, unsupported: true };
  return overlay.removeOwnedOrphanForMain(main, options);
}

module.exports = { ensureForMain, removeForState, removeOwnedOrphanForMain, queryInstalledOverlay };
