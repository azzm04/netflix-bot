"use strict";

require("dotenv").config();
const cron = require("node-cron");
const { getExpiredAccounts, markAsKicked, updatePin, findSpreadsheetId } = require("./sheets");
const { kickDevicesForProfiles, isPakeKode } = require("./kicker");
const { changePinsForProfiles } = require("./pin-changer");
const { notifyKickDone, notifyPinChanged, notifyError, notifySummary } = require("./notify");

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

  // 2. Pisahkan: KICK (normal/MEET) vs PIN CHANGE (MAHESH/ROSE)
  const toKick = [];
  const toPin  = [];
  for (const a of expiredList) {
    if (a.isSkipped) toPin.push(a);
    else             toKick.push(a);
  }

  console.log(`\nTotal expired : ${expiredList.length}`);
  console.log(`Kick device   : ${toKick.length}`);
  console.log(`Ganti PIN     : ${toPin.length} (MAHESH/ROSE)`);

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
    const emailGroups = new Map();
    for (const a of toKick) {
      const key = a.email.toLowerCase();
      if (!emailGroups.has(key)) emailGroups.set(key, []);
      emailGroups.get(key).push(a);
    }
    const kickGroups = [...emailGroups.values()];

    console.log(`\n== KICK DEVICE (${kickGroups.length} email, ${toKick.length} profil) ==`);

    for (let gi = 0; gi < kickGroups.length; gi++) {
      const group       = kickGroups[gi];
      const email       = group[0].email;
      const password    = group[0].password;
      const isMeet      = group[0].isMeet ?? false;
      const accountLabel = group[0].blockLabel ?? "";
      const profiles    = group.map(a => a.profile);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[${gi + 1}/${kickGroups.length}] ${email}`);
      console.log(`  Profil : ${profiles.join(", ")}`);
      console.log(`  Tipe   : ${isMeet ? "MEET (auto 4-digit)" : isPakeKode(password) ? "PAKE KODE" : "Password"}`);
      console.log("─".repeat(60));

      const t0 = Date.now();
      try {
        const result = await kickDevicesForProfiles(email, password, profiles, isMeet, accountLabel);

        if (result.skipped) {
          console.log(`  Skip: ${result.reason}`);
          totalFailed += group.length;
          continue;
        }

        for (const account of group) {
          await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  Berhasil: ${result.kicked} device dikick dalam ${elapsed}s`);
        totalKicked += group.length;

        // Notifikasi Telegram
        await notifyKickDone({
          email,
          profiles,
          kicked: result.kicked,
          sheetUpdated: true,
          elapsed,
          blockLabel: accountLabel,
          rows: group.map(a => ({
            profile: a.profile,
            sheetName: a.sheetName,
            rowIndex: a.rowIndex,
            logoutText: a.logoutText,
          })),
        });

      } catch (err) {
        console.error(`  Error: ${err.message}`);
        totalFailed += group.length;
        await notifyError(email, profiles, err.message);
      }

      if (gi < kickGroups.length - 1) {
        console.log("  Jeda 4 detik...");
        await sleep(4000);
      }
    }
  }

  // ── SECTION B: GANTI PIN (MAHESH/ROSE) ─────────────────
  if (toPin.length > 0) {
    const pinGroups = new Map();
    for (const a of toPin) {
      const key = a.email.toLowerCase();
      if (!pinGroups.has(key)) pinGroups.set(key, []);
      pinGroups.get(key).push(a);
    }
    const pinEmailGroups = [...pinGroups.values()];

    console.log(`\n== GANTI PIN (${pinEmailGroups.length} email, ${toPin.length} profil) ==`);

    for (let gi = 0; gi < pinEmailGroups.length; gi++) {
      const group       = pinEmailGroups[gi];
      const email       = group[0].email;
      const password    = group[0].password;
      const blockLabel  = group[0].blockLabel;
      const accountType = blockLabel === "ROSE" ? "rose" : "mahesh";
      const profiles    = group.map(a => a.profile);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[${gi + 1}/${pinEmailGroups.length}] ${email} [${blockLabel}]`);
      console.log(`  Profil : ${profiles.join(", ")}`);
      console.log("─".repeat(60));

      const t0 = Date.now();
      try {
        const pinChanges = await changePinsForProfiles(email, password, accountType, profiles);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        // Update spreadsheet: PIN baru + kosongkan E/F/G + hijau
        for (const account of group) {
          const newPin = pinChanges.get(account.profile)
            ?? [...pinChanges.entries()].find(([k]) =>
                account.profile.toLowerCase().includes(k.toLowerCase()) ||
                k.toLowerCase().includes(account.profile.toLowerCase())
              )?.[1];

          if (newPin) {
            await updatePin(spreadsheetId, account.sheetName, account.rowIndex, newPin);
            await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
            console.log(`  PIN "${account.profile}": ${newPin} — sheet diupdate.`);
          }
        }

        totalPinChanged += group.length;

        // Notifikasi Telegram
        await notifyPinChanged({
          email,
          blockLabel,
          pinChanges,
          sheetUpdated: true,
          elapsed,
          rows: group.map(a => ({
            profile: a.profile,
            sheetName: a.sheetName,
            rowIndex: a.rowIndex,
          })),
        });

      } catch (err) {
        console.error(`  Error: ${err.message}`);
        totalFailed += group.length;
        await notifyError(email, profiles, err.message);
      }

      if (gi < pinEmailGroups.length - 1) {
        console.log("  Jeda 4 detik...");
        await sleep(4000);
      }
    }
  }

  // ── Ringkasan ───────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SELESAI dalam ${elapsed}s`);
  console.log(`  Kick    : ${totalKicked}`);
  console.log(`  PIN     : ${totalPinChanged}`);
  console.log(`  Gagal   : ${totalFailed}`);
  console.log("=".repeat(60) + "\n");

  // Notifikasi ringkasan
  await notifySummary({
    totalKick: totalKicked,
    totalPin: totalPinChanged,
    totalFailed,
    elapsed,
  });
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
