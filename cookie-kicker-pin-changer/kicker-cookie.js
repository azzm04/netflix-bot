/**
 * kicker-cookie.js — Kick device Netflix via Cookie Injection
 *
 * Perbedaan dari kicker.js:
 *  - TIDAK ada proses login (tidak perlu email + password)
 *  - Cookie di-inject langsung ke browser context
 *  - Jika cookie expired → throw CookieExpiredError (bukan crash)
 *  - Logic kick device SAMA persis dengan kicker.js
 *
 * SETUP AWAL:
 *   node cookie-helper.js save-interactive "email@gmail.com"
 *
 * PEMAKAIAN:
 *   const { kickDevicesForProfilesCookie } = require("./kicker-cookie");
 *   await kickDevicesForProfilesCookie("email@gmail.com", ["Profil A", "Profil B"]);
 */

"use strict";

require("dotenv").config();
const { requestCodeFromTelegram } = require("./tg-bridge");
const { chromium } = require("playwright");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
} = require("./cookie-helper");
const fs = require("fs");

const HEADLESS = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;

const URL_DEVICES = "https://www.netflix.com/manageaccountaccess";

// ── Custom Errors ─────────────────────────────────────────
class CookieExpiredError extends Error {
  constructor(email) {
    super(
      `Cookie expired untuk ${email}. Jalankan: node cookie-helper.js save-interactive "${email}"`,
    );
    this.name = "CookieExpiredError";
    this.email = email;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Debug Screenshot ──────────────────────────────────────
function debugShot(page, name) {
  const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return page
    .screenshot({ path: `${dir}/${name}_${Date.now()}.png`, fullPage: true })
    .catch(() => {});
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
      "--lang=id-ID",
    ],
  });
}

