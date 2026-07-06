/**
 * index.js — Entry point Netflix Device Kicker
 *
 * Mode:
 * - `node index.js`           → jalankan cron scheduler (sesuai CRON_SCHEDULE di .env)
 * - `node index.js --run-now` → langsung eksekusi sekali tanpa scheduler
 *
 * ⚠️  Karena membutuhkan input kode dari user (4/6 digit),
 *     proses ini harus dijalankan di terminal yang bisa menerima input.
 *     Tidak cocok untuk dijalankan sebagai background service tanpa interaksi.
 */

"use strict";

require("dotenv").config();
const cron = require("node-cron");
const { getExpiredAccounts, markAsKicked, findSpreadsheetId } = require("./sheets");
const { kickDevicesForProfile, kickDevicesForProfiles, isPakeKode } = require("./kicker");

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "*/15 * * * *";
const RUN_NOW = process.argv.includes("--run-now");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fungsi Utama ─────────────────────────────────────────

async function processExpiredAccounts() {
  const startTime = Date.now();
  const banner = "=".repeat(60);

  console.log(`\n${banner}`);
  console.log(`[${new Date().toLocaleString("id-ID")}] 🔍 Mulai proses device kicker...`);
  console.log(banner);

  // 1. Baca akun expired dari Google Sheets
  let expiredList;
  try {
    expiredList = await getExpiredAccounts();
  } catch (err) {
    console.error("❌ [sheets] Gagal baca spreadsheet:", err.message);
    return;
  }

  if (expiredList.length === 0) {
    console.log("✅ Tidak ada akun expired saat ini.\n");
    return;
  }

  // Pisahkan: yang bisa diproses vs yang harus diskip
  const toProcess = [];
  const skippedAuto = [];

  for (const account of expiredList) {
    if (account.isSkipped) {
      skippedAuto.push(account);
    } else {
      toProcess.push(account);
    }
  }

  console.log(`\n📋 Total expired   : ${expiredList.length} akun`);
  console.log(`✅ Akan diproses   : ${toProcess.length} akun`);
  console.log(`⛔ Skip otomatis   : ${skippedAuto.length} akun (MAHESH/ROSE)`);

  if (skippedAuto.length > 0) {
    console.log("\n⛔ Akun yang di-skip (blok MAHESH/ROSE di spreadsheet):");
    skippedAuto.forEach((a, i) => {
      console.log(`   ${i + 1}. [${a.sheetName}] Row ${a.rowIndex} | ${a.email} | Profil: ${a.profile} | Blok: ${a.blockLabel}`);
    });
  }

  if (toProcess.length === 0) {
    console.log("\n📭 Tidak ada akun yang bisa diproses.\n");
    return;
  }

  console.log("\n📋 Akun yang akan diproses:");
  toProcess.forEach((a, i) => {
    const tipe = isPakeKode(a.password) ? "PAKE KODE" : "Password";
    console.log(
      `   ${i + 1}. [${a.sheetName}] Row ${a.rowIndex} | ${a.email} | ` +
      `Profil: ${a.profile} | Login: ${tipe} | Expired: ${a.logoutText}`
    );
  });

  // 2. Cari spreadsheet ID
  let spreadsheetId;
  try {
    spreadsheetId = await findSpreadsheetId();
  } catch (err) {
    console.error("❌ [sheets] Gagal cari spreadsheet ID:", err.message);
    return;
  }

  // 3. GROUP BY EMAIL — akun dengan email sama diproses sekali login
  // Contoh: fred50314@nfpro.store punya LIPSTICK + FLAMINGO + UNICORN expired
  //         → login sekali, kick semua profil dalam 1 sesi browser

  // Build map: email → list of accounts
  const emailGroups = new Map();
  for (const account of toProcess) {
    const key = account.email.toLowerCase();
    if (!emailGroups.has(key)) emailGroups.set(key, []);
    emailGroups.get(key).push(account);
  }

  const groups = [...emailGroups.values()];
  console.log(`\n📦 Dikelompokkan: ${groups.length} akun unik (${toProcess.length} profil total)`);
  groups.forEach((grp, i) => {
    const profiles = grp.map(a => a.profile).join(", ");
    console.log(`   ${i + 1}. ${grp[0].email} → [${profiles}]`);
  });

  let totalKicked = 0;
  let totalFailed = 0;
  let totalSkipped = skippedAuto.length;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const { email, password } = group[0];
    const profiles = group.map(a => a.profile);
    const tipe = isPakeKode(password) ? "PAKE KODE (4-digit)" : "Password";

    console.log(`\n${"─".repeat(60)}`);
    console.log(`▶ [${gi + 1}/${groups.length}] ${email}`);
    console.log(`   Profil  : ${profiles.join(", ")}`);
    console.log(`   Login   : ${tipe}`);
    console.log(`   Expired : ${group.map(a => `${a.profile}=${a.logoutText}`).join(" | ")}`);
    console.log(`${"─".repeat(60)}`);

    try {
      // Kick semua profil dalam satu sesi browser
      const result = await kickDevicesForProfiles(email, password, profiles);

      if (result.skipped) {
        console.log(`   ⛔ Skip: ${result.reason}`);
        totalSkipped += group.length;
        continue;
      }

      // Update sheet untuk semua profil dalam group ini
      for (const account of group) {
        await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
        console.log(`   📝 Sheet diupdate: [${account.sheetName}] Row ${account.rowIndex} — ${account.profile}`);
      }

      console.log(`   ✅ Total ${result.kicked} device dikick (${profiles.length} profil).`);
      totalKicked += group.length;

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      totalFailed += group.length;
    }

    if (gi < groups.length - 1) {
      console.log(`\n   ⏳ Jeda 4 detik sebelum akun berikutnya...`);
      await sleep(4000);
    }
  }

  // 4. Ringkasan
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 SELESAI dalam ${elapsed} detik`);
  console.log(`   ✅ Berhasil diproses : ${totalKicked}`);
  console.log(`   ❌ Gagal             : ${totalFailed}`);
  console.log(`   ⛔ Skip (MAHESH/ROSE blok): ${totalSkipped}`);
  console.log(`${"=".repeat(60)}\n`);
}

// ─── Run ──────────────────────────────────────────────────

if (RUN_NOW) {
  console.log("🚀 Netflix Device Kicker — Mode: Run Now");
  console.log("   (Tekan Ctrl+C untuk berhenti kapan saja)\n");
  processExpiredAccounts().catch(console.error);
} else {
  console.log(`🕐 Netflix Device Kicker — Mode: Scheduler`);
  console.log(`   Cron: "${CRON_SCHEDULE}"`);
  console.log(`   ⚠️  Mode scheduler membutuhkan terminal aktif untuk input kode.`);
  console.log(`   Tekan Ctrl+C untuk berhenti.\n`);

  // Jalankan sekali saat startup
  processExpiredAccounts().catch(console.error);

  // Jadwalkan sesuai cron
  cron.schedule(CRON_SCHEDULE, () => {
    processExpiredAccounts().catch(console.error);
  });
}
