/**
 * test-sheets.js — Test koneksi Google Sheets + scan akun expired
 * Tanpa Puppeteer, hanya baca data sheet.
 * Jalankan: node test-sheets.js
 */
"use strict";

require("dotenv").config();
const { getExpiredAccounts, findSpreadsheetId } = require("./sheets");

async function main() {
  console.log("🔍 Test koneksi Google Sheets...\n");
  console.log(`   Spreadsheet : ${process.env.SPREADSHEET_NAME}`);
  console.log(`   Sheets      : ${process.env.SHEETS_TO_CHECK}`);
  console.log(`   Credentials : ${process.env.GOOGLE_CREDENTIALS_PATH}\n`);

  // Step 1: Cari spreadsheet ID
  let spreadsheetId;
  try {
    spreadsheetId = await findSpreadsheetId();
    console.log(`✅ Spreadsheet ditemukan! ID: ${spreadsheetId}\n`);
  } catch (err) {
    console.error(`❌ Gagal cari spreadsheet: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Baca akun expired
  let expired;
  try {
    expired = await getExpiredAccounts();
  } catch (err) {
    console.error(`❌ Gagal baca akun expired: ${err.message}`);
    process.exit(1);
  }

  const toProcess = expired.filter((a) => !a.isSkipped);
  const skipped   = expired.filter((a) => a.isSkipped);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`📊 Hasil scan:`);
  console.log(`   Total expired  : ${expired.length}`);
  console.log(`   Akan diproses  : ${toProcess.length}`);
  console.log(`   Skip MAHESH/ROSE: ${skipped.length}`);

  if (toProcess.length > 0) {
    console.log(`\n✅ Akun yang AKAN diproses:`);
    toProcess.forEach((a, i) => {
      const tipe = (!a.password || a.password.toUpperCase().includes("PAKE KODE"))
        ? "PAKE KODE" : "Password";
      console.log(`   ${i + 1}. [${a.sheetName}] Row ${a.rowIndex} | ${a.email}`);
      console.log(`      Profil: ${a.profile} | Login: ${tipe} | Expired: ${a.logoutText}`);
    });
  }

  if (skipped.length > 0) {
    console.log(`\n⛔ Akun yang DI-SKIP (MAHESH/ROSE):`);
    skipped.forEach((a, i) => {
      console.log(`   ${i + 1}. [${a.sheetName}] Row ${a.rowIndex} | ${a.email} | Blok: ${a.blockLabel}`);
    });
  }

  console.log(`\n${"=".repeat(55)}`);
  console.log("✅ Test selesai, koneksi OK!\n");
}

main().catch((err) => {
  console.error("❌ Error tidak terduga:", err.message);
  process.exit(1);
});
