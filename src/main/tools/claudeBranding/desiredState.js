"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonIfExists, writeJsonAtomic } = require("./fsx");

// Tek sorumluluk: "markalama acik olmali mi" niyetini, onarim gorevinin
// okuyabilecegi bir bicimde tutmak.
//
// NEDEN AYRI BIR DOSYA
// Switch'in asil durum kaydi (state.json) Electron safeStorage ile, yani
// KULLANICIYA BAGLI olarak sifrelenir. Onarim gorevi SYSTEM olarak calistigi
// icin o kaydi cozemez - okumayi denerse yalnizca "okunamadi" sonucunu alir ve
// switch acikken bile hicbir sey yapamaz.
//
// Bu yuzden niyet, yaninda duz metin olarak ayrica yazilir. Icinde sir yoktur:
// yalnizca acik/kapali bilgisi ve hangi Claude surumu icin yazildigi. Gizli olan
// hicbir sey buraya girmemelidir; API anahtari, taban adres ve oturum bilgisi
// sifreli kayitta kalir.
//
// Bu dosya yetkilendirme araci DEGIL, yalnizca niyet bildirimidir: gorev yine de
// her seye dosya hash'ine bakarak karar verir.

const FILE_NAME = "desired.json";
const SCHEMA_VERSION = 1;

function desiredPath(workRoot) {
  return path.join(workRoot, FILE_NAME);
}

function read(workRoot) {
  const value = readJsonIfExists(desiredPath(workRoot), null);
  if (!value || typeof value !== "object" || Number(value.schemaVersion) !== SCHEMA_VERSION) {
    return { enabled: false, known: false };
  }
  return {
    enabled: value.enabled === true,
    known: true,
    version: typeof value.version === "string" ? value.version : null,
    at: typeof value.at === "string" ? value.at : null,
  };
}

function write(workRoot, { enabled, version = null, now = () => new Date().toISOString() }) {
  writeJsonAtomic(desiredPath(workRoot), {
    schemaVersion: SCHEMA_VERSION,
    enabled: enabled === true,
    version: version || null,
    at: now(),
  });
  return read(workRoot);
}

function clear(workRoot) {
  fs.rmSync(desiredPath(workRoot), { force: true });
}

module.exports = { desiredPath, read, write, clear, FILE_NAME, SCHEMA_VERSION };
