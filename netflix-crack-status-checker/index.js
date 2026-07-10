/**
 * check-status.js — Cek status cookie Netflix langsung dari Google Sheets
 *
 * Kolom sheet (sesuai spreadsheet Azzam):
 *   A: No | B: Email | C: Password | D: Profil | E: Waktu | F: Nomor | G: Status | H+I: Cookie (merged cell)
 *
 * Cookie di kolom H (atau H+I kalau kepotong/belum merge) formatnya:
 *   "NetflixId=xxx;SecureNetflixId=yyy;"
 *
 * Cara pakai:
 *   1. cp .env.example .env  -> isi SHEET_ID dan path service account
 *   2. npm install
 *   3. npx playwright install chromium   (sekali saja)
 *   4. npm run check
 *
 * Hasil:
 *   - Kolom G ditulis bertahap tiap BATCH_SIZE baris (default 20).
 *   - Kolom H ditulis ulang dengan cookie TERBARU (hasil refresh dari server Netflix)
 *     tiap kali cookie itu terbukti masih hidup — biar makin sering di-run, makin awet.
 *   - Baris dengan cookie yang SAMA dengan baris lain (cached) tidak di-log ke terminal,
 *     tapi tetap ditulis statusnya ke sheet.
 *   - Rekap akhir BISA/MATI dihitung per cookie UNIK, bukan per baris.
 */

"use strict";

require("dotenv").config();
const { google } = require("googleapis");
const { chromium } = require("playwright");
const { parseCookieString, buildPlaywrightCookies, buildCookieRawString } = require("./netflix-helpers");

const SHEET_ID   = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
const HEADLESS   = process.env.HEADLESS !== "false";
const DELAY_MS   = Number(process.env.DELAY_MS || 2000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const DATA_RANGE = `${SHEET_NAME}!B2:I`; // B=Email ... H+I=Cookie (merged cell)
const STATUS_COL = "G";
const COOKIE_COL = "H";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tulis batch: kolom Status (rentang) + kolom Cookie (per baris, kalau ada refresh) ──
async function flushBatch(sheets, statusStartRow, statusValues, cookieUpdates) {
  const data = [];

  if (statusValues.length > 0) {
    const endRow = statusStartRow + statusValues.length - 1;
    data.push({
      range: `${SHEET_NAME}!${STATUS_COL}${statusStartRow}:${STATUS_COL}${endRow}`,
      values: statusValues,
    });
  }

  for (const cu of cookieUpdates) {
    data.push({
      range: `${SHEET_NAME}!${COOKIE_COL}${cu.row}:${COOKIE_COL}${cu.row}`,
      values: [[cu.value]],
    });
  }

  if (data.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });

  const endRow = statusStartRow + statusValues.length - 1;
  console.log(`  → Tersimpan ke sheet (baris ${statusStartRow}–${endRow}, ${cookieUpdates.length} cookie di-refresh)\n`);
}

// ── Google Sheets auth ─────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// ── Cek satu cookie hidup/mati, sekalian ambil cookie yang sudah di-refresh server ──
async function checkCookieAlive(browser, cookieMap) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await ctx.addCookies(buildPlaywrightCookies(cookieMap));
    const page = await ctx.newPage();
    await page.goto("https://www.netflix.com/browse", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const url = page.url();
    if (url.includes("/login") || url.includes("/LoginHelp")) {
      return { alive: false, refreshedCookie: null };
    }

    // Ambil cookie terbaru yang sudah di-refresh server Netflix
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

    let refreshedCookie = null;
    if (cm.NetflixId && cm.SecureNetflixId) {
      refreshedCookie = buildCookieRawString({
        NetflixId: cm.NetflixId,
        SecureNetflixId: cm.SecureNetflixId,
      });
    }

    return { alive: true, refreshedCookie };
  } catch (err) {
    console.error(`  [warn] Gagal cek: ${err.message}`);
    return { alive: false, refreshedCookie: null };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  if (!SHEET_ID) {
    console.error("SHEET_ID belum diisi di .env");
    process.exit(1);
  }

  const sheets = await getSheetsClient();

  console.log(`Ambil data dari sheet "${SHEET_NAME}"...`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];

  if (rows.length === 0) {
    console.log("Tidak ada data.");
    return;
  }

  console.log(`Ditemukan ${rows.length} baris. Memulai pengecekan...\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  // Cache per cookie unik: { alive, refreshedCookie }
  const cache = new Map();
  let invalidCount = 0; // baris dengan cookie kosong/format salah (selalu dianggap unik)

  let pendingStatus  = [];  // status yang belum ditulis ke sheet
  let pendingCookies = [];  // { row, value } cookie yang belum ditulis ke sheet
  let batchStartRow  = 2;   // baris pertama di pendingStatus saat ini

  for (let i = 0; i < rows.length; i++) {
    const row       = rows[i];
    const email     = row[0] || "(tanpa email)";
    const sheetRow  = i + 2;
    // Kolom H (index 6) + I (index 7), relatif dari B.
    const rawCookie = `${row[6] || ""}${row[7] || ""}`;
    const cookieMap = parseCookieString(rawCookie);

    let alive = false;
    let refreshedCookie = null;

    if (!cookieMap) {
      console.log(`[${sheetRow}] ${email} — MATI (cookie kosong/tidak valid format)`);
      invalidCount++;
    } else {
      const cacheKey = `${cookieMap.NetflixId}::${cookieMap.SecureNetflixId}`;

      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        alive = cached.alive;
        refreshedCookie = cached.refreshedCookie;
        // sengaja tidak di-log, ini baris duplikat/cached
      } else {
        const result = await checkCookieAlive(browser, cookieMap);
        alive = result.alive;
        refreshedCookie = result.refreshedCookie;
        cache.set(cacheKey, { alive, refreshedCookie });
        console.log(`[${sheetRow}] ${email} — ${alive ? "BISA" : "MATI"}`);
        await sleep(DELAY_MS);
      }
    }

    pendingStatus.push([alive ? "BISA" : "MATI"]);
    if (refreshedCookie) {
      pendingCookies.push({ row: sheetRow, value: refreshedCookie });
    }

    const isLastRow = i === rows.length - 1;
    if (pendingStatus.length >= BATCH_SIZE || isLastRow) {
      await flushBatch(sheets, batchStartRow, pendingStatus, pendingCookies);
      batchStartRow += pendingStatus.length;
      pendingStatus  = [];
      pendingCookies = [];
    }
  }

  await browser.close();

  console.log("\nSemua hasil sudah tersimpan ke sheet secara bertahap.");

  // ── Rekap berdasarkan cookie UNIK (bukan per baris) ──
  let bisaUnik = 0;
  let matiUnik = 0;
  for (const entry of cache.values()) {
    if (entry.alive) bisaUnik++;
    else matiUnik++;
  }
  matiUnik += invalidCount; // baris tanpa cookie valid dihitung MATI unik juga

  console.log(`\n${"═".repeat(40)}`);
  console.log("SELESAI");
  console.log(`  BISA (unik) : ${bisaUnik}`);
  console.log(`  MATI (unik) : ${matiUnik}`);
  console.log(`  Total baris diproses : ${rows.length}`);
  console.log("═".repeat(40));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});