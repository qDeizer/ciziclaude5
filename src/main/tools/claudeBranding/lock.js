"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { codedError, ensureDir } = require("./fsx");

// Tek sorumluluk: iki surecin ayni anda yama yazmasini engellemek.
//
// Neden gerekli: iki koruyucu paralel calisiyor. Zamanlanmis gorev (olay
// tetikli) ile bizim baslaticimiz ayni saniyede tetiklenebilir. Ikisi de ayni
// dosyaya yazarsa dosya bozulur. Kilit, ikinci gelenin beklemesini saglar.
//
// Kilit dosya tabanli ve 'wx' ile atomik olusturulur. Surec cokerse kilit
// bayatlar: PID yasamiyorsa veya sure asilmissa devralinir.

const STALE_AFTER_MS = 10 * 60 * 1000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createLock({ logger, workRoot, name = "patch" }) {
  const lockPath = path.join(workRoot, `${name}.lock`);

  function readLock() {
    try {
      return JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      return null;
    }
  }

  function tryTake() {
    ensureDir(workRoot);
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        at: new Date().toISOString(),
      });
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  }

  function breakIfStale() {
    const held = readLock();
    if (!held) {
      // Okunamayan kilit dosyasi = bozuk, devral.
      fs.rmSync(lockPath, { force: true });
      return true;
    }
    const ageMs = Date.now() - Date.parse(held.at || 0);
    const stale = !processAlive(Number(held.pid)) || !(ageMs < STALE_AFTER_MS);
    if (!stale) return false;
    logger.warning("lock", "Bayat kilit devralindi", {
      heldByPid: held.pid,
      ageSeconds: Math.round(ageMs / 1000),
      pidAlive: processAlive(Number(held.pid)),
    });
    fs.rmSync(lockPath, { force: true });
    return true;
  }

  // Beklemek ASLA senkron olmamali: bu kod Cizi Code'un ana surecinde de
  // calisiyor ve mesgul bekleme arayuzu dondurur.
  function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  async function acquire({ timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let waited = false;
    for (;;) {
      if (tryTake()) {
        if (waited) logger.info("lock", "Kilit alindi (bekledikten sonra)", { lockPath });
        return {
          release() {
            const held = readLock();
            if (held && Number(held.pid) !== process.pid) {
              logger.warning("lock", "Kilit baskasina ait, kaldirilmadi", { heldByPid: held.pid });
              return;
            }
            fs.rmSync(lockPath, { force: true });
          },
        };
      }
      if (breakIfStale()) continue;
      if (Date.now() >= deadline) {
        const held = readLock();
        throw codedError(
          "PATCH_LOCK_BUSY",
          `Baska bir yama islemi surüyor (pid ${held?.pid || "?"}). Sonra tekrar denenecek.`,
        );
      }
      waited = true;
      await sleep(500);
    }
  }

  return { acquire, lockPath, readLock };
}

module.exports = { createLock, STALE_AFTER_MS };
