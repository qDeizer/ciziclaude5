"use strict";

const fs = require("fs");
const path = require("path");
const { codedError, ensureDir, readJson, sha256File, writeJsonAtomic } = require("./fsx");

// Tek sorumluluk: stage edilmis dosyalari canli kuruluma UYGULAMAK ve her
// basarisizlikta geri almak.
//
// Sira: on kosullar -> yedek -> yazma izni -> yaz -> dogrula -> izni geri al.
// Herhangi bir adim patlarsa yedekten geri donulur ve geri alma aciklikla
// loglanir. Yazma izni ADMIN gerektirir; WindowsApps varsayilan olarak
// TrustedInstaller'a aittir.

const ADMINISTRATORS_SID = "*S-1-5-32-544";
const TRUSTED_INSTALLER = "NT SERVICE\\TrustedInstaller";

// MSIX icerigi WindowsApps altindadir ve TrustedInstaller'a aittir: yazmak icin
// once sahiplik/ACL alinmasi, dolayisiyla yonetici hakki gerekir. Squirrel
// kurulumu kullanicinin kendi LOCALAPPDATA dizinindedir; orada ne yukseltme ne
// de ACL degisikligi gerekir - ve kullanici dizininin ACL'lerini kurcalamak
// gereksiz bir yan etki olurdu.
function needsProtectionBypass(packageInfo) {
  return (packageInfo?.installKind || "msix") !== "squirrel";
}

