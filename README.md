# Cizi Code — Masaüstü Uygulaması

Kullanıcılara verilen, Cizi Code markalı masaüstü uygulaması. Kullanıcı API key'i ile giriş yapar, kalan kullanımını görür ve kodlama araçlarını (Claude Code CLI, Codex, Cline, Roo Code, Kilo, OpenCode) **tek switch ile** Cizi Code ağ geçidine bağlar. Arka plandaki sağlayıcı/model bilgisi kullanıcıya **asla** gösterilmez.

## Özellikler
- **API key ile giriş** — anahtar OS keychain (Electron safeStorage) ile şifreli saklanır.
- **Kalan kullanım** — yüzdelik halka + kullanılan/limit. Limit dolunca Cizi Code markalı uyarı.
- **Token kullanım grafiği** — bugün / 7g / 30g / 60g.
- **Erişilebilen modeller** — yalnızca combo isimleri (provider/model gizli).
- **Araç yapılandırma switch'i** — Aç: aracı Cizi Code'a bağlar. Kapat: değişiklikten **önceki** config dosyalarını **aynen** geri yükler (tam yedek/geri-yükleme).

## Çalıştırma (geliştirme)
```bash
npm install
npm start
```

## Renderer-level CLI

The local CLI starts the desktop app when needed and attaches to its loopback
bridge. `screen`/`list` read the visible renderer UI. Mutating commands resolve
the visible DOM control and dispatch its real UI event; they do not call login,
tool, gateway, or other application services directly.

```bash
npm run cli -- screen
npm run cli -- list
npm run cli -- click update-check
npm run cli -- switch tool.claude-code-cli.switch off
npm run cli -- select period-select 7d
```

Results are JSON. Passwords, API keys, tokens, and secrets are masked before
they reach the terminal.

When Claude Code CLI is missing, the desktop UI exposes `Download & Install`
and `Go to official site`. The installer button downloads and runs Anthropic's
official installer script, reports download and installer activity, and
re-checks the local `claude` command before enabling the configuration switch.

Codex CLI follows the same desktop and renderer-CLI flow. Cizi Code detects an
existing standalone or npm installation, offers `İndir ve Kur` with the
official OpenAI installer and exposes step-by-step activity. Once installed,
the Codex switch writes only `~/.codex/cizicode.config.toml`; it keeps the
user's primary Codex configuration untouched and stores the Cizi API key only
as `experimental_bearer_token` in that provider profile. The `Aç` button runs
the `cizicode` profile. `Kökten Kaldır` only removes the verified standalone
CLI paths, the Cizi Code profile, and its exact User PATH entry; Codex Desktop
and ChatGPT Desktop are preserved.

## Paketleme
```bash
npm run dist:win    # Windows .exe (NSIS)
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux AppImage
```
> Paketleme için `assets/icon.*` ekleyin (yoksa varsayılan Electron ikonu kullanılır).

## Mimari
- `src/main/` — Electron ana süreç. `apiClient.js` yalnızca holder-scoped uçları çağırır (`/api/me`, `/api/usage/me`, `/api/cli-tools/templates`). Backend'e erişim yoktur.
- `src/main/tools/registry.js` — her araç için yerel config şekli (gateway'in kendi cli-tools mantığından port edildi; kullanıcının makinesine yazar).
- `src/main/tools/backup.js` — config dosyalarının tam yedeği; geri alımda **aynen** geri yükler.
- `src/renderer/` — Cizi Code temalı arayüz (vanilla JS, framework yok).

## Güvenlik
- Renderer izole (`contextIsolation: true`, `nodeIntegration: false`); tüm yetenekler preload köprüsü üzerinden.
- Uygulama backend'e değil, yalnızca kendi dashboard'una erişir.
