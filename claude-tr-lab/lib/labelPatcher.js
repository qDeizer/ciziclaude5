"use strict";

const fs = require("fs");
const { codedError, sha256Buffer } = require("./fsx");

// Tek sorumluluk: kataloga girmeyen, JS icine gomulu etiketleri yamalamak.
//
// Bunlar Anthropic'in cevirmedigi saglayici/marka etiketleridir (de-DE.json'da
// da Ingilizce kalirlar). Kataloktan cevrilemezler, byte yamasi gerekir.
// Yama minimaldir: yalnizca tirnak icindeki metin degisir, tirnak turu korunur.

function createLabelPatcher({ logger }) {
  function patchFile(absolutePath, sitesForFile, rulesById) {
    const originalBuffer = fs.readFileSync(absolutePath);
    let content = originalBuffer.toString("utf8");
    const applied = [];

    for (const site of sitesForFile) {
      const rule = rulesById.get(site.ruleId);
      if (!rule) throw codedError("RULE_NOT_FOUND", `Kural bulunamadi: ${site.ruleId}`);

      const search = `${rule.objectKey}:${site.quote}${rule.from}${site.quote}`;
      const replacement = `${rule.objectKey}:${site.quote}${rule.to}${site.quote}`;

      // Tarama sirasinda bosluklu varyant gorulmus olabilir; tam eslesmeyi
      // taramanin bildirdigi metinden alalim.
      const exactSearch = site.matched;
      const exactReplacement = exactSearch.replace(
        `${site.quote}${rule.from}${site.quote}`,
        `${site.quote}${rule.to}${site.quote}`,
      );

      const occurrences = content.split(exactSearch).length - 1;
      if (occurrences !== 1) {
        throw codedError(
          "LABEL_OCCURRENCE_UNEXPECTED",
          `Yama noktasi tek degil (${occurrences} adet): ${site.ruleId} @ ${site.relativePath}`,
        );
      }
      content = content.replace(exactSearch, exactReplacement);
      applied.push({
        ruleId: rule.id,
        from: rule.from,
        to: rule.to,
        search: exactSearch === search ? search : exactSearch,
        replacement: exactReplacement,
      });
    }

    const patchedBuffer = Buffer.from(content, "utf8");
    if (patchedBuffer.equals(originalBuffer)) {
      throw codedError("LABEL_PATCH_NO_OP", `Yama dosyada hicbir degisiklik uretmedi: ${absolutePath}`);
    }

    return {
      originalBuffer,
      patchedBuffer,
      applied,
      sourceSha256: sha256Buffer(originalBuffer),
      patchedSha256: sha256Buffer(patchedBuffer),
      byteDelta: patchedBuffer.length - originalBuffer.length,
    };
  }

  function patch(sites, rules) {
    const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    const byFile = new Map();
    for (const site of sites) {
      if (!byFile.has(site.absolutePath)) byFile.set(site.absolutePath, []);
      byFile.get(site.absolutePath).push(site);
    }

    const results = [];
    for (const [absolutePath, sitesForFile] of byFile) {
      const result = patchFile(absolutePath, sitesForFile, rulesById);
      results.push({
        absolutePath,
        relativePath: sitesForFile[0].relativePath,
        ...result,
      });
      logger.success("label", "Etiket yamasi hazirlandi", {
        file: sitesForFile[0].relativePath,
        applied: result.applied.map((item) => `${item.from} -> ${item.to}`),
        byteDelta: result.byteDelta,
      });
    }
    return results;
  }

  return { patch, patchFile };
}

module.exports = { createLabelPatcher };
