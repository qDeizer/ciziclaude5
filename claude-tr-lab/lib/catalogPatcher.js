"use strict";

const fs = require("fs");
const { codedError } = require("./fsx");
const icu = require("./icu");

// Tek sorumluluk: i18n katalogunu cevirmek.
//
// Neden guncellemeye dayanikli: katalog anahtari kaynak metnin icerik
// kimligidir. Ingilizce metin degismediyse anahtar da degismez ve ceviri
// calismaya devam eder. Ingilizce metin degistiyse anahtar da degisir; eski
// ceviri "orphan" olarak raporlanir ve o string Ingilizce'ye duser. Yani
// bozulma kismi ve zararsizdir.
//
// Sozlukte her girdi hem 'en' hem 'tr' tutar. 'en' beklenen kaynak metindir;
// kataloktaki deger ondan farkliysa ceviri UYGULANMAZ (SOURCE_DRIFT).
//
// Yama METIN uzerinde cerrahi yapilir, JSON yeniden serilestirilmez. Kaynak
// dosya 273 adet \uXXXX kacis dizisi iceriyor; yeniden serilestirme
// cevrilmeyen satirlarin temsilini de degistirirdi. Bu yontemle yalnizca
// cevrilen anahtarlarin deger literali degisir, geri kalan her byte korunur.

const STRING_LITERAL = '"(?:[^"\\\\]|\\\\.)*"';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Marka terimi degisimi: BUTUN dil kataloglarinda uygulanir.
//
// Neden gerekli: kullanicinin Windows dili farkli olabilir; o zaman Claude
// de-DE/ja-JP gibi baska bir katalogu yukler ve orada da "Gateway" yazar.
// Marka tutarliligi icin her dilde ayni terim gorunmeli.
//
// Neden guvenli: bu, calisma anindaki kor bir metin degisimi DEGIL. Sinirli bir
// string katalogu uzerinde, derleme aninda, yalnizca TEK BASINA duran kelimede
// yapilir. Kullanici mesajlarina, model ciktisina veya kod bloklarina asla
// dokunmaz. Kod/URL benzeri belirtecler (api://gateway/.default,
// https://llm-gateway.example.com, inferenceGatewayApiKey) atlanir.
// Terim HER YERDE degistirilir - tireli bilesiklerin icinde de. Dilbilgisi
// tutarliligi hedef DEGIL; marka tutarliligi hedef.
//
// Korunan tek istisna ISLEVSEL olanlardir; bunlari degistirmek anlami degil
// calismayi bozar:
//   1) URL / yol / tanimlayici iceren belirtecler
//      api://gateway/.default   https://llm-gateway.example.com
//   2) Harfe bitisik tanimlayicilar (camelCase yapilandirma anahtarlari)
//      inferenceGatewayApiKey   inferenceGatewayAuthScheme
//
// Buna karsilik tireli GORUNUR metinler degistirilir:
//   Inferenz-Gateway-Endpunkts  ->  Inferenz-Ağ Geçidi-Endpunkts
//   Gateway-SSO-IdP             ->  Ağ Geçidi-SSO-IdP
const URLISH = /:\/\/|\/|_|\\/;

function enclosingToken(text, start, end) {
  let from = start;
  let to = end;
  while (from > 0 && !/\s/.test(text[from - 1])) from -= 1;
  while (to < text.length && !/\s/.test(text[to])) to += 1;
  return text.slice(from, to);
}

function applyTokenRule(value, rule) {
  const flags = rule.caseSensitive ? "g" : "gi";
  const pattern = new RegExp(`\\b${escapeRegExp(rule.from)}\\b`, flags);
  let result = "";
  let cursor = 0;
  let changed = 0;
  let skipped = 0;

  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    // 1) URL / yol / tanimlayici iceren belirtec
    let allow = !URLISH.test(enclosingToken(value, start, end));
    // 2) harf veya rakama bitisikse tanimlayicinin parcasidir
    if (allow && (/[A-Za-z0-9]/.test(value[start - 1] || "") || /[A-Za-z0-9]/.test(value[end] || ""))) {
      allow = false;
    }
    if (!allow) {
      skipped += 1;
      continue;
    }
    result += value.slice(cursor, start) + rule.to;
    cursor = end;
    changed += 1;
  }
  result += value.slice(cursor);
  return { value: changed ? result : value, changed, skipped };
}

