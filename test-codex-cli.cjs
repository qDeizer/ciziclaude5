const assert = require("assert");
const os = require("os");
const path = require("path");
const { createCodexCliService } = require("./src/main/codexCli");

const executable = "C:\\Program Files\\OpenAI\\Codex\\bin\\codex.exe";
let launched = null;
let unreferenced = false;

const service = createCodexCliService({
  userDataPath: path.join(os.tmpdir(), "cizi-codex-cli-test"),
  log: { info: () => {} },
  detect: async () => ({ installed: true, command: executable, version: "codex-cli test" }),
  spawnProcess: (command, args, options) => {
    launched = { command, args, options };
    return { unref: () => { unreferenced = true; } };
  },
});

(async () => {
  const result = await service.open({ model: "gpt-5.6-luna", useCiziProfile: true });
  assert.deepStrictEqual(result, { opened: true, command: executable, profile: "cizicode", model: "gpt-5.6-luna" });
  assert(/cmd\.exe$/i.test(launched.command), "Windows must use its console launcher");
  assert.deepStrictEqual(launched.args.slice(0, 3), ["/d", "/s", "/c"], "The console launcher must disable command autorun and preserve quoting");
  assert(launched.args[3].includes(`"${executable}"`), "Open must target the detected Codex executable directly");
  assert(launched.args[3].includes('"--profile" "cizicode" "-m" "gpt-5.6-luna"'), "Profile and model must be passed as separate arguments");
  assert.strictEqual(launched.options.detached, true, "The Codex window must outlive the desktop app request");
  assert.strictEqual(launched.options.windowsHide, false, "The Codex console must be visible to the user");
  assert.strictEqual(launched.options.windowsVerbatimArguments, true, "cmd.exe must receive the quoted executable path verbatim");
  assert(unreferenced, "The launcher process must be unreferenced after opening");
  launched = null;
  unreferenced = false;
  const plainResult = await service.open({ model: "gpt-5.6-luna", useCiziProfile: false });
  assert.deepStrictEqual(plainResult, { opened: true, command: executable, profile: null, model: null });
  assert(launched.args[3].includes(`"${executable}"`), "Plain open must still target the detected Codex executable directly");
  assert(!launched.args[3].includes("--profile") && !launched.args[3].includes("-m"), "Plain open must not require the Cizi Code profile or its model");
  assert(unreferenced, "The plain launcher process must be unreferenced after opening");
  console.log("✅ Codex direct-launch test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
