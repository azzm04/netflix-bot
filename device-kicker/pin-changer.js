/**
 * pin-changer.js — Ganti PIN profil Netflix untuk akun MAHESH / ROSE
 * Menggunakan Playwright (bukan Puppeteer) + proxy support
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const readline = require("readline");
const { fetchNetflixCode } = require("./nfpro");
const { isPakeKode, RateLimitError } = require("./kicker");
const { requestCodeFromTelegram } = require("./tg-bridge");

const HEADLESS    = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const CODE_INPUT_MODE = process.env.CODE_INPUT_MODE ?? "terminal";
const URL_PIN_SETTINGS = "https://www.netflix.com/settings/migration";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function generateNewPin(oldPin) {
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (pin === oldPin);
  return pin;
}

async function getCodeFromUser(email, codeType, label = "") {
  if (CODE_INPUT_MODE === "telegram") return requestCodeFromTelegram(email, codeType, label);
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  [${email}] Masukkan ${codeType === "4digit" ? "4" : "6"} digit kode: `, ans => {
      rl.close(); resolve(ans.trim());
    });
  });
}

// ── Launch Browser dengan Proxy ───────────────────────────
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
}

async function newPage(browser) {
  const proxyConfig = process.env.PROXY_SERVER
    ? { server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD }
    : undefined;

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "id-ID",
    proxy: proxyConfig,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });
  if (proxyConfig) console.log(`  [pin] Proxy aktif: ${proxyConfig.server}`);
  return page;
}

// ── Login ─────────────────────────────────────────────────
async function loginNetflix(browser, email, password, accountType) {
  const page = await newPage(browser);

  // Clear cookies
  await page.goto("https://www.netflix.com/clearcookies", { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
  await sleep(500);

  // Ke halaman login
  try {
    await page.locator('a[href*="/login"]').first().click({ timeout: 5000 });
    await page.waitForURL("**/login**", { timeout: TIMEOUT_NAV }).catch(() => {});
  } catch {
    await page.goto("https://www.netflix.com/login", { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
  }

  // Isi email — pastikan field benar-benar terisi sebelum klik Continue
  console.log(`  [login] Isi email: ${email}`);
  const emailInput = page.locator('input[name="userLoginId"], input[type="email"], input[autocomplete="email"]').first();
  await emailInput.waitFor({ timeout: TIMEOUT_NAV });

  // Klik field, lalu isi dengan beberapa cara untuk memastikan React state update
  await emailInput.click({ clickCount: 3 });
  await sleep(300);
  await emailInput.fill(""); // kosongkan dulu
  await sleep(200);

  // Ketik manual karakter per karakter
  for (const char of email) {
    await emailInput.press(char);
    await sleep(30 + Math.random() * 40);
  }
  await sleep(500);

  // Verifikasi email terisi
  let emailVal = await emailInput.inputValue().catch(() => "");
  console.log(`  [login] Email terisi: "${emailVal.substring(0, 20)}"`);

  // Jika masih kosong, coba cara lain: evaluateHandle
  if (!emailVal || emailVal.trim() === "") {
    console.log("  [login] Email masih kosong, coba evaluateHandle...");
    await page.evaluate((emailStr) => {
      const input = document.querySelector('input[name="userLoginId"], input[type="email"], input');
      if (!input) return;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, emailStr);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, email);
    await sleep(400);
    emailVal = await emailInput.inputValue().catch(() => "");
    console.log(`  [login] Email setelah fallback: "${emailVal.substring(0, 20)}"`);
  }

  await sleep(800 + Math.random() * 500);

  // Klik Continue
  const contBtn = page.locator('button[type="submit"], button[data-uia="login-continue-btn"]').first();
  if (await contBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await contBtn.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
    }
    console.log("  [login] Klik Continue...");
    await contBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  // Tunggu halaman pindah ke OTP atau password
  await sleep(3000);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  // Cek rate limit
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const isRateLimited = bodyText.toLowerCase().includes("something went wrong") &&
    !(await page.locator('input[type="password"]').isVisible().catch(() => false));
  if (isRateLimited) {
    await page.close();
    throw new RateLimitError(`Netflix rate limit untuk ${email}`);
  }

  console.log(`  [login] URL: ${page.url()}`);

  // Re-deteksi halaman SETELAH Continue diklik
  const isOtpPage = await page.locator('input[maxlength="1"]').count().then(n => n >= 3).catch(() => false)
    || bodyText.toLowerCase().includes("code we sent")
    || bodyText.toLowerCase().includes("enter the code");

  // isPassPage: cek apakah halaman menampilkan HANYA password (bukan form gabungan email+password)
  // Ciri: ada input password DAN tidak ada input email yang kosong
  const isPassPage = await page.evaluate(() => {
    const pwInput = document.querySelector('input[type="password"], input[name="password"]');
    if (!pwInput) return false;
    // Kalau masih di halaman gabungan (email + password + continue), anggap belum di halaman password
    const emailInput = document.querySelector('input[name="userLoginId"], input[type="email"]');
    if (emailInput && (!emailInput.value || emailInput.value.trim() === "")) return false;
    return true;
  });

  // Screenshot debug
  const fs = require("fs");
  fs.mkdirSync("/tmp/nfdebug", { recursive: true });
  await page.screenshot({ path: `/tmp/nfdebug/pin_after_email_${Date.now()}.png`, fullPage: true }).catch(() => {});
  const bodySnippet = bodyText.slice(0, 300).replace(/\n/g, " | ");
  console.log(`  [login] isOtpPage=${isOtpPage}, isPassPage=${isPassPage}`);
  console.log(`  [login] Body: ${bodySnippet}`);

  // ── ROSE: password ──────────────────────────────────────
  if (accountType === "rose") {
    if (isOtpPage) {
      // Switch ke password
      const byUia = page.locator('[data-uia="usePasswordInsteadHelpMenuItem"]').first();
      if (!await byUia.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('button:has-text("Get Help")').first().click().catch(() => {});
        await sleep(800);
      }
      const switchBtn = page.locator('[data-uia="usePasswordInsteadHelpMenuItem"], a:has-text("Use password instead")').first();
      await switchBtn.click({ timeout: 5000 });
      await page.locator('input[type="password"]').waitFor({ timeout: 10000 });
    }
    console.log("  [login] Isi password (ROSE)...");
    await page.locator('input[type="password"]').fill(password);
    await sleep(300);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(async () => {
      await sleep(2000);
    });

  // ── MAHESH: password dulu, fallback kode ────────────────
  } else {
    if (!isOtpPage && isPassPage) {
      console.log("  [login] Isi password (MAHESH)...");
      await page.locator('input[type="password"]').fill(password);
      await sleep(300);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(async () => {
        const urlNow = page.url();
        const bodyNow = await page.locator("body").innerText().catch(() => "");
        console.log(`  [login] MAHESH timeout. URL: ${urlNow}`);
        console.log(`  [login] Body: ${bodyNow.slice(0, 300).replace(/\n/g, " | ")}`);
        await page.screenshot({ path: `/tmp/nfdebug/pin_mahesh_timeout_${Date.now()}.png`, fullPage: true }).catch(() => {});
        await sleep(2000);
      });
    } else if (isOtpPage) {
      // Coba switch ke password
      const jeda = 2000 + Math.random() * 2000;
      await sleep(jeda);
      await page.locator('button:has-text("Get Help")').first().click().catch(() => {});
      await sleep(800);
      const usePw = page.locator('[data-uia="usePasswordInsteadHelpMenuItem"], a:has-text("Use password instead")').first();
      if (await usePw.isVisible({ timeout: 3000 }).catch(() => false) && password && !isPakeKode(password)) {
        await usePw.click();
        await page.locator('input[type="password"]').waitFor({ timeout: 10000 });
        await page.locator('input[type="password"]').fill(password);
        await sleep(300);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(() => sleep(2000));
      } else {
        // Fallback: minta kode via input
        console.log(`  [login] MAHESH membutuhkan kode 4 digit...`);
        await sleep(10_000);
        const code4 = await getCodeFromUser(email, "4digit", "MAHESH");
        for (let i = 0; i < code4.length; i++) {
          const boxes = await page.$$('input[maxlength="1"]');
          if (boxes[i]) { await boxes[i].click(); await boxes[i].press(code4[i]); }
        }
        await page.locator('button[type="submit"]').first().click().catch(() => page.keyboard.press("Enter"));
        await page.waitForURL(url => !url.includes("/login"), { timeout: TIMEOUT_NAV }).catch(() => {});
      }
    }
  }

  const urlAfter = page.url();
  if (urlAfter.includes("/login")) throw new Error(`Login gagal untuk ${email}.`);
  console.log(`  [login] Login berhasil: ${urlAfter}`);
  return page;
}

// ── Ganti PIN ─────────────────────────────────────────────
async function changePinsForProfiles(email, password, accountType, targetProfiles) {
  const browser = await launchBrowser();
  const pinChanges = new Map();

  try {
    const page = await loginNetflix(browser, email, password, accountType);

    console.log("  [pin] Buka /settings/migration...");
    await page.goto(URL_PIN_SETTINGS, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
    await sleep(1500);

    // Isi password Kontrol Orang Tua
    const pwRestrict = page.locator('[data-uia="input-account-content-restrictions"]').first();
    if (await pwRestrict.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log("  [pin] Isi password Kontrol Orang Tua...");
      await pwRestrict.fill(password);
      await sleep(300);
      await page.locator('[data-uia="btn-account-pin-submit"]').click();
      await page.waitForSelector(".parental-control-profile", { timeout: 20000 });
      await sleep(800);
    }

    // Baca semua profil dan PIN lama
    const profiles = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".parental-control-profile")).map(li => {
        const name = li.querySelector("h3")?.textContent?.trim() ?? "";
        const pins = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
          .sort((a, b) => +a.getAttribute("data-uia").slice(-1) - +b.getAttribute("data-uia").slice(-1))
          .map(inp => inp.value ?? "");
        return { name, oldPin: pins.join("") };
      })
    );

    console.log(`  [pin] Profil: ${profiles.map(p => `${p.name}(${p.oldPin})`).join(", ")}`);

    const targets = targetProfiles.map(t => t.trim().toLowerCase());

    for (const prof of profiles) {
      if (!targets.some(t => prof.name.toLowerCase().includes(t))) continue;

      const newPin = generateNewPin(prof.oldPin);
      console.log(`  [pin] "${prof.name}": ${prof.oldPin} → ${newPin}`);

      await page.evaluate((profileName, newPin) => {
        for (const li of document.querySelectorAll(".parental-control-profile")) {
          const h3 = li.querySelector("h3");
          if (!h3?.textContent?.toLowerCase().includes(profileName.toLowerCase())) continue;
          const inputs = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
            .sort((a, b) => +a.getAttribute("data-uia").slice(-1) - +b.getAttribute("data-uia").slice(-1));
          newPin.split("").forEach((d, i) => {
            if (!inputs[i]) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(inputs[i], d);
            inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
            inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
          });
          return;
        }
      }, prof.name, newPin);

      await sleep(400);
      pinChanges.set(prof.name, newPin);
    }

    if (pinChanges.size > 0) {
      console.log("  [pin] Klik Terapkan...");
      await page.locator('[data-uia="profile-hub-migration-apply"]').click();
      await page.waitForURL(url => !url.includes("/settings/migration"), { timeout: TIMEOUT_NAV }).catch(() => {});
      await sleep(1500);
      console.log(`  [pin] Selesai! ${[...pinChanges.keys()].join(", ")}`);
    }
  } finally {
    await browser.close();
  }

  return pinChanges;
}

module.exports = { changePinsForProfiles };