function createCatalogPatcher({ logger }) {
  function normaliseDictionary(rawDictionary) {
    const entries = new Map();
    for (const [key, value] of Object.entries(rawDictionary || {})) {
      if (typeof value === "string") {
        entries.set(key, { en: null, tr: value });
        continue;
      }
      if (!value || typeof value !== "object" || typeof value.tr !== "string") {
        throw codedError("DICTIONARY_ENTRY_INVALID", `Sozluk girdisi gecersiz: ${key}`);
      }
      entries.set(key, { en: typeof value.en === "string" ? value.en : null, tr: value.tr });
    }
    return entries;
  }

  // Anahtarin deger literalini metinde bulup degistirir. Eslesme tam 1 olmalidir.
  function replaceValueLiteral(text, key, translated) {
    const pattern = new RegExp(`(${escapeRegExp(JSON.stringify(key))}\\s*:\\s*)(${STRING_LITERAL})`, "g");
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) {
      throw codedError(
        "CATALOG_KEY_NOT_UNIQUE",
        `Katalog anahtari metinde tam 1 kez bulunmadi (${matches.length} adet): ${key}`,
      );
    }
    const match = matches[0];
    const replacement = `${match[1]}${JSON.stringify(translated)}`;
    return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
  }

  function patch(catalog, rawDictionary, tokenRules = []) {
    const rawBuffer = fs.readFileSync(catalog.absolutePath);
    const hasBom = rawBuffer.length >= 3
      && rawBuffer[0] === 0xEF && rawBuffer[1] === 0xBB && rawBuffer[2] === 0xBF;
    const bom = hasBom ? "﻿" : "";
    let text = rawBuffer.toString("utf8");
    if (hasBom) text = text.slice(1);

    let source;
    try {
      source = JSON.parse(text);
    } catch (cause) {
      throw codedError("CATALOG_PARSE_FAILED", `Katalog okunamadi: ${catalog.absolutePath}`, cause);
    }
    const sourceKeys = Object.keys(source);
    const dictionary = normaliseDictionary(rawDictionary);

    const applied = [];
    // Her anahtarin beklenen NIHAI degeri. Dogrulama buna gore yapilir; boylece
    // "dokunulmamasi gerekeni degistirdim" hatasi kesin olarak yakalanir.
    const expectedValues = new Map();
    const sourceDrift = [];
    const invalidIcu = [];
    const orphan = [];
    const unchanged = [];

    for (const [key, entry] of dictionary) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        orphan.push(key);
        continue;
      }
      const sourceText = source[key];
      if (entry.en !== null && entry.en !== sourceText) {
        sourceDrift.push({ key, expected: entry.en, actual: sourceText });
        continue;
      }
      const validation = icu.validate(sourceText, entry.tr);
      if (!validation.ok) {
        invalidIcu.push({ key, ...validation });
        continue;
      }
      if (entry.tr === sourceText) {
        unchanged.push(key);
        continue;
      }
      text = replaceValueLiteral(text, key, entry.tr);
      expectedValues.set(key, entry.tr);
      applied.push(key);
    }

    // 2. gecis: marka terimi degisimi - butun dillerde, anahtar bazli cevirinin
    // dokunmadigi girdilerde. Yer tutucular yine dogrulanir.
    const appliedLookup = new Set(applied);
    const tokenApplied = [];
    const tokenSkipped = [];
    for (const key of sourceKeys) {
      if (appliedLookup.has(key)) continue;
      const sourceText = source[key];
      let nextText = sourceText;
      let totalChanged = 0;
      let totalSkipped = 0;
      for (const rule of tokenRules) {
        const outcome = applyTokenRule(nextText, rule);
        nextText = outcome.value;
        totalChanged += outcome.changed;
        totalSkipped += outcome.skipped;
      }
      if (totalSkipped) tokenSkipped.push(key);
      if (!totalChanged || nextText === sourceText) continue;
      const validation = icu.validate(sourceText, nextText);
      if (!validation.ok) {
        invalidIcu.push({ key, scope: "token-rule", ...validation });
        continue;
      }
      text = replaceValueLiteral(text, key, nextText);
      expectedValues.set(key, nextText);
      tokenApplied.push(key);
    }

    const patchedText = `${bom}${text}`;

    // Dogrulama: yamali metin gecerli JSON mu, anahtar kumesi ve sirasi ayni mi,
    // ve DOKUNULMAYAN her deger kaynakla birebir ayni mi.
    let patchedParsed;
    try {
      patchedParsed = JSON.parse(text);
    } catch (cause) {
      throw codedError("PATCHED_CATALOG_INVALID_JSON", "Yamali katalog gecerli JSON uretmedi.", cause);
    }
    const patchedKeys = Object.keys(patchedParsed);
    if (patchedKeys.length !== sourceKeys.length) {
      throw codedError("CATALOG_KEY_SET_CHANGED", "Yamali katalogun anahtar sayisi kaynaktan farkli.");
    }
    for (let index = 0; index < sourceKeys.length; index += 1) {
      const key = sourceKeys[index];
      if (patchedKeys[index] !== key) {
        throw codedError("CATALOG_KEY_ORDER_CHANGED", "Yamali katalogun anahtar sirasi kaynaktan farkli.");
      }
      const expected = expectedValues.has(key) ? expectedValues.get(key) : source[key];
      if (patchedParsed[key] !== expected) {
        throw codedError(
          expectedValues.has(key) ? "CATALOG_TRANSLATION_NOT_APPLIED" : "CATALOG_COLLATERAL_CHANGE",
          `Beklenmeyen deger: ${key}`,
        );
      }
    }

    const report = {
      catalogId: catalog.id,
      totalKeys: sourceKeys.length,
      dictionaryEntries: dictionary.size,
      applied: applied.length,
      tokenApplied: tokenApplied.length,
      tokenSkippedStrings: tokenSkipped.length,
      totalChanged: applied.length + tokenApplied.length,
      unchanged: unchanged.length,
      sourceDrift,
      invalidIcu,
      orphan,
      coveragePercent: Number(((applied.length / sourceKeys.length) * 100).toFixed(3)),
    };

    if (sourceDrift.length) {
      logger.warning("catalog", "Kaynak metni degismis anahtarlar atlandi", {
        catalogId: catalog.id,
        count: sourceDrift.length,
        keys: sourceDrift.slice(0, 10).map((item) => item.key),
      });
    }
    if (invalidIcu.length) {
      logger.error("catalog", "ICU dogrulamasi basarisiz ceviriler atlandi", {
        catalogId: catalog.id,
        count: invalidIcu.length,
        details: invalidIcu.slice(0, 10),
      });
    }
    if (orphan.length) {
      logger.warning("catalog", "Bu Claude surumunde bulunmayan sozluk anahtarlari (ceviri islenmedi)", {
        catalogId: catalog.id,
        count: orphan.length,
        keys: orphan.slice(0, 10),
      });
    }
    if (applied.length || tokenApplied.length) {
      logger.success("catalog", "Katalog cevirisi hazirlandi", {
        catalogId: catalog.id,
        locale: catalog.locale || null,
        keyTranslations: applied.length,
        brandTermChanges: tokenApplied.length,
        totalKeys: sourceKeys.length,
      });
    }

    return {
      patchedBuffer: Buffer.from(patchedText, "utf8"),
      sourceBuffer: rawBuffer,
      report,
      appliedKeys: applied,
      tokenAppliedKeys: tokenApplied,
      changed: applied.length + tokenApplied.length,
    };
  }

  return { patch, normaliseDictionary, replaceValueLiteral };
}

module.exports = { createCatalogPatcher };