// ── Buat Context + Inject Cookie ─────────────────────────
/**
 * Buat browser context baru, inject cookie Netflix, lalu buka halaman target.
 * @param {import('playwright').Browser} browser
 * @param {string} email
 * @param {string} targetUrl
 * @returns {Promise<import('playwright').Page>}
 * @throws {CookieExpiredError} jika redirect ke /login
 */
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
    extraHTTPHeaders: { "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8" },
    proxy: proxyConfig,
  });

  // Inject cookie SEBELUM navigate
  await ctx.addCookies(buildPlaywrightCookies(cookieData));

  const page = await ctx.newPage();

  // Langsung ke halaman target
  console.log(`  [cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });

  // Cek apakah Netflix redirect ke login (cookie expired)
  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    await debugShot(page, `cookie_expired_${email.split("@")[0]}`);
    deleteCookieForEmail(email);
    await page.close();
    throw new CookieExpiredError(email);
  }

  // MFA ditangani oleh checkForExtraVerification — jangan throw di sini
  console.log(`  [cookie] Berhasil akses: ${url}`);
  return page;
}

// ── Verifikasi MFA (jika muncul) ─────────────────────────
/**
 * Handle halaman /mfa yang muncul saat akses halaman sensitif.
 * Cookie masih valid — Netflix hanya minta verifikasi tambahan untuk IP baru.
 * Strategi: klik "Email a code", fetch kode otomatis via nfpro.js, submit.
 * Auto-retry jika kode salah (klik "Kirim Ulang Kode").
 */
async function checkForExtraVerification(page, email, isMahesh = false) {
  await sleep(1000);
  const url = page.url();
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const needsMfa =
    url.includes("/mfa") ||
    bodyText.toLowerCase().includes("verifikasi identitas") ||
    bodyText.toLowerCase().includes("verify your identity") ||
    bodyText.toLowerCase().includes("email a code") ||
    bodyText.toLowerCase().includes("kirim kode");

  if (!needsMfa) return; // tidak perlu verifikasi

  console.log(`  [mfa] Halaman verifikasi terdeteksi (${url})`);

  // ── Loop retry jika kode salah ──────────────────────────
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  [mfa] Attempt ${attempt}/3`);

    // Klik tombol kirim kode via email (atau "Kirim Ulang" jika retry)
    const emailCodeBtn = page
      .locator(
        'button:has-text("Email a code"), button:has-text("Kirim kode"), button:has-text("Kirim Ulang Kode"), [data-uia="account-mfa-button-OTP_EMAIL"] button',
      )
      .first();

    if (await emailCodeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol kirim kode...`);
      await emailCodeBtn.click();
    }

    // Tunggu form OTP muncul
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll(
            'input[inputmode="numeric"], input[maxlength="1"]',
          ).length >= 4 ||
          document.body.innerText.toLowerCase().includes("code will expire") ||
          document.body.innerText
            .toLowerCase()
            .includes("kode tersebut akan kedaluwarsa"),
        { timeout: 15_000, polling: 500 },
      )
      .catch(() => {});

    console.log(`  [mfa] Tunggu 10 detik agar email terkirim...`);
    await sleep(10_000);

    // Coba auto-fetch kode
    let code6 = null;
    try {
      if (isMahesh) {
        // Akun MAHESH: fetch via bot Telegram @Maheshshoppiebot
        // Tombol "Verification Code" (vercode) — bukan "Verification code after login" (signin6)
        const { fetchFromMaheshBot } = require("./mahesh-fetcher");

        const maheshExtraRetries = 2; // percobaan tambahan: kirim ulang di Netflix + tunggu 5s + minta lagi
        for (let mAttempt = 1; mAttempt <= maheshExtraRetries + 1; mAttempt++) {
          console.log(`  [mfa] Fetch kode via Mahesh Bot (percobaan ${mAttempt}/${maheshExtraRetries + 1})...`);
          try {
            code6 = await fetchFromMaheshBot(email, "vercode", {
              retries: 0,
              retryDelay: 5000,
            });
            break; // sukses, keluar dari loop mahesh
          } catch (maheshErr) {
            console.warn(`  [mfa] Mahesh Bot gagal (percobaan ${mAttempt}): ${maheshErr.message}`);

            if (mAttempt <= maheshExtraRetries) {
              // Kirim ulang kode di halaman Netflix
              const resendBtn = page.locator(
                'button:has-text("Kirim Ulang Kode"), button:has-text("Resend"), button:has-text("Email a code"), button:has-text("Kirim kode")'
              ).first();
              if (await resendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                console.log(`  [mfa] Klik kirim ulang kode di Netflix...`);
                await resendBtn.click();
              } else {
                console.warn(`  [mfa] Tombol kirim ulang tidak ditemukan di halaman Netflix.`);
              }
              console.log(`  [mfa] Tunggu 5 detik sebelum minta kode lagi ke Mahesh Bot...`);
              await sleep(5000);
            } else {
              throw maheshErr; // habis semua percobaan, lempar ke catch luar → fallback Telegram
            }
          }
        }
      } else {
        // Akun lain: fetch via nfpro.js
        const { fetchNetflixCode } = require("./nfpro");
        console.log(`  [mfa] Auto-fetch kode 6 digit via nfpro...`);
        code6 = await fetchNetflixCode(email, "signin6", {
          retries: 2,
          retryDelay: 5000,
        });
      }
      console.log(`  [mfa] Kode: ${code6}`);
    } catch (err) {
      console.warn(`  [mfa] Auto-fetch gagal: ${err.message}`);
      // Fallback: minta kode via Telegram bot (bukan terminal lagi)
      console.log(`  [mfa] Minta kode manual via Telegram...`);
      try {
        code6 = await requestCodeFromTelegram(
          email,
          "6digit",
          isMahesh ? "MAHESH" : "",
        );
      } catch (tgErr) {
        console.error(
          `  [mfa] Gagal dapat kode dari Telegram: ${tgErr.message}`,
        );
        throw new Error(
          `MFA gagal untuk ${email}: auto-fetch dan Telegram fallback sama-sama gagal.`,
        );
      }
    }

    if (!code6) {
      throw new Error(`Kode MFA tidak tersedia untuk ${email}`);
    }

    // ── Isi kotak OTP — tiru fillOtpBoxes dari kicker.js ──
    const digits = code6.replace(/\D/g, "").split("");
    console.log(`  [mfa] Isi ${digits.length} digit: ${code6}`);

    // Cari input dengan urutan prioritas sama seperti kicker.js
    const selectors = [
      'input[inputmode="numeric"]',
      'input[maxlength="1"]',
      'input[autocomplete="one-time-code"]',
    ];

    let inputs = [];
    for (const sel of selectors) {
      inputs = await page.$$(sel);
      if (inputs.length >= digits.length) break;
    }

    console.log(`  [mfa] Input boxes ditemukan: ${inputs.length}`);

    if (inputs.length === 0) {
      // Fallback: satu input field
      console.log(`  [mfa] Fallback ke single input...`);
      const single = page
        .locator('input[type="text"], input[type="number"]')
        .first();
      if (await single.isVisible({ timeout: 2000 }).catch(() => false)) {
        await single.fill(code6);
      }
    } else if (inputs.length === 1) {
      // Single input — isi sekaligus (Netflix /mfa pakai satu input autocomplete)
      console.log(`  [mfa] Single input — isi sekaligus: ${code6}`);
      await inputs[0].click();
      await sleep(100);
      // Clear dulu
      await inputs[0].evaluate((el) => {
        el.value = "";
      });
      // Set value via React-compatible setter
      await inputs[0].evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, code6);
      await sleep(300);
    } else {
      // Multiple boxes — isi digit per digit
      for (let i = 0; i < digits.length && i < inputs.length; i++) {
        await inputs[i].click();
        await inputs[i].press(digits[i]);
        await sleep(100);
      }
    }

    // Tunggu sebentar sebelum submit (agar React state update selesai)
    await sleep(500);

    // Submit
    const submitBtn = page
      .locator('button[type="submit"], button:has-text("Kirim")')
      .first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol Kirim...`);
      await submitBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Tunggu response dari server
    await sleep(3000);

    // ── Cek apakah kode salah ──────────────────────────────
    const bodyAfter = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const urlAfter = page.url();

    // Sukses: keluar dari /mfa
    if (!urlAfter.includes("/mfa")) {
      console.log(`  [mfa] ✅ Verifikasi berhasil! URL: ${urlAfter}`);
      return;
    }

    // Kode salah: ada error message
    const isWrongCode =
      bodyAfter.toLowerCase().includes("kode tersebut salah") ||
      bodyAfter.toLowerCase().includes("code is incorrect") ||
      bodyAfter.toLowerCase().includes("kode salah");

    if (isWrongCode && attempt < 3) {
      console.warn(`  [mfa] ❌ Kode salah. Coba lagi...`);
      await sleep(2000);
      continue; // retry loop
    }

    if (attempt === 3) {
      throw new Error(`MFA gagal setelah 3 percobaan untuk ${email}`);
    }
  }
}

