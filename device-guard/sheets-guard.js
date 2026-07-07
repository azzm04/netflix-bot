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
const COL_DEVICE   = parseInt(process.env.COL_DEVICE   ?? "6"); // G

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

    const email = row[COL_EMAIL]?.trim() ?? "";
    if (!email.includes("@") || email.toLowerCase() === "email") continue;

    const password      = row[COL_PASSWORD]?.trim() ?? "";
    const profile       = row[COL_PROFILE]?.trim()  ?? "";
    const allowedDevice = row[COL_DEVICE]?.trim()   ?? "";

    if (!profile) continue;

    results.push({
      sheetName,
      email,
      password,
      profile,
      allowedDevice,
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
    });
  }

  return [...emailGroups.values()];
}

module.exports = { getMeetAccounts, findSpreadsheetId };
