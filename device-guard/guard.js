/**
 * guard.js — Smart Device Guard logic
 *
 * Untuk setiap akun MEET:
 *   1. Buka halaman /manageaccountaccess via cookie
 *   2. Untuk setiap profil, cek device yang sedang login
 *   3. Bandingkan dengan device yang diizinkan (dari kolom G spreadsheet)
 *   4. Kick device yang tidak sesuai rules
 *
 * Rules:
 *   - Kolom G ada isi  → kick semua device yang TIDAK cocok dengan kata kunci device
 *   - Kolom G kosong   → izinkan hanya 1 device (yang paling atas = terbaru), kick sisanya
 *   - Device "PERANGKAT SAAT INI" → JANGAN dikick
 */

"use strict";

require("dotenv").config();
const path   = require("path");
const fs     = require("fs");
const { chromium } = require("playwright");

// Pakai cookie dari cookie-kicker-pin-changer
const COOKIE_FILE = path.resolve(__dirname, process.env.COOKIE_FILE ?? "../cookie-kicker-pin-changer/cookies.json");

const HEADLESS    = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const URL_DEVICES = "https://www.netflix.com/manageaccountaccess";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Load cookie ───────────────────────────────────────────
function loadAllCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8")); } catch { return {}; }
}

function getCookieForEmail(email) {
  const all = loadAllCookies();
  return all[email.toLowerCase()] ?? null;
}

function saveCookieForEmail(email, cookieData) {
  const all = loadAllCookies();
  all[email.toLowerCase()] = { ...cookieData, savedAt: new Date().toISOString() };
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 2), "utf-8");
}

function buildPlaywrightCookies(cookieData) {
  const base = { domain: ".netflix.com", path: "/", secure: true, httpOnly: true, sameSite: "None" };
  const cookies = [
    { ...base, name: "NetflixId",       value: cookieData.netflixId },
    { ...base, name: "SecureNetflixId", value: cookieData.secureNetflixId },
  ];
  if (cookieData.memclid) cookies.push({ ...base, name: "memclid", value: cookieData.memclid, httpOnly: false });
  if (cookieData.nfvdid)  cookies.push({ ...base, name: "nfvdid",  value: cookieData.nfvdid,  httpOnly: false });
  return cookies;
}

// ── Device matching ───────────────────────────────────────
/**
 * Mapping kata kunci dari kolom G ke nama device Netflix.
 *
 * Netflix device name format:
 *   "Apple - iPhone"
 *   "Android Mobile" / "Samsung Android"
 *   "Chrome - Browser Web" / "PC Chrome - Browser Web"
 *   "Edge - Browser Web"
 *   "Mac Safari - Browser Web"
 *   "Samsung Smart TV" / "LG TV" / "[Merek] TV"
 */
const DEVICE_KEYWORDS = [
  { keywords: ["iphone", "apple"],         netflixMatch: ["apple", "iphone"] },
  { keywords: ["android", "samsung", "xiaomi", "oppo", "vivo", "realme", "redmi", "hp"],
                                            netflixMatch: ["android", "samsung", "xiaomi", "oppo", "vivo", "realme", "redmi", "mobile"] },
  { keywords: ["laptop", "chrome", "pc", "chromebook"],
                                            netflixMatch: ["chrome", "browser", "pc"] },
  { keywords: ["mac", "macbook", "safari"], netflixMatch: ["mac", "safari"] },
  { keywords: ["edge"],                     netflixMatch: ["edge"] },
  { keywords: ["tv", "smart tv", "televisi"], netflixMatch: ["tv", "television", "smart"] },
  { keywords: ["ipad", "tablet"],           netflixMatch: ["ipad", "tablet"] },
];

/**
 * Cek apakah nama device Netflix cocok dengan kata kunci dari kolom G.
 * @param {string} netflixDeviceName  - misal "Apple - iPhone"
 * @param {string} allowedDeviceHint  - misal "iphone 11 pm" atau "laptop"
 * @returns {boolean}
 */
function isDeviceAllowed(netflixDeviceName, allowedDeviceHint) {
  if (!allowedDeviceHint) return false; // kolom G kosong: handle terpisah

  const hint   = allowedDeviceHint.toLowerCase();
  const device = netflixDeviceName.toLowerCase();

  // Cari mapping yang cocok dengan hint dari kolom G
  for (const mapping of DEVICE_KEYWORDS) {
    const hintMatch = mapping.keywords.some(k => hint.includes(k));
    if (!hintMatch) continue;

    // Hint cocok dengan kategori ini — cek apakah device Netflix juga cocok
    const deviceMatch = mapping.netflixMatch.some(k => device.includes(k));
    if (deviceMatch) return true;
  }

  // Fallback: cek langsung substring
  const hintWords = hint.split(/\s+/).filter(w => w.length > 2);
  return hintWords.some(w => device.includes(w));
}