function createApplyService({ logger, powershell, elevation, claudeProcess, lock, workRoot }) {
  function backupRoot(version) {
    return path.join(workRoot, version, "backup");
  }

  function backupManifestPath(version) {
    return path.join(workRoot, version, "backup", "backup-manifest.json");
  }

  // Yalnizca YAMALANACAK klasorden calisan bir UYGULAMA sureci varsa reddeder.
  // Guncelleme sonrasi calisan Claude eski klasordedir; yeni klasoru yamalamak
  // guvenlidir. Paketin kendi Windows servisi de engel degildir (bkz.
  // claudeProcess): kullanicinin kapatabilecegi bir sey degil ve yamalanan
  // dosyalari kullanmiyor.
  async function assertTargetNotInUse(packageInfo) {
    const state = await claudeProcess.runsFrom(packageInfo.installLocation);
    if (state.runsFromTarget) {
      // Hangi surecin engelledigi yaziyor: "kapat" denen sey kullanicinin
      // ekraninda gorunmuyorsa mesaj tek basina hicbir sey anlatmiyordu.
      throw codedError(
        "CLAUDE_RUNNING_FROM_TARGET",
        `Claude Desktop yamalanacak surumden calisiyor; once kapatilmali (${
          state.processes.map((item) => `${item.name}#${item.id}`).join(", ")
        }).`,
      );
    }
    if (state.paths.length) {
      logger.info("apply", "Claude acik ama baska bir surumden calisiyor; hedef klasor kullanimda degil", {
        runningPaths: state.paths.length,
      });
    }
    return state;
  }

  async function grantWrite(absolutePath, packageInfo) {
    if (!needsProtectionBypass(packageInfo)) return;
    await powershell.run(
      "$ErrorActionPreference='Stop';"
      + "$f=[string]$env:CIZI_TARGET;"
      + "& takeown.exe /F $f /A | Out-Null;"
      + `& icacls.exe $f /grant ${ADMINISTRATORS_SID}:'(F)' | Out-Null`,
      { env: { CIZI_TARGET: absolutePath }, timeoutMs: 60000 },
    );
  }

  async function restoreProtection(absolutePath, packageInfo) {
    if (!needsProtectionBypass(packageInfo)) return true;
    // SIRA ONEMLI: once sahiplik TrustedInstaller'a devredilir, SONRA eklenen
    // Administrators ACE'i kaldirilir.
    //
    // Ters sirada calismaz ve sessizce yarim is birakir: /remove:g bizim tam
    // yetki ACE'imizi silince WRITE_OWNER hakki da gider; sahip olmak tek
    // basina WRITE_OWNER vermez (yalnizca WRITE_DAC/READ_CONTROL verir). Bu
    // yuzden /setowner "Erisim engellendi" ile doner ve dosyalar Administrators
    // sahipliginde, tam yetkili ACE ile ortada kalir.
    try {
      await powershell.run(
        "$ErrorActionPreference='Stop';"
        + "$f=[string]$env:CIZI_TARGET;"
        + `& icacls.exe $f /setowner '${TRUSTED_INSTALLER}';`
        + "if($LASTEXITCODE -ne 0){throw 'SETOWNER_FAILED'};"
        + `& icacls.exe $f /remove:g ${ADMINISTRATORS_SID};`
        + "if($LASTEXITCODE -ne 0){throw 'REMOVE_ACE_FAILED'}",
        { env: { CIZI_TARGET: absolutePath }, timeoutMs: 60000 },
      );
      return true;
    } catch (cause) {
      logger.warning("apply", "Dosya korumasi tam olarak geri alinamadi", {
        file: path.basename(absolutePath),
        error: String(cause?.message || cause),
      });
      return false;
    }
  }

  function createBackup(packageInfo, stagedFiles) {
    const root = backupRoot(packageInfo.version);
    const entries = [];
    for (const file of stagedFiles) {
      const livePath = path.join(packageInfo.installLocation, file.relativePath.split("/").join(path.sep));
      const backupPath = path.join(root, file.relativePath.split("/").join(path.sep));
      ensureDir(path.dirname(backupPath));
      fs.copyFileSync(livePath, backupPath);
      const backupSha = sha256File(backupPath);
      if (backupSha !== file.sourceSha256) {
        throw codedError(
          "BACKUP_SHA_MISMATCH",
          `Yedek, beklenen kaynak hash'i ile uyusmuyor: ${file.relativePath}`,
        );
      }
      entries.push({ relativePath: file.relativePath, backupPath, sha256: backupSha });
    }
    const manifest = {
      schemaVersion: 1,
      version: packageInfo.version,
      packageFullName: packageInfo.packageFullName,
      files: entries,
    };
    writeJsonAtomic(backupManifestPath(packageInfo.version), manifest);
    logger.success("apply", "Orijinal dosyalar yedeklendi", { count: entries.length, root });
    return manifest;
  }

  function restoreFromBackup(packageInfo, reason) {
    const manifestPath = backupManifestPath(packageInfo.version);
    if (!fs.existsSync(manifestPath)) {
      logger.error("apply", "Geri alma yapilamadi: yedek manifesti yok", { manifestPath, reason });
      return { restored: false, files: [] };
    }
    const manifest = readJson(manifestPath);
    const restored = [];
    const failed = [];
    for (const entry of manifest.files) {
      const livePath = path.join(packageInfo.installLocation, entry.relativePath.split("/").join(path.sep));
      try {
        fs.copyFileSync(entry.backupPath, livePath);
        const liveSha = sha256File(livePath);
        if (liveSha !== entry.sha256) throw new Error(`hash uyusmadi (${liveSha})`);
        restored.push(entry.relativePath);
      } catch (cause) {
        failed.push({ relativePath: entry.relativePath, error: String(cause?.message || cause) });
      }
    }
    if (failed.length) {
      logger.error("apply", "GERI ALMA KISMI BASARISIZ - kurulum tutarsiz olabilir", { reason, restored, failed });
    } else {
      logger.success("apply", "GERI ALMA TAMAMLANDI - orijinal dosyalar geri yuklendi", { reason, restored });
    }
    return { restored: !failed.length, files: restored, failed };
  }

  // Canli dosya GERCEKTEN bozuk mu?
  //
  // Ayrim onemli: icerigi degismis ama GECERLI bir dosya, Anthropic'in kendi
  // degisikligi olabilir - onu yedekten geri yazmak bir guncellemeyi geri almak
  // olur. Bos ya da ayristirilamayan bir dosya ise kimsenin isteyecegi bir sey
  // degildir; yalnizca yarim yazma, kesilmis kopyalama ya da disk hatasi boyle
  // gorunur.
  function liveFileCorruption(livePath) {
    let stat;
    try { stat = fs.statSync(livePath); } catch { return "unreadable"; }
    if (stat.size === 0) return "empty";
    if (!livePath.toLowerCase().endsWith(".json")) return null;
    try {
      JSON.parse(fs.readFileSync(livePath, "utf8").replace(/^﻿/, ""));
      return null;
    } catch {
      return "invalid-json";
    }
  }

  // Bozuk hedefi kendi yedegimizden geri getirir.
  //
  // NEDEN GEREKLI: canli dosyaya yazma atomik DEGIL - gecici dosya + rename
  // yapmak, TrustedInstaller'a ait dizin uzerinde de yetki almayi gerektirirdi,
  // ki bu paketin sertlestirmesini gereksiz yere daha genis acardi. Bunun bedeli
  // sudur: surec tam yazma anininda olurse dosya yarim kalir. Boyle bir dosya
  // eskiden `LIVE_FILE_DRIFTED` ile cikmaz sokaga giriyordu - ne yamalanabiliyor
  // ne de kendiliginden duzeliyordu, cunku hicbir yol onu yedekten geri koymuyordu.
  async function recoverCorruptLiveFile(packageInfo, file, reason) {
    const manifestPath = backupManifestPath(packageInfo.version);
    if (!fs.existsSync(manifestPath)) return false;
    let manifest;
    try { manifest = readJson(manifestPath); } catch { return false; }
    if (manifest.packageFullName && manifest.packageFullName !== packageInfo.packageFullName) return false;
    const entry = (manifest.files || []).find((item) => item.relativePath === file.relativePath);
    // Yedegin gercekten BU build'in kaynagi oldugu kanitlanmadan geri yazilmaz.
    if (!entry || entry.sha256 !== file.sourceSha256 || !fs.existsSync(entry.backupPath)) return false;
    if (sha256File(entry.backupPath) !== file.sourceSha256) return false;

    const livePath = path.join(packageInfo.installLocation, file.relativePath.split("/").join(path.sep));
    try {
      await grantWrite(livePath, packageInfo);
      fs.copyFileSync(entry.backupPath, livePath);
      if (sha256File(livePath) !== file.sourceSha256) return false;
      logger.success("apply", "Bozulmus hedef dosya yedekten geri getirildi", {
        file: file.relativePath, reason,
      });
      return true;
    } catch (cause) {
      logger.error("apply", "Bozulmus hedef dosya geri getirilemedi", {
        file: file.relativePath, reason, error: String(cause?.message || cause),
      });
      return false;
    }
  }

  async function assertPreconditions(packageInfo, provenance) {
    if (provenance.source.packageFullName !== packageInfo.packageFullName) {
      throw codedError(
        "BUILD_VERSION_MISMATCH",
        `Stage edilen yama ${provenance.source.packageFullName} icin uretilmis, kurulu paket ${packageInfo.packageFullName}.`,
      );
    }
    if (needsProtectionBypass(packageInfo)) {
      await elevation.assertElevated("WindowsApps altindaki Claude dosyalarini yamalamak");
    }
    await assertTargetNotInUse(packageInfo);
    // Build ile apply arasinda dosya degismis mi?
    for (const file of provenance.files) {
      const livePath = path.join(packageInfo.installLocation, file.relativePath.split("/").join(path.sep));
      if (!fs.existsSync(livePath)) {
        throw codedError("LIVE_FILE_MISSING", `Hedef dosya yok: ${file.relativePath}`);
      }
      const liveSha = sha256File(livePath);
      if (liveSha === file.patchedSha256) {
        throw codedError("ALREADY_PATCHED", `Dosya zaten yamali: ${file.relativePath}`);
      }
      if (liveSha !== file.sourceSha256) {
        // Bozuksa kendi yedegimizden geri getirilir; degismis ama gecerliyse
        // dokunulmaz ve yeniden build istenir.
        const corruption = liveFileCorruption(livePath);
        const recovered = corruption
          ? await recoverCorruptLiveFile(packageInfo, file, corruption)
          : false;
        if (!recovered) {
          throw codedError(
            "LIVE_FILE_DRIFTED",
            corruption
              ? `Hedef dosya bozuk (${file.relativePath}: ${corruption}) ve yedekten geri getirilemedi.`
              : `Hedef dosya build sirasindakinden farkli (${file.relativePath}). Yeniden build gerekiyor.`,
          );
        }
      }
    }
  }

  async function apply(packageInfo, buildResult, { confirm = false } = {}) {
    if (confirm !== true) {
      throw codedError("CONFIRMATION_REQUIRED", "Canli kuruluma yazmak icin acik onay (--yes) gerekiyor.");
    }
    const { provenance, stagedFiles } = buildResult;
    // Iki koruyucu (zamanlanmis gorev + baslatici) ayni anda yazamaz.
    const held = await lock.acquire();
    try {
      return await applyLocked(packageInfo, provenance, stagedFiles, { confirm });
    } finally {
      held.release();
    }
  }

  async function applyLocked(packageInfo, provenance, stagedFiles) {
    await assertPreconditions(packageInfo, provenance);
    createBackup(packageInfo, stagedFiles);

    const written = [];
    const granted = [];
    try {
      for (const file of stagedFiles) {
        const livePath = path.join(packageInfo.installLocation, file.relativePath.split("/").join(path.sep));
        await grantWrite(livePath, packageInfo);
        granted.push(livePath);
        fs.writeFileSync(livePath, fs.readFileSync(file.stagedPath));
        const liveSha = sha256File(livePath);
        if (liveSha !== file.patchedSha256) {
          throw codedError("WRITE_VERIFY_FAILED", `Yazilan dosya beklenen hash'i vermedi: ${file.relativePath}`);
        }
        written.push(file.relativePath);
        logger.success("apply", "Dosya yamalandi ve dogrulandi", {
          file: file.relativePath,
          patchedSha256: liveSha.slice(0, 12),
        });
      }
    } catch (cause) {
      logger.error("apply", "Yama basarisiz - geri alma baslatiliyor", {
        error: String(cause?.message || cause),
        writtenBeforeFailure: written,
      });
      const rollback = restoreFromBackup(packageInfo, "apply-failed");
      for (const target of granted) await restoreProtection(target, packageInfo);
      const error = codedError("APPLY_FAILED", `Yama uygulanamadi: ${cause?.message || cause}`, cause);
      error.rollback = rollback;
      throw error;
    }

    const protectionRestored = [];
    for (const target of granted) protectionRestored.push(await restoreProtection(target, packageInfo));
    const restoredCount = protectionRestored.filter(Boolean).length;

    logger.success("apply", "Turkce yama uygulandi", {
      version: packageInfo.version,
      files: written.length,
      protectionRestored: restoredCount,
    });
    // Yama calisir ama koruma geri gelmediyse dosyalar yoneticiye acik kalir.
    // Bu sessiz gecilemez: kurulumun sertlestirmesi zayiflamis olur.
    if (granted.length && restoredCount !== granted.length) {
      logger.warning("apply", "Bazi dosyalarda orijinal koruma geri alinamadi; dosyalar yonetici erisimine acik kaldi", {
        version: packageInfo.version,
        restored: restoredCount,
        expected: granted.length,
      });
    }
    return { applied: true, files: written, protectionRestored, protectionRestoredCount: restoredCount };
  }

  function verifyLive(packageInfo, provenance) {
    const results = [];
    for (const file of provenance.files) {
      const livePath = path.join(packageInfo.installLocation, file.relativePath.split("/").join(path.sep));
      if (!fs.existsSync(livePath)) {
        results.push({ relativePath: file.relativePath, state: "missing" });
        continue;
      }
      const liveSha = sha256File(livePath);
      let state = "drifted";
      if (liveSha === file.patchedSha256) state = "patched";
      else if (liveSha === file.sourceSha256) state = "original";
      results.push({ relativePath: file.relativePath, state, liveSha256: liveSha.slice(0, 12) });
    }
    const allPatched = results.length > 0 && results.every((item) => item.state === "patched");
    const level = allPatched ? "success" : "warning";
    logger[level]("verify", allPatched ? "Tum hedefler yamali" : "Hedeflerin durumu karisik", {
      states: results.reduce((accumulator, item) => {
        accumulator[item.state] = (accumulator[item.state] || 0) + 1;
        return accumulator;
      }, {}),
    });
    return { allPatched, files: results };
  }

  async function restore(packageInfo, { confirm = false } = {}) {
    if (confirm !== true) {
      throw codedError("CONFIRMATION_REQUIRED", "Geri yukleme icin acik onay (--yes) gerekiyor.");
    }
    // Yedek yoksa geri alinacak bir sey de yok. Bu bir hata degil: switch hic
    // acilmamis ya da bu Claude surumu hic yamalanmamis olabilir. Hata atmak,
    // switch'i kapatmayi bosuna engellerdi.
    if (!fs.existsSync(backupManifestPath(packageInfo.version))) {
      logger.info("apply", "Bu Claude surumu icin yedek yok; geri yuklenecek dosya bulunmuyor", {
        version: packageInfo.version,
      });
      return { restored: false, reason: "NO_BACKUP", files: [] };
    }
    if (needsProtectionBypass(packageInfo)) {
      await elevation.assertElevated("Orijinal Claude dosyalarini geri yuklemek");
    }
    const held = await lock.acquire();
    try {
      // Kullanimda mi kontrolu KILIDIN ICINDE: disarida yapildiginda kontrol ile
      // yazma arasinda Claude baslayabiliyordu ve yazma calisan bir kuruluma
      // gidiyordu.
      await assertTargetNotInUse(packageInfo);
      const manifest = readJson(backupManifestPath(packageInfo.version));
      // Yedek, kurulu paketin yedegi mi? Surum dizesi ayni kalirken paket
      // degismis olabilir (yeniden kurulum, farkli mimari). Baska bir paketin
      // baytlarini geri yazmak, duzeltmek istedigimiz seyi bozmak olurdu.
      if (manifest.packageFullName && manifest.packageFullName !== packageInfo.packageFullName) {
        logger.warning("apply", "Yedek baska bir Claude paketine ait; geri yukleme yapilmadi", {
          backupPackage: manifest.packageFullName,
          installedPackage: packageInfo.packageFullName,
        });
        return { restored: false, reason: "BACKUP_PACKAGE_MISMATCH", files: [] };
      }
      for (const entry of manifest.files) {
        const livePath = path.join(packageInfo.installLocation, entry.relativePath.split("/").join(path.sep));
        await grantWrite(livePath, packageInfo);
      }
      const result = restoreFromBackup(packageInfo, "manual-restore");
      for (const entry of manifest.files) {
        const livePath = path.join(packageInfo.installLocation, entry.relativePath.split("/").join(path.sep));
        await restoreProtection(livePath, packageInfo);
      }
      return result;
    } finally {
      held.release();
    }
  }

  return {
    apply, restore, verifyLive, createBackup, restoreFromBackup,
    assertTargetNotInUse, backupManifestPath,
  };
}

module.exports = { createApplyService };
