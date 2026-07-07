/**
 * sheets-guard.js — Baca data akun MEET dari spreadsheet untuk device guard
 *
 * Baca semua akun di blok MEET dari semua sheet.
 * Return: email, profil, dan device yang diizinkan (kolom G).
 */

"use strict";

require("dotenv").config();
const path = require("path");
const { google } = require("googleapis");

const COL_EMAIL    = parseInt(process.env.COL_EMAIL    ?? "0"); // A
const COL_PASSWORD = parseInt(process.env.COL_PASSWORD ?? "1"); // B
const COL_PROFILE  = parseInt(process.env.COL_PROFILE  ?? "2"); // C
const COL_LOGOUT   = parseInt(process.env.COL_LOGOUT   ?? "4"); // E
const COL_DEVICE   = parseInt(process.env.COL_DEVICE   ?? "6"); // G

// ── Parse max device dari kolom E ─────────────────────────
/**
 * Parse jumlah device maksimum dari teks kolom E.
 *
 * Rules:
 *   - Mengandung "SEMIPRIVATE" atau "SEMPRIV" → 2 device
 *   - Mengandung "1U" (misal "1U", "2B1U", "1 Bulan 1U") → 1 device
 *   - Mengandung "2U" → 2 device
 *   - Tidak ada keterangan → null (ikut kolom G saja)
 *
 * @param {string} logoutText - teks dari kolom E
 * @returns {number|null} jumlah max device, atau null jika tidak ada info
 */
function parseMaxDevices(logoutText) {
  if (!logoutText) return null;
  const text = logoutText.toUpperCase();

  if (text.includes("SEMIPRIVATE") || text.includes("SEMPRIV") || text.includes("SEMI PRIVATE")) {
    return 2;
  }

  // Cari pola XU di mana X adalah angka (1U, 2U, 3B1U, dll)
  const uMatch = text.match(/(\d+)U/);
  if (uMatch) {
    return parseInt(uMatch[1]);
  }

  return null; // tidak ada info
}

// ── Google Auth ───────────────────────────────────────────
let _sheetsClient = null;

async function getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_PATH ?? "../credentials.json");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client  = await auth.getClient();
  _sheetsClient = google.sheets({ version: "v4", auth: client });
  return _sheetsClient;
}

let _spreadsheetId = null;

async function findSpreadsheetId() {
  if (_spreadsheetId) return _spreadsheetId;
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
  _spreadsheetId = files[0].id;
  return _spreadsheetId;
}

// ── Deteksi header blok ───────────────────────────────────
function isHeaderRow(row) {
  const colA = row[COL_EMAIL]?.trim() ?? "";
  if (colA.includes("@")) return false;
  return row.some((cell) => cell && cell.trim().length > 2);
}

function isMeetBlock(row) {
  return row.join(" ").toUpperCase().includes("MEET");
}

function isMaheshOrRoseBlock(row) {
  const text = row.join(" ").toUpperCase();
  return text.includes("MAHESH") || text.includes("ROSE");
}

// ── Scan sheet untuk akun MEET ────────────────────────────
/**
 * Baca satu sheet dan kembalikan semua akun di blok MEET.
 * @returns {Array<{
 *   sheetName: string,
 *   email: string,
 *   password: string,
 *   profile: string,
 *   allowedDevice: string,   // isi kolom G, kosong jika tidak ada
 * }>}
 */
function scanSheetForMeet(rows, sheetName) {
  const results       = [];
  let inMeetBlock     = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (isHeaderRow(row)) {
      if (isMaheshOrRoseBlock(row)) {
        inMeetBlock = false;
      } else if (isMeetBlock(row)) {
        inMeetBlock = true;
        console.log(`  [guard-scan:${sheetName}] Blok MEET: "${row.join(" ").trim().substring(0, 50)}"`);
      } else {
        inMeetBlock = false;
      }
      continue;
    }

    if (!inMeetBlock) continue;

    const email         = row[COL_EMAIL]?.trim()    ?? "";
    if (!email.includes("@") || email.toLowerCase() === "email") continue;

    const password      = row[COL_PASSWORD]?.trim() ?? "";
    const profile       = row[COL_PROFILE]?.trim()  ?? "";
    const logoutText    = row[COL_LOGOUT]?.trim()   ?? "";
    const allowedDevice = row[COL_DEVICE]?.trim()   ?? "";

    if (!profile) continue;

    const maxDevices = parseMaxDevices(logoutText);
    // Slot kosong = kolom E kosong → tidak boleh ada yang login
    const hasCustomer = logoutText.length > 0;

    results.push({
      sheetName,
      email,
      password,
      profile,
      allowedDevice,
      maxDevices,
      logoutText,
      hasCustomer,   // false = slot kosong, kick semua device
    });
  }

  return results;
}

/**
 * Baca semua sheet, kembalikan semua akun MEET dengan info device yang diizinkan.
 * Deduplikasi per email+profil (ambil yang pertama ditemukan).
 */
async function getMeetAccounts() {
  const sheets        = await getSheets();
  const spreadsheetId = await findSpreadsheetId();
  const sheetNames    = (process.env.SHEETS_TO_CHECK ?? "HARIAN,MINGGUAN,BULANAN")
    .split(",").map(s => s.trim()).filter(Boolean);

  const allAccounts = [];
  const seen        = new Set(); // untuk deduplikasi email+profil

  for (const sheetName of sheetNames) {
    console.log(`\n[guard] Membaca sheet: ${sheetName}`);
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName });
      rows = res.data.values ?? [];
    } catch (err) {
      console.warn(`[guard] Sheet "${sheetName}" tidak bisa dibaca: ${err.message}`);
      continue;
    }

    const accounts = scanSheetForMeet(rows, sheetName);
    console.log(`[guard] → ${accounts.length} profil MEET di sheet ${sheetName}`);

    for (const acc of accounts) {
      const key = `${acc.email.toLowerCase()}::${acc.profile.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        allAccounts.push(acc);
      }
    }
  }

  // Grup per email
  const emailGroups = new Map();
  for (const acc of allAccounts) {
    const key = acc.email.toLowerCase();
    if (!emailGroups.has(key)) {
      emailGroups.set(key, { email: acc.email, password: acc.password, profiles: [] });
    }
    emailGroups.get(key).profiles.push({
      name:          acc.profile,
      allowedDevice: acc.allowedDevice,
      maxDevices:    acc.maxDevices,
      logoutText:    acc.logoutText,
      hasCustomer:   acc.hasCustomer,  // false = slot kosong
    });
  }

  return [...emailGroups.values()];
}

module.exports = { getMeetAccounts, findSpreadsheetId, parseMaxDevices };
