/**
 * sync-profiles.js — Scrape nama profil live dari Netflix, sinkronkan ke sheet
 *
 * Kolom sheet:
 *   A: No | B: Email | C: Password | D: Profil | E: Waktu | F: Nomor | G: Status | H+I: Cookie
 *
 * Sumber data profil: layar "Who's watching?" di https://www.netflix.com/browse
 * (muncul otomatis kalau cookie yang di-inject belum punya profil aktif terpilih).
 *
 * Aturan sync (per akun / per cookie unik), MATCHING BERDASARKAN NAMA (bukan posisi):
 *   - Nama profil hasil scrape yang BELUM ada di baris manapun untuk akun itu
 *     -> ditambahkan sebagai baris baru (Email/Password/Cookie/Status disalin, No dikosongkan).
 *   - Nama profil yang ADA di sheet tapi TIDAK ketemu lagi di hasil scrape
 *     -> baris itu DIHAPUS dari sheet.
 *   - Urutan baris/profil tidak diubah/dipedulikan.
 *   - Cookie MATI (redirect ke /login) -> grup dilewati, tidak disentuh sama sekali.
 *   - Scraping tidak nemu apa-apa (selector meleset / markup berubah) -> HTML halaman
 *     didump ke ./debug-dumps/ dan grup itu dilewati (tidak menghapus apa pun).
 *
 * Cara pakai: sama seperti check-status.js (butuh .env yang sama)
 *   node sync-profiles.js
 */

"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { chromium } = require("playwright");
const { parseCookieString, buildPlaywrightCookies } = require("./netflix-helpers");

const SHEET_ID   = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
const HEADLESS   = process.env.HEADLESS !== "false";
const DELAY_MS   = Number(process.env.DELAY_MS || 2000);
// Range full termasuk kolom A (No) karena kita perlu tahu posisi baris asli tiap grup
const DATA_RANGE = `${SHEET_NAME}!A2:I`;
const DEBUG_DIR  = path.resolve(__dirname, "debug-dumps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Google Sheets auth ─────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

// Ambil sheetId numerik (bukan nama tab) — dibutuhkan buat request hapus baris
async function getSheetGid(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!found) throw new Error(`Tab "${sheetName}" tidak ditemukan di spreadsheet.`);
  return found.properties.sheetId;
}

// ── Selector sesuai markup asli layar "Who's watching?" ──
// <ul class="choose-profile"><li class="profile">...<span class="profile-name">NAMA</span>
const NAME_SELECTORS = [
  ".choose-profile .profile-name",
  ".profile-name",
  '[data-uia^="action-select-profile"] .profile-name',
];

