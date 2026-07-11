/**
 * check-status.js — Cek status cookie Netflix + (opsional) sync profil, dari Google Sheets
 *
 * Kolom sheet:
 *   A: No | B: Email | C: Password | D: Profil | E: Waktu | F: Nomor | G: Status | H+I: Cookie (merged cell)
 *
 * Cookie di kolom H (atau H+I kalau kepotong/belum merge) formatnya:
 *   "NetflixId=xxx;SecureNetflixId=yyy;"
 *
 * Cara pakai:
 *   node check-status.js                    -> cek status + refresh cookie aja
 *   node check-status.js --sync-profiles    -> sekalian scrape & sync nama profil
 *
 * Yang dilakukan tiap cookie UNIK (sekali buka /browse aja, dipakai bareng):
 *   1. Cek hidup/mati.
 *   2. Kalau hidup: ambil cookie yang sudah di-refresh server Netflix.
 *   3. Kalau --sync-profiles: scrape nama profil dari layar "Who's watching?" di page yang sama.
 *
 * Sync profil (MATCHING BERDASARKAN NAMA, bukan posisi), baru dieksekusi setelah
 * semua akun selesai dicek (supaya nomor baris nggak berubah di tengah proses):
 *   - Nama di scrape tapi belum ada di sheet -> baris baru ditambahkan.
 *   - Nama di sheet tapi udah nggak ada di scrape -> baris itu DIHAPUS.
 *   - Cookie MATI / scraping gagal -> grup itu dilewati, tidak disentuh.
 *
 * Baris dengan cookie yang SAMA (duplikat/multi-profil) tidak di-log ke terminal
 * saat cached, tapi tetap ditulis statusnya. Rekap akhir dihitung per cookie UNIK.
 */

"use strict";

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { chromium } = require("playwright");
const { parseCookieString, buildPlaywrightCookies, buildCookieRawString } = require("./netflix-helpers");

const SHEET_ID       = process.env.SHEET_ID;
const SHEET_NAME     = process.env.SHEET_NAME || "Sheet1";
const HEADLESS       = process.env.HEADLESS !== "false";
const DELAY_MS       = Number(process.env.DELAY_MS || 2000);
const BATCH_SIZE     = Number(process.env.BATCH_SIZE || 20);
const SYNC_PROFILES  = process.argv.includes("--sync-profiles");

// Kolom lengkap A..I (A=No, B=Email, C=Password, D=Profil, E=Waktu, F=Nomor, G=Status, H+I=Cookie)
const DATA_RANGE = `${SHEET_NAME}!A2:I`;
const STATUS_COL = "G";
const COOKIE_COL = "H";
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

async function getSheetGid(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME);
  if (!found) throw new Error(`Tab "${SHEET_NAME}" tidak ditemukan di spreadsheet.`);
  return found.properties.sheetId;
}

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

// ── Scrape nama profil dari layar "Who's watching?" (page sudah di /browse) ──
const NAME_SELECTORS = [
  ".choose-profile .profile-name",
  ".profile-name",
  '[data-uia^="action-select-profile"] .profile-name',
];

async function scrapeProfileNames(page, email) {
  for (const selector of NAME_SELECTORS) {
    const texts = await page.locator(selector).allTextContents().catch(() => []);
    const names = texts.map((t) => t.trim()).filter(Boolean);
    if (names.length > 0) return names;
  }
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const html = await page.content();
    const safeEmail = email.replace(/[^a-z0-9@._-]/gi, "_");
    const dumpPath = path.join(DEBUG_DIR, `${safeEmail}-${Date.now()}.html`);
    fs.writeFileSync(dumpPath, html, "utf-8");
    console.warn(`    [warn] Selector profil tidak nemu apa-apa. HTML didump ke: ${dumpPath}`);
  } catch (err) {
    console.warn(`    [warn] Gagal dump HTML: ${err.message}`);
  }
  return [];
}

