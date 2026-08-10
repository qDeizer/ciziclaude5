"use strict";

const { codedError } = require("./fsx");

// Tek sorumluluk: "kurulu Claude surumu icin yama yerinde olsun" durumunu
// saglamak. Idempotent: zaten yamaliysa hicbir sey yapmaz.
//
// Iki koruyucu da bu ayni servisi cagirir:
//   1) Zamanlanmis gorev (olay tetikli + periyodik) - Cizi Code kapali olsa da
//   2) Bizim baslaticimiz (start.bat / switch) - baslatmadan hemen once
//
// Karar HER ZAMAN dosya hash'ine bakilarak verilir, "guncelleme oldu mu"
// tahminiyle degil. Bu yuzden tetikleyicilerin genis olmasi sorun degil.

function createReconcileService({ logger, buildService, applyService }) {
  async function ensurePatched(packageInfo, dictionary, { confirm = false } = {}) {
    const steps = [];

    const rebuild = () => {
      buildService.build(packageInfo, dictionary);
      return buildService.loadStaged(packageInfo.version);
    };

    let build = null;
    try {
      build = buildService.loadStaged(packageInfo.version);
    } catch {
      build = null;
    }
    if (!build) {
      // Yeni Claude surumu: hedefler yeniden taranir, dosya adlari otomatik bulunur.
      build = rebuild();
      steps.push("build");
      logger.info("reconcile", "Bu Claude surumu icin yama ilk kez uretildi", {
        version: packageInfo.version,
      });
    }

    let verification = applyService.verifyLive(packageInfo, build.provenance);
    if (verification.allPatched) {
      if (!steps.length) logger.info("reconcile", "Yama zaten yerinde; islem yok", { version: packageInfo.version });
      return { changed: false, steps, verification };
    }

    // Dosya ne orijinal ne yamali ise (Claude guncellemesi vb.) yeniden uret.
    if (verification.files.some((file) => file.state === "drifted" || file.state === "missing")) {
      build = rebuild();
      steps.push("rebuild");
      logger.warning("reconcile", "Hedef dosyalar degismis; yama yeniden uretildi", {
        version: packageInfo.version,
      });
      verification = applyService.verifyLive(packageInfo, build.provenance);
    }

    if (!verification.allPatched && verification.files.some((file) => file.state === "patched")) {
      throw codedError(
        "PARTIAL_PATCH_STATE",
        "Dosyalarin bir kismi yamali, bir kismi degil. Once 'restore --yes' ile orijinallere don.",
      );
    }

    if (!verification.allPatched) {
      await applyService.apply(packageInfo, build, { confirm });
      steps.push("apply");
      verification = applyService.verifyLive(packageInfo, build.provenance);
    }

    if (!verification.allPatched) {
      throw codedError("PATCH_VERIFY_FAILED", "Yama uygulandi ama dogrulanamadi.");
    }

    // Kapsam dususu sessizce gecilmemeli: yeni/degisen stringler Ingilizce kalir.
    const coverage = build.provenance.files
      .filter((file) => file.kind === "catalog")
      .map((file) => file.relativePath);
    logger.success("reconcile", "Yama yerine kondu ve dogrulandi", {
      version: packageInfo.version,
      steps,
      catalogs: coverage.length,
    });
    return { changed: true, steps, verification, build };
  }

  return { ensurePatched };
}

module.exports = { createReconcileService };
