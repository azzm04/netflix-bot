/**
 * pin-changer.js — Ganti PIN profil Netflix untuk akun MAHESH / ROSE
 *
 * Digunakan karena akun MAHESH/ROSE tidak bisa mendapatkan 6-digit
 * kode verifikasi untuk /manageaccountaccess.
 * Solusi alternatif: ganti PIN profil → customer tidak bisa akses profil.
 *
 * Flow:
 *   1. Login (ROSE: password | MAHESH: 4-digit kode, input manual)
 *   2. Buka https://www.netflix.com/settings/migration
 *   3. Isi password akun → klik Lanjut
 *   4. Tampil semua profil beserta PIN kotak
 *   5. Untuk profil yang expired (ada di targetProfiles):
 *      - Baca PIN lama
 *      - Generate PIN baru random (berbeda dari lama)
 *      - Isi PIN baru ke input
 *   6. Klik "Terapkan"
 *   7. Return map { profileName → newPin } untuk update spreadsheet
 */

"use strict";

require("dotenv").config();
const puppeteer  = require("puppeteer");
const readline   = require("readline");
const { fetchNetflixCode } = require("./nfpro");
const { isPakeKode } = require("./kicker");

const HEADLESS    = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const TIMEOUT_SEL = 20_000;
const DELAY_TYPE  = 80;

const URL_CLEARCOOKIES = "https://www.netflix.com/clearcookies";
const URL_PIN_SETTINGS = "https://www.netflix.com/settings/migration";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helper: minta input terminal ────────────────────────
function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ─── Helper: isi OTP boxes ───────────────────────────────
async function fillOtpBoxes(page, code) {
  const digits = code.replace(/\D/g, "").split("");
  const sels = [
    'input[data-uia*="otp"]', 'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]', 'input[type="tel"]', 'input[maxlength="1"]',
  ];
  let inputs = [];
  for (const sel of sels) {
    inputs = await page.$$(sel);
    if (inputs.length >= digits.length) break;
  }
  if (inputs.length === 0) {
    const single = await page.$('input[type="text"], input[type="number"]');
    if (single) { await single.click({ clickCount: 3 }); await single.type(code, { delay: DELAY_TYPE }); return; }
    throw new Error("Input OTP tidak ditemukan.");
  }
  for (let i = 0; i < digits.length && i < inputs.length; i++) {
    await inputs[i].click(); await sleep(100);
    await inputs[i].type(digits[i], { delay: 80 }); await sleep(150);
  }
}

async function submitOtp(page) {
  const sels = ['button[data-uia="continue-btn"]', 'button[type="submit"]', 'button[data-uia*="submit"]'];
  for (const sel of sels) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); return; }
  }
  await page.keyboard.press("Enter");
}

// ─── Generate PIN 4 digit random, berbeda dari oldPin ────
function generateNewPin(oldPin) {
  let newPin;
  do {
    newPin = String(Math.floor(1000 + Math.random() * 9000));
  } while (newPin === oldPin);
  return newPin;
}

// ─── Login Netflix ────────────────────────────────────────
/**
 * @param {import('puppeteer').Browser} browser
 * @param {string} email
 * @param {string} password  - "PAKE KODE" atau password asli
 * @param {"rose"|"mahesh"} accountType
 */
