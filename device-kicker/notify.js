/**
 * notify.js — Kirim notifikasi ke Telegram langsung dari Node.js
 * Menggunakan Telegram Bot API via HTTPS request (tanpa library tambahan)
 */

"use strict";

require("dotenv").config();
const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = process.env.ADMIN_ID;

if (!BOT_TOKEN || !ADMIN_ID) {
  console.warn("[notify] BOT_TOKEN atau ADMIN_ID tidak diset di .env — notifikasi dinonaktifkan.");
}

/**
 * Kirim pesan Telegram ke ADMIN_ID.
 * @param {string} text  - pesan dalam format Markdown
 * @returns {Promise<void>}
 */
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

/**
 * Notifikasi hasil kick device (akun MEET / normal).
 *
 * @param {{
 *   email: string,
 *   profiles: string[],
 *   kicked: number,
 *   sheetUpdated: boolean,
 *   elapsed: number,
 *   blockLabel: string,
 *   rows: Array<{profile: string, sheetName: string, rowIndex: number, logoutText: string}>
 * }} info
 */
async function notifyKickDone(info) {
  const { email, profiles, kicked, sheetUpdated, elapsed, blockLabel, rows } = info;

  const profileList = rows.map(r =>
    `  • *${r.profile}* — [${r.sheetName}] baris ${r.rowIndex} _(${r.logoutText})_`
  ).join("\n");

  const status = kicked > 0 ? "✅ Berhasil dikick" : "ℹ️ Tidak ada device aktif";
  const label  = blockLabel ? `[${blockLabel}] ` : "";

  const msg =
    `🔓 *Device Kicker — Selesai*\n\n` +
    `📧 Akun: \`${label}${email}\`\n` +
    `🔢 Device dikick: *${kicked}*\n` +
    `📋 Profil diproses:\n${profileList}\n\n` +
    `${status}\n` +
    `📝 Sheet: ${sheetUpdated ? "diupdate (kosong + hijau)" : "tidak diupdate"}\n` +
    `⏱ Waktu: ${elapsed}s`;

  await sendTelegram(msg);
}

/**
 * Notifikasi hasil ganti PIN (akun MAHESH/ROSE).
 *
 * @param {{
 *   email: string,
 *   blockLabel: string,
 *   pinChanges: Map<string, string>,   // profileName → newPin
 *   sheetUpdated: boolean,
 *   elapsed: number,
 *   rows: Array<{profile: string, sheetName: string, rowIndex: number}>
 * }} info
 */
async function notifyPinChanged(info) {
  const { email, blockLabel, pinChanges, sheetUpdated, elapsed, rows } = info;

  if (pinChanges.size === 0) {
    await sendTelegram(
      `⚠️ *PIN Change — Tidak Ada Perubahan*\n\n` +
      `📧 Akun: \`[${blockLabel}] ${email}\`\n` +
      `Profil tidak ditemukan atau PIN tidak berhasil diganti.`
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
    `🔑 *PIN Change — Berhasil*\n\n` +
    `📧 Akun: \`[${blockLabel}] ${email}\`\n` +
    `🔢 Profil diubah: *${pinChanges.size}*\n\n` +
    `${pinList}\n\n` +
    `📝 Sheet: ${sheetUpdated ? "diupdate (PIN baru + kosong + hijau)" : "tidak diupdate"}\n` +
    `⏱ Waktu: ${elapsed}s`;

  await sendTelegram(msg);
}

/**
 * Notifikasi error saat proses.
 */
async function notifyError(email, profileNames, errorMessage) {
  const msg =
    `❌ *Device Kicker — Error*\n\n` +
    `📧 Akun: \`${email}\`\n` +
    `👤 Profil: ${profileNames.join(", ")}\n\n` +
    `Error: \`${errorMessage.substring(0, 300)}\``;

  await sendTelegram(msg);
}

/**
 * Notifikasi ringkasan akhir setelah semua akun selesai diproses.
 */
async function notifySummary({ totalKick, totalPin, totalFailed, elapsed }) {
  if (totalKick === 0 && totalPin === 0 && totalFailed === 0) return;

  const msg =
    `📊 *Device Kicker — Ringkasan*\n\n` +
    `✅ Kick device : *${totalKick}* profil\n` +
    `🔑 Ganti PIN   : *${totalPin}* profil\n` +
    `❌ Gagal       : *${totalFailed}* profil\n` +
    `⏱ Total waktu : ${elapsed}s`;

  await sendTelegram(msg);
}

module.exports = { sendTelegram, notifyKickDone, notifyPinChanged, notifyError, notifySummary };
