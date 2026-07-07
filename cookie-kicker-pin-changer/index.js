"use strict";

/**
 * index.js — Cookie Kicker + PIN Changer (Server Mode)
 *
 * Berbeda dari device-kicker/index.js:
 *  - HANYA pakai cookie injection (tidak ada fallback ke login biasa)
 *  - Jika CookieExpiredError → kirim notif Telegram + skip akun tersebut
 *  - Cocok untuk dijalankan di server tanpa akses browser GUI interaktif
 */

require("dotenv").config();
const cron = require("node-cron");
const { getExpiredAccounts, markAsKicked, updatePin, findSpreadsheetId } = require("./sheets");
const { kickDevicesForProfilesCookie, CookieExpiredError } = require("./kicker-cookie");
const { changePinsForProfilesCookie } = require("./pin-changer-cookie");
const { getCookieForEmail } = require("./cookie-helper");
const { notifyKickDone, notifyPinChanged, notifyError, notifySummary, sendTelegram } = require("./notify");

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "*/15 * * * *";
const RUN_NOW = process.argv.includes("--run-now");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Notifikasi cookie expired ─────────────────────────────
async function notifyCookieExpired(email, profiles) {
  const profileList = profiles.join(", ");
  await sendTelegram(
    `🍪 *Cookie Expired — Perlu Update Manual*\n\n` +
    `📧 Akun: \`${email}\`\n` +
    `👤 Profil: ${profileList}\n\n` +
    `Cookie tidak valid atau belum ada. Akun ini di-skip.\n\n` +
    `*Cara memperbarui cookie:*\n` +
    `Di komputer lokal jalankan:\n` +
    `\`node cookie-helper.js save-interactive "${email}"\`\n` +
    `Lalu copy \`cookies.json\` terbaru ke server.`
  );
}

// -------------------------------------------------------
async function processExpiredAccounts() {
  const startTime = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[cookie-server] [${new Date().toLocaleString("id-ID")}] Mulai proses...`);
  console.log("=".repeat(60));

  // 1. Baca expired dari sheets
  let expiredList;
  try {
    expiredList = await getExpiredAccounts();
  } catch (err) {
    console.error("[cookie-server] Gagal baca spreadsheet:", err.message);
    return;
  }

  if (expiredList.length === 0) {
    console.log("[cookie-server] Tidak ada akun expired saat ini.\n");
    return;
  }

  // 2. Pisahkan: KICK (normal/MEET) vs PIN CHANGE (MAHESH/ROSE)
  const toKick = [];
  const toPin  = [];
  for (const a of expiredList) {
    if (a.isSkipped) toPin.push(a);
    else             toKick.push(a);
  }

  console.log(`\n[cookie-server] Total expired : ${expiredList.length}`);
  console.log(`[cookie-server] Kick device   : ${toKick.length}`);
  console.log(`[cookie-server] Ganti PIN     : ${toPin.length} (MAHESH/ROSE)`);

  if (toKick.length === 0 && toPin.length === 0) {
    console.log("[cookie-server] Tidak ada yang bisa diproses.\n");
    return;
  }

  // 3. Cari spreadsheet ID
  let spreadsheetId;
  try {
    spreadsheetId = await findSpreadsheetId();
  } catch (err) {
    console.error("[cookie-server] Gagal cari spreadsheet ID:", err.message);
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

    console.log(`\n[cookie-server] == KICK DEVICE (${kickGroups.length} email, ${toKick.length} profil) ==`);

    for (let gi = 0; gi < kickGroups.length; gi++) {
      const group        = kickGroups[gi];
      const email        = group[0].email;
      const accountLabel = group[0].blockLabel ?? "";
      const profiles     = group.map(a => a.profile);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[cookie-server] [${gi + 1}/${kickGroups.length}] ${email}`);
      console.log(`  Profil : ${profiles.join(", ")}`);
      console.log(`  Mode   : 🍪 Cookie injection`);
      console.log("─".repeat(60));

      // Cek cookie tersedia sebelum proses
      if (!getCookieForEmail(email)) {
        console.warn(`[cookie-server]   Cookie tidak ada untuk ${email} — skip.`);
        await notifyCookieExpired(email, profiles);
        totalFailed += group.length;
        continue;
      }

      const t0 = Date.now();
      try {
        const result = await kickDevicesForProfilesCookie(email, profiles);

        if (result.skipped) {
          console.log(`[cookie-server]   Skip: ${result.reason}`);
          totalFailed += group.length;
          continue;
        }

        for (const account of group) {
          await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[cookie-server]   Berhasil: ${result.kicked} device dikick dalam ${elapsed}s`);
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
        if (err instanceof CookieExpiredError || err.name === "CookieExpiredError") {
          // Cookie expired → kirim notif + skip, TIDAK crash
          console.warn(`[cookie-server]   Cookie expired untuk ${email} — skip.`);
          await notifyCookieExpired(email, profiles);
          totalFailed += group.length;
        } else {
          console.error(`[cookie-server]   Error: ${err.message}`);
          totalFailed += group.length;
          await notifyError(email, profiles, err.message);
        }
      }

      if (gi < kickGroups.length - 1) {
        console.log("[cookie-server]   Jeda 4 detik...");
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

    console.log(`\n[cookie-server] == GANTI PIN (${pinEmailGroups.length} email, ${toPin.length} profil) ==`);

    for (let gi = 0; gi < pinEmailGroups.length; gi++) {
      const group      = pinEmailGroups[gi];
      const email      = group[0].email;
      const password   = group[0].password;
      const blockLabel = group[0].blockLabel;
      const profiles   = group.map(a => a.profile);

      console.log(`\n${"─".repeat(60)}`);
      console.log(`[cookie-server] [${gi + 1}/${pinEmailGroups.length}] ${email} [${blockLabel}]`);
      console.log(`  Profil : ${profiles.join(", ")}`);
      console.log(`  Mode   : 🍪 Cookie injection`);
      console.log("─".repeat(60));

      // Cek cookie tersedia sebelum proses
      if (!getCookieForEmail(email)) {
        console.warn(`[cookie-server]   Cookie tidak ada untuk ${email} — skip.`);
        await notifyCookieExpired(email, profiles);
        totalFailed += group.length;
        continue;
      }

      const t0 = Date.now();
      try {
        const pinChanges = await changePinsForProfilesCookie(email, password, profiles);
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
            console.log(`[cookie-server]   PIN "${account.profile}": ${newPin} — sheet diupdate.`);
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
        if (err instanceof CookieExpiredError || err.name === "CookieExpiredError") {
          // Cookie expired → kirim notif + skip, TIDAK crash
          console.warn(`[cookie-server]   Cookie expired untuk ${email} — skip.`);
          await notifyCookieExpired(email, profiles);
          totalFailed += group.length;
        } else {
          console.error(`[cookie-server]   Error: ${err.message}`);
          totalFailed += group.length;
          await notifyError(email, profiles, err.message);
        }
      }

      if (gi < pinEmailGroups.length - 1) {
        console.log("[cookie-server]   Jeda 4 detik...");
        await sleep(4000);
      }
    }
  }

  // ── Ringkasan ───────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[cookie-server] SELESAI dalam ${elapsed}s`);
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
  console.log("[cookie-server] Netflix Cookie Kicker — Run Now\n");
  processExpiredAccounts().catch(console.error);
} else {
  console.log(`[cookie-server] Netflix Cookie Kicker — Scheduler: "${CRON_SCHEDULE}"\n`);
  processExpiredAccounts().catch(console.error);
  cron.schedule(CRON_SCHEDULE, () => {
    processExpiredAccounts().catch(console.error);
  });
}