async function scrapeProfileNames(page, email) {
  for (const selector of NAME_SELECTORS) {
    const texts = await page
      .locator(selector)
      .allTextContents()
      .catch(() => []);
    const names = texts.map((t) => t.trim()).filter(Boolean);
    if (names.length > 0) return names;
  }

  // Nggak ada selector yang match — dump HTML buat didebug manual
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const html = await page.content();
    const safeEmail = email.replace(/[^a-z0-9@._-]/gi, "_");
    const dumpPath = path.join(DEBUG_DIR, `${safeEmail}-${Date.now()}.html`);
    fs.writeFileSync(dumpPath, html, "utf-8");
    console.warn(`  [warn] Selector tidak nemu apa-apa. HTML didump ke: ${dumpPath}`);
    console.warn(`  [warn] Kirim isi file itu biar selector-nya bisa disesuaikan.`);
  } catch (err) {
    console.warn(`  [warn] Gagal dump HTML: ${err.message}`);
  }

  return [];
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  if (!SHEET_ID) {
    console.error("SHEET_ID belum diisi di .env");
    process.exit(1);
  }

  const sheets = await getSheetsClient();
  const gid    = await getSheetGid(sheets, SHEET_NAME);

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

  // ── Kelompokkan baris berdasarkan cookie unik ──
  // row index relatif dari A2, jadi baris sheet asli = idx + 2
  const groups = new Map(); // cacheKey -> { email, cookieMap, rowIndices: [idx,...], template: row }
  rows.forEach((row, idx) => {
    const email     = row[1] || "";
    const rawCookie = `${row[7] || ""}${row[8] || ""}`; // H=idx7, I=idx8 (A=0,B=1,...)
    const cookieMap = parseCookieString(rawCookie);
    if (!cookieMap) return; // baris tanpa cookie valid dilewati

    const key = `${cookieMap.NetflixId}::${cookieMap.SecureNetflixId}`;
    if (!groups.has(key)) {
      groups.set(key, { email, cookieMap, rowIndices: [], template: row });
    }
    groups.get(key).rowIndices.push(idx);
  });

  console.log(`Ditemukan ${groups.size} akun unik dari ${rows.length} baris.\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const newRows      = []; // baris baru (profil yang belum ada di sheet)
  const rowsToDelete  = []; // nomor baris asli di sheet yang mau dihapus (profil sudah tidak ada)

  for (const { email, cookieMap, rowIndices, template } of groups.values()) {
    console.log(`Cek: ${email} (${rowIndices.length} baris di sheet)`);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    try {
      await ctx.addCookies(buildPlaywrightCookies(cookieMap));
      await page.goto("https://www.netflix.com/browse", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      if (page.url().includes("/login") || page.url().includes("/LoginHelp")) {
        console.log(`  MATI — dilewati (tidak diubah)\n`);
        continue;
      }

      await sleep(1500); // kasih waktu render layar "Who's watching?"
      const scraped = await scrapeProfileNames(page, email);

      if (scraped.length === 0) {
        console.log(`  Tidak ada nama profil yang berhasil di-scrape, dilewati.\n`);
        continue;
      }

      console.log(`  Ditemukan profil live: ${scraped.join(", ")}`);

      // Nama existing di sheet untuk grup ini
      const existingEntries = rowIndices.map((idx) => ({
        idx,
        sheetRow: idx + 2,
        name: (rows[idx][3] || "").trim(),
      }));
      const existingNames = new Set(existingEntries.map((e) => e.name));
      const scrapedNames  = new Set(scraped);

      // Profil baru: ada di scrape, belum ada di sheet
      for (const name of scraped) {
        if (!existingNames.has(name)) {
          const newRow = [...template];
          newRow[0] = "";     // No dikosongkan
          newRow[3] = name;   // Profil
          newRows.push(newRow);
          console.log(`    + Baris baru: "${name}"`);
        }
      }

      // Profil hilang: ada di sheet, tidak ada lagi di scrape -> hapus
      for (const entry of existingEntries) {
        if (!scrapedNames.has(entry.name)) {
          rowsToDelete.push(entry.sheetRow);
          console.log(`    - Hapus baris ${entry.sheetRow}: "${entry.name}"`);
        }
      }

      console.log("");
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`  [error] ${err.message}\n`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  await browser.close();

  // ── Hapus baris (urutan dari bawah ke atas biar index tidak geser) ──
  if (rowsToDelete.length > 0) {
    console.log(`Menghapus ${rowsToDelete.length} baris...`);
    const sortedDesc = [...rowsToDelete].sort((a, b) => b - a);
    const deleteRequests = sortedDesc.map((sheetRow) => ({
      deleteDimension: {
        range: {
          sheetId: gid,
          dimension: "ROWS",
          startIndex: sheetRow - 1, // 0-indexed
          endIndex: sheetRow,
        },
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: deleteRequests },
    });
  }

  // ── Tambah baris baru untuk profil yang baru muncul ──
  if (newRows.length > 0) {
    console.log(`Menambah ${newRows.length} baris baru...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:I`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newRows },
    });
  }

  console.log(`\n${"═".repeat(40)}`);
  console.log("SELESAI");
  console.log(`  Baris baru ditambahkan : ${newRows.length}`);
  console.log(`  Baris dihapus          : ${rowsToDelete.length}`);
  console.log("═".repeat(40));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});