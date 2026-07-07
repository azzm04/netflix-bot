/**
 * index.js — Smart Device Guard Scheduler
 *
 * Jalankan 2x sehari (jam 08:00 dan 20:00).
 * Cek semua akun MEET dan pastikan device sesuai rules spreadsheet kolom G.
 *
 * PM2: pm2 start index.js --name "netflix-device-guard"
 */

"use strict";

require("dotenv").config();
const cron  = require("node-cron");
const https = require("https");
const { getMeetAccounts } = require("./sheets-guard");
const { guardAccount }    = require("./guard");

// Jam 08:00 dan 20:00 setiap hari
const GUARD_SCHEDULE = process.env.GUARD_SCHEDULE ?? "0 8,20 * * *";
const RUN_NOW        = process.argv.includes("--run-now");
const sleep          = (ms) => new Promise(r => setTimeout(r, ms));

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const ADMIN_ID  = process.env.ADMIN_ID  ?? "";

// ── Kirim notifikasi Telegram ─────────────────────────────
function sendTelegram(text) {
  if (!BOT_TOKEN || !ADMIN_ID) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: ADMIN_ID, text, parse_mode: "Markdown", disable_notification: false });
    const req  = https.request(
      { hostname: "api.telegram.org", path: `/bot${BOT_TOKEN}/sendMessage`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

// ── Lock ──────────────────────────────────────────────────
let _isRunning = false;

// ── Main ──────────────────────────────────────────────────
async function runGuard() {
  if (_isRunning) {
    console.log("[guard] Proses sebelumnya masih berjalan — skip.");
    return;
  }
  _isRunning = true;

  const startTime  = Date.now();
  let totalKicked  = 0;
  let totalFailed  = 0;
  const kickDetails = [];

  try {
    console.log(`\n${"=".repeat(55)}`);
    console.log(`[guard] [${new Date().toLocaleString("id-ID")}] Device Guard mulai...`);
    console.log("=".repeat(55));

    // 1. Baca semua akun MEET dari spreadsheet
    let meetAccounts;
    try {
      meetAccounts = await getMeetAccounts();
    } catch (err) {
      console.error("[guard] Gagal baca spreadsheet:", err.message);
      return;
    }

    if (meetAccounts.length === 0) {
      console.log("[guard] Tidak ada akun MEET ditemukan.\n");
      return;
    }

    console.log(`[guard] ${meetAccounts.length} email MEET ditemukan.\n`);

    // 2. Proses tiap email
    for (let i = 0; i < meetAccounts.length; i++) {
      const { email, profiles } = meetAccounts[i];

      console.log(`\n${"─".repeat(55)}`);
      console.log(`[guard] [${i + 1}/${meetAccounts.length}] ${email}`);
      console.log(`  Profil: ${profiles.map(p => `${p.name}${p.allowedDevice ? ` (${p.allowedDevice})` : " (kosong)"}`).join(", ")}`);
      console.log("─".repeat(55));

      try {
        const result = await guardAccount(email, profiles);
        totalKicked += result.kicked;
        if (result.kicked > 0) {
          kickDetails.push({ email, details: result.details });
          console.log(`  ✓ ${result.kicked} device dikick`);
        } else {
          console.log(`  ✓ Semua device sesuai rules`);
        }
      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
        totalFailed++;
      }

      if (i < meetAccounts.length - 1) await sleep(3000);
    }

    // 3. Ringkasan
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${"=".repeat(55)}`);
    console.log(`[guard] SELESAI dalam ${elapsed}s`);
    console.log(`  Dikick : ${totalKicked} device`);
    console.log(`  Gagal  : ${totalFailed} akun`);
    console.log("=".repeat(55) + "\n");

    // 4. Notifikasi Telegram — hanya jika ada yang dikick atau gagal
    if (totalKicked > 0 || totalFailed > 0) {
      let teks = `🛡️ *Device Guard — Selesai*\n\n`;
      teks += `📅 ${new Date().toLocaleString("id-ID")}\n`;
      teks += `⏱ Waktu: ${elapsed}s\n\n`;

      if (totalKicked > 0) {
        teks += `🔓 *Device dikick: ${totalKicked}*\n`;
        for (const { email, details } of kickDetails) {
          teks += `\n📧 \`${email}\`\n`;
          details.forEach(d => { teks += `  • ${d}\n`; });
        }
      }

      if (totalFailed > 0) {
        teks += `\n❌ Gagal: ${totalFailed} akun`;
      }

      await sendTelegram(teks);
    }

  } catch (fatalErr) {
    console.error("[guard] Fatal error:", fatalErr.message);
  } finally {
    _isRunning = false;
  }
}

// ── Run ───────────────────────────────────────────────────
if (RUN_NOW) {
  console.log("[guard] Device Guard — Run Now\n");
  runGuard().catch(console.error);
} else {
  console.log(`[guard] Device Guard — Scheduler: "${GUARD_SCHEDULE}"\n`);
  console.log(`[guard] Jadwal: jam 08:00 dan 20:00 setiap hari\n`);
  runGuard().catch(console.error); // jalankan sekali saat startup
  cron.schedule(GUARD_SCHEDULE, () => {
    runGuard().catch(console.error);
  });
}