async function loginNetflix(browser, email, password, accountType) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });

  console.log("  [login] Clear cookies...");
  await page.goto(URL_CLEARCOOKIES, { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  await sleep(1000);

  try {
    await page.waitForSelector('a[href*="/login"], button[data-uia*="sign-in"]', { timeout: 8000 });
    await page.click('a[href*="/login"], button[data-uia*="sign-in"]');
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  } catch {
    await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  }
  await sleep(800);

  // Isi email
  console.log(`  [login] Isi email: ${email}`);
  await page.waitForSelector(
    'input[name="userLoginId"], input[type="email"], input[autocomplete="email"]',
    { timeout: TIMEOUT_SEL }
  );
  const emailInput = await page.$('input[name="userLoginId"], input[type="email"], input[autocomplete="email"]')
    ?? await page.$("input");
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: DELAY_TYPE });
  await sleep(400);

  const contBtn = await page.$('button[data-uia="login-continue-btn"], button[type="submit"]');
  if (contBtn) {
    const t = await contBtn.evaluate(b => b.textContent.trim().toLowerCase());
    if (t.includes("continue") || t.includes("lanjut")) {
      await contBtn.click();
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
      await sleep(1500);
    }
  }

  // Deteksi halaman: OTP atau password
  const isOtpPage = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]');
    const body = document.body.innerText.toLowerCase();
    return inputs.length >= 3 || body.includes("code we sent") || body.includes("enter the code");
  });

  if (accountType === "rose") {
    // ROSE: selalu pakai password
  if (isOtpPage) {
    console.log("  [login] Halaman OTP, switch ke password (ROSE)...");

    // Cek apakah "Use password instead" sudah visible (Get Help sudah expanded)
    const alreadyVisible = await page.evaluate(() =>
      !!(document.querySelector('[data-uia="usePasswordInsteadHelpMenuItem"]'))
    );

    if (!alreadyVisible) {
      // Get Help belum expanded → klik dulu
      await page.evaluate(() => {
        const btns = document.querySelectorAll("button");
        for (const b of btns) {
          if (b.textContent.trim().toLowerCase().includes("get help")) { b.click(); return; }
        }
      });
      await sleep(800);
    }

    // Klik "Use password instead"
    const clicked = await page.evaluate(() => {
      const byUia = document.querySelector('[data-uia="usePasswordInsteadHelpMenuItem"]');
      if (byUia) { byUia.click(); return true; }
      for (const el of document.querySelectorAll("a, button, span")) {
        if (el.textContent.trim().toLowerCase().includes("use password instead")) {
          el.click(); return true;
        }
      }
      return false;
    });

    if (!clicked) throw new Error("Tombol 'Use password instead' tidak ditemukan.");
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 10000 });
    console.log("  [login] Halaman password muncul.");
  }

    console.log("  [login] Isi password (ROSE)...");
    const pw = await page.$('input[name="password"], input[type="password"]');
    await pw.click({ clickCount: 3 });
    await pw.type(password, { delay: DELAY_TYPE });
    await sleep(300);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }),
      page.click('button[data-uia="login-submit-button"], button[type="submit"]'),
    ]);

  } else {
    // MAHESH: coba password dulu, fallback ke 4-digit kode jika tidak ada password
    if (!isOtpPage) {
      // Langsung halaman password
      console.log("  [login] Isi password (MAHESH)...");
      const pw = await page.$('input[name="password"], input[type="password"]');
      if (pw) {
        await pw.click({ clickCount: 3 });
        await pw.type(password, { delay: DELAY_TYPE });
        await sleep(300);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }),
          page.click('button[data-uia="login-submit-button"], button[type="submit"]'),
        ]);
      }
    } else {
      // Halaman OTP — coba switch ke password dulu
      console.log("  [login] Halaman OTP, coba switch ke password (MAHESH)...");
      await page.evaluate(() => {
        document.querySelectorAll("button, span, a, div").forEach(el => {
          if (el.textContent.trim().toLowerCase() === "get help") el.click();
        });
      });
      await sleep(700);

      const hasPwOption = await page.evaluate(() =>
        !!(document.querySelector('[data-uia="usePasswordInsteadHelpMenuItem"]') ||
          Array.from(document.querySelectorAll("a, button, span"))
            .some(el => el.textContent.trim().toLowerCase().includes("use password instead")))
      );

      if (hasPwOption && password && !isPakeKode(password)) {
        // Ada opsi password → pakai password
        await page.evaluate(() => {
          const byUia = document.querySelector('[data-uia="usePasswordInsteadHelpMenuItem"]');
          if (byUia) { byUia.click(); return; }
          for (const el of document.querySelectorAll("a, button, span")) {
            if (el.textContent.trim().toLowerCase().includes("use password instead")) { el.click(); return; }
          }
        });
        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        const pw = await page.$('input[type="password"]');
        await pw.click({ clickCount: 3 });
        await pw.type(password, { delay: DELAY_TYPE });
        await sleep(300);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }),
          page.click('button[data-uia="login-submit-button"], button[type="submit"]'),
        ]);
      } else {
        // Tidak ada opsi password → fallback ke 4-digit kode (input manual)
        console.log(`\n  Akun MAHESH "${email}" membutuhkan kode 4 digit.`);
        const code4 = await askUser(`  Masukkan 4 digit kode dari email ${email}: `);
        await fillOtpBoxes(page, code4);
        await sleep(400);
        await submitOtp(page);
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
      }
    }
  }

  await sleep(1000);
  const urlAfter = page.url();
  if (urlAfter.includes("/login")) throw new Error(`Login gagal untuk ${email}.`);
  console.log(`  [login] Login berhasil: ${urlAfter}`);
  return page;
}

