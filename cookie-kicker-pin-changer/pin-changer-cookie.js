"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
} = require("./cookie-helper");
const { CookieExpiredError } = require("./kicker-cookie");

const HEADLESS = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const URL_PIN_SETTINGS = "https://www.netflix.com/settings/migration";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WrongPasswordError extends Error {
  constructor(email) {
    super(`Password salah untuk ${email} (Kontrol Orang Tua).`);
    this.name = "WrongPasswordError";
    this.email = email;
  }
}

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
        server: process.env.PROXY_SERVER,
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
        server: process.env.PROXY_SERVER,
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
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });

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
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_NAV,
    });
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

/**
 * Ganti PIN untuk profil tertentu menggunakan cookie.
 * Menggunakan iterasi per-profil dari https://www.netflix.com/account/profiles
 */
async function changePinsForProfilesCookie(email, password, targetProfiles) {
  const browser = await launchBrowser();
  const pinChanges = new Map();

  try {
    const startUrl = "https://www.netflix.com/account/profiles";
    const page = await newCookiePage(browser, email, startUrl);
    await sleep(2000);

    const targets = targetProfiles.map((t) => t.trim().toLowerCase());

    for (const target of targets) {
      console.log(`\n  [pin-cookie] ➔ Memproses profil target: "${target}"`);

      // 1. Pastikan selalu mulai dari halaman daftar profil di setiap iterasi
      if (!page.url().includes("/account/profiles")) {
        await page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT_NAV,
        });
        await sleep(2000);
      }

      // Cari tombol profil yang namanya persis dengan target
      const profileButtons = page.locator(
        'button[data-uia^="menu-card+account-profiles-page+profiles-menu-card+"]',
      );
      const count = await profileButtons.count();
      let targetBtn = null;

      for (let i = 0; i < count; i++) {
        const btn = profileButtons.nth(i);
        const text = (await btn.textContent()) || "";

        // Bersihkan teks Netflix dan target: jadikan huruf kecil, ubah spasi ganda jadi spasi tunggal, dan hilangkan spasi ujung
        const cleanText = text.toLowerCase().replace(/\s+/g, " ").trim();
        const cleanTarget = target.toLowerCase().replace(/\s+/g, " ").trim();

        // Gunakan .includes() untuk mengabaikan teks tambahan tersembunyi dari Netflix (seperti "Now Watching")
        if (cleanText.includes(cleanTarget)) {
          targetBtn = btn;
          break;
        }
      }

      if (!targetBtn) {
        console.warn(
          `  [pin-cookie] ⚠ Profil "${target}" tidak ditemukan di halaman ini.`,
        );
        continue;
      }

      // 2. Klik profil (Masuk ke halaman Manage profile and preferences)
      console.log(`  [pin-cookie] Klik profil "${target}"...`);
      await targetBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1500);

      // 3. Klik tombol Profile Lock / Kunci Profil
      const profileLockBtn = page.locator(
        '[data-uia="menu-card+profile-lock"]',
      );
      if (
        !(await profileLockBtn.isVisible({ timeout: 5000 }).catch(() => false))
      ) {
        console.warn(
          `  [pin-cookie] ⚠ Tombol Profile Lock tidak ditemukan untuk "${target}".`,
        );
        continue;
      }
      console.log(`  [pin-cookie] Masuk ke pengaturan Profile Lock...`);
      await profileLockBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1500);

      // 4. Klik Edit PIN (Jika PIN sudah aktif sebelumnya)
      const editPinBtn = page.locator(
        '[data-uia="profile-lock-page+edit-button"]',
      );
      if (await editPinBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  [pin-cookie] Klik tombol Edit PIN...`);
        await editPinBtn.click();
        await sleep(1500);
      }

      // 5. Cek Form MFA (Confirm Password / Email Code)
      const confirmPwBtn = page.locator(
        'button:has([data-uia="account-mfa-button-PASSWORD+label"])',
      );
      if (await confirmPwBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(
          `  [pin-cookie] MFA Terdeteksi, memilih Confirm Password...`,
        );
        await confirmPwBtn.click();
        await sleep(1000);

        // 6. Masukkan Password Akun
        const pwInput = page.locator(
          '[data-uia="collect-password-input-modal-entry"]',
        );
        const konfirmPwButtons = page.locator(
        '[data-uia="collect-input-submit-cta"]',
      );
        console.log(`  [pin-cookie] Memasukkan password akun...`);
        await pwInput.fill(password);
        await sleep(500);

        // Tekan Enter untuk submit modal password
        await konfirmPwButtons.click();

        // Tunggu hingga masuk ke input PIN atau muncul error password
        await Promise.race([
          page
            .locator('[data-uia="profile-lock+pin-input"]')
            .waitFor({ state: "visible", timeout: 10_000 }),
          page
            .locator('[data-uia="input-message-error"]')
            .waitFor({ state: "visible", timeout: 10_000 }),
        ]).catch(() => {});

        const pwError = page.locator(
          '[data-uia="input-message-error"], .ui-message-error',
        );
        if (await pwError.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.error(`  [pin-cookie] ✗ Password ditolak.`);
          throw new WrongPasswordError(email);
        }
      }

      // 7. Input PIN Baru (Format input tunggal)
      const pinInput = page.locator('[data-uia="profile-lock+pin-input"]');
      if (!(await pinInput.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.warn(
          `  [pin-cookie] ⚠ Form input PIN gagal dimuat untuk "${target}".`,
        );
        continue;
      }

      // Ambil PIN lama untuk direkam sebelum membuat yang baru
      const oldPin = (await pinInput.inputValue()) || "0000";
      const newPin = generateNewPin(oldPin);

      console.log(
        `  [pin-cookie] "${target}" PIN lama: ${oldPin !== "0000" ? oldPin : "(kosong)"} ➔ PIN baru: ${newPin}`,
      );

      // Bersihkan dan ketik PIN baru
      await pinInput.fill("");
      await pinInput.fill(newPin);
      await sleep(500);

      // Centang "Require PIN to add new profiles" jika muncul dan kamu butuh (Opsional)
      // await page.locator('input[type="checkbox"]').check().catch(()=>{});

      // 8. Simpan PIN
      console.log("  [pin-cookie] Menyimpan PIN...");
      const savePinBtn = page.locator(
        '[data-uia="profile-lock-pin-entry-page+save-button"]',
      );
      await savePinBtn.click();

      // Tunggu hingga loading selesai dan kembali ke halaman profile lock status
      await page
        .waitForURL((url) => !url.toString().includes("pin-entry"), {
          timeout: TIMEOUT_NAV,
        })
        .catch(() => {});
      await sleep(1500);

      pinChanges.set(target, newPin);
    }

    // Dynamic Update: simpan cookie terbaru dari server setelah semua selesai
    if (pinChanges.size > 0) {
      console.log(
        `\n  [pin-cookie] Selesai! Update PIN sukses untuk: ${[...pinChanges.keys()].join(", ")}`,
      );
      const { refreshAndSaveCookies } = require("./kicker-cookie");
      await refreshAndSaveCookies(page.context(), email);
    } else {
      console.log("\n  [pin-cookie] Tidak ada profil yang berhasil diubah.");
    }
  } finally {
    await browser.close();
  }

  return pinChanges;
}

module.exports = {
  changePinsForProfilesCookie,
  CookieExpiredError,
  WrongPasswordError,
};
