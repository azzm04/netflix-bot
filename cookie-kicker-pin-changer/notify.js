// Menggunakan Telegram Bot API via HTTPS request (tanpa library tambahan)


"use strict";

require("dotenv").config();
const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = process.env.ADMIN_ID;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.warn("[notify] BOT_TOKEN atau ADMIN_ID tidak diset di .env — notifikasi dinonaktifkan.");
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !ADMIN_ID) return;

  const body = JSON.stringify({
    chat_id: ADMIN_ID,
    text,
    parse_mode: "Markdown",
    disable_notification: false,
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", (err) => {
      console.warn("[notify] Gagal kirim Telegram:", err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function notifyKickDone(info) {
  const { email, profiles, kicked, sheetUpdated, elapsed, blockLabel, rows } = info;

  const profileList = rows.map(r =>
    `  • *${r.profile}* — [${r.sheetName}] baris ${r.rowIndex} _(${r.logoutText})_`
  ).join("\n");

  const status = kicked > 0
    ? `✅ ${kicked} device berhasil dikick`
    : "💤 Tidak ada device aktif — semua aman";
  const label = blockLabel ? `[${blockLabel}] ` : "";

  const msg =
    `🔓 *Kick Device Selesai*\n\n` +
    `📧 Akun   : \`${label}${email}\`\n` +
    `📋 Profil diproses:\n${profileList}\n\n` +
    `${status}\n` +
    `📝 Sheet  : ${sheetUpdated ? "diupdate (kosong + hijau)" : "tidak diupdate"}\n` +
    `⏱ Durasi : ${elapsed}s`;

  await sendTelegram(msg);
}

async function notifyPinChanged(info) {
  const { email, blockLabel, pinChanges, sheetUpdated, elapsed, rows } = info;

  if (pinChanges.size === 0) {
    await sendTelegram(
      `🔒 *Ganti PIN — Tidak Ada yang Berubah*\n\n` +
      `📧 Akun: \`[${blockLabel}] ${email}\`\n` +
      `Profil tidak ditemukan atau PIN gagal disimpan.`
    );
    return;
  }

  const pinList = rows.map(r => {
    const newPin = pinChanges.get(r.profile)
      ?? [...pinChanges.entries()].find(([k]) =>
          r.profile.toLowerCase().includes(k.toLowerCase()) ||
          k.toLowerCase().includes(r.profile.toLowerCase())
        )?.[1]
      ?? "?";
    return `  • *${r.profile}*: PIN baru \`${newPin}\` — [${r.sheetName}] baris ${r.rowIndex}`;
  }).join("\n");

  const msg =
    `🔑 *Ganti PIN Selesai*\n\n` +
    `📧 Akun   : \`[${blockLabel}] ${email}\`\n` +
    `🔢 Diubah : *${pinChanges.size}* profil\n\n` +
    `${pinList}\n\n` +
    `📝 Sheet  : ${sheetUpdated ? "diupdate (PIN baru + kosong + hijau)" : "tidak diupdate"}\n` +
    `⏱ Durasi : ${elapsed}s`;

  await sendTelegram(msg);
}

// Notifikasi error saat proses.
async function notifyError(email, profileNames, errorMessage) {
  const msg =
    `❌ *Proses Akun Gagal*\n\n` +
    `📧 Akun   : \`${email}\`\n` +
    `👤 Profil : ${profileNames.join(", ")}\n\n` +
    `Penyebab:\n\`${errorMessage.substring(0, 300)}\``;

  await sendTelegram(msg);
}

// Notifikasi ringkasan akhir setelah semua akun selesai diproses.
async function notifySummary({ totalKick, totalPin, totalFailed, elapsed }) {
  if (totalKick === 0 && totalPin === 0 && totalFailed === 0) return;

  const msg =
    `📊 *Ringkasan Proses Hari Ini*\n\n` +
    `🔓 Kick device : *${totalKick}* profil\n` +
    `🔑 Ganti PIN   : *${totalPin}* profil\n` +
    `❌ Gagal       : *${totalFailed}* profil\n` +
    `⏱ Total waktu : ${elapsed}s`;

  await sendTelegram(msg);
}

module.exports = { sendTelegram, notifyKickDone, notifyPinChanged, notifyError, notifySummary };
