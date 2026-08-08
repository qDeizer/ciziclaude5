// End-to-end test of the Cizi Code desktop app, driving the REAL Electron window
// via Playwright (button clicks, form fills) — like a human.
// Usage: node e2e.cjs <stage>   where stage = "read" (default) or "toggle"
const path = require("path");
const fs = require("fs");
const os = require("os");
const { _electron: electron } = require("playwright-core");

const BASE = process.env.CIZI_BASE || "http://46.101.222.119";
const KEY = process.env.CIZI_KEY || "sk-cizi-c133f176ca3c8eef2adb7d01be94c295295037aff94ca11f";
const STAGE = process.argv[2] || "read";
const APP_DIR = __dirname;
const OPENCODE_CFG = path.join(os.homedir(), ".config", "opencode", "opencode.json");

function log(...a) { console.log("[E2E]", ...a); }

async function ensureDashboard(win) {
  await win.waitForLoadState("domcontentloaded");
  await win.waitForTimeout(600);
  const dashVisible = await win.isVisible("#dash-view:not(.hidden)").catch(() => false);
  if (dashVisible) return;
  await win.waitForSelector("#login-view:not(.hidden)", { timeout: 8000 });
  await win.fill("#login-base", BASE);
  await win.fill("#login-key", KEY);
  await win.click("#login-btn");
  await win.waitForSelector("#dash-view:not(.hidden)", { timeout: 20000 });
  await win.waitForFunction(() => document.querySelector("#combo-chips")?.children.length > 0, { timeout: 20000 }).catch(() => {});
  await win.waitForTimeout(1200);
}

async function collectLogs(win, limit = 60) {
  return win.$$eval("#log-list .log-row", (rows, lim) => rows.slice(0, lim).map(r => ({
    level: (r.className.match(/log-(info|warn|error|debug)/) || [])[1],
    scope: r.querySelector(".log-scope")?.textContent.trim(),
    msg: r.querySelector(".log-msg")?.textContent.trim().slice(0, 90),
  })), limit);
}

(async () => {
  const app = await electron.launch({ args: ["."], cwd: APP_DIR });
  const out = { stage: STAGE };
  try {
    const win = await app.firstWindow();

    if (STAGE === "read") {
      // Force login flow: log out if a session auto-entered.
      await win.waitForLoadState("domcontentloaded");
      await win.waitForTimeout(600);
      if (await win.isVisible("#dash-view:not(.hidden)").catch(() => false)) {
        await win.click("#logout-btn"); await win.waitForTimeout(400);
      }
      await ensureDashboard(win);
      out.loginError = await win.textContent("#login-error").catch(() => null);
      out.connBase = (await win.textContent("#conn-base")).trim();
      out.quotaPct = (await win.textContent("#quota-pct")).trim();
      out.used = (await win.textContent("#q-used")).trim();
      out.limit = (await win.textContent("#q-limit")).trim();
      out.requests = (await win.textContent("#t-requests")).trim();
      out.tokens = (await win.textContent("#t-tokens")).trim();
      out.combos = await win.$$eval("#combo-chips .chip", els => els.map(e => e.textContent.trim()));
      out.tools = await win.$$eval("#tools-list .tool-row", rows => rows.map(r => ({
        name: r.querySelector(".tool-name")?.textContent.trim(),
        sub: r.querySelector(".tool-sub")?.textContent.trim(),
        on: !!r.querySelector('input[type="checkbox"]')?.checked,
      })));
      out.chartDrawn = await win.evaluate(() => { const c = document.querySelector("#usage-chart"); return !!c && c.width > 0; });
      await win.waitForTimeout(1500);
      out.logCount = await win.$$eval("#log-list .log-row", r => r.length);
      out.logSample = await collectLogs(win, 14);
    }

    if (STAGE === "toggle") {
      await ensureDashboard(win);
      const row = win.locator(".tool-row", { hasText: "OpenCode" });
      await row.waitFor({ timeout: 8000 });
      // pick first combo in this row's model dropdown
      await row.locator("select.tool-model").selectOption({ index: 0 }).catch(() => {});
      out.selectedModel = await row.locator("select.tool-model").inputValue().catch(() => null);

      out.before_exists = fs.existsSync(OPENCODE_CFG);

      // ── Toggle ON (real click on the switch) ──
      log("clicking OpenCode switch ON…");
      await row.locator(".switch").click();
      await win.waitForTimeout(2500);
      out.after_on_subStatus = (await row.locator(".tool-sub").textContent()).trim();
      out.after_on_checked = await row.locator('input[type="checkbox"]').isChecked();
      out.after_on_exists = fs.existsSync(OPENCODE_CFG);
      if (out.after_on_exists) {
        const cfg = JSON.parse(fs.readFileSync(OPENCODE_CFG, "utf-8"));
        out.after_on_hasProvider = !!cfg?.provider?.cizicode;
        out.after_on_baseURL = cfg?.provider?.cizicode?.options?.baseURL;
        out.after_on_model = cfg?.model;
      }

      // ── Toggle OFF (real click) → must restore exactly (file should be gone) ──
      log("clicking OpenCode switch OFF…");
      await row.locator(".switch").click();
      await win.waitForTimeout(2500);
      out.after_off_subStatus = (await row.locator(".tool-sub").textContent()).trim();
      out.after_off_checked = await row.locator('input[type="checkbox"]').isChecked();
      out.after_off_exists = fs.existsSync(OPENCODE_CFG);

      await win.waitForTimeout(1200);
      out.logSample = (await collectLogs(win, 40)).filter(l => /tools|backup/.test(l.scope || ""));

      out.PASS = out.before_exists === false && out.after_on_exists === true &&
        out.after_on_hasProvider === true && out.after_off_exists === false &&
        out.after_on_checked === true && out.after_off_checked === false;
    }

    if (STAGE === "shot") {
      await ensureDashboard(win);
      await win.waitForTimeout(2500); // let logs + chart populate
      await win.screenshot({ path: path.join(APP_DIR, "shot-top.png") });
      await win.evaluate(() => { const c = document.querySelector(".content"); if (c) c.scrollTop = c.scrollHeight; });
      await win.waitForTimeout(800);
      await win.screenshot({ path: path.join(APP_DIR, "shot-logs.png") });
      out.shots = ["shot-top.png", "shot-logs.png"];
    }

    log("RESULT:\n" + JSON.stringify(out, null, 2));
  } catch (e) {
    out.error = e.message;
    log("ERROR:", e.message);
    log("RESULT:\n" + JSON.stringify(out, null, 2));
  } finally {
    await app.close();
  }
})();
