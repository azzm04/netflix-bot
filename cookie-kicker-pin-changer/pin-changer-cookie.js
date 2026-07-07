/**
 * pin-changer-cookie.js — Ganti PIN profil Netflix via Cookie Injection
 *
 * Perbedaan dari pin-changer.js:
 *  - TIDAK ada proses login
 *  - Cookie di-inject langsung
 *  - Jika cookie expired → throw CookieExpiredError
 *  - Logic ganti PIN SAMA persis
 *
 * SETUP AWAL:
 *   node cookie-helper.js save-interactive "email@gmail.com"
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
} = require("./cookie-helper");
const { CookieExpiredError } = require("./kicker-cookie");

const HEADLESS    = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const URL_PIN_SETTINGS = "https://www.netflix.com/settings/migration";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Generate PIN Baru ─────────────────────────────────────
function generateNewPin(oldPin) {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (pin === oldPin);
  return pin;
}

// ── Launch Browser ────────────────────────────────────────
async function launchBrowser() {
  const proxyConfig = process.env.PROXY_SERVER
    ? {
        server:   process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  return chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,
    proxy: proxyConfig,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });
}

// ── Buat Context + Inject Cookie ─────────────────────────
async function newCookiePage(browser, email, targetUrl) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new CookieExpiredError(email);
  }

  const proxyConfig = process.env.PROXY_SERVER
    ? {
        server:   process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "id-ID",
    proxy: proxyConfig,
  });

  await ctx.addCookies(buildPlaywrightCookies(cookieData));

  const page = await ctx.newPage();

  console.log(`  [pin-cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    deleteCookieForEmail(email);
    throw new CookieExpiredError(email);
  }

  // Handle MFA jika muncul
  if (url.includes("/mfa")) {
    console.log(`  [pin-cookie] MFA terdeteksi, selesaikan verifikasi...`);
    const { checkForExtraVerification } = require("./kicker-cookie");
    await checkForExtraVerification(page, email);
    // Navigate ulang ke target setelah MFA selesai
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
  }

  console.log(`  [pin-cookie] Berhasil akses: ${page.url()}`);
  return page;
}

// ── Ganti PIN ─────────────────────────────────────────────

/**
 * Ganti PIN untuk profil tertentu menggunakan cookie.
 *
 * @param {string}   email
 * @param {string}   password      - password akun (untuk form Kontrol Orang Tua jika diminta)
 * @param {string[]} targetProfiles - nama profil yang PIN-nya mau diganti
 * @returns {Promise<Map<string, string>>} map nama profil → PIN baru
 * @throws {CookieExpiredError} jika cookie tidak ada / expired
 */
async function changePinsForProfilesCookie(email, password, targetProfiles) {
  const browser    = await launchBrowser();
  const pinChanges = new Map();

  try {
    const page = await newCookiePage(browser, email, URL_PIN_SETTINGS);
    await sleep(1500);

    // Form Kontrol Orang Tua (muncul jika parent control aktif)
    const pwRestrict = page.locator('[data-uia="input-account-content-restrictions"]').first();
    if (await pwRestrict.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log("  [pin-cookie] Isi password Kontrol Orang Tua...");
      await pwRestrict.fill(password);
      await sleep(500);
      await page.locator('[data-uia="btn-account-pin-submit"]').click();

      // Tunggu network selesai dulu (Netflix sering ada redirect internal)
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await sleep(500);

      // Tunggu profil muncul
      const loaded = await page.waitForFunction(
        () => {
          // Cek berbagai kemungkinan selector yang Netflix pakai
          return (
            document.querySelectorAll(".parental-control-profile").length > 0 ||
            document.querySelectorAll('[data-uia^="pin-number-"]').length > 0 ||
            document.querySelectorAll('[class*="profile-hub"]').length > 0 ||
            document.querySelectorAll('[class*="parental"]').length > 0
          );
        },
        { timeout: 30_000, polling: 1000 }
      ).catch(() => null);

      if (!loaded) {
        // Screenshot untuk debug
        const fs = require("fs");
        const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        await page.screenshot({ path: `${dir}/pin_parental_fail_${Date.now()}.png`, fullPage: true }).catch(() => {});
        console.warn("  [pin-cookie] Profil tidak muncul setelah submit password.");
        console.warn(`  [pin-cookie] URL saat ini: ${page.url()}`);
        // Coba navigate ulang ke halaman yang sama
        console.log("  [pin-cookie] Coba navigate ulang...");
        await page.goto(URL_PIN_SETTINGS, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
        await sleep(2000);
      }

      await sleep(800);
    }

    // Baca semua profil + PIN lama
    const profiles = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".parental-control-profile")).map((li) => {
        const name = li.querySelector("h3")?.textContent?.trim() ?? "";
        const pins = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
          .sort(
            (a, b) =>
              +a.getAttribute("data-uia").slice(-1) -
              +b.getAttribute("data-uia").slice(-1)
          )
          .map((inp) => inp.value ?? "");
        return { name, oldPin: pins.join("") };
      })
    );

    console.log(
      `  [pin-cookie] Profil: ${profiles.map((p) => `${p.name}(${p.oldPin})`).join(", ")}`
    );

    const targets = targetProfiles.map((t) => t.trim().toLowerCase());

    for (const prof of profiles) {
      if (!targets.some((t) => prof.name.toLowerCase().includes(t))) continue;

      const newPin = generateNewPin(prof.oldPin);
      console.log(`  [pin-cookie] "${prof.name}": ${prof.oldPin} → ${newPin}`);

      await page.evaluate(
        ({ profileName, newPin }) => {
          for (const li of document.querySelectorAll(".parental-control-profile")) {
            const h3 = li.querySelector("h3");
            if (!h3?.textContent?.toLowerCase().includes(profileName.toLowerCase())) continue;
            const inputs = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]')).sort(
              (a, b) =>
                +a.getAttribute("data-uia").slice(-1) -
                +b.getAttribute("data-uia").slice(-1)
            );
            newPin.split("").forEach((d, i) => {
              if (!inputs[i]) return;
              const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value"
              ).set;
              setter.call(inputs[i], d);
              inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
              inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
            });
            return;
          }
        },
        { profileName: prof.name, newPin }
      );

      await sleep(400);
      pinChanges.set(prof.name, newPin);
    }

    if (pinChanges.size > 0) {
      console.log("  [pin-cookie] Klik Terapkan...");
      await page.locator('[data-uia="profile-hub-migration-apply"]').click();
      await page
        .waitForURL((url) => !url.toString().includes("/settings/migration"), { timeout: TIMEOUT_NAV })
        .catch(() => {});
      await sleep(1500);
      console.log(`  [pin-cookie] Selesai! ${[...pinChanges.keys()].join(", ")}`);

      // Dynamic Update: simpan cookie terbaru dari server
      const { refreshAndSaveCookies } = require("./kicker-cookie");
      await refreshAndSaveCookies(page.context(), email);
    } else {
      console.log("  [pin-cookie] Tidak ada profil yang cocok.");
    }
  } finally {
    await browser.close();
  }

  return pinChanges;
}

module.exports = { changePinsForProfilesCookie, CookieExpiredError };
