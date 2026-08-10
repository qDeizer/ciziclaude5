"use strict";

const fs = require("fs");
const path = require("path");
const { codedError, sha256Buffer, listFiles } = require("./fsx");

// Tek sorumluluk: yamalanacak hedefleri BULMAK. Dosya adina veya byte offsetine
// guvenmez; hedefi kod icindeki anlamsal isaretten ve komsu baglamdan bulur.
// Claude her guncellendiginde dosya adlari (icerik hash'i) degisir, bu yuzden
// tarama her seferinde yeniden yapilir.

// Katalog kesfi: sabit yol listesi YERINE dizin taramasi.
// Kullanicinin Windows dili farkli olabilir; o zaman Claude de-DE/ja-JP gibi
// baska bir katalogu yukler. Bu yuzden BUTUN dil kataloglari hedeftir.
//
// id semasi: "<grup>" tek dilli katalog icin, "<grup>:<locale>" digerleri icin.
// Anahtar bazli ceviri sozlugu yalnizca en-US id'lerini kullanir; token
// kurallari (marka terimi degisimi) butun kataloglara uygulanir.
const CATALOG_GROUPS = [
  { group: "main-process", relativeDir: path.join("app", "resources") },
  { group: "renderer", relativeDir: path.join("app", "resources", "ion-dist", "i18n") },
  { group: "renderer-dynamic", relativeDir: path.join("app", "resources", "ion-dist", "i18n", "dynamic") },
];
const PRIMARY_LOCALE = "en-US";
const LOCALE_FILE = /^([a-z]{2}(?:-[A-Za-z0-9]+)?)(\.overrides)?\.json$/;

const RENDERER_ASSET_DIRECTORY = path.join("app", "resources", "ion-dist", "assets", "v1");
const ASAR_RELATIVE_PATH = path.join("app", "resources", "app.asar");
const KEY_SHAPE = /^[A-Za-z0-9+/=_.-]{6,16}$/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Katalog oldugunu iceriginden dogrular: opak anahtar -> metin haritasi.
function looksLikeCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 50) return false;
  const sample = keys.slice(0, 50);
  if (!sample.every((key) => KEY_SHAPE.test(key))) return false;
  return sample.every((key) => typeof value[key] === "string");
}