// ─── Fungsi Utama: changePinsForProfiles ─────────────────
/**
 * Ganti PIN untuk profil-profil yang expired dalam satu akun.
 *
 * @param {string}   email
 * @param {string}   password
 * @param {"rose"|"mahesh"} accountType
 * @param {string[]} targetProfiles  - nama profil yang harus diganti PIN
 * @returns {Promise<Map<string, string>>}  map { profileName → newPin }
 */
async function changePinsForProfiles(email, password, accountType, targetProfiles) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    defaultViewport: { width: 1280, height: 900 },
  });

  const pinChanges = new Map(); // profileName → newPin

  try {
    const page = await loginNetflix(browser, email, password, accountType);

    // Buka halaman pengaturan PIN profil
    console.log("  [pin] Buka /settings/migration...");
    await page.goto(URL_PIN_SETTINGS, { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
    await sleep(1500);

    // Isi password untuk Kontrol Orang Tua
    const passwordInput = await page.$('[data-uia="input-account-content-restrictions"]');
    if (passwordInput) {
      console.log("  [pin] Isi password untuk Kontrol Orang Tua...");
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: DELAY_TYPE });
      await sleep(300);
      await page.click('[data-uia="btn-account-pin-submit"]');

      // Halaman ini render via JS (tidak full navigation) — tunggu profil list muncul
      await page.waitForSelector(".parental-control-profile", { timeout: TIMEOUT_SEL });
      await sleep(800);
    }

    // Halaman profil dengan PIN sekarang tampil
    // Baca semua profil + PIN lama, lalu update yang ada di targetProfiles
    const targets = targetProfiles.map(p => p.trim().toLowerCase());

    console.log(`  [pin] Mencari profil: ${targetProfiles.join(", ")}`);

    // Baca semua profil dari halaman
    const profiles = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".parental-control-profile")).map(li => {
        const name = li.querySelector("h3")?.textContent?.trim() ?? "";
        const pins = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
          .sort((a, b) => {
            const ia = parseInt(a.getAttribute("data-uia").replace("pin-number-", ""));
            const ib = parseInt(b.getAttribute("data-uia").replace("pin-number-", ""));
            return ia - ib;
          })
          .map(inp => inp.value ?? "");
        return { name, oldPin: pins.join("") };
      });
    });

    console.log(`  [pin] Profil ditemukan: ${profiles.map(p => `${p.name}(${p.oldPin})`).join(", ")}`);

    // Update PIN untuk profil yang ditarget
    for (const prof of profiles) {
      const isTarget = targets.some(t => prof.name.toLowerCase().includes(t));
      if (!isTarget) continue;

      const newPin = generateNewPin(prof.oldPin);
      console.log(`  [pin] Ganti PIN "${prof.name}": ${prof.oldPin} → ${newPin}`);

      // Isi PIN baru ke input
      await page.evaluate((profileName, newPin) => {
        const allProfiles = document.querySelectorAll(".parental-control-profile");
        for (const li of allProfiles) {
          const h3 = li.querySelector("h3");
          if (!h3 || !h3.textContent.trim().toLowerCase().includes(profileName.toLowerCase())) continue;

          const pinInputs = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
            .sort((a, b) => {
              return parseInt(a.getAttribute("data-uia").replace("pin-number-", "")) -
                     parseInt(b.getAttribute("data-uia").replace("pin-number-", ""));
            });

          newPin.split("").forEach((digit, i) => {
            if (pinInputs[i]) {
              // Set value via native input event (React-aware)
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
              ).set;
              nativeInputValueSetter.call(pinInputs[i], digit);
              pinInputs[i].dispatchEvent(new Event("input", { bubbles: true }));
              pinInputs[i].dispatchEvent(new Event("change", { bubbles: true }));
            }
          });
          return true;
        }
        return false;
      }, prof.name, newPin);

      await sleep(500);
      pinChanges.set(prof.name, newPin);
    }

    if (pinChanges.size === 0) {
      console.log("  [pin] Tidak ada profil yang cocok untuk diganti PIN.");
      return pinChanges;
    }

    // Klik "Terapkan"
    console.log("  [pin] Klik Terapkan...");
    await page.click('[data-uia="profile-hub-migration-apply"]');
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
    await sleep(1500);

    console.log(`  [pin] Selesai! PIN berhasil diganti untuk: ${[...pinChanges.keys()].join(", ")}`);

  } finally {
    await browser.close();
  }

  return pinChanges;
}

module.exports = { changePinsForProfiles };
