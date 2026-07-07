"use strict";

/**
 * index.js — Cookie Kicker + PIN Changer (Server Mode)
 *
 * - HANYA pakai cookie injection (tidak ada fallback ke login biasa)
 * - Jika CookieExpiredError → kirim notif Telegram + skip akun
 * - Lock agar tidak ada dua proses berjalan bersamaan
 */

require("dotenv").config();
const cron = require("node-cron");
const { getExpiredAccounts, markAsKicked, updatePin, findSpreadsheetId } = require("./sheets");
const { kickDevicesForProfilesCookie, CookieExpiredError } = require("./kicker-cookie");
const { changePinsForProfilesCookie } = require("./pin-changer-cookie");
const { getCookieForEmail } = require("./cookie-helper");
const { notifyKickDone, notifyPinChanged, notifyError, notifySummary, sendTelegram } = require("./notify");

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? "*/15 * * * *";
const RUN_NOW       = process.argv.includes("--run-now");
const sleep         = (ms) => new Promise((r) => setTimeout(r, ms));

// Lock agar tidak overlap antar cron tick
let _isRunning = false;

// ── Notifikasi cookie expired ─────────────────────────────
async function notifyCookieExpired(email, profiles) {
  await sendTelegram(
    `🍪 *Cookie Expired — Perlu Update Manual*\n\n` +
    `📧 Akun: \`${email}\`\n` +
    `👤 Profil: ${profiles.join(", ")}\n\n` +
    `Jalankan di lokal:\n` +
    `\`node cookie-helper.js save-interactive "${email}"\`\n` +
    `Lalu copy \`cookies.json\` ke server.`
  );
}

