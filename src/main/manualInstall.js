// "Sadece indir" yolu: resmî yükleyiciyi kullanıcının indirilenler klasörüne
// koyar ve orada bırakır.
//
// NEDEN AYRI BİR MODÜL
// Üç ürün de (Claude Code CLI, Codex CLI, Claude Desktop) aynı şeye ihtiyaç
// duyuyor: HTTPS doğrulanmış bir indirme, ilerleme bildirimi ve kalıcı,
// kullanıcının görebileceği bir hedef. Otomatik kurulum yolları yükleyiciyi
// geçici klasöre indirip siliyor; manuel kurulum için dosyanın KALMASI gerekir.
//
// Neden geçici klasör değil: kullanıcı "sonra kendim kuracağım" dediğinde dosya
// Windows'un temizlediği bir yerde durmamalı. İndirilenler klasörü kullanıcının
// zaten baktığı yerdir.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertHttpsUrl } = require("./httpsUrl");

const FOLDER_NAME = "Cizi Code";

// İndirilenler klasörü sabit `~/Downloads` DEĞİLDİR: kullanıcı onu taşımış,
// OneDrive'a yönlendirmiş ya da Windows farklı bir dile göre adlandırmış olabilir.
// Doğru cevabı yalnızca kabuğun bilinen-klasör kaydı verir; Electron bunu
// `app.getPath("downloads")` ile açar. `~/Downloads` yalnızca son çare - ve
// oraya yazmak, gerçek indirilenler klasörü başka yerdeyse kullanıcının
// bulamayacağı bir klasör oluşturmak olur.
function downloadsRoot() {
  const override = String(process.env.CIZI_DOWNLOAD_DIR || "").trim();
  if (override) return path.resolve(override);
  try {
    // Electron dışı bağlamda (birim testi) bu çağrı yok; o zaman geri düşülür.
    const known = require("electron")?.app?.getPath?.("downloads");
    if (known) return known;
  } catch { /* Electron yok */ }
  return path.join(os.homedir(), "Downloads");
}

function manualInstallDirectory() {
  const target = path.join(downloadsRoot(), FOLDER_NAME);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

// İndirme, akış olarak yapılır: 250 MB'lık bir paket için tüm baytları bellekte
// biriktirmek kullanıcının makinesini gereksiz yorar (madde 10). Dosya önce
// geçici bir ada yazılır, sonra yerine taşınır - yarım kalmış bir indirme
// "kurulabilir dosya" gibi görünmesin.
async function downloadForManualInstall({ url, fileName, label, onProgress = null }) {
  const directory = manualInstallDirectory();
  const target = path.join(directory, fileName);
  const temporary = `${target}.part`;

  const response = await fetch(assertHttpsUrl(url, `${label || "Yükleyici"} adresi`), { cache: "no-store" });
  if (!response.ok) throw new Error(`${label || "Yükleyici"} indirilemedi (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || null;

  fs.rmSync(temporary, { force: true });
  const handle = fs.openSync(temporary, "w");
  let received = 0;
  let lastPercent = -1;
  try {
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk);
      fs.writeSync(handle, buffer);
      received += buffer.length;
      const percent = total ? Math.min(100, Math.round((received / total) * 100)) : null;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.({ received, total, percent });
      }
    }
  } finally {
    fs.closeSync(handle);
  }
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
  onProgress?.({ received, total, percent: 100 });
  return { path: target, directory, bytes: received, total };
}

// Bir yolun gerçekten bu klasörün içinde olup olmadığı. Ayırıcı olmadan
// karşılaştırmak "Cizi Code2" gibi bir kardeş klasörü de içeride sayar.
function isInsideManualInstallDirectory(target) {
  const directory = manualInstallDirectory();
  const resolved = path.resolve(String(target || ""));
  const compare = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  return compare(resolved) === compare(directory)
    || compare(resolved).startsWith(compare(directory + path.sep));
}

module.exports = { manualInstallDirectory, isInsideManualInstallDirectory, downloadForManualInstall, FOLDER_NAME };