// ── Kick Device Logic ─────────────────────────────────────
// (Sama persis dengan kicker.js — dipindah ke sini agar file ini standalone)
async function kickDevicesByProfiles(page, profileNames) {
  const targets = profileNames.map((p) => p.trim().toLowerCase());
  let totalKicked = 0;
  const processedIds = new Set();

  await sleep(1500);

  // Expand "Tampilkan Lainnya" sampai habis
  let more = true;
  while (more) {
    const showMore = page.locator('[data-uia="device-list+show-more-button"]');
    if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showMore.click();
      console.log("  [kick] Klik Tampilkan Lainnya...");
      await sleep(1200);
    } else {
      more = false;
    }
  }

  // Iterasi semua card device
  for (let round = 0; round < 30; round++) {
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();
    if (count === 0) break;

    let foundUnprocessed = false;
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);

      let deviceId;
      try {
        deviceId = await card.getAttribute("data-uia", { timeout: 5000 });
      } catch (err) {
        console.warn(
          `  [kick] ⚠ Card index ${i} sudah hilang dari DOM (mungkin ke-refresh) — skip.`,
        );
        continue; // jangan tandai processedIds karena deviceId tidak diketahui, biar round berikutnya re-scan fresh
      }

      const uniqueKey = `${deviceId}::${i}`;
      if (processedIds.has(uniqueKey)) continue;

      foundUnprocessed = true;

      // Skip PERANGKAT SAAT INI
      const isCurrent =
        (await card
          .locator('[data-uia$="+current-device-badge+ANNOUNCE"]')
          .count()) > 0;
      if (isCurrent) {
        processedIds.add(uniqueKey);
        continue;
      }

      // Expand card jika belum ada tombol Keluar
      const keluarBtn = card
        .locator('button:has-text("Keluar"), button:has-text("Sign Out")')
        .first();
      let isExpanded = await keluarBtn
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (!isExpanded) {
        const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
        if (await dropBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await dropBtn.click();
          await sleep(1000);
          isExpanded = await keluarBtn
            .isVisible({ timeout: 1500 })
            .catch(() => false);
        }
        if (!isExpanded) {
          console.warn(
            `  [kick] ⚠ Gagal expand card ${deviceId} — dilewati (button tidak muncul).`,
          );
          processedIds.add(uniqueKey);
          continue;
        }
      }

      // Baca teks card untuk deteksi nama profil
      const cardText = await card.innerText().catch(() => "");
      const lowerText = cardText.toLowerCase();

      let profileText = null;
      const lines = cardText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (
          line.toLowerCase().includes("terakhir ditonton") ||
          line.toLowerCase().includes("last watched")
        ) {
          profileText = line;
          break;
        }
      }

      if (
        profileText &&
        (profileText.toLowerCase().includes("tidak ada aktivitas") ||
          profileText.toLowerCase().includes("no activity"))
      ) {
        profileText = null;
      }

      const noActivity =
        lowerText.includes("tidak ada aktivitas") ||
        lowerText.includes("no activity");

      // Skip jika profil tidak cocok dengan target
      const matchedTarget = targets.find(
        (t) => profileText && profileText.toLowerCase().includes(t),
      );
      if (profileText && !matchedTarget) {
        processedIds.add(uniqueKey);
        continue;
      }

      // Kick!
      const keluarVisible = await keluarBtn
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (keluarVisible) {
        const display =
          profileText ?? (noActivity ? "tidak ada aktivitas" : "no profile");
        await keluarBtn.click();
        totalKicked++;
        console.log(`  [kick] Dikick: "${display}" (${deviceId})`);
        processedIds.add(uniqueKey);
        await sleep(1500);
      } else {
        const display =
          profileText ?? (noActivity ? "tidak ada aktivitas" : "no profile");
        console.warn(
          `  [kick] ⚠ MISS: "${display}" (${deviceId}) — tombol Keluar tidak muncul, mungkin belum ter-kick!`,
        );
        processedIds.add(uniqueKey);
      }
    }
    if (!foundUnprocessed) break;
  }

  return totalKicked;
}