function createTargetScanner({ logger }) {
  function scanCatalogs(installLocation) {
    const found = [];
    const skipped = [];
    for (const { group, relativeDir } of CATALOG_GROUPS) {
      const absoluteDir = path.join(installLocation, relativeDir);
      if (!fs.existsSync(absoluteDir)) {
        skipped.push({ group, reason: "DIRECTORY_NOT_FOUND" });
        continue;
      }
      for (const filePath of listFiles(absoluteDir, ".json")) {
        const fileName = path.basename(filePath);
        const match = LOCALE_FILE.exec(fileName);
        if (!match) continue;
        const locale = match[1];
        const overrides = !!match[2];

        const buffer = fs.readFileSync(filePath);
        let parsed;
        try {
          parsed = JSON.parse(buffer.toString("utf8").replace(/^﻿/, ""));
        } catch {
          skipped.push({ group, fileName, reason: "JSON_PARSE_FAILED" });
          continue;
        }
        if (!looksLikeCatalog(parsed)) {
          skipped.push({ group, fileName, reason: "SHAPE_UNRECOGNISED" });
          continue;
        }
        // Birincil (en-US) katalog anahtar bazli ceviri sozlugunun hedefidir.
        const primary = locale === PRIMARY_LOCALE && !overrides;
        found.push({
          id: primary ? group : `${group}:${locale}${overrides ? ".overrides" : ""}`,
          group,
          locale,
          overrides,
          primary,
          relativePath: path.relative(installLocation, filePath),
          absolutePath: filePath,
          keyCount: Object.keys(parsed).length,
          sha256: sha256Buffer(buffer),
          bytes: buffer.length,
        });
      }
    }
    if (!found.length) {
      throw codedError("CATALOG_NOT_FOUND", "Hicbir i18n katalogu bulunamadi; Claude'un yapisi degismis olabilir.");
    }
    for (const entry of skipped) {
      logger.warning("scan", "Katalog adayi atlandi", entry);
    }
    logger.success("scan", "i18n kataloglari bulundu", {
      total: found.length,
      locales: [...new Set(found.map((entry) => entry.locale))],
      primary: found.filter((entry) => entry.primary).map((entry) => entry.id),
    });
    return { catalogs: found, skipped };
  }

  // Bir kuralin eslesmesini yalnizca komsu isaretler de dogrulandiginda kabul
  // eder. Boylece 'Gateway' kelimesinin enum/config/HTTP hata gibi UI olmayan
  // kullanimlari yamalanmaz.
  function matchRuleInContent(content, rule) {
    const pattern = new RegExp(
      `${escapeRegExp(rule.objectKey)}\\s*:\\s*(["'\`])${escapeRegExp(rule.from)}\\1`,
      "g",
    );
    const windowChars = Number(rule.windowChars) || 400;
    const minSiblings = Number(rule.minSiblings) || 2;
    const confirmed = [];
    const rejected = [];

    for (const match of content.matchAll(pattern)) {
      const index = match.index;
      const window = content.slice(Math.max(0, index - windowChars), index + windowChars);
      const siblings = (rule.siblingMarkers || []).filter((marker) => window.includes(marker));
      const record = {
        index,
        quote: match[1],
        matched: match[0],
        siblingsFound: siblings,
      };
      if (siblings.length >= minSiblings) confirmed.push(record);
      else rejected.push({ ...record, reason: "INSUFFICIENT_CONTEXT" });
    }
    return { confirmed, rejected };
  }

  function scanLabelSites(installLocation, rules) {
    const assetDirectory = path.join(installLocation, RENDERER_ASSET_DIRECTORY);
    const files = listFiles(assetDirectory, ".js");
    if (!files.length) {
      throw codedError("ASSET_DIRECTORY_EMPTY", `Renderer varlik dizini bos veya okunamadi: ${assetDirectory}`);
    }

    const sites = [];
    const rejections = [];
    const alreadyTranslated = [];
    let scannedFiles = 0;

    for (const filePath of files) {
      const buffer = fs.readFileSync(filePath);
      scannedFiles += 1;
      for (const rule of rules) {
        const sourceHit = buffer.includes(rule.from);
        const targetHit = buffer.includes(rule.to);
        if (!sourceHit && !targetHit) continue;

        const content = buffer.toString("utf8");
        if (!sourceHit && targetHit) {
          const already = matchRuleInContent(content, { ...rule, from: rule.to });
          if (already.confirmed.length) {
            alreadyTranslated.push({ ruleId: rule.id, file: path.basename(filePath) });
          }
          continue;
        }
        const { confirmed, rejected } = matchRuleInContent(content, rule);
        for (const item of rejected) {
          rejections.push({ ruleId: rule.id, file: path.basename(filePath), ...item });
        }
        for (const item of confirmed) {
          sites.push({
            ruleId: rule.id,
            relativePath: path.relative(installLocation, filePath).split(path.sep).join("/"),
            absolutePath: filePath,
            byteOffset: buffer.indexOf(item.matched),
            quote: item.quote,
            matched: item.matched,
            siblingsFound: item.siblingsFound,
            sha256: sha256Buffer(buffer),
          });
        }
      }
    }

    // Belirsizlik hatadir: beklenen sayida eslesme yoksa yama uretilmez.
    const problems = [];
    for (const rule of rules) {
      const ruleSites = sites.filter((site) => site.ruleId === rule.id);
      const expected = Number(rule.expectedMatches) || 1;
      const skipped = alreadyTranslated.some((entry) => entry.ruleId === rule.id);
      if (ruleSites.length === expected) continue;
      if (!ruleSites.length && skipped) continue;
      problems.push({
        ruleId: rule.id,
        expected,
        found: ruleSites.length,
        reason: ruleSites.length === 0 ? "MARKER_NOT_FOUND" : "AMBIGUOUS_MATCH",
      });
    }

    logger.info("scan", "Renderer varliklari tarandi", {
      scannedFiles,
      confirmedSites: sites.length,
      contextRejected: rejections.length,
      alreadyTranslated: alreadyTranslated.length,
    });
    for (const problem of problems) {
      logger.error("scan", "Etiket kurali dogrulanamadi", problem);
    }
    return { sites, rejections, alreadyTranslated, problems, scannedFiles };
  }

  // app.asar bir arsivdir; header'da offset+size tutar. Uzunluk degistiren bir
  // replace paketi bozar. Bu yuzden yalnizca RAPORLANIR, yamalanmaz.
  function inspectAsar(installLocation, rules) {
    const asarPath = path.join(installLocation, ASAR_RELATIVE_PATH);
    if (!fs.existsSync(asarPath)) return { present: false, occurrences: [] };
    const buffer = fs.readFileSync(asarPath);
    const occurrences = [];
    for (const rule of rules) {
      for (const quote of ['"', "'", "`"]) {
        const needle = `${rule.objectKey}:${quote}${rule.from}${quote}`;
        let index = buffer.indexOf(needle);
        while (index !== -1) {
          occurrences.push({ ruleId: rule.id, byteOffset: index, needle });
          index = buffer.indexOf(needle, index + 1);
        }
      }
    }
    if (occurrences.length) {
      logger.warning("scan", "app.asar icinde ayni etiketin kopyalari var; bu surumde yamalanmiyor", {
        occurrences: occurrences.length,
        note: "Arsiv header'i offset/size tutar; uzunluk degisimi paketi bozar.",
      });
    }
    return { present: true, bytes: buffer.length, sha256: sha256Buffer(buffer), occurrences };
  }

  function scan(installLocation, rules) {
    const catalogs = scanCatalogs(installLocation);
    const labels = scanLabelSites(installLocation, rules);
    const asar = inspectAsar(installLocation, rules);
    return { catalogs: catalogs.catalogs, catalogsSkipped: catalogs.skipped, labels, asar };
  }

  return { scan, scanCatalogs, scanLabelSites, inspectAsar, matchRuleInContent };
}

module.exports = {
  createTargetScanner,
  CATALOG_GROUPS,
  PRIMARY_LOCALE,
  RENDERER_ASSET_DIRECTORY,
  ASAR_RELATIVE_PATH,
  looksLikeCatalog,
};
