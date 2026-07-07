/**
 * cookie-helper.js — Tool untuk simpan & load cookie Netflix
 *
 * CARA PAKAI (satu kali setup per akun):
 *
 *   1. Buka browser biasa, login ke Netflix manual
 *   2. Buka DevTools → Application → Cookies → https://www.netflix.com
 *   3. Copy value dari cookie: NetflixId, SecureNetflixId, memclid (opsional)
 *   4. Jalankan:
 *        node cookie-helper.js save "email@gmail.com" "NetflixId_value" "SecureNetflixId_value"
 *   5. Cookie tersimpan di cookies.json
 *
 * Atau pakai mode interaktif:
 *   node cookie-helper.js save-interactive
 *
 * Cek cookie masih valid:
 *   node cookie-helper.js check "email@gmail.com"
 */

"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const COOKIE_FILE = path.resolve(__dirname, process.env.COOKIE_FILE ?? "cookies.json");

// ── Storage ───────────────────────────────────────────────

/**
 * Load semua cookie dari file.
 * @returns {Record<string, object>} map email → cookie data
 */
function loadAllCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Simpan cookie untuk satu email.
 * @param {string} email
 * @param {object} cookieData - { netflixId, secureNetflixId, savedAt }
 */
function saveCookieForEmail(email, cookieData) {
  const all = loadAllCookies();
  all[email.toLowerCase()] = {
    ...cookieData,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 2), "utf-8");
  console.log(`[cookie] Tersimpan untuk: ${email}`);
}

/**
 * Ambil cookie untuk satu email.
 * @param {string} email
 * @returns {{ netflixId: string, secureNetflixId: string, savedAt: string } | null}
 */
function getCookieForEmail(email) {
  const all = loadAllCookies();
  return all[email.toLowerCase()] ?? null;
}

/**
 * Hapus cookie untuk satu email (misal sudah expired dan perlu refresh).
 * @param {string} email
 */
function deleteCookieForEmail(email) {
  const all = loadAllCookies();
  delete all[email.toLowerCase()];
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 2), "utf-8");
  console.log(`[cookie] Dihapus untuk: ${email}`);
}

// ── Inject ke Playwright ──────────────────────────────────

/**
 * Bangun array cookie untuk browserContext.addCookies().
 * @param {{ netflixId: string, secureNetflixId: string }} cookieData
 * @returns {Array<import('playwright').Cookie>}
 */
function buildPlaywrightCookies(cookieData) {
  const base = {
    domain: ".netflix.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
  };

  const cookies = [
    { ...base, name: "NetflixId",       value: cookieData.netflixId },
    { ...base, name: "SecureNetflixId", value: cookieData.secureNetflixId },
  ];

  // Cookie opsional tambahan jika tersedia
  if (cookieData.memclid)  cookies.push({ ...base, name: "memclid",  value: cookieData.memclid,  httpOnly: false });
  if (cookieData.nfvdid)   cookies.push({ ...base, name: "nfvdid",   value: cookieData.nfvdid,   httpOnly: false });
  if (cookieData.clSharedContext) {
    cookies.push({ ...base, name: "clSharedContext", value: cookieData.clSharedContext, httpOnly: false });
  }

  return cookies;
}

// ── Verifikasi Cookie ─────────────────────────────────────

/**
 * Cek apakah cookie masih valid dengan membuka Netflix.
 * @param {string} email
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
async function verifyCookie(email) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    return { valid: false, reason: "Cookie tidak ditemukan di cookies.json" };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });

    await ctx.addCookies(buildPlaywrightCookies(cookieData));

    const page = await ctx.newPage();
    await page.goto("https://www.netflix.com/browse", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const url = page.url();
    if (url.includes("/login") || url.includes("/LoginHelp")) {
      return { valid: false, reason: `Cookie expired — redirect ke ${url}` };
    }

    return { valid: true, reason: `Cookie valid — URL: ${url}` };
  } finally {
    await browser.close();
  }
}

// ── Auto-Extract Cookie dari Browser ─────────────────────

/**
 * Buka browser VISIBLE, biarkan user login manual, lalu auto-extract cookie.
 * Berguna saat pertama kali setup atau setelah cookie expired.
 * @param {string} email - untuk label penyimpanan
 * @returns {Promise<void>}
 */
