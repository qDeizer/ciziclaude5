"use strict";

// Onarim gorevinin giris noktasi. Cizi Code KAPALI olsa da calisir.
//
// NASIL CALISIR
// Zamanlanmis gorev bunu, uygulamanin kendi Electron ikilisini ELECTRON_RUN_AS_NODE
// ile duz Node olarak kullanarak calistirir: pencere acilmaz, oturum gerekmez,
// SYSTEM baglaminda session 0 sorunu yasanmaz. Bu yuzden bu dosya ve bagimliliklari
// ASLA 'electron' modulunu require etmez.
//
// NE YAPAR
//   niyet acik  -> yamanin yerinde olmasini saglar (idempotent)
//   niyet kapali-> yamayi geri alir (yarim kalmis bir OFF'u tamamlar)
//   niyet yok   -> hicbir sey yapmaz
//
// Karar HER ZAMAN dosya hash'ine bakilarak verilir, "guncelleme oldu mu"
// tahminiyle degil. Bu yuzden gorevin tetikleyicilerinin genis olmasi (AppX olayi,
// acilis, oturum, periyodik) sorun degil: gereksiz calisma sessizce "islem yok"
// ile biter.

// NOT: Claude'un app.asar dosyasini ham bayt olarak okurken Electron'un asar
// yamasinin devre disi olmasi gerekir. Bu, okumanin yapildigi yerde
// (targetScanner.inspectAsar) dar kapsamli olarak ele alinir - burada global bir
// ayar YAPILMAZ, cunku ayni duzeltmenin Cizi Code'un ana surecinde de gecerli
// olmasi gerekiyor ve tek bir is icin iki ayri mekanizma tutmak yaniltici olur.

const path = require("path");
const { createLogger } = require("./logger");
const { createPowerShell } = require("./powershell");
const { createClaudePackageService } = require("./claudePackage");
const { createClaudeProcess } = require("./claudeProcess");
const { createTargetScanner } = require("./targetScanner");
const { createCatalogPatcher } = require("./catalogPatcher");
const { createLabelPatcher } = require("./labelPatcher");
const { createBuildService } = require("./buildService");
const { createApplyService } = require("./applyService");
const { createReconcileService } = require("./reconcileService");
const { createElevation } = require("./elevation");
const { createLock } = require("./lock");
const { readJson } = require("./fsx");
const desiredState = require("./desiredState");

const DICTIONARY_DIRECTORY = path.join(__dirname, "dictionary");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--work-root") { values.workRoot = argv[index + 1]; index += 1; }
  }
  return values;
}

function loadDictionary(directory) {
  const labelsPath = path.join(directory, "tr-TR.labels.json");
  const catalogPath = path.join(directory, "tr-TR.catalog.json");
  const labels = readJson(labelsPath);
  const catalog = readJson(catalogPath);
  return {
    labels: { rules: labels.rules, tokenRules: labels.tokenRules || [] },
    catalog: { entries: catalog?.entries || {} },
    paths: { labels: labelsPath, catalog: catalogPath },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ minLevel: "info" });

  if (!args.workRoot) {
    logger.error("repair", "Calisma dizini verilmedi (--work-root); islem yapilmadi");
    return 2;
  }
  const workRoot = path.resolve(args.workRoot);

  const desired = desiredState.read(workRoot);
  if (!desired.known) {
    logger.info("repair", "Markalama niyeti kayitli degil; islem yok", { workRoot });
    return 0;
  }

  const powershell = createPowerShell();
  const claudePackage = createClaudePackageService({ powershell, logger });
  const claudeProcess = createClaudeProcess({ powershell, logger });

  let packageInfo;
  try {
    packageInfo = await claudePackage.detect();
  } catch (error) {
    // Claude kaldirilmis olabilir: bu bir hata degil, yapilacak is yok demektir.
    if (error?.code === "CLAUDE_NOT_INSTALLED") {
      logger.info("repair", "Claude Desktop kurulu degil; islem yok");
      return 0;
    }
    throw error;
  }

  const dictionary = loadDictionary(DICTIONARY_DIRECTORY);
  const scanner = createTargetScanner({ logger });
  const buildService = createBuildService({
    logger,
    scanner,
    catalogPatcher: createCatalogPatcher({ logger }),
    labelPatcher: createLabelPatcher({ logger }),
    workRoot,
    dictionaryPaths: dictionary.paths,
    generatedBy: "cizi-code-claude-branding-repair/1",
  });
  const applyService = createApplyService({
    logger,
    powershell,
    elevation: createElevation({ powershell }),
    claudeProcess,
    lock: createLock({ logger, workRoot, name: "claude-branding" }),
    workRoot,
  });

  if (!desired.enabled) {
    // Switch kapali olmali: yamali dosya varsa geri konur. Yedek yoksa
    // applyService "geri alinacak sey yok" der, hata atmaz.
    const result = await applyService.restore(packageInfo, { confirm: true });
    logger.success("repair", "Kapali niyet uygulandi", {
      version: packageInfo.version,
      restored: result.restored,
      reason: result.reason || null,
    });
    return 0;
  }

  const reconcileService = createReconcileService({ logger, buildService, applyService });
  try {
    const outcome = await reconcileService.ensurePatched(packageInfo, dictionary, { confirm: true });
    logger.success("repair", "Markalama denetimi tamamlandi", {
      version: packageInfo.version,
      changed: outcome.changed,
      steps: outcome.steps,
    });
    return 0;
  } catch (error) {
    // Claude hedef surumden calisiyorsa yamalanamaz; bu beklenen bir durumdur ve
    // gorev bir sonraki tetiklemede yeniden dener. Hata olarak isaretlenmesi
    // gereksiz alarm uretirdi.
    if (error?.code === "CLAUDE_RUNNING_FROM_TARGET") {
      logger.info("repair", "Claude su an hedef surumden calisiyor; sonraki tetiklemede denenecek", {
        version: packageInfo.version,
      });
      return 0;
    }
    if (error?.code === "ALREADY_BRANDED_WITHOUT_RECORD") {
      logger.warning("repair", "Dosyalar zaten markali ama uretim kaydi yok; dogrulanamiyor", {
        version: packageInfo.version,
      });
      return 0;
    }
    throw error;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const logger = createLogger({ minLevel: "info" });
    logger.error("repair", "Onarim basarisiz", {
      code: error?.code || null,
      error: String(error?.message || error),
    });
    process.exit(1);
  });