// ── Main ──────────────────────────────────────────────────
async function processExpiredAccounts() {
  if (_isRunning) {
    console.log("[cookie-server] Proses sebelumnya masih berjalan — skip.");
    return;
  }
  _isRunning = true;

  const startTime = Date.now();
  let totalKicked = 0, totalPinChanged = 0, totalFailed = 0;

  try {
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
      console.log("[cookie-server] Tidak ada akun expired.\n");
      return;
    }

    // 2. Pisahkan KICK vs PIN CHANGE
    // - MAHESH/ROSE (isSkipped=true)  → hanya ganti PIN
    // - MEET (isMeet=true)            → kick device LALU ganti PIN
    // - Normal                        → hanya kick device
    const toKick    = expiredList.filter(a => !a.isSkipped);           // semua kecuali MAHESH/ROSE
    const toPin     = expiredList.filter(a => a.isSkipped);            // MAHESH/ROSE
    const toPinMeet = expiredList.filter(a => !a.isSkipped && a.isMeet); // MEET: kick dulu, PIN setelahnya

    console.log(`\n[cookie-server] Total expired : ${expiredList.length}`);
    console.log(`[cookie-server] Kick device   : ${toKick.length}`);
    console.log(`[cookie-server] Ganti PIN     : ${toPin.length} (MAHESH/ROSE) + ${toPinMeet.length} (MEET setelah kick)`);

    if (toKick.length === 0 && toPin.length === 0) return;

    // 3. Spreadsheet ID
    let spreadsheetId;
    try {
      spreadsheetId = await findSpreadsheetId();
    } catch (err) {
      console.error("[cookie-server] Gagal cari spreadsheet ID:", err.message);
      return;
    }

    // ── SECTION A: KICK DEVICE ────────────────────────────
    if (toKick.length > 0) {
      // Grup per email
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
        console.log("─".repeat(60));

        if (!getCookieForEmail(email)) {
          console.warn(`[cookie-server]   ⚠ Cookie tidak ada — skip.`);
          await notifyCookieExpired(email, profiles);
          totalFailed += group.length;
          continue;
        }

        const t0 = Date.now();
        try {
          const result  = await kickDevicesForProfilesCookie(email, profiles, accountLabel === "MAHESH");
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

          for (const account of group) {
            await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
          }

          console.log(`[cookie-server]   ✓ ${result.kicked} dikick (${elapsed}s)`);
          totalKicked += group.length;

          await notifyKickDone({
            email, profiles,
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
            console.warn(`[cookie-server]   ✗ Cookie expired — skip.`);
            await notifyCookieExpired(email, profiles);
          } else {
            console.error(`[cookie-server]   ✗ Error: ${err.message}`);
            await notifyError(email, profiles, err.message);
          }
          totalFailed += group.length;
        }

        if (gi < kickGroups.length - 1) await sleep(4000);
      }
    }

    // ── SECTION C: GANTI PIN AKUN MEET (setelah kick) ───────
    // Gabungkan toPinMeet dengan toPin — pakai antrian yang sama
    const toPinAll = [...toPin, ...toPinMeet];

    if (toPinAll.length > 0) {
      const pinGroups = new Map();
      for (const a of toPinAll) {
        const key = a.email.toLowerCase();
        if (!pinGroups.has(key)) pinGroups.set(key, []);
        pinGroups.get(key).push(a);
      }
      const pinEmailGroups = [...pinGroups.values()];

      console.log(`\n[cookie-server] == GANTI PIN (${pinEmailGroups.length} email, ${toPinAll.length} profil) ==`);

      for (let gi = 0; gi < pinEmailGroups.length; gi++) {
        const group      = pinEmailGroups[gi];
        const email      = group[0].email;
        const password   = group[0].password;
        const blockLabel = group[0].blockLabel;
        const profiles   = group.map(a => a.profile);

        console.log(`\n${"─".repeat(60)}`);
        console.log(`[cookie-server] [${gi + 1}/${pinEmailGroups.length}] ${email} [${blockLabel}]`);
        console.log(`  Profil : ${profiles.join(", ")}`);
        console.log("─".repeat(60));

        if (!getCookieForEmail(email)) {
          console.warn(`[cookie-server]   ⚠ Cookie tidak ada — skip.`);
          await notifyCookieExpired(email, profiles);
          totalFailed += group.length;
          continue;
        }

        const t0 = Date.now();
        try {
          const pinChanges = await changePinsForProfilesCookie(email, password, profiles);
          const elapsed    = ((Date.now() - t0) / 1000).toFixed(1);

          // Update spreadsheet dengan PIN yang baru-baru ini di-return
          for (const account of group) {
            let newPin = null;
            for (const [profName, pin] of pinChanges.entries()) {
              if (
                account.profile.toLowerCase().includes(profName.toLowerCase()) ||
                profName.toLowerCase().includes(account.profile.toLowerCase())
              ) {
                newPin = pin;
                break;
              }
            }

            if (newPin) {
              await updatePin(spreadsheetId, account.sheetName, account.rowIndex, newPin);
              await markAsKicked(spreadsheetId, account.sheetName, account.rowIndex);
              console.log(`[cookie-server]   ✓ PIN "${account.profile}" → ${newPin}`);
            } else {
              console.warn(`[cookie-server]   ⚠ PIN tidak ditemukan untuk "${account.profile}"`);
            }
          }

          totalPinChanged += group.length;

          await notifyPinChanged({
            email, blockLabel, pinChanges,
            sheetUpdated: true, elapsed,
            rows: group.map(a => ({
              profile: a.profile,
              sheetName: a.sheetName,
              rowIndex: a.rowIndex,
            })),
          });

        } catch (err) {
          if (err instanceof CookieExpiredError || err.name === "CookieExpiredError") {
            console.warn(`[cookie-server]   ✗ Cookie expired — skip.`);
            await notifyCookieExpired(email, profiles);
          } else {
            console.error(`[cookie-server]   ✗ Error: ${err.message}`);
            await notifyError(email, profiles, err.message);
          }
          totalFailed += group.length;
        }

        if (gi < pinEmailGroups.length - 1) await sleep(4000);
      }
    }

    // ── Ringkasan ─────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[cookie-server] SELESAI dalam ${elapsed}s`);
    console.log(`  Kick : ${totalKicked} | PIN : ${totalPinChanged} | Gagal : ${totalFailed}`);
    console.log("=".repeat(60) + "\n");

    await notifySummary({ totalKick: totalKicked, totalPin: totalPinChanged, totalFailed, elapsed });

  } catch (fatalErr) {
    console.error("[cookie-server] Fatal error:", fatalErr.message);
  } finally {
    _isRunning = false;
  }
}

// ─── Run ──────────────────────────────────────────────────
if (RUN_NOW) {
  console.log("[cookie-server] Run Now\n");
  processExpiredAccounts().catch(console.error);
} else {
  console.log(`[cookie-server] Scheduler: "${CRON_SCHEDULE}"\n`);
  processExpiredAccounts().catch(console.error);
  cron.schedule(CRON_SCHEDULE, () => {
    processExpiredAccounts().catch(console.error);
  });
}
