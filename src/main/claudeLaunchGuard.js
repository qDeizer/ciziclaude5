// Yonlendirilmis Claude kisayolu tiklandiginda calisan akis.
//
// ILKESI: KULLANICIYI ASLA ENGELLEMEZ.
// Claude'u acmak kullanicinin istedigi sey; markalama ikincil. Bu yuzden burada
// hicbir hata Claude'un acilmasini durdurmaz. Kontrol basarisiz olursa Claude
// yine acilir, yalnizca etiketler o oturumda Ingilizce kalir ve durum loglanir.
//
// NEDEN BURADA YAMA UYGULANMIYOR
// Kisayol kullanici hakkiyla calisir; WindowsApps'e yazmak yonetici ister. Her
// Claude acilisinda UAC istemi cikarmak kabul edilemez. Bunun yerine:
//   1) durum dosya hash'inden OKUNUR (yetki gerekmez)
//   2) bozuksa SYSTEM onarim gorevi tetiklenmeye CALISILIR (sessizce basarisiz
//      olabilir; gorev kendi tetikleyicisiyle nasil olsa calisacaktir)
//   3) Claude her durumda acilir
//
// Tek instance kilidi ile ETKILESMEZ: bu akis kilit istemeden calisir ve isini
// bitirip cikar. Boylece Cizi Code acikken de kisayol calisir.

const log = require("./logger");

function summarise(error) {
  return String(error?.code || error?.message || error || "bilinmeyen");
}

async function run({
  brandingTaskName,
  branding,
  lifecycle,
  packageIdentity,
  runPowerShellFn,
} = {}) {
  const outcome = { checked: false, brandingOk: null, repairRequested: false, launched: false };

  try {
    const runtime = await lifecycle.getRuntimeStatus("claude-desktop");
    if (!runtime?.installed) {
      log.warning("claude-launch", "Claude Desktop kurulu degil; baslatilamadi");
      return outcome;
    }

    // Markalama acik olmali mi? Niyet kaydi yoksa kontrol edilecek bir sey yok.
    const desired = branding.readDesired();
    // Hangi dizine bakildigi loglanir: niyet dosyasi baska bir yerde durursa bu
    // akis sessizce "yapilacak is yok" der ve ozellik calisiyor gorunurken
    // hicbir sey yapmaz. Yolu gormek o durumu tespit edilebilir kilar.
    outcome.workRoot = branding.workRoot();
    outcome.desired = desired.enabled;
    if (desired.enabled) {
      try {
        const main = packageIdentity.mainPackageIdentity(runtime);
        const state = await branding.inspect(main);
        outcome.checked = true;
        outcome.brandingOk = state.allPatched === true;
        if (!state.allPatched) {
          log.warning("claude-launch", "Claude etiketleri yerinde degil; onarim gorevi tetikleniyor", {
            known: state.known,
            version: main.version,
          });
          outcome.repairRequested = await requestRepair(brandingTaskName, runPowerShellFn);
        }
      } catch (error) {
        // Kontrol basarisiz olabilir (surum degismis, kayit yok...). Bu Claude'u
        // acmayi engellemez.
        log.warning("claude-launch", "Etiket kontrolu yapilamadi; Claude yine aciliyor", {
          reason: summarise(error),
        });
      }
    }

    await lifecycle.launchAppUserModelId(packageIdentity.CLAUDE_MAIN_APP_ID);
    outcome.launched = true;
    log.info("claude-launch", "Claude Desktop kisayol uzerinden baslatildi", {
      brandingDesired: outcome.desired,
      brandingChecked: outcome.checked,
      brandingOk: outcome.brandingOk,
      repairRequested: outcome.repairRequested,
      workRoot: outcome.workRoot,
    });
  } catch (error) {
    log.error("claude-launch", "Claude Desktop baslatilamadi", { reason: summarise(error) });
  }
  return outcome;
}

// Gorevi tetiklemek yetki gerektirebilir. Basarisizlik beklenen bir durumdur ve
// sessizce gecilir: gorev kendi olay/periyodik tetikleyicisiyle calisacaktir.
async function requestRepair(taskName, runPowerShellFn) {
  if (!taskName || typeof runPowerShellFn !== "function") return false;
  try {
    await runPowerShellFn(
      "$ErrorActionPreference='Stop';Start-ScheduledTask -TaskName $env:CIZI_TASK_NAME;'ok'",
      { env: { CIZI_TASK_NAME: taskName }, timeout: 20000, maxBuffer: 32 * 1024 },
    );
    return true;
  } catch (error) {
    log.info("claude-launch", "Onarim gorevi bu kullaniciyla tetiklenemedi; kendi tetikleyicisini bekleyecek", {
      reason: summarise(error),
    });
    return false;
  }
}

module.exports = { run };
