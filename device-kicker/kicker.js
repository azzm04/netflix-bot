"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const { fetchNetflixCode } = require("./nfpro");
const { requestCodeFromTelegram } = require("./tg-bridge");
const fs = require("fs");

const HEADLESS        = process.env.HEADLESS !== "false";
const TIMEOUT_NAV     = 45_000;
const CODE_INPUT_MODE = process.env.CODE_INPUT_MODE ?? "terminal";

const URL_CLEARCOOKIES = "https://www.netflix.com/clearcookies";
const URL_DEVICES      = "https://www.netflix.com/manageaccountaccess";

// ── Custom Errors ─────────────────────────────────────────
class RateLimitError extends Error {
  constructor(msg) { super(msg); this.name = "RateLimitError"; }
}

// ── Helpers ───────────────────────────────────────────────
function shouldSkip(_email) { return false; }

function isPakeKode(password) {
  if (!password) return true;
  const up = password.toUpperCase().trim();
  return up === "PAKE KODE" || up === "PAKE KODE MASUK";
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getCodeFromUser(email, codeType, accountLabel = "") {
  if (CODE_INPUT_MODE === "telegram") {
    return requestCodeFromTelegram(email, codeType, accountLabel);
  }
  const readline = require("readline");
  const label = codeType === "4digit" ? "4 digit" : "6 digit";
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  [${email}] Masukkan ${label} kode: `, ans => { rl.close(); resolve(ans.trim()); });
  });
}

function debugShot(page, name) {
  const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return page.screenshot({ path: `${dir}/${name}_${Date.now()}.png`, fullPage: true }).catch(() => {});
}

// ── Launch Browser ────────────────────────────────────────
async function launchBrowser() {
  const proxyConfig = process.env.PROXY_SERVER
    ? { server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD }
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

async function newStealthPage(browser) {
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
    // userAgent Dihapus: Biarkan Playwright + Stealth Plugin yang mengatur otomatis
  });

  const page = await ctx.newPage();

  if (proxyConfig) {
    console.log(`  [browser] Proxy aktif: ${proxyConfig.server}`);
  }

  // Anti-deteksi manual (addInitScript) dihapus karena sudah ditangani chromium.use(stealth)

  return page;
}

// ── OTP Input Boxes ───────────────────────────────────────
async function fillOtpBoxes(page, code) {
  const digits = code.replace(/\D/g, "").split("");

  // Playwright: cari input OTP
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

  if (inputs.length === 0) {
    // Fallback: satu input
    const single = page.locator('input[type="text"], input[type="number"]').first();
    await single.fill(code);
    return;
  }

  for (let i = 0; i < digits.length && i < inputs.length; i++) {
    await inputs[i].click();
    await inputs[i].press(digits[i]);
    await sleep(100);
  }
}

// ── Login ─────────────────────────────────────────────────
/**
 * @param {import('playwright').Browser} browser
 * @param {string} email
 * @param {string} password
 * @param {boolean} forcePakeKode - true untuk MEET
 * @param {string} accountLabel
 */
async function loginNetflix(browser, email, password, forcePakeKode = false, accountLabel = "") {
  const page = await newStealthPage(browser);
  const effectivePakeKode = forcePakeKode || isPakeKode(password);

  // Step 1: Clear cookies
  console.log("  [login] Clear cookies...");
  await page.goto(URL_CLEARCOOKIES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

  // Klik Sign In jika ada
  try {
    await page.locator('a[href*="/login"], [data-uia*="sign-in"]').first().click({ timeout: 5000 });
    await page.waitForURL("**/login**", { timeout: TIMEOUT_NAV }).catch(() => {});
  } catch {
    await page.goto("https://www.netflix.com/login", { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
  }

  // Step 2: Isi email
  console.log(`  [login] Isi email: ${email}`);
  const emailInput = page.locator('input[name="userLoginId"], input[type="email"], input[autocomplete="email"]').first();
  await emailInput.waitFor({ timeout: TIMEOUT_NAV });

  await emailInput.click({ clickCount: 3 });
  await sleep(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await sleep(200);
  await page.evaluate((val) => {
    const input = document.querySelector('input[name="userLoginId"], input[type="email"]')
      ?? document.querySelector('input[autocomplete="email"]')
      ?? document.querySelector('input');
    if (!input) return;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, email);
  await sleep(500);

  const emailValue = await emailInput.inputValue().catch(() => "");
  console.log(`  [login] Email value: "${emailValue}"`);

  // Klik Continue
  const continueBtn = page.locator('button[type="submit"], button[data-uia="login-continue-btn"]').first();
  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("  [login] Klik Continue...");
    // Gerak mouse ke tombol dulu
    const box = await continueBtn.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2 - 10, box.y - 15);
      await sleep(200 + Math.random() * 300);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(100 + Math.random() * 200);
    }
    await continueBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  // Tunggu halaman berubah (OTP atau password)
  await sleep(2000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  // Cek rate limit
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const isRateLimited = bodyText.toLowerCase().includes("something went wrong") &&
    !bodyText.toLowerCase().includes("code we sent") &&
    !(await page.locator('input[type="password"]').isVisible().catch(() => false));
  if (isRateLimited) {
    console.log(`  [login] Rate limit untuk ${email}`);
    await page.close();
    throw new RateLimitError(`Netflix rate limit untuk ${email}`);
  }

  console.log(`  [login] URL: ${page.url()}`);

  // Step 3: Deteksi halaman
  const isOtpPage = await page.locator('input[maxlength="1"], input[inputmode="numeric"]').count().then(n => n >= 3).catch(() => false)
    || bodyText.toLowerCase().includes("code we sent")
    || bodyText.toLowerCase().includes("enter the code");

  const isPassPage = await page.locator('input[type="password"]').isVisible().catch(() => false);

  console.log(`  [login] isOtpPage=${isOtpPage}, isPassPage=${isPassPage}, effectivePakeKode=${effectivePakeKode}`);

  // ── Flow OTP ─────────────────────────────────────────────
  if (isOtpPage) {
    if (!effectivePakeKode) {
      // Coba beralih ke password
      console.log("  [login] OTP page, coba switch ke password...");
      const switched = await _switchToPasswordPage(page);
      if (switched) {
        await page.locator('input[type="password"]').waitFor({ timeout: 10000 });
      } else {
        // Tidak bisa switch, tetap pakai OTP
        await _handleOtpLogin(page, email, accountLabel);
        await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(() => {});
        return _verifyLoginSuccess(page, email);
      }
    } else {
      // PAKE KODE / MEET: langsung OTP
      await _handleOtpLogin(page, email, accountLabel);
      await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(() => {});
      return _verifyLoginSuccess(page, email);
    }
  }

  // ── Flow Password ─────────────────────────────────────────
  const passVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
  if (passVisible && !isPakeKode(password)) {
    console.log("  [login] Isi password...");
    await debugShot(page, "before_password");

    await page.locator('input[type="password"]').fill(password);
    await sleep(300);
    await debugShot(page, "after_fill_password");

    // Klik Sign In
    await page.locator('button[data-uia="login-submit-button"], button[type="submit"]').first().click();

    // Tunggu navigasi keluar dari /login
    await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(async () => {
      const urlNow = page.url();
      console.log(`  [login] Timeout setelah submit password, URL: ${urlNow}`);
      // Screenshot untuk debug apa yang terjadi
      await debugShot(page, "submit_timeout");
      // Dump teks halaman untuk lihat error
      const bodySnippet = await page.locator("body").innerText().catch(() => "").then(t => t.slice(0, 500));
      console.log(`  [login] Halaman setelah submit:\n${bodySnippet}`);
    });

    await debugShot(page, "after_submit");

    // Cek apakah Netflix minta OTP setelah password (2-step)
    const urlAfter = page.url();
    if (urlAfter.includes("/login")) {
      const isOtpAfterPass = await page.locator('input[maxlength="1"]').count().then(n => n >= 3).catch(() => false);
      if (isOtpAfterPass) {
        console.log("  [login] OTP muncul setelah password...");
        await _handleOtpLogin(page, email, accountLabel);
        await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(() => {});
      }
    }
  }

  return _verifyLoginSuccess(page, email);
}

async function _handleOtpLogin(page, email, accountLabel) {
  console.log("  [login] Tunggu 10 detik agar email terkirim...");
  await sleep(10_000);

  let code4;
  if (accountLabel === "MAHESH") {
    code4 = await getCodeFromUser(email, "4digit", "MAHESH");
  } else {
    console.log("  [login] Auto-fetch 4-digit kode...");
    try {
      code4 = await fetchNetflixCode(email, "signin", { retries: 3, retryDelay: 5000 });
    } catch (err) {
      console.warn(`  [login] Fetch gagal: ${err.message}, fallback input...`);
      code4 = await getCodeFromUser(email, "4digit", accountLabel);
    }
  }

  console.log(`  [login] Isi kode 4 digit: ${code4}`);
  await fillOtpBoxes(page, code4);

  // Submit (Enter atau klik tombol)
  const submitBtn = page.locator('button[type="submit"], button[data-uia*="continue"]').first();
  if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
}

async function _switchToPasswordPage(page) {
  // Jeda manusiawi 2-4 detik sebelum klik
  const delay = 2000 + Math.random() * 2000;
  console.log(`  [login] Jeda ${Math.round(delay)}ms sebelum klik Get Help...`);
  await sleep(delay);

  // Cek error sebelum klik
  const errorBefore = await page.locator(':text("Something went wrong")').isVisible({ timeout: 1000 }).catch(() => false);
  if (errorBefore) {
    console.log("  [login] Error terdeteksi sebelum klik — reCAPTCHA block.");
    return false;
  }

  const getHelpBtn = page.locator('button:has-text("Get Help"), button[data-uia*="help"]').first();
  if (!await getHelpBtn.isVisible({ timeout: 3000 }).catch(() => false)) return false;

  // Simulasi gerakan mouse manusiawi
  const box = await getHelpBtn.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2 - 30, box.y - 20);
    await sleep(300 + Math.random() * 300);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150 + Math.random() * 200);
  }
  await getHelpBtn.click();
  await sleep(800 + Math.random() * 600);

  // Cek error setelah klik
  const errorAfter = await page.locator(':text("Something went wrong")').isVisible({ timeout: 2000 }).catch(() => false);
  if (errorAfter) {
    console.log("  [login] Error muncul setelah klik Get Help — reCAPTCHA block.");
    return false;
  }

  // Klik Use password instead
  const usePwBtn = page.locator('[data-uia="usePasswordInsteadHelpMenuItem"], a:has-text("Use password instead")').first();
  if (await usePwBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await sleep(500 + Math.random() * 400);
    await usePwBtn.click();
    await sleep(500);
    return true;
  }
  return false;
}

function _verifyLoginSuccess(page, email) {
  const url = page.url();
  if (url.includes("/login") || url.includes("/loginHelp")) {
    throw new Error(`Login gagal untuk ${email}. URL: ${url}`);
  }
  console.log(`  [login] Login berhasil: ${url}`);
  return page;
}

// ── Verifikasi /manageaccountaccess ───────────────────────
async function handleDeviceVerification(page, email, accountLabel = "") {
  await sleep(1000);

  const url = page.url();
  const isMfaUrl = url.includes("/mfa");
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const needsVerify = isMfaUrl ||
    bodyText.toLowerCase().includes("verifikasi identitas") ||
    bodyText.toLowerCase().includes("first, let's make sure") ||
    bodyText.toLowerCase().includes("email a code") ||
    bodyText.toLowerCase().includes("kirim kode");

  if (!needsVerify) {
    console.log("  [verify] Tidak perlu verifikasi.");
    return;
  }

  console.log(`  [verify] Halaman verifikasi (${url})`);

  // Tunggu tombol email code
  const emailCodeBtn = page.locator('[data-uia="account-mfa-button-OTP_EMAIL"] button').first();
  await emailCodeBtn.waitFor({ timeout: 10000 });
  await emailCodeBtn.click();
  console.log("  [verify] Klik Email a code.");

  // Tunggu form OTP muncul (tetap di halaman yang sama)
  await page.waitForFunction(() => {
    const inputs = document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]');
    return inputs.length >= 3 || document.body.innerText.toLowerCase().includes("code will expire");
  }, { timeout: 20000 }).catch(() => {
    console.log("  [verify] Form OTP tidak muncul, lanjut...");
  });

  console.log("  [verify] Tunggu 10 detik agar email terkirim...");
  await sleep(10_000);

  let code6;
  if (accountLabel === "MAHESH") {
    code6 = await getCodeFromUser(email, "6digit", "MAHESH");
  } else {
    console.log("  [verify] Auto-fetch 6-digit kode...");
    try {
      code6 = await fetchNetflixCode(email, "signin6", { retries: 3, retryDelay: 5000 });
    } catch (err) {
      console.warn(`  [verify] Fetch gagal: ${err.message}`);
      code6 = await getCodeFromUser(email, "6digit", accountLabel);
    }
  }

  console.log(`  [verify] Isi kode 6 digit: ${code6}`);
  await fillOtpBoxes(page, code6);

  const submitBtn = page.locator('button[type="submit"]').first();
  if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await page.waitForURL(url => !url.includes("/mfa"), { timeout: TIMEOUT_NAV }).catch(() => {});
  await sleep(1000);
  console.log(`  [verify] Selesai. URL: ${page.url()}`);
}

// ── Kick Devices ──────────────────────────────────────────
async function kickDevicesByProfiles(page, profileNames) {
  const targets = profileNames.map(p => p.trim().toLowerCase());
  let totalKicked = 0;
  const processedIds = new Set();

  await sleep(1500);

  // Klik "Tampilkan Lainnya" sampai habis
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

  // Iterasi semua card
  for (let round = 0; round < 30; round++) {
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();
    if (count === 0) break;

    let foundUnprocessed = false;
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const deviceId = await card.getAttribute("data-uia");
      const uniqueKey = `${deviceId}::${i}`;
      if (processedIds.has(uniqueKey)) continue;

      foundUnprocessed = true;

      // Cek PERANGKAT SAAT INI
      const isCurrent = await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count() > 0;
      if (isCurrent) {
        processedIds.add(uniqueKey);
        continue;
      }

      // Expand jika belum ada tombol Keluar
      const keluarBtn = card.locator('button:has-text("Keluar"), button:has-text("Sign Out")').first();
      const isExpanded = await keluarBtn.isVisible({ timeout: 500 }).catch(() => false);
      if (!isExpanded) {
        const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
        if (await dropBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await dropBtn.click();
          await sleep(800);
        } else {
          processedIds.add(uniqueKey);
          continue;
        }
      }

      // Cek profil
      const cardText = await card.innerText().catch(() => "");
      const lowerText = cardText.toLowerCase();

      // Deteksi nama profil dari "(terakhir ditonton)"
      let profileText = null;
      const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.toLowerCase().includes("terakhir ditonton") || line.toLowerCase().includes("last watched")) {
          profileText = line;
          break;
        }
      }

      // Bersihkan teks "tidak ada aktivitas"
      if (profileText && (
        profileText.toLowerCase().includes("tidak ada aktivitas") ||
        profileText.toLowerCase().includes("no activity")
      )) profileText = null;

      const noActivity = lowerText.includes("tidak ada aktivitas") || lowerText.includes("no activity");

      // Skip jika profil ada tapi tidak cocok
      const matchedTarget = targets.find(t => profileText && profileText.toLowerCase().includes(t));
      if (profileText && !matchedTarget) {
        processedIds.add(uniqueKey);
        continue;
      }

      // Kick!
      const keluarVisible = await keluarBtn.isVisible({ timeout: 1000 }).catch(() => false);
      if (keluarVisible) {
        const display = profileText ?? (noActivity ? "tidak ada aktivitas" : "no profile");
        await keluarBtn.click();
        totalKicked++;
        console.log(`  [kick] Dikick: "${display}" (${deviceId})`);
        processedIds.add(uniqueKey);
        await sleep(1500);
      } else {
        processedIds.add(uniqueKey);
      }
      break; // proses satu card per round
    }

    if (!foundUnprocessed) break;
  }

  return totalKicked;
}

// ── Entry Points ──────────────────────────────────────────
async function kickDevicesForProfiles(email, password, profileNames, isMeet = false, accountLabel = "") {
  if (shouldSkip(email)) return { skipped: true, kicked: 0, reason: "MAHESH/ROSE" };

  const browser = await launchBrowser();
  let totalKicked = 0;
  try {
    const page = await loginNetflix(browser, email, password, isMeet, accountLabel);

    await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
    await handleDeviceVerification(page, email, accountLabel);

    if (!page.url().includes("manageaccountaccess")) {
      await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
      await sleep(1000);
      await handleDeviceVerification(page, email, accountLabel);
    }

    totalKicked = await kickDevicesByProfiles(page, profileNames);
    console.log(`  [devices] Total ${totalKicked} dikick.`);
  } finally {
    await browser.close();
  }
  return { skipped: false, kicked: totalKicked };
}

async function kickDevicesForProfile(email, password, profileName, isMeet = false, accountLabel = "") {
  return kickDevicesForProfiles(email, password, [profileName], isMeet, accountLabel);
}

module.exports = { kickDevicesForProfile, kickDevicesForProfiles, shouldSkip, isPakeKode, RateLimitError };
