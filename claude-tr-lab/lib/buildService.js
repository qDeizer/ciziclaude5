"use strict";

const fs = require("fs");
const path = require("path");
const {
  codedError, ensureDir, readJson, sha256Buffer, sha256File, writeFileAtomic, writeJsonAtomic,
} = require("./fsx");

// Tek sorumluluk: taranan hedeflerden yamali dosyalari STAGE etmek.
// Canli dosyaya hicbir sey yazmaz; her sey work/<surum>/staged altinda uretilir.
// Boylece uretim ve uygulama ayri adimlar olarak dogrulanabilir.

const SCHEMA_VERSION = 1;

function createBuildService({
  logger, scanner, catalogPatcher, labelPatcher, workRoot, dictionaryPaths, generatedBy,
}) {
  function stagedPathFor(version, relativePath) {
    return path.join(workRoot, version, "staged", relativePath.split("/").join(path.sep));
  }

  function buildCatalogs(packageInfo, catalogs, catalogDictionary, tokenRules) {
    const staged = [];
    const reports = [];
    for (const catalog of catalogs) {
      // Anahtar bazli ceviri yalnizca sozlukte karsiligi olan katalog icin;
      // marka terimi kurallari BUTUN kataloglar icin.
      const dictionaryForCatalog = catalogDictionary[catalog.id] || {};
      const { patchedBuffer, report } = catalogPatcher.patch(catalog, dictionaryForCatalog, tokenRules);
      reports.push(report);

      if (!report.totalChanged) {
        logger.info("build", "Katalog icin uygulanacak ceviri yok; dosya stage edilmedi", {
          catalogId: catalog.id,
        });
        continue;
      }

      const relativePath = catalog.relativePath.split(path.sep).join("/");
      const target = stagedPathFor(packageInfo.version, relativePath);
      writeFileAtomic(target, patchedBuffer);

      // Stage edilen dosya diskten tekrar okunup dogrulanir: JSON gecerli mi ve
      // anahtar kumesi kaynakla ayni mi.
      const stagedKeys = Object.keys(readJson(target));
      const sourceKeys = Object.keys(readJson(catalog.absolutePath));
      if (sourceKeys.length !== stagedKeys.length) {
        throw codedError("STAGED_CATALOG_INVALID", `Stage edilen katalogun anahtar sayisi bozuk: ${catalog.id}`);
      }

      staged.push({
        kind: "catalog",
        catalogId: catalog.id,
        relativePath,
        stagedPath: target,
        sourceSha256: catalog.sha256,
        patchedSha256: sha256Buffer(patchedBuffer),
        sourceBytes: catalog.bytes,
        patchedBytes: patchedBuffer.length,
        locale: catalog.locale || null,
        keyTranslations: report.applied,
        brandTermChanges: report.tokenApplied,
      });
    }
    return { staged, reports };
  }

  function buildLabels(packageInfo, labelScan, rules) {
    if (labelScan.problems.length) {
      throw codedError(
        "LABEL_TARGETS_UNRESOLVED",
        `Etiket hedefleri dogrulanamadi: ${labelScan.problems.map((p) => `${p.ruleId}=${p.reason}`).join(", ")}`,
      );
    }
    if (!labelScan.sites.length) {
      logger.info("build", "Uygulanacak etiket yamasi yok (muhtemelen zaten cevrili)", {
        alreadyTranslated: labelScan.alreadyTranslated,
      });
      return [];
    }

    const results = labelPatcher.patch(labelScan.sites, rules);
    const staged = [];
    for (const result of results) {
      const target = stagedPathFor(packageInfo.version, result.relativePath);
      writeFileAtomic(target, result.patchedBuffer);

      // Stage edilen JS'te hedef metnin gercekten bulundugunu dogrula.
      const verifyBuffer = fs.readFileSync(target);
      for (const item of result.applied) {
        if (!verifyBuffer.includes(item.replacement)) {
          throw codedError("STAGED_LABEL_MISSING", `Stage edilen dosyada yama bulunamadi: ${result.relativePath}`);
        }
      }

      staged.push({
        kind: "label",
        relativePath: result.relativePath,
        stagedPath: target,
        sourceSha256: result.sourceSha256,
        patchedSha256: result.patchedSha256,
        sourceBytes: result.originalBuffer.length,
        patchedBytes: result.patchedBuffer.length,
        byteDelta: result.byteDelta,
        applied: result.applied.map((item) => ({ ruleId: item.ruleId, from: item.from, to: item.to })),
      });
    }
    return staged;
  }

  function build(packageInfo, dictionary) {
    const versionRoot = path.join(workRoot, packageInfo.version);
    fs.rmSync(path.join(versionRoot, "staged"), { recursive: true, force: true });
    ensureDir(versionRoot);

    const scanResult = scanner.scan(packageInfo.installLocation, dictionary.labels.rules);
    const catalogResult = buildCatalogs(
      packageInfo, scanResult.catalogs, dictionary.catalog.entries, dictionary.labels.tokenRules || [],
    );
    const labelStaged = buildLabels(packageInfo, scanResult.labels, dictionary.labels.rules);
    const stagedFiles = [...catalogResult.staged, ...labelStaged];

    if (!stagedFiles.length) {
      throw codedError("NOTHING_TO_STAGE", "Uygulanacak hicbir degisiklik uretilmedi; sozluk bos olabilir.");
    }

    const provenance = {
      schemaVersion: SCHEMA_VERSION,
      generatedBy,
      source: {
        packageFullName: packageInfo.packageFullName,
        version: packageInfo.version,
        publisher: packageInfo.publisher,
        installLocation: packageInfo.installLocation,
      },
      dictionary: {
        labelsSha256: sha256File(dictionaryPaths.labels),
        catalogSha256: sha256File(dictionaryPaths.catalog),
        labelRuleIds: dictionary.labels.rules.map((rule) => rule.id),
      },
      files: stagedFiles.map((file) => ({
        kind: file.kind,
        relativePath: file.relativePath,
        sourceSha256: file.sourceSha256,
        patchedSha256: file.patchedSha256,
        sourceBytes: file.sourceBytes,
        patchedBytes: file.patchedBytes,
      })),
      asar: {
        present: scanResult.asar.present,
        untouchedOccurrences: scanResult.asar.occurrences?.length || 0,
        note: "Arsiv header'i offset/size tutar; bu surumde app.asar yamalanmaz.",
      },
    };

    const report = {
      schemaVersion: SCHEMA_VERSION,
      version: packageInfo.version,
      scannedRendererFiles: scanResult.labels.scannedFiles,
      catalogs: catalogResult.reports.filter((entry) => entry.totalChanged > 0),
      catalogsScanned: catalogResult.reports.length,
      locales: [...new Set(scanResult.catalogs.map((entry) => entry.locale))],
      labels: {
        confirmedSites: scanResult.labels.sites.length,
        contextRejected: scanResult.labels.rejections.length,
        alreadyTranslated: scanResult.labels.alreadyTranslated,
        staged: labelStaged.map((file) => ({ relativePath: file.relativePath, applied: file.applied })),
      },
      stagedFileCount: stagedFiles.length,
    };

    writeJsonAtomic(path.join(versionRoot, "provenance.json"), provenance);
    writeJsonAtomic(path.join(versionRoot, "report.json"), report);

    logger.success("build", "Yama paketi stage edildi", {
      version: packageInfo.version,
      stagedFiles: stagedFiles.length,
      versionRoot,
    });

    return { versionRoot, stagedFiles, provenance, report, scanResult };
  }

  // Diskte duran bir build'i apply/verify icin yeniden kurar.
  function loadStaged(version) {
    const versionRoot = path.join(workRoot, version);
    const provenancePath = path.join(versionRoot, "provenance.json");
    if (!fs.existsSync(provenancePath)) {
      throw codedError("BUILD_NOT_FOUND", `Bu surum icin stage edilmis yama yok: ${version}`);
    }
    const provenance = readJson(provenancePath);
    const stagedFiles = provenance.files.map((file) => {
      const stagedPath = path.join(versionRoot, "staged", file.relativePath.split("/").join(path.sep));
      if (!fs.existsSync(stagedPath)) {
        throw codedError("STAGED_FILE_MISSING", `Stage edilmis dosya yok: ${file.relativePath}`);
      }
      return { ...file, stagedPath };
    });
    return { provenance, stagedFiles, versionRoot };
  }

  return { build, loadStaged, stagedPathFor };
}

module.exports = { createBuildService, SCHEMA_VERSION };
