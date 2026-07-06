/**
 * sheets.js — Baca data expired dari Google Sheets
 *
 * ─── Cara Mendeteksi Akun MAHESH / ROSE (SKIP) ──────────────────────────────
 *
 * Di spreadsheet, akun dikelompokkan dalam "blok" yang diawali baris header.
 * Header blok ada di baris manapun, ditandai dengan:
 *   - Kolom A KOSONG (bukan email)
 *   - Kolom B atau C mengandung kata "MAHESH" atau "ROSE"
 *
 * Contoh header: "MAHESH EXTEND - 11 JULI", "ROSE EXTEND - 1 JUNI"
 *
 * Semua baris akun (ada '@' di kolom A) yang berada di bawah header MAHESH/ROSE
 * akan di-skip sampai ketemu header blok lain (atau akhir sheet).
 *
 * Akun di luar blok MAHESH/ROSE (header lain atau tidak ada header) = DIPROSES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

"use strict";

require("dotenv").config();
const path = require("path");
const { google } = require("googleapis");

// ─── Konstanta kolom (0-based) ────────────────────────────
const COL_EMAIL    = parseInt(process.env.COL_EMAIL    ?? "0"); // A
const COL_PASSWORD = parseInt(process.env.COL_PASSWORD ?? "1"); // B
const COL_PROFILE  = parseInt(process.env.COL_PROFILE  ?? "2"); // C
const COL_LOGOUT   = parseInt(process.env.COL_LOGOUT   ?? "4"); // E
const DATA_START_ROW = parseInt(process.env.DATA_START_ROW ?? "2");

// ─── Mapping bulan Indonesia ──────────────────────────────
const BULAN_ID = {
  januari: 1, februari: 2, maret: 3, april: 4,
  mei: 5, juni: 6, juli: 7, agustus: 8,
  september: 9, oktober: 10, november: 11, desember: 12,
};

// ─── Parse tanggal logout ─────────────────────────────────
/**
 * Parse teks logout ke Date.
 * Format: "28 Mei 12:30" | "30 Juni 22.10" | "23 Juni ( Sempriv )"
 * @param {string} text
 * @returns {Date|null}
 */
function parseTanggalLogout(text) {
  if (!text || text.trim() === "" || text.toUpperCase() === "EXPIRED") return null;

  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;

  const hari = parseInt(parts[0]);
  const bulan = BULAN_ID[parts[1].toLowerCase().replace(",", "")];
  if (!bulan || isNaN(hari)) return null;

  let jam = 19, menit = 0;
  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    const mc = p.match(/^(\d{1,2}):(\d{2})$/);
    const md = p.match(/^(\d{1,2})\.(\d{2})$/);
    if (mc) { jam = parseInt(mc[1]); menit = parseInt(mc[2]); break; }
    if (md) { jam = parseInt(md[1]); menit = parseInt(md[2]); break; }
  }

  return new Date(new Date().getFullYear(), bulan - 1, hari, jam, menit, 0);
}

// ─── Deteksi baris header blok ────────────────────────────
/**
 * Cek apakah sebuah baris adalah baris header blok akun.
 *
 * Ciri header:
 * - Kolom A TIDAK mengandung '@' (bukan email)
 * - Minimal ada satu kolom yang mengandung teks bermakna (bukan semua kosong)
 *
 * @param {string[]} row
 * @returns {boolean}
 */
function isHeaderRow(row) {
  const colA = row[COL_EMAIL]?.trim() ?? "";
  if (colA.includes("@")) return false; // baris data, bukan header

  // Cek apakah ada kolom yang berisi teks (bukan semua kosong)
  const hasText = row.some((cell) => cell && cell.trim().length > 2);
  return hasText;
}

/**
 * Cek apakah baris header menandakan blok MAHESH atau ROSE.
 * Cukup cari kata "MAHESH" atau "ROSE" di seluruh sel baris tersebut.
 *
 * @param {string[]} row
 * @returns {{ isMaheshOrRose: boolean, label: string }}
 */
function classifyHeaderRow(row) {
  const fullText = row.join(" ").toUpperCase();
  const isMahesh = fullText.includes("MAHESH");
  const isRose   = fullText.includes("ROSE");

  if (isMahesh) return { isMaheshOrRose: true, label: "MAHESH" };
  if (isRose)   return { isMaheshOrRose: true, label: "ROSE" };
  return { isMaheshOrRose: false, label: "" };
}

