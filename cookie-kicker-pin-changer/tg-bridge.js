/**
 * tg-bridge.js — Komunikasi antara Node.js dan Telegram bot Python
 *
 * Mekanisme via file (simple, tidak perlu port/socket):
 *
 *   Node.js                         Python bot
 *   ──────────                      ──────────
 *   Tulis request.json         →    Baca request.json
 *                                   Kirim pesan ke Telegram admin
 *                                   Tunggu reply dari admin
 *                                   Tulis response.json
 *   Baca response.json         ←
 *   Hapus kedua file
 *
 * Format request.json:
 *   { "id": "unique-id", "email": "user@example.com", "type": "4digit" | "6digit" }
 *
 * Format response.json:
 *   { "id": "unique-id", "code": "1234" }
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// Lokasi file bridge (di /tmp agar mudah diakses Python juga)
const BRIDGE_DIR      = process.env.BRIDGE_DIR ?? os.tmpdir();
const REQUEST_FILE    = path.join(BRIDGE_DIR, "netflix_code_request.json");
const RESPONSE_FILE   = path.join(BRIDGE_DIR, "netflix_code_response.json");

// Timeout tunggu balasan dari Telegram (ms) — default 5 menit
const TELEGRAM_TIMEOUT = parseInt(process.env.TELEGRAM_CODE_TIMEOUT ?? "300000");
const POLL_INTERVAL    = 2000; // cek response setiap 2 detik

/**
 * Minta kode OTP dari admin via Telegram bot.
 * Node.js tulis request → Python bot kirim pesan → admin balas → Python tulis response → Node.js baca.
 *
 * @param {string} email     - email akun Netflix yang butuh kode
 * @param {"4digit"|"6digit"} codeType
 * @param {"MAHESH"|"ROSE"|""} accountLabel - untuk info ke admin
 * @returns {Promise<string>}  kode yang dibalas admin
 */
async function requestCodeFromTelegram(email, codeType, accountLabel = "") {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Hapus response lama jika ada
  try { fs.unlinkSync(RESPONSE_FILE); } catch {}

  // Tulis request
  const requestData = {
    id: requestId,
    email,
    type: codeType,
    label: accountLabel,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(requestData, null, 2), "utf8");
  console.log(`  [tg-bridge] Request ditulis: ${email} (${codeType}) — menunggu reply Telegram...`);

  // Poll response file
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      // Timeout
      if (Date.now() - startTime > TELEGRAM_TIMEOUT) {
        clearInterval(timer);
        try { fs.unlinkSync(REQUEST_FILE); } catch {}
        reject(new Error(`Timeout: tidak ada reply dari Telegram dalam ${TELEGRAM_TIMEOUT / 60000} menit.`));
        return;
      }

      // Cek response file
      if (!fs.existsSync(RESPONSE_FILE)) return;

      try {
        const raw = fs.readFileSync(RESPONSE_FILE, "utf8");
        const data = JSON.parse(raw);

        // Pastikan response untuk request yang sama
        if (data.id !== requestId) return;

        clearInterval(timer);
        // Cleanup files
        try { fs.unlinkSync(REQUEST_FILE); } catch {}
        try { fs.unlinkSync(RESPONSE_FILE); } catch {}

        const code = String(data.code ?? "").trim().replace(/\D/g, "");
        if (!code) {
          reject(new Error("Kode dari Telegram kosong atau tidak valid."));
          return;
        }

        console.log(`  [tg-bridge] Kode diterima: ${code}`);
        resolve(code);
      } catch {
        // File belum selesai ditulis, coba lagi
      }
    }, POLL_INTERVAL);
  });
}

module.exports = { requestCodeFromTelegram };