// ── Handle MFA ────────────────────────────────────────────
async function handleMfa(page, email) {
  await sleep(1000);
  const url      = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const needsMfa =
    url.includes("/mfa") ||
    bodyText.toLowerCase().includes("email a code") ||
    bodyText.toLowerCase().includes("kirim kode") ||
    bodyText.toLowerCase().includes("verifikasi identitas");

  if (!needsMfa) return;

  console.log(`  [guard-mfa] MFA terdeteksi untuk ${email}`);

  // Klik tombol kirim kode
  const emailBtn = page.locator(
    '[data-uia="account-mfa-button-OTP_EMAIL"] button, button:has-text("Email a code"), button:has-text("Kirim kode")'
  ).first();

  if (await emailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailBtn.click();
  }

  await page.waitForFunction(
    () => document.querySelectorAll('input[inputmode="numeric"], input[maxlength="1"]').length >= 1,
    { timeout: 15_000, polling: 500 }
  ).catch(() => {});

  console.log(`  [guard-mfa] Tunggu 10 detik...`);
  await sleep(10_000);

  // Fetch kode via Mahesh bot (akun MEET = @mahesh domain)
  let code6 = null;
  try {
    const { fetchFromMaheshBot } = require("../cookie-kicker-pin-changer/mahesh-fetcher");
    console.log(`  [guard-mfa] Fetch kode via Mahesh Bot...`);
    code6 = await fetchFromMaheshBot(email, "signin6", { retries: 2, retryDelay: 5000 });
    console.log(`  [guard-mfa] Kode: ${code6}`);
  } catch (err) {
    console.warn(`  [guard-mfa] Fetch gagal: ${err.message}`);
    // Fallback terminal
    const readline = require("readline");
    code6 = await new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n  [MFA] Kode 6 digit untuk ${email}: `, ans => { rl.close(); resolve(ans.trim()); });
    });
  }

  if (!code6) throw new Error(`Kode MFA tidak tersedia untuk ${email}`);

  // Isi kode
  const inputs = await page.$$('input[inputmode="numeric"], input[maxlength="1"], input[autocomplete="one-time-code"]');
  if (inputs.length === 1) {
    await inputs[0].evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, code6);
  } else if (inputs.length > 1) {
    const digits = code6.split("");
    for (let i = 0; i < digits.length && i < inputs.length; i++) {
      await inputs[i].click();
      await inputs[i].press(digits[i]);
      await sleep(80);
    }
  }

  await sleep(300);
  const submitBtn = page.locator('button[type="submit"], button:has-text("Kirim")').first();
  if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  await page.waitForURL(u => !u.toString().includes("/mfa"), { timeout: 30_000 }).catch(() => {});
  await sleep(1000);
  console.log(`  [guard-mfa] Selesai. URL: ${page.url()}`);
}

// ── Guard satu akun ───────────────────────────────────────
/**
 * Buka halaman device management, cek dan kick device yang tidak sesuai rules.
 *
 * @param {string} email
 * @param {Array<{name: string, allowedDevice: string}>} profiles
 * @returns {Promise<{ kicked: number, details: string[] }>}
 */
async function guardAccount(email, profiles) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new Error(`Cookie tidak ada untuk ${email}`);
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  let totalKicked = 0;
  const details   = [];

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "id-ID" });
    await ctx.addCookies(buildPlaywrightCookies(cookieData));
    const page = await ctx.newPage();

    await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

    // Cek expired
    if (page.url().includes("/login")) {
      throw new Error(`Cookie expired untuk ${email}`);
    }

    // Handle MFA
    await handleMfa(page, email);

    // Navigate ulang jika perlu
    if (!page.url().includes("manageaccountaccess")) {
      await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
      await handleMfa(page, email);
    }

    await sleep(1500);

    // Expand "Tampilkan Lainnya"
    let more = true;
    while (more) {
      const showMore = page.locator('[data-uia="device-list+show-more-button"]');
      if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
        await showMore.click();
        await sleep(1200);
      } else {
        more = false;
      }
    }

    // Baca semua card device
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();
    console.log(`  [guard] ${count} device ditemukan untuk ${email}`);

    // Bangun daftar device per profil
    // { profilName: [{ cardIndex, deviceName, isCurrent }] }
    const profileDevices = new Map();

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);

      // Expand card untuk lihat profil
      const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
      if (await dropBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await dropBtn.click();
        await sleep(600);
      }

      const isCurrent = (await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0;
      const cardText  = await card.innerText().catch(() => "");

      // Device name (baris pertama card biasanya nama device)
      const lines      = cardText.split("\n").map(l => l.trim()).filter(Boolean);
      const deviceName = lines[0] ?? "";

      // Profil yang sedang aktif di device ini
      let profileName = null;
      for (const line of lines) {
        if (line.toLowerCase().includes("terakhir ditonton") || line.toLowerCase().includes("last watched")) {
          profileName = line
            .replace(/\(terakhir ditonton\)/i, "")
            .replace(/\(last watched\)/i, "")
            .trim();
          break;
        }
      }

      // Skip "tidak ada aktivitas" — profile unknown
      if (!profileName ||
          profileName.toLowerCase().includes("tidak ada aktivitas") ||
          profileName.toLowerCase().includes("no activity")) {
        profileName = "__noactivity__";
      }

      const profileKey = profileName.toLowerCase();
      if (!profileDevices.has(profileKey)) {
        profileDevices.set(profileKey, []);
      }
      profileDevices.get(profileKey).push({ cardIndex: i, deviceName, isCurrent, profileName });
    }

    // Evaluasi setiap profil yang perlu di-guard
    const processedCards = new Set();

    for (const prof of profiles) {
      const profKey     = prof.name.toLowerCase();
      const allowedDev  = prof.allowedDevice;

      // Cari device yang menggunakan profil ini
      // Matching: cek apakah nama profil dari Netflix ada di profileDevices
      let devicesForProfile = [];
      for (const [key, devs] of profileDevices.entries()) {
        if (key.includes(profKey) || profKey.includes(key)) {
          devicesForProfile = devs;
          break;
        }
      }

      if (devicesForProfile.length === 0) {
        console.log(`  [guard] Profil "${prof.name}" tidak aktif di device manapun — skip`);
        continue;
      }

      console.log(`  [guard] Profil "${prof.name}" aktif di ${devicesForProfile.length} device:`);
      devicesForProfile.forEach((d, idx) => {
        console.log(`    [${idx}] ${d.deviceName} ${d.isCurrent ? "(SAAT INI)" : ""}`);
      });

      // Tentukan mana yang harus dikick
      const toKick = [];

      if (allowedDev) {
        // Kolom G ada isi → kick yang tidak cocok dengan device yang diizinkan
        for (const dev of devicesForProfile) {
          if (dev.isCurrent) continue; // jangan kick device saat ini
          if (!isDeviceAllowed(dev.deviceName, allowedDev)) {
            toKick.push(dev);
            console.log(`    → KICK: "${dev.deviceName}" (tidak cocok dengan "${allowedDev}")`);
          } else {
            console.log(`    → BIARKAN: "${dev.deviceName}" (cocok dengan "${allowedDev}")`);
          }
        }
      } else {
        // Kolom G kosong → izinkan hanya 1 device (index 0 = terbaru), kick sisanya
        const nonCurrentDevices = devicesForProfile.filter(d => !d.isCurrent);
        if (nonCurrentDevices.length > 1) {
          // Device pertama = terbaru (jangan kick), kick sisanya
          for (let i = 1; i < nonCurrentDevices.length; i++) {
            toKick.push(nonCurrentDevices[i]);
            console.log(`    → KICK: "${nonCurrentDevices[i].deviceName}" (lebih dari 1 device, kolom G kosong)`);
          }
        } else {
          console.log(`    → OK: hanya ${devicesForProfile.length} device, tidak perlu kick`);
        }
      }

      // Eksekusi kick
      for (const dev of toKick) {
        if (processedCards.has(dev.cardIndex)) continue;

        const card     = cards.nth(dev.cardIndex);
        const keluarBtn = card.locator('button:has-text("Keluar"), button:has-text("Sign Out")').first();

        if (await keluarBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await keluarBtn.click();
          totalKicked++;
          processedCards.add(dev.cardIndex);
          const msg = `Dikick: "${dev.deviceName}" dari profil "${prof.name}"`;
          details.push(msg);
          console.log(`  [guard] ✓ ${msg}`);
          await sleep(1500);
        }
      }
    }

    // Dynamic Update cookie
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map(c => [c.name, c.value]));
    if (cm["NetflixId"]) {
      saveCookieForEmail(email, {
        netflixId:       cm["NetflixId"],
        secureNetflixId: cm["SecureNetflixId"] ?? cookieData.secureNetflixId,
        memclid:         cm["memclid"] ?? null,
        nfvdid:          cm["nfvdid"]  ?? null,
      });
      console.log(`  [guard] ✓ Cookie diperbarui.`);
    }

  } finally {
    await browser.close();
  }

  return { kicked: totalKicked, details };
}

module.exports = { guardAccount, isDeviceAllowed };