// ── Cek satu cookie: hidup/mati + refresh cookie + (opsional) scrape profil ──
// Semua dalam SATU kali buka /browse.
async function checkCookie(browser, cookieMap, email) {
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
      return { alive: false, refreshedCookie: null, scrapedProfiles: null };
    }

    // Cookie terbaru hasil refresh server Netflix
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));
    let refreshedCookie = null;
    if (cm.NetflixId && cm.SecureNetflixId) {
      refreshedCookie = buildCookieRawString({
        NetflixId: cm.NetflixId,
        SecureNetflixId: cm.SecureNetflixId,
      });
    }

    let scrapedProfiles = null;
    if (SYNC_PROFILES) {
      await sleep(1500); // kasih waktu render layar "Who's watching?"
      scrapedProfiles = await scrapeProfileNames(page, email);
    }

    return { alive: true, refreshedCookie, scrapedProfiles };
  } catch (err) {
    console.error(`  [warn] Gagal cek: ${err.message}`);
    return { alive: false, refreshedCookie: null, scrapedProfiles: null };
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: DATA_RANGE });
  const rows = res.data.values || [];

  if (rows.length === 0) {
    console.log("Tidak ada data.");
    return;
  }

  console.log(`Ditemukan ${rows.length} baris.${SYNC_PROFILES ? " (mode: cek status + sync profil)" : ""}\n`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  // Cache per cookie unik: { alive, refreshedCookie, scrapedProfiles }
  const cache = new Map();
  let invalidCount = 0;

  let pendingStatus  = [];
  let pendingCookies = [];
  let batchStartRow  = 2;

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const email    = row[1] || "(tanpa email)"; // B
    const sheetRow = i + 2;
    const rawCookie = `${row[7] || ""}${row[8] || ""}`; // H + I
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
        const result = await checkCookie(browser, cookieMap, email);
        alive = result.alive;
        refreshedCookie = result.refreshedCookie;
        cache.set(cacheKey, result);
        console.log(`[${sheetRow}] ${email} — ${alive ? "BISA" : "MATI"}`);
        await sleep(DELAY_MS);
      }
    }

    pendingStatus.push([alive ? "BISA" : "MATI"]);
    if (refreshedCookie) pendingCookies.push({ row: sheetRow, value: refreshedCookie });

    const isLastRow = i === rows.length - 1;
    if (pendingStatus.length >= BATCH_SIZE || isLastRow) {
      await flushBatch(sheets, batchStartRow, pendingStatus, pendingCookies);
      batchStartRow += pendingStatus.length;
      pendingStatus  = [];
      pendingCookies = [];
    }
  }

  await browser.close();
  console.log("Semua status & cookie sudah tersimpan ke sheet.\n");

  // ── Rekap unik ──
  let bisaUnik = 0, matiUnik = 0;
  for (const entry of cache.values()) entry.alive ? bisaUnik++ : matiUnik++;
  matiUnik += invalidCount;

  // ── Sync profil (kalau flag di-pass) ──
  if (SYNC_PROFILES) {
    console.log(`${"─".repeat(40)}`);
    console.log("Sinkronisasi profil...\n");

    const groups = new Map(); // cacheKey -> { rowIndices: [], template }
    rows.forEach((row, idx) => {
      const rawCookie = `${row[7] || ""}${row[8] || ""}`;
      const cookieMap = parseCookieString(rawCookie);
      if (!cookieMap) return;
      const key = `${cookieMap.NetflixId}::${cookieMap.SecureNetflixId}`;
      if (!groups.has(key)) groups.set(key, { rowIndices: [], template: row });
      groups.get(key).rowIndices.push(idx);
    });

    const newRows     = [];
    const rowsToDelete = [];

    for (const [key, { rowIndices, template }] of groups.entries()) {
      const cached = cache.get(key);
      if (!cached || !cached.alive) continue;
      const scraped = cached.scrapedProfiles;
      if (!scraped || scraped.length === 0) continue;

      const email = template[1] || "(tanpa email)";
      const existingEntries = rowIndices.map((idx) => ({
        idx,
        sheetRow: idx + 2,
        name: (rows[idx][3] || "").trim(),
      }));
      const existingNames = new Set(existingEntries.map((e) => e.name));
      const scrapedNames  = new Set(scraped);

      for (const name of scraped) {
        if (!existingNames.has(name)) {
          const newRow = [...template];
          newRow[0] = "";
          newRow[3] = name;
          newRows.push(newRow);
          console.log(`  + [${email}] Baris baru: "${name}"`);
        }
      }
      for (const entry of existingEntries) {
        if (!scrapedNames.has(entry.name)) {
          rowsToDelete.push(entry.sheetRow);
          console.log(`  - [${email}] Hapus baris ${entry.sheetRow}: "${entry.name}"`);
        }
      }
    }

    if (rowsToDelete.length > 0) {
      console.log(`\nMenghapus ${rowsToDelete.length} baris...`);
      const gid = await getSheetGid(sheets);
      const sortedDesc = [...rowsToDelete].sort((a, b) => b - a);
      const deleteRequests = sortedDesc.map((sheetRow) => ({
        deleteDimension: {
          range: { sheetId: gid, dimension: "ROWS", startIndex: sheetRow - 1, endIndex: sheetRow },
        },
      }));
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: deleteRequests },
      });
    }

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

    console.log(`\nSync profil selesai — ditambah: ${newRows.length}, dihapus: ${rowsToDelete.length}`);
  }

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