// ChatGPT Desktop service: installer progress parsing, detection shape, and the
// conditional-removal preview. Nothing here installs or removes anything.
const desktop = require("./src/main/codexDesktop.js");
const paths = require("./src/main/codexPaths.js");

let fail = 0;
function check(label, condition, extra) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!condition) fail++;
}

console.log("--- winget progress parsing ---");
// [line, expected percent, expected named phase]
const PROGRESS_CASES = [
  ["  ██████████  12.4 MB / 88.0 MB", 14, null],
  ["Downloading https://example.com/pkg", null, "download"],
  ["  45%", 45, null],
  ["Successfully verified installer hash", null, "verify"],
  ["Starting package install...", null, "install"],
  ["Kurulum baslatiliyor", null, "install"],
  ["Indiriliyor 5,5 MB / 11,0 MB", 50, "download"],
  ["random noise", null, null],
  // Out-of-range percentages are noise, not progress.
  ["999%", null, null],
];
for (const [line, percent, phase] of PROGRESS_CASES) {
  const progress = desktop.parseProgress(line);
  const gotPercent = progress ? progress.percent : null;
  const gotPhase = desktop.parsePhase(line);
  check(`parse ${JSON.stringify(line)}`, gotPercent === percent && gotPhase === phase, `percent=${gotPercent} phase=${gotPhase}`);
}
// Byte counters must win over a bare percentage on the same line.
const bytes = desktop.parseProgress("  50%  10.0 MB / 40.0 MB");
check("byte counters take priority over a bare percentage", bytes?.percent === 25, `got ${bytes?.percent}`);

console.log("\n--- detection ---");
(async () => {
  const status = await desktop.detectCodexDesktop();
  check("detect returns the package identity", status.packageFamilyName === "OpenAI.Codex_2p2nqsd0c76g0");
  check("detect reports the verified Store id", status.storeId === "9PLM9XGG6VKS");
  check("detect reports a boolean install state", typeof status.installed === "boolean");
  if (status.installed) {
    check("installed package reports a version", Boolean(status.version), status.version);
    check("installed package reports its real path", Boolean(status.installLocation), status.installLocation);
    // The version must come from Windows, never from a hard-coded constant.
    check("install location is not hard-coded", !paths.desktopPaths().packageStateDir.includes(String(status.version)));
  } else {
    console.log("  (ChatGPT Desktop is not installed here; install-specific checks skipped)");
  }

  console.log("\n--- removal preview ---");
  const service = desktop.createCodexDesktopService({
    userDataPath: require("os").tmpdir(),
    log: { info() {}, warn() {}, error() {} },
    detect: async () => ({ installed: true, packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0" }),
  });
  const withCli = await service.planUninstall({ cliInstalled: true });
  const alone = await service.planUninstall({ cliInstalled: false });
  const shared = paths.sharedPaths().root;
  check("preview protects shared data while the CLI is installed", withCli.sharedRemovable === false);
  check("preview never lists the shared folder for deletion then", !withCli.remove.some((item) => item.path === shared));
  check("preview allows shared cleanup when the CLI is absent", alone.sharedRemovable === true);
  check("preview names the shared root", alone.sharedRoot === shared);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
