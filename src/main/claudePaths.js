// Claude Code CLI'nin yapılandırma dizini nerede.
//
// NEDEN AYRI BİR MODÜL
// Yol `~/.claude` diye sabit yazılıydı. Oysa Claude Code `CLAUDE_CONFIG_DIR`
// ortam değişkenini okuyor (kurulu ikilide 31 yerde geçiyor). Bu değişkeni
// ayarlamış bir kullanıcıda Cizi Code, Claude Code'un hiç okumadığı bir dosyaya
// yazar - sonra kendi yazdığı dosyayı geri okuyup "Bağlı" der. Yani anahtar
// açık görünür ama araç yapılandırılmamıştır: tam olarak madde 9'un önlemeye
// çalıştığı durum, üstelik hiçbir denetimin yakalayamayacağı biçimde, çünkü
// yazan ve doğrulayan aynı yanlış yola bakar.
//
// Codex tarafında aynı kural `CODEX_HOME` için zaten uygulanıyordu; burası
// eksik kalmış.
const os = require("os");
const fs = require("fs");
const path = require("path");

function claudeConfigDirectory() {
  const override = String(process.env.CLAUDE_CONFIG_DIR || "").trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".claude");
}

function claudeSettingsFile() {
  return path.join(claudeConfigDirectory(), "settings.json");
}

// Yükleyicinin indirdiği sürümleri koyduğu yer; kurulum ilerlemesi buradan
// izlenir, o yüzden yapılandırma dizinini takip etmesi gerekir.
function claudeDownloadsDirectory() {
  return path.join(claudeConfigDirectory(), "downloads");
}

// `~/.claude.json` kullanıcı kaydı. Yapılandırma dizini taşındığında bu dosyanın
// da taşındığını VARSAYMIYORUZ - hangisinin gerçekten var olduğuna disk karar
// verir. Kaldırma listesi bu yüzden iki adayı da içerir; yazma yolu bu dosyaya
// hiç dokunmaz.
function claudeUserRecordCandidates() {
  const candidates = [path.join(os.homedir(), ".claude.json")];
  const directory = claudeConfigDirectory();
  candidates.push(path.join(directory, ".claude.json"));
  candidates.push(path.join(path.dirname(directory), `${path.basename(directory)}.json`));
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function usesCustomDirectory() {
  return Boolean(String(process.env.CLAUDE_CONFIG_DIR || "").trim());
}

function directoryExists() {
  try { return fs.existsSync(claudeConfigDirectory()); } catch { return false; }
}

module.exports = {
  claudeConfigDirectory,
  claudeSettingsFile,
  claudeDownloadsDirectory,
  claudeUserRecordCandidates,
  usesCustomDirectory,
  directoryExists,
};