// ─── Auth Google ──────────────────────────────────────────
let _sheetsClient = null;

async function getSheets() {
  if (_sheetsClient) return _sheetsClient;
  const credPath = path.resolve(
    __dirname,
    process.env.GOOGLE_CREDENTIALS_PATH ?? "../credentials.json"
  );
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  const client = await auth.getClient();
  _sheetsClient = google.sheets({ version: "v4", auth: client });
  return _sheetsClient;
}

let _spreadsheetId = null;

/**
 * Cari spreadsheet ID berdasarkan nama di Google Drive.
 * Di-cache setelah pertama kali dipanggil.
 * @returns {Promise<string>}
 */
async function findSpreadsheetId() {
  if (_spreadsheetId) return _spreadsheetId;

  const credPath = path.resolve(
    __dirname,
    process.env.GOOGLE_CREDENTIALS_PATH ?? "../credentials.json"
  );
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const client = await auth.getClient();
  const drive = google.drive({ version: "v3", auth: client });

  const name = process.env.SPREADSHEET_NAME;
  // Escape apostrof dalam nama file untuk query Drive API
  // Contoh: "jaeminies's" → "jaeminies\\'s"
  const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name='${escapedName}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  const files = res.data.files ?? [];
  if (files.length === 0) {
    throw new Error(`Spreadsheet "${name}" tidak ditemukan di Google Drive.`);
  }

  _spreadsheetId = files[0].id;
  return _spreadsheetId;
}

// ─── Fungsi Utama ─────────────────────────────────────────

/**
 * Scan satu sheet dan kembalikan semua akun expired beserta info bloknya.
 *
 * @param {string[][]} rows       - semua baris dari sheet (dari API)
 * @param {string}     sheetName  - nama sheet (untuk info)
 * @returns {Array<{
 *   sheetName: string,
 *   rowIndex: number,
 *   email: string,
 *   password: string,
 *   profile: string,
 *   logoutText: string,
 *   logoutDate: Date,
 *   isSkipped: boolean,
 *   skipReason: string,
 *   blockLabel: string,   // label header blok: "MAHESH", "ROSE", atau ""
 * }>}
 */
function scanSheetForExpired(rows, sheetName) {
  const now = new Date();
  const results = [];

  // State: blok aktif saat ini
  let currentBlockIsMaheshOrRose = false;
  let currentBlockLabel = "";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowIndex = i + 1; // 1-based

    // Lewati baris sebelum DATA_START_ROW (biasanya baris 1 = header kolom)
    // KECUALI: baris 1 di sheet BULANAN bisa langsung jadi header blok
    // Jadi kita scan dari baris 1 untuk mendeteksi header blok
    if (rowIndex < 1) continue;

    // ── Cek apakah ini baris header blok ──────────────────
    if (isHeaderRow(row)) {
      const { isMaheshOrRose, label } = classifyHeaderRow(row);
      currentBlockIsMaheshOrRose = isMaheshOrRose;
      currentBlockLabel = label;

      if (isMaheshOrRose) {
        console.log(`  [scan:${sheetName}] Blok SKIP ditemukan: "${row.join(" ").trim().substring(0, 50)}"`);
      } else {
        // Header blok selain MAHESH/ROSE (blok akun sendiri)
        const headerText = row.join(" ").trim().substring(0, 50);
        if (headerText.length > 2) {
          console.log(`  [scan:${sheetName}] Blok PROSES: "${headerText}"`);
        }
      }
      continue; // baris header sendiri tidak diproses
    }

    // ── Baris data (ada '@' di kolom A) ───────────────────
    const email = row[COL_EMAIL]?.trim() ?? "";
    if (!email.includes("@")) continue;

    // Lewati baris header kolom (baris pertama spreadsheet biasanya "EMAIL", "PASSWORD", dst)
    if (email.toLowerCase() === "email") continue;

    const password   = row[COL_PASSWORD]?.trim() ?? "";
    const profile    = row[COL_PROFILE]?.trim()  ?? "";
    const logoutText = row[COL_LOGOUT]?.trim()   ?? "";

    // Skip jika kolom E kosong (slot belum terisi) atau sudah EXPIRED
    if (!logoutText || logoutText.toUpperCase() === "EXPIRED") continue;

    // Parse tanggal logout
    const logoutDate = parseTanggalLogout(logoutText);
    if (!logoutDate) continue;

    // Hanya ambil yang sudah lewat deadline
    if (logoutDate > now) continue;

    results.push({
      sheetName,
      rowIndex,
      email,
      password,
      profile,
      logoutText,
      logoutDate,
      isSkipped: currentBlockIsMaheshOrRose,
      skipReason: currentBlockIsMaheshOrRose
        ? `Blok ${currentBlockLabel} — tidak punya akses ke email akun`
        : "",
      blockLabel: currentBlockLabel,
    });
  }

  return results;
}