async function extractCookieInteractive(email) {
  console.log("\n[cookie] Membuka browser untuk login manual...");
  console.log("[cookie] Silakan login ke Netflix di browser yang terbuka.");
  console.log("[cookie] Browser akan auto-close setelah login berhasil.\n");

  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto("https://www.netflix.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  // Tunggu sampai user berhasil login (URL berubah dari /login)
  console.log("[cookie] Menunggu login...");
  await page.waitForURL(
    (url) => !url.includes("/login") && !url.includes("/LoginHelp"),
    { timeout: 5 * 60_000 } // 5 menit timeout
  );

  console.log("[cookie] Login terdeteksi! Mengekstrak cookie...");
  await new Promise((r) => setTimeout(r, 2000)); // tunggu cookie di-set

  const allCookies = await ctx.cookies("https://www.netflix.com");
  const cookieMap = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

  const netflixId       = cookieMap["NetflixId"];
  const secureNetflixId = cookieMap["SecureNetflixId"];

  if (!netflixId || !secureNetflixId) {
    console.error("[cookie] Cookie utama tidak ditemukan! Pastikan login berhasil.");
    await browser.close();
    return;
  }

  saveCookieForEmail(email, {
    netflixId,
    secureNetflixId,
    memclid:         cookieMap["memclid"]         ?? null,
    nfvdid:          cookieMap["nfvdid"]           ?? null,
    clSharedContext: cookieMap["clSharedContext"]  ?? null,
  });

  console.log(`\n[cookie] Berhasil disimpan untuk: ${email}`);
  console.log(`  NetflixId       : ${netflixId.substring(0, 20)}...`);
  console.log(`  SecureNetflixId : ${secureNetflixId.substring(0, 20)}...`);

  await browser.close();
}

// ── CLI ───────────────────────────────────────────────────

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case "save": {
      // node cookie-helper.js save "email" "NetflixId" "SecureNetflixId" [memclid] [nfvdid]
      const [email, netflixId, secureNetflixId, memclid, nfvdid] = args;
      if (!email || !netflixId || !secureNetflixId) {
        console.error("Usage: node cookie-helper.js save <email> <NetflixId> <SecureNetflixId> [memclid] [nfvdid]");
        process.exit(1);
      }
      saveCookieForEmail(email, { netflixId, secureNetflixId, memclid: memclid ?? null, nfvdid: nfvdid ?? null });
      break;
    }

    case "save-interactive": {
      // node cookie-helper.js save-interactive "email"
      const [email] = args;
      if (!email) {
        console.error("Usage: node cookie-helper.js save-interactive <email>");
        process.exit(1);
      }
      await extractCookieInteractive(email);
      break;
    }

    case "check": {
      // node cookie-helper.js check "email"
      const [email] = args;
      if (!email) {
        console.error("Usage: node cookie-helper.js check <email>");
        process.exit(1);
      }
      const result = await verifyCookie(email);
      console.log(`\n[${email}] Valid: ${result.valid}`);
      console.log(`  ${result.reason}`);
      break;
    }

    case "list": {
      // node cookie-helper.js list
      const all = loadAllCookies();
      const emails = Object.keys(all);
      if (emails.length === 0) {
        console.log("Belum ada cookie tersimpan.");
      } else {
        console.log(`Cookie tersimpan (${emails.length} akun):`);
        for (const email of emails) {
          const d = all[email];
          console.log(`  ${email} — disimpan: ${d.savedAt ?? "tidak diketahui"}`);
        }
      }
      break;
    }

    case "delete": {
      // node cookie-helper.js delete "email"
      const [email] = args;
      if (!email) {
        console.error("Usage: node cookie-helper.js delete <email>");
        process.exit(1);
      }
      deleteCookieForEmail(email);
      break;
    }

    default:
      console.log(`
Netflix Cookie Helper
=====================
Perintah:
  save <email> <NetflixId> <SecureNetflixId>   Simpan cookie manual dari DevTools
  save-interactive <email>                     Buka browser, login manual, auto-extract
  check <email>                                Cek apakah cookie masih valid
  list                                         Lihat semua cookie tersimpan
  delete <email>                               Hapus cookie untuk email tertentu

Cara ambil cookie dari browser:
  1. Buka Netflix → DevTools → Application → Cookies → https://www.netflix.com
  2. Copy nilai NetflixId dan SecureNetflixId
  3. Jalankan: node cookie-helper.js save "email@gmail.com" "<NetflixId>" "<SecureNetflixId>"
      `);
  }
}

// Jalankan CLI hanya jika dipanggil langsung (bukan di-require)
if (require.main === module) {
  main().catch(console.error);
}

// Export untuk dipakai kicker-cookie.js dan pin-changer-cookie.js
module.exports = {
  getCookieForEmail,
  saveCookieForEmail,
  deleteCookieForEmail,
  buildPlaywrightCookies,
  verifyCookie,
  loadAllCookies,
};
