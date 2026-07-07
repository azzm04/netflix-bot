/**
 * harvest-cookies.js — Ambil cookie semua akun dari sheet & simpan ke spreadsheet
 *
 * CARA PAKAI:
 *   node harvest-cookies.js           → proses sheet HARIAN (default)
 *   node harvest-cookies.js MINGGUAN  → proses sheet MINGGUAN
 *   node harvest-cookies.js ALL       → semua sheet
 *   node harvest-cookies.js HARIAN --keep-alive  → refresh cookie yang sudah ada
 *
 * KOLOM SPREADSHEET:
 *   A=0 email | B=1 password | C=2 profil | D=3 pin | E=4 logout | F=5 phone | I=8 cookie
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const path  = require("path");
const https = require("https");
const { google } = require("googleapis");
const { saveCookieForEmail, getCookieForEmail, buildPlaywrightCookies } = require("./cookie-helper");

// ─── Konstanta ────────────────────────────────────────────
const COL_EMAIL    = parseInt(process.env.COL_EMAIL    ?? "0"); // A
const COL_PASSWORD = parseInt(process.env.COL_PASSWORD ?? "1"); // B
const COL_COOKIE   = parseInt(process.env.COL_COOKIE   ?? "8"); // I
const COL_COOKIE_LETTER = String.fromCharCode(65 + COL_COOKIE); // "I"

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit per akun
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Google Sheets auth ───────────────────────────────────
async function getSheets() {
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_PATH ?? "../credentials.json");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function findSpreadsheetId() {
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_PATH ?? "../credentials.json");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const client  = await auth.getClient();
  const drive   = google.drive({ version: "v3", auth: client });
  const name    = process.env.SPREADSHEET_NAME;
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res     = await drive.files.list({
    q:      `name='${escaped}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  const files = res.data.files ?? [];
  if (files.length === 0) throw new Error(`Spreadsheet "${name}" tidak ditemukan.`);
  return files[0].id;
}

// ─── Baca email unik dari sheet ───────────────────────────
async function readEmailsFromSheet(sheets, spreadsheetId, sheetName) {
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName });
  const rows = res.data.values ?? [];
  const seen = new Map();
  const out  = [];

  for (let i = 0; i < rows.length; i++) {
    const row   = rows[i];
    const email = row[COL_EMAIL]?.trim() ?? "";
    if (!email.includes("@") || email.toLowerCase() === "email") continue;

    if (!seen.has(email.toLowerCase())) {
      const existingCookie = row[COL_COOKIE]?.trim() ?? "";
      seen.set(email.toLowerCase(), true);
      out.push({
        email,
        rowIndex:       i + 1,
        hasCookie:      existingCookie.length > 10,
        password:       row[COL_PASSWORD]?.trim() ?? "",
        existingCookie,
      });
    }
  }
  return out;
}

// ─── Simpan cookie ke SEMUA baris email di sheet ──────────
async function saveCookieToSheet(sheets, spreadsheetId, sheetName, email, cookieStr) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:A`,
  });
  const col     = res.data.values ?? [];
  const updates = [];

  for (let i = 0; i < col.length; i++) {
    if ((col[i]?.[0]?.trim() ?? "").toLowerCase() === email.toLowerCase()) {
      updates.push({
        range:  `${sheetName}!${COL_COOKIE_LETTER}${i + 1}`,
        values: [[cookieStr]],
      });
    }
  }

  if (updates.length === 0) {
    console.warn(`  [sheets] Tidak ada baris untuk ${email}`);
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  console.log(`  [sheets] Cookie disimpan ke ${updates.length} baris untuk ${email}`);
}

// ─── Format cookie ringkas untuk kolom spreadsheet ────────
function formatCookieForSheet(netflixId, secureNetflixId) {
  return JSON.stringify({ n: netflixId, s: secureNetflixId });
}

// ─── Quick verify via HTTP (tanpa buka browser) ───────────
async function verifyCookieQuick(cookieData) {
  return new Promise((resolve) => {
    const cookieStr = `NetflixId=${cookieData.netflixId}; SecureNetflixId=${cookieData.secureNetflixId}`;
    const req = https.request(
      {
        hostname: "www.netflix.com",
        path:     "/browse",
        method:   "GET",
        headers: {
          "Cookie":     cookieStr,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        const loc   = res.headers["location"] ?? "";
        const valid = res.statusCode === 200 || (res.statusCode < 400 && !loc.includes("/login"));
        res.resume();
        resolve(valid);
      }
    );
    req.on("error", () => resolve(false));
    req.setTimeout(10_000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ─── Login manual + extract cookie ───────────────────────
async function extractCookieForEmail(email, skipIfExists = true) {
  // Cek cookie lokal dulu
  if (skipIfExists) {
    const existing = getCookieForEmail(email);
    if (existing?.netflixId && existing?.secureNetflixId) {
      console.log(`  [extract] Cookie lokal ada, verifikasi...`);
      const valid = await verifyCookieQuick(existing);
      if (valid) {
        console.log(`  [extract] Cookie masih valid — skip login.`);
        return existing;
      }
      console.log(`  [extract] Cookie expired — login ulang.`);
    }
  }

  console.log(`\n${"─".repeat(55)}`);
  console.log(`[LOGIN] ${email}`);
  console.log(`  1. Isi email: ${email}`);
  console.log(`  2. Isi password dan selesaikan login`);
  console.log(`  3. Setelah masuk ke halaman Netflix, tekan Enter di terminal ini`);
  console.log("─".repeat(55));

  // Tunggu user siap (beri waktu baca instruksi)
  await sleep(500);

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (err) {
    console.error(`  [extract] ✗ Gagal launch browser: ${err.message}`);
    return null;
  }

  let cookieData    = null;
  let browserClosed = false;
  browser.on("disconnected", () => { browserClosed = true; });

  try {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto("https://www.netflix.com/login", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });

    // Isi email otomatis agar user tinggal isi password
    try {
      const emailInput = page.locator('input[name="userLoginId"], input[type="email"]').first();
      await emailInput.waitFor({ timeout: 5000 });
      await emailInput.fill(email);
      console.log(`  [extract] Email sudah diisi otomatis: ${email}`);
    } catch {
      console.log(`  [extract] Isi email manual di browser.`);
    }

    // Tunggu user tekan Enter di terminal (bukan tunggu URL berubah)
    await waitForEnter(`  >> Tekan ENTER setelah berhasil login ke Netflix untuk ${email}`);

    if (browserClosed) {
      console.warn(`  [extract] Browser ditutup — skip.`);
      return null;
    }

    // Cek apakah sudah di luar halaman login
    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/LoginHelp")) {
      console.warn(`  [extract] Masih di halaman login (${currentUrl}). Cookie tidak diambil.`);
      return null;
    }

    await sleep(1500); // tunggu cookie di-set

    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm         = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));
    const netflixId       = cm["NetflixId"];
    const secureNetflixId = cm["SecureNetflixId"];

    if (!netflixId || !secureNetflixId) {
      console.error(`  [extract] Cookie utama tidak ditemukan! Pastikan sudah login.`);
      return null;
    }

    cookieData = {
      netflixId,
      secureNetflixId,
      memclid:         cm["memclid"]         ?? null,
      nfvdid:          cm["nfvdid"]           ?? null,
      clSharedContext: cm["clSharedContext"]  ?? null,
    };

    console.log(`  [extract] ✓ Cookie berhasil diambil untuk ${email}`);
  } catch (err) {
    if (browserClosed || err.message.includes("closed") || err.message.includes("detached") || err.message.includes("ERR_ABORTED")) {
      console.warn(`  [extract] ✗ Browser ditutup — skip akun ini.`);
    } else {
      console.error(`  [extract] ✗ Error: ${err.message}`);
    }
  } finally {
    if (!browserClosed) {
      await browser.close().catch(() => {});
    }
  }

  return cookieData;
}

// ─── Tunggu user tekan Enter ──────────────────────────────
function waitForEnter(prompt) {
  const readline = require("readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt}\n`, () => { rl.close(); resolve(); });
  });
}

// ─── Refresh cookie headless (keep-alive) ─────────────────
async function refreshCookieHeadless(email, cookieData) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    console.error(`  [refresh] Gagal launch browser: ${err.message}`);
    return null;
  }

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(buildPlaywrightCookies(cookieData));
    const page = await ctx.newPage();

    await page.goto("https://www.netflix.com/browse", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });

    if (page.url().includes("/login")) {
      console.warn(`  [refresh] Cookie expired untuk ${email}`);
      return null;
    }

    // Aktivitas ringan (keep-alive)
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, -300));
    await sleep(1000);

    // Ambil cookie yang sudah di-refresh server
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm         = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

    return {
      netflixId:       cm["NetflixId"]       ?? cookieData.netflixId,
      secureNetflixId: cm["SecureNetflixId"] ?? cookieData.secureNetflixId,
      memclid:         cm["memclid"]         ?? cookieData.memclid ?? null,
      nfvdid:          cm["nfvdid"]          ?? cookieData.nfvdid  ?? null,
    };
  } catch (err) {
    console.error(`  [refresh] Error: ${err.message}`);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Proses satu sheet (harvest) ──────────────────────────
async function processSheet(sheets, spreadsheetId, sheetName) {
  console.log(`\n${"═".repeat(55)}`);
  console.log(`SHEET: ${sheetName}`);
  console.log("═".repeat(55));

  let emailList;
  try {
    emailList = await readEmailsFromSheet(sheets, spreadsheetId, sheetName);
  } catch (err) {
    console.error(`[harvest] Tidak bisa baca sheet ${sheetName}: ${err.message}`);
    return { done: 0, skipped: 0, failed: 0 };
  }

  const toProcess  = emailList.filter((e) => !e.hasCookie);
  const alreadyHave = emailList.filter((e) => e.hasCookie);

  console.log(`  Total email unik    : ${emailList.length}`);
  console.log(`  Sudah punya cookie  : ${alreadyHave.length}`);
  console.log(`  Perlu diambil       : ${toProcess.length}`);

  if (alreadyHave.length > 0) {
    console.log(`  (skip) ${alreadyHave.map((e) => e.email).join(", ")}`);
  }

  let done = 0, skipped = alreadyHave.length, failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { email } = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${email}`);

    const cookieData = await extractCookieForEmail(email, true);

    if (!cookieData) {
      failed++;
      console.log(`  ✗ Gagal — lanjut ke akun berikutnya.`);
      continue;
    }

    // Simpan lokal
    saveCookieForEmail(email, cookieData);

    // Simpan ke spreadsheet
    const cookieStr = formatCookieForSheet(cookieData.netflixId, cookieData.secureNetflixId);
    try {
      await saveCookieToSheet(sheets, spreadsheetId, sheetName, email, cookieStr);
    } catch (err) {
      console.error(`  [sheets] Gagal simpan ke spreadsheet: ${err.message}`);
    }

    done++;

    if (i < toProcess.length - 1) {
      console.log("  Jeda 3 detik...");
      await sleep(3000);
    }
  }

  return { done, skipped, failed };
}

// ─── Keep-alive: refresh semua cookie yang sudah ada ──────
async function keepAliveSheet(sheets, spreadsheetId, sheetName) {
  console.log(`\n${"═".repeat(55)}`);
  console.log(`KEEP-ALIVE: ${sheetName}`);
  console.log("═".repeat(55));

  const emailList  = await readEmailsFromSheet(sheets, spreadsheetId, sheetName);
  const withCookie = emailList.filter((e) => e.hasCookie);
  console.log(`[keep-alive] ${withCookie.length} akun dengan cookie`);

  let refreshed = 0, failed = 0;

  for (let i = 0; i < withCookie.length; i++) {
    const { email, existingCookie } = withCookie[i];
    console.log(`\n[${i + 1}/${withCookie.length}] ${email}`);

    // Parse cookie dari sheet
    let cookieData = null;
    try {
      const parsed = JSON.parse(existingCookie);
      cookieData   = { netflixId: parsed.n, secureNetflixId: parsed.s };
    } catch {
      cookieData = getCookieForEmail(email);
    }

    if (!cookieData?.netflixId) {
      console.warn(`  ⚠ Cookie tidak bisa di-parse, skip.`);
      failed++;
      continue;
    }

    const newCookie = await refreshCookieHeadless(email, cookieData);
    if (!newCookie) {
      failed++;
      continue;
    }

    saveCookieForEmail(email, newCookie);
    const cookieStr = formatCookieForSheet(newCookie.netflixId, newCookie.secureNetflixId);
    await saveCookieToSheet(sheets, spreadsheetId, sheetName, email, cookieStr).catch(() => {});

    refreshed++;
    console.log(`  ✓ Cookie diperbarui.`);

    if (i < withCookie.length - 1) await sleep(2000);
  }

  return { refreshed, failed };
}

// ─── Entry point ──────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const mode      = args.includes("--keep-alive") ? "keep-alive" : "harvest";
  const sheetArg  = args.find((a) => !a.startsWith("--")) ?? "HARIAN";

  const sheetNames = sheetArg.toUpperCase() === "ALL"
    ? (process.env.SHEETS_TO_CHECK ?? "HARIAN,MINGGUAN,BULANAN").split(",").map((s) => s.trim())
    : [sheetArg.toUpperCase()];

  console.log(`\nNetflix Cookie Harvester`);
  console.log(`Mode   : ${mode}`);
  console.log(`Sheet  : ${sheetNames.join(", ")}`);
  console.log(`Kolom cookie : ${COL_COOKIE_LETTER} (index ${COL_COOKIE})\n`);

  const sheets        = await getSheets();
  const spreadsheetId = await findSpreadsheetId();

  let totalDone = 0, totalSkipped = 0, totalFailed = 0;

  for (const sheetName of sheetNames) {
    if (mode === "keep-alive") {
      const r = await keepAliveSheet(sheets, spreadsheetId, sheetName);
      totalDone   += r.refreshed;
      totalFailed += r.failed;
    } else {
      const r = await processSheet(sheets, spreadsheetId, sheetName);
      totalDone    += r.done;
      totalSkipped += r.skipped;
      totalFailed  += r.failed;
    }
  }

  console.log(`\n${"═".repeat(55)}`);
  if (mode === "keep-alive") {
    console.log(`KEEP-ALIVE SELESAI`);
    console.log(`  Diperbarui : ${totalDone}`);
    console.log(`  Gagal      : ${totalFailed}`);
  } else {
    console.log(`HARVEST SELESAI`);
    console.log(`  Berhasil   : ${totalDone}`);
    console.log(`  Di-skip    : ${totalSkipped} (sudah punya cookie)`);
    console.log(`  Gagal      : ${totalFailed}`);
  }
  console.log("═".repeat(55));
}

main().catch(console.error);
