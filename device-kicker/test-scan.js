/**
 * test-scan.js — Test logika scanSheetForExpired tanpa konek ke Google Sheets
 * Jalankan: node test-scan.js
 */
"use strict";

const { scanSheetForExpired, classifyHeaderRow, isHeaderRow } = require("./sheets");

// Simulasi data sheet BULANAN seperti di screenshot
// Baris 1 = header blok "MAHESH EXTEND - 11 JULI"
// Baris 2-5 = akun mahesh (harus SKIP)
// Baris 6 = header blok lain (misal akun sendiri)
// Baris 7+ = akun normal (harus DIPROSES)

const fakeRows = [
  // Baris 1 — header blok MAHESH
  ["", "MAHESH EXTEND - 11 JULI", "", "", "", ""],
  // Baris 2-4 — akun mahesh (expired)
  ["dmroz.us@mrthala.com", "janganubahapapun", "Farfalle", "9480", "1 Juli (1U)", "882-9090-6522"],
  ["Debra.us@mahflix.com", "L0v3hidden", "dolphin", "8396", "26 Juli (1U)", "812-5415-4788"],
  ["fomige9848@ramaco.tech", "janganisenjangancurang", "Melody", "1072", "21 Agustus (1U)", "857-8342-5069"],
  // Baris 5 — header blok lain (akun non-mahesh)
  ["", "AKUN ENA - JULI 2026", "", "", "", ""],
  // Baris 6-7 — akun normal (expired, harus DIPROSES)
  ["humpadhis@stayhome.li", "pass123", "NERINE", "1234", "1 Juli 10:00", "081234567890"],
  ["fitwhovex@fuwari.be", "mypass", "ASTER", "5678", "30 Juni 22:00", "089876543210"],
  // Baris 8 — akun normal tapi belum expired (harus dilewati)
  ["someother@gmail.com", "pass456", "LILY", "9999", "31 Desember 23:59", "081111111111"],
  // Baris 9 — header blok ROSE
  ["", "ROSE EXTEND - 5 JULI", "", "", "", ""],
  // Baris 10 — akun rose (expired, harus SKIP)
  ["ournapapt@stayhome.li", "rosepass", "BUTTERFLY", "4321", "5 Juni 10:00", "082222222222"],
];

console.log("=== TEST classifyHeaderRow ===");
console.log("MAHESH:", classifyHeaderRow(["", "MAHESH EXTEND - 11 JULI", ""]));
console.log("ROSE  :", classifyHeaderRow(["", "ROSE EXTEND - 5 JULI", ""]));
console.log("NORMAL:", classifyHeaderRow(["", "AKUN ENA - JULI 2026", ""]));
console.log("DATA  :", classifyHeaderRow(["user@email.com", "pass", "profile"]));

console.log("\n=== TEST isHeaderRow ===");
console.log("Header MAHESH:", isHeaderRow(["", "MAHESH EXTEND - 11 JULI", ""]));
console.log("Baris data   :", isHeaderRow(["user@email.com", "pass", "profile"]));
console.log("Baris kosong :", isHeaderRow(["", "", ""]));

console.log("\n=== TEST scanSheetForExpired ===");
// Set tanggal sekarang ke Agustus 2026 untuk simulasi expired
// (semua tanggal di atas pasti sudah lewat)
const results = scanSheetForExpired(fakeRows, "BULANAN_TEST");

results.forEach((r) => {
  const status = r.isSkipped ? "⛔ SKIP" : "✅ PROSES";
  console.log(`${status} | Row ${r.rowIndex} | ${r.email} | Profil: ${r.profile} | Blok: "${r.blockLabel || '-'}"`);
});

const shouldProcess = results.filter((r) => !r.isSkipped);
const shouldSkip    = results.filter((r) => r.isSkipped);

console.log(`\nRingkasan:`);
console.log(`  Akan diproses : ${shouldProcess.length}`);
console.log(`  Di-skip       : ${shouldSkip.length}`);

// Validasi
const errors = [];
// dmroz, Debra, fomige → harus skip (mahesh)
if (!results.find((r) => r.email === "dmroz.us@mrthala.com")?.isSkipped)
  errors.push("FAIL: dmroz.us@mrthala.com harusnya SKIP");
// humpadhis, fitwhovex → harus diproses
if (results.find((r) => r.email === "humpadhis@stayhome.li")?.isSkipped)
  errors.push("FAIL: humpadhis@stayhome.li harusnya DIPROSES");
// ournapapt → harus skip (rose)
if (!results.find((r) => r.email === "ournapapt@stayhome.li")?.isSkipped)
  errors.push("FAIL: ournapapt@stayhome.li harusnya SKIP (blok ROSE)");
// someother belum expired → tidak muncul sama sekali
if (results.find((r) => r.email === "someother@gmail.com"))
  errors.push("FAIL: someother@gmail.com belum expired, harusnya tidak muncul");

if (errors.length === 0) {
  console.log("\n✅ Semua test PASSED!");
} else {
  errors.forEach((e) => console.error("❌", e));
  process.exit(1);
}