/**
 * Baca semua sheet yang dikonfigurasi, kembalikan seluruh akun expired.
 * Setiap item sudah diberi flag `isSkipped` berdasarkan header blok MAHESH/ROSE.
 *
 * @returns {Promise<Array>}
 */
async function getExpiredAccounts() {
  const sheets = await getSheets();
  const spreadsheetId = await findSpreadsheetId();

  const sheetNames = (process.env.SHEETS_TO_CHECK ?? "HARIAN,MINGGUAN,BULANAN")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allExpired = [];

  for (const sheetName of sheetNames) {
    console.log(`\n[sheets] Membaca sheet: ${sheetName}`);
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetName,
      });
      rows = res.data.values ?? [];
    } catch (err) {
      console.warn(`[sheets] Sheet "${sheetName}" tidak bisa dibaca: ${err.message}`);
      continue;
    }

    const expired = scanSheetForExpired(rows, sheetName);
    console.log(`[sheets] → ${expired.length} akun expired di sheet ${sheetName}`);
    allExpired.push(...expired);
  }

  return allExpired;
}

/**
 * Reset slot akun yang sudah expired:
 * - Kosongkan kolom E (tanggal logout) dan kolom F (nomor HP pelanggan)  
 * - Set background kolom E jadi HIJAU (menandakan slot siap dipakai lagi)
 * - Set background kolom F jadi putih
 *
 * Ini mereplikasi behavior Python sheets_handler.py:
 *   BG_HIJAU = {"red": 0.0, "green": 1.0, "blue": 0.0}
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} rowIndex  - 1-based
 */
async function markAsKicked(spreadsheetId, sheetName, rowIndex) {
  const sheets = await getSheets();
  console.log(`  [sheets] markAsKicked: ${sheetName} baris ${rowIndex}...`);

  const colE = String.fromCharCode(65 + COL_LOGOUT);       // "E"
  const colF = String.fromCharCode(65 + COL_LOGOUT + 1);   // "F"
  const rangeE = `${sheetName}!${colE}${rowIndex}`;
  const rangeF = `${sheetName}!${colF}${rowIndex}`;

  // Step 1: Kosongkan kolom E, F, dan G (hapus tanggal logout + nomor HP + info device)
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: rangeE, values: [[""]] },
        { range: rangeF, values: [[""]] },
        { range: `${sheetName}!G${rowIndex}`, values: [[""]] },
      ],
    },
  });

  // Step 2: Set background E = hijau (#00FF00), F = putih
  // Ambil sheetId dulu
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheetMeta = meta.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheetMeta) {
    console.warn(`[sheets] Sheet "${sheetName}" tidak ditemukan untuk format.`);
    return;
  }
  const sheetId = sheetMeta.properties.sheetId;

  // rowIndex 1-based → startRowIndex = rowIndex-1 (0-based)
  const rowIdx = rowIndex - 1;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Kolom E → hijau terang (slot tersedia kembali)
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: rowIdx,
              endRowIndex: rowIdx + 1,
              startColumnIndex: COL_LOGOUT,
              endColumnIndex: COL_LOGOUT + 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.0, green: 1.0, blue: 0.0 },
              },
            },
            fields: "userEnteredFormat.backgroundColor",
          },
        },
        // Kolom F → kosongkan isi saja, JANGAN ubah warna background
        // (warna asli kolom F = biru, dibiarkan tetap biru)
      ],
    },
  });
  console.log(`  [sheets] markAsKicked selesai: ${sheetName} baris ${rowIndex} → kosong + hijau`);
}

module.exports = {
  getExpiredAccounts,
  markAsKicked,
  findSpreadsheetId,
  // Export untuk unit test / debug
  parseTanggalLogout,
  isHeaderRow,
  classifyHeaderRow,
  scanSheetForExpired,
};