// ── Entry Point ───────────────────────────────────────────

/**
 * Kick devices untuk beberapa profil sekaligus (satu email).
 * @param {string}   email
 * @param {string[]} profileNames
 * @returns {Promise<{ kicked: number }>}
 * @throws {CookieExpiredError} jika cookie tidak ada / expired
 */
// ── Dynamic Update: simpan cookie terbaru dari server ─────
/**
 * Setelah setiap operasi berhasil, server Netflix sering refresh cookie.
 * Ambil cookie terbaru dari context dan timpa cookies.json.
 */
async function refreshAndSaveCookies(ctx, email) {
  try {
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

    const netflixId = cm["NetflixId"];
    const secureNetflixId = cm["SecureNetflixId"];

    if (!netflixId || !secureNetflixId) {
      console.log(
        "  [cookie] Dynamic update: cookie baru tidak ditemukan, skip.",
      );
      return;
    }

    const { saveCookieForEmail } = require("./cookie-helper");
    saveCookieForEmail(email, {
      netflixId,
      secureNetflixId,
      memclid: cm["memclid"] ?? null,
      nfvdid: cm["nfvdid"] ?? null,
      clSharedContext: cm["clSharedContext"] ?? null,
    });
    console.log("  [cookie] ✓ Dynamic update: cookie terbaru disimpan.");
  } catch (err) {
    console.warn(`  [cookie] Dynamic update gagal: ${err.message}`);
  }
}

async function kickDevicesForProfilesCookie(
  email,
  profileNames,
  isMahesh = false,
) {
  const browser = await launchBrowser();
  let totalKicked = 0;

  try {
    const page = await newCookiePage(browser, email, URL_DEVICES);

    await checkForExtraVerification(page, email, isMahesh);

    // Jika halaman bukan manageaccountaccess, navigate ulang
    if (!page.url().includes("manageaccountaccess")) {
      console.log("  [kick] Redirect tidak terduga, navigate ulang...");
      await page.goto(URL_DEVICES, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_NAV,
      });
      await checkForExtraVerification(page, email, isMahesh);
    }

    totalKicked = await kickDevicesByProfiles(page, profileNames);
    console.log(`  [kick] Total ${totalKicked} device dikick.`);

    // Dynamic Update: simpan cookie terbaru
    await refreshAndSaveCookies(page.context(), email);
  } finally {
    await browser.close();
  }

  return { kicked: totalKicked };
}

/**
 * Kick devices untuk satu profil.
 * @param {string} email
 * @param {string} profileName
 */
async function kickDevicesForProfileCookie(
  email,
  profileName,
  isMahesh = false,
) {
  return kickDevicesForProfilesCookie(email, [profileName], isMahesh);
}

module.exports = {
  kickDevicesForProfileCookie,
  kickDevicesForProfilesCookie,
  CookieExpiredError,
  checkForExtraVerification,
  refreshAndSaveCookies,
};
