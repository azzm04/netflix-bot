"use strict";

require("dotenv").config();
const cron = require("node-cron");
const { getExpiredAccounts, markAsKicked, updatePin, findSpreadsheetId } = require("./sheets");
const { kickDevicesForProfiles, isPakeKode } = require("./kicker");
const { changePinsForProfiles } = require("./pin-changer");

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "*/15 * * * *";
const RUN_NOW = process.argv.includes("--run-now");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------
async function processExpiredAccounts() {
  const startTime = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${new Date().toLocaleString("id-ID")}] Mulai proses device kicker...`);
  console.log("=".repeat(60));

  // 1. Baca expired dari sheets
  let expiredList;
  try {
    expiredList = await getExpiredAccounts();
  } catch (err) {
    console.error("Gagal baca spreadsheet:", err.message);
    return;
  }

  if (expiredList.length === 0) {
    console.log("Tidak ada akun expired saat ini.\n");
    return;
  }

  // 2. Pisahkan: KICK (normal) vs PIN CHANGE (MAHESH/ROSE)
  const toKick = [];
  const toPin  = [];

  for (const a of expiredList) {
    if (a.isSkipped) toPin.push(a);   // MAHESH/ROSE → ganti PIN
    else             toKick.push(a);  // normal      → kick device
  }

  console.log(`\nTotal expired   : ${expiredList.length}`);
  console.log(`Kick device     : ${toKick.length}`);
  console.log(`Ganti PIN       : ${toPin.length} (MAHESH/ROSE)`);

  if (toKick.length === 0 && toPin.length === 0) {
    console.log("Tidak ada yang bisa diproses.\n");
    return;
  }

  // 3. Cari spreadsheet ID
  let spreadsheetId;
  try {
    spreadsheetId = await findSpreadsheetId();
  } catch (err) {
    console.error("Gagal cari spreadsheet ID:", err.message);
    return;
  }

  let totalKicked = 0;
  let totalPinChanged = 0;
  let totalFailed = 0;

  // ── SECTION A: KICK DEVICE ──────────────────────────────
  if (toKick.length > 0) {
    // Group by email → login sekali per email
    // Semua akun dalam satu group pasti punya isMeet yang sama
    const emailGroups = new Map();
    for (const a of toKick) {
      const key = a.email.toLowerCase();
      if (!emailGroups.has(key)) emailGroups.set(key, []);
      emailGroups.get(key).push(a);
    }
    const kickGroups = [...emailGroups.values()];

    console.log(`\n== KICK DEVICE (${kickGroups.length} email, ${toKick.length} profil) ==`);
    kickGroups.forEach((grp, i) => {
      console.log(`  ${i + 1}. ${grp[0].email} -> [${grp.map(a => a.profile).join(", ")}]`);
    });

    for (let gi = 0; gi < kickGroups.length; gi++) {
      const group = kickGroups[gi];
      const { email, password } = group[0];
      const profiles = group.map(a => a.profile);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[${gi + 1}/${kickGroups.length}] ${email}`);
      console.log(`  Profil  : ${profiles.join(", ")}`);
      console.log(`  Login   : ${isPakeKode(password) ? "PAKE KODE" : "Password"}`);
      console.log("─".repeat(60));

      try {
        const isMeet = group[0].isMeet ?? false;
      const accountLabel = group[0].blockLabel ?? "";
      const result = await kickDevicesForProfiles(email, password, profiles, isMeet, accountLabel);

        if (result.skipped) {
          console.log(`  Skip: ${result.reason}`);
          totalFailed += group.length;
          continue;
        }

        for (const account of group) {
          await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
        }
        console.log(`  Berhasil: ${result.kicked} device dikick, sheet diupdate.`);
        totalKicked += group.length;

      } catch (err) {
        console.error(`  Error: ${err.message}`);
        totalFailed += group.length;
      }

      if (gi < kickGroups.length - 1) {
        console.log("\n  Jeda 4 detik...");
        await sleep(4000);
      }
    }
  }

  // ── SECTION B: GANTI PIN (MAHESH/ROSE) ─────────────────
  if (toPin.length > 0) {
    // Group by email
    const pinGroups = new Map();
    for (const a of toPin) {
      const key = a.email.toLowerCase();
      if (!pinGroups.has(key)) pinGroups.set(key, []);
      pinGroups.get(key).push(a);
    }
    const pinEmailGroups = [...pinGroups.values()];

    console.log(`\n== GANTI PIN MAHESH/ROSE (${pinEmailGroups.length} email, ${toPin.length} profil) ==`);
    pinEmailGroups.forEach((grp, i) => {
      console.log(`  ${i + 1}. ${grp[0].email} [${grp[0].blockLabel}] -> [${grp.map(a => a.profile).join(", ")}]`);
    });

    for (let gi = 0; gi < pinEmailGroups.length; gi++) {
      const group = pinEmailGroups[gi];
      const { email, password, blockLabel } = group[0];
      const profiles  = group.map(a => a.profile);
      const accountType = blockLabel === "ROSE" ? "rose" : "mahesh";

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[${gi + 1}/${pinEmailGroups.length}] ${email} [${blockLabel}]`);
      console.log(`  Profil  : ${profiles.join(", ")}`);
      console.log(`  Tipe    : ${accountType.toUpperCase()}`);
      console.log("─".repeat(60));

      try {
        const pinChanges = await changePinsForProfiles(email, password, accountType, profiles);

        if (pinChanges.size === 0) {
          console.log("  Tidak ada PIN yang diganti.");
          totalFailed += group.length;
          continue;
        }

        // Update spreadsheet: PIN baru di kolom D + kosongkan E/F/G + hijau
        for (const account of group) {
          const newPin = pinChanges.get(account.profile)
            // coba partial match (nama profil bisa ada emoji)
            ?? [...pinChanges.entries()].find(([k]) =>
                account.profile.toLowerCase().includes(k.toLowerCase()) ||
                k.toLowerCase().includes(account.profile.toLowerCase())
              )?.[1];

          if (newPin) {
            await updatePin(spreadsheetId, account.sheetName, account.rowIndex, newPin);
            await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
            console.log(`  PIN "${account.profile}": ${newPin} — sheet diupdate.`);
          } else {
            console.log(`  PIN "${account.profile}": tidak ditemukan di hasil.`);
          }
        }

        totalPinChanged += group.length;

      } catch (err) {
        console.error(`  Error: ${err.message}`);
        totalFailed += group.length;
      }

      if (gi < pinEmailGroups.length - 1) {
        console.log("\n  Jeda 4 detik...");
        await sleep(4000);
      }
    }
  }

  // ── Ringkasan ───────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SELESAI dalam ${elapsed} detik`);
  console.log(`  Kick berhasil    : ${totalKicked}`);
  console.log(`  PIN diganti      : ${totalPinChanged}`);
  console.log(`  Gagal            : ${totalFailed}`);
  console.log("=".repeat(60) + "\n");
}

// ─── Run ──────────────────────────────────────────────────
if (RUN_NOW) {
  console.log("Netflix Device Kicker — Run Now\n");
  processExpiredAccounts().catch(console.error);
} else {
  console.log(`Netflix Device Kicker — Scheduler: "${CRON_SCHEDULE}"\n`);
  processExpiredAccounts().catch(console.error);
  cron.schedule(CRON_SCHEDULE, () => {
    processExpiredAccounts().catch(console.error);
  });
}
