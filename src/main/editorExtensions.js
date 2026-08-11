// VS Code ve türevlerine kurulmuş eklentileri bulur.
//
// NEDEN ÖNEMLİ
// Hem Claude Code hem Codex, kod düzenleyici eklentisi olarak kurulabiliyor ve
// her ikisi de KENDİ CLI ikilisini taşıyor (sırasıyla ~279 MB ve ~293 MB). Yani
// eklentiyi kuran kullanıcıda ürün VARDIR ama PATH'te komut YOKTUR. Yalnızca
// PATH'e bakan bir algılama bu kullanıcıya "kurulu değil" der ve anahtarı kapalı
// tutar - oysa bağlanacak bir kurulum orada durur.
//
// NEDEN AYRI MODÜL
// İki ürün de aynı şeyi soruyor: hangi düzenleyicilerin uzantı dizinleri var,
// içlerinde bu kimlikte bir klasör var mı, sürümü ne. Bu mantığı iki yerde
// yazmak, birinin yeni bir düzenleyiciyi öğrenip diğerinin öğrenmemesi demek.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Sabit bir liste değil: her düzenleyicinin kendi uzantı dizini var ve
// hangilerinin bulunduğuna disk karar verir. Taşınabilir kurulum uzantılarını
// kurulum klasörünün içinde tutar.
const EDITOR_DIRECTORIES = Object.freeze([
  ".vscode", ".vscode-insiders", ".vscode-oss", ".vscode-server",
  ".cursor", ".cursor-server", ".windsurf", ".trae",
]);

function editorExtensionRoots() {
  const home = os.homedir();
  const roots = EDITOR_DIRECTORIES.map((directory) => ({
    editor: directory.replace(/^\./, ""),
    root: path.join(home, directory, "extensions"),
  }));
  const portable = String(process.env.VSCODE_PORTABLE || "").trim();
  if (portable) roots.push({ editor: "vscode-portable", root: path.join(portable, "extensions") });
  return roots;
}

// Düzenleyicinin kendi kaydı. Diskte eski sürümlerin klasörü kalabiliyor (bu
// makinede `openai.chatgpt-26.5803.61601` kayıtlı değil ama klasörü duruyor), o
// yüzden "hangi sürüm ETKİN" sorusunun cevabı klasör listesi değil bu dosyadır.
function registeredExtensions(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "extensions.json"), "utf8"));
    if (!Array.isArray(parsed)) return null;
    return new Map(parsed
      .map((entry) => [String(entry?.identifier?.id || "").toLowerCase(), String(entry?.version || "")])
      .filter(([id]) => id));
  } catch {
    return null;
  }
}

// `binaries` göreli yol listesi: eklentinin taşıdığı çalıştırılabilir dosyalar.
// Var olmayanlar atlanır, böylece platforma göre farklı isimler tek listede
// tanımlanabilir.
function findEditorExtensions(extensionId, { binaries = [] } = {}) {
  const id = String(extensionId).toLowerCase();
  const prefix = `${id}-`;
  const versionPattern = new RegExp(`^${id.replace(/\./g, "\\.")}-(\\d+(?:\\.\\d+)*)`, "i");
  const found = [];

  for (const { editor, root } of editorExtensionRoots()) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const registered = registeredExtensions(root);
    const activeVersion = registered ? registered.get(id) || null : null;

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;
      const directory = path.join(root, entry.name);
      const version = versionPattern.exec(entry.name)?.[1] || null;
      const available = binaries
        .map((relative) => path.join(directory, ...(Array.isArray(relative) ? relative : [relative])))
        .filter((candidate) => {
          try { return fs.existsSync(candidate); } catch { return false; }
        });
      found.push({
        editor,
        directory,
        version,
        binaries: available,
        // Düzenleyicinin kaydında bu sürüm mü yazıyor? Kayıt okunamıyorsa
        // bilinmiyor demektir (null), "hayır" değil.
        active: activeVersion == null ? null : activeVersion === version,
      });
    }
  }

  // Etkin sürüm önce, sonra sürüme göre azalan: ekran ve algılama önce gerçekten
  // kullanılan kurulumu görsün.
  return found.sort((a, b) => {
    if (a.active !== b.active) return (b.active === true ? 1 : 0) - (a.active === true ? 1 : 0);
    return compareVersions(b.version, a.version);
  });
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Kullanılabilir bir ikili taşıyan kurulumlar; algılamanın ilgilendiği küme.
function usableEditorExtensions(extensionId, options) {
  return findEditorExtensions(extensionId, options).filter((item) => item.binaries.length > 0);
}

// Düzenleyicinin kullanıcı ayarları. Eklentinin davranışını değiştiren bir ayar
// varsa (örn. Codex'i WSL içinde çalıştırmak) onu OKUMAK gerekir; yazmak değil.
function editorUserSettings() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    candidates.push(
      { editor: "vscode", file: path.join(appData, "Code", "User", "settings.json") },
      { editor: "vscode-insiders", file: path.join(appData, "Code - Insiders", "User", "settings.json") },
      { editor: "vscode-oss", file: path.join(appData, "VSCodium", "User", "settings.json") },
      { editor: "cursor", file: path.join(appData, "Cursor", "User", "settings.json") },
      { editor: "windsurf", file: path.join(appData, "Windsurf", "User", "settings.json") },
    );
  } else if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    candidates.push(
      { editor: "vscode", file: path.join(support, "Code", "User", "settings.json") },
      { editor: "cursor", file: path.join(support, "Cursor", "User", "settings.json") },
    );
  } else {
    candidates.push(
      { editor: "vscode", file: path.join(home, ".config", "Code", "User", "settings.json") },
      { editor: "cursor", file: path.join(home, ".config", "Cursor", "User", "settings.json") },
    );
  }
  const portable = String(process.env.VSCODE_PORTABLE || "").trim();
  if (portable) candidates.push({ editor: "vscode-portable", file: path.join(portable, "user-data", "User", "settings.json") });

  const result = [];
  for (const candidate of candidates) {
    let text;
    try { text = fs.readFileSync(candidate.file, "utf8"); } catch { continue; }
    // VS Code ayar dosyası JSONC'dir: yorum ve son virgül içerebilir. Tam bir
    // ayrıştırıcı gerekmiyor; okunamazsa o dosya atlanır.
    try {
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      result.push({ ...candidate, settings: JSON.parse(stripped) });
    } catch {
      result.push({ ...candidate, settings: null, unreadable: true });
    }
  }
  return result;
}

module.exports = {
  EDITOR_DIRECTORIES,
  editorExtensionRoots,
  findEditorExtensions,
  usableEditorExtensions,
  editorUserSettings,
  compareVersions,
};
