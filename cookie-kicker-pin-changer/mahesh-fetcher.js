/**
 * mahesh-fetcher.js — Fetch kode Netflix dari @Maheshshoppiebot di Telegram
 *
 * SETUP AWAL (sekali saja, lakukan di lokal bukan server):
 *   node mahesh-fetcher.js --setup
 *
 * TEST fetch kode:
 *   node mahesh-fetcher.js "jack01@maheshpro.com" "signin"
 *   node mahesh-fetcher.js "jack01@maheshpro.com" "signin6"
 *
 * MAPPING tipe kode ke tombol bot Mahesh:
 *   signin    → "Sign-in Code"              (4 digit, untuk login)
 *   signin6   → "Verification code after login" (6 digit, untuk MFA)
 *   verify    → "Verify Email"
 *   household → "Household Code"
 *
 * Setelah setup, file mahesh.session akan tersimpan.
 * Copy file itu ke server bersama .env yang sudah diisi.
 */

"use strict";

require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const { NewMessage }     = require("telegram/events");
const readline           = require("readline");
const fs                 = require("fs");
const path               = require("path");

// ── Config dari .env ──────────────────────────────────────
const API_ID       = parseInt(process.env.MAHESH_API_ID   ?? "0");
const API_HASH     = process.env.MAHESH_API_HASH           ?? "";
const PHONE        = process.env.MAHESH_PHONE              ?? "";
const SESSION_FILE = path.resolve(__dirname, process.env.MAHESH_SESSION_FILE ?? "mahesh.session");
const BOT_USERNAME = process.env.MAHESH_BOT_USERNAME       ?? "Maheshshoppiebot";
const TIMEOUT_MS   = parseInt(process.env.MAHESH_TIMEOUT   ?? "30000");

// ── Mapping tipe → label tombol bot Mahesh ────────────────
const BUTTON_MAP = {
  signin:    "Sign-in Code",
  signin6:   "Verification code after login",
  verify:    "Verify Email",
  household: "Household Code",
  reset:     "Reset Password",
  tvlogin:   "TV Login Link",
  vercode:   "Verification Code",
};

// ── Load / Save session ───────────────────────────────────
function loadSession() {
  if (fs.existsSync(SESSION_FILE)) {
    return fs.readFileSync(SESSION_FILE, "utf-8").trim();
  }
  return "";
}

function saveSession(sessionStr) {
  fs.writeFileSync(SESSION_FILE, sessionStr, "utf-8");
  console.log(`[mahesh] Session tersimpan: ${SESSION_FILE}`);
}

// ── Buat client ───────────────────────────────────────────
function createClient(sessionStr = "") {
  if (!API_ID || !API_HASH) {
    throw new Error(
      "MAHESH_API_ID dan MAHESH_API_HASH belum diset di .env\n" +
      "Daftar di: https://my.telegram.org → API development tools"
    );
  }
  return new TelegramClient(
    new StringSession(sessionStr),
    API_ID,
    API_HASH,
    { connectionRetries: 3 }
  );
}

// ── Input terminal helper ─────────────────────────────────
function input(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); });
  });
}

// ── Setup: login pertama kali ─────────────────────────────
async function setupSession() {
  console.log("\n=== Setup Session Telegram ===");
  console.log("Ini hanya perlu dilakukan SEKALI.\n");

  if (!PHONE) {
    console.error("Set MAHESH_PHONE di .env dulu (format: +628xxx)");
    process.exit(1);
  }

  const client = createClient("");
  await client.start({
    phoneNumber:  async () => PHONE,
    password:     async () => input("Password 2FA (kosongkan jika tidak ada): "),
    phoneCode:    async () => input("Kode OTP yang masuk ke Telegram kamu: "),
    onError:      (err)   => console.error("[mahesh] Auth error:", err.message),
  });

  const sessionStr = client.session.save();
  saveSession(sessionStr);

  console.log("\n✓ Setup berhasil!");
  console.log(`✓ Session disimpan di: ${SESSION_FILE}`);
  console.log("\nLangkah selanjutnya:");
  console.log("  1. Copy mahesh.session ke server");
  console.log("  2. Test: node mahesh-fetcher.js \"email@mahesh.co\" \"signin\"");

  await client.disconnect();
}

// ── Parse kode dari pesan bot Mahesh ─────────────────────
/**
 * Ekstrak kode dari pesan balasan bot.
 * Format yang mungkin:
 *   "Login Code: 0254"
 *   "Verification Code: 123456"
 *   "Code: 4567"
 */
function parseCodeFromMessage(text) {
  if (!text) return null;

  // Cek jika tidak ditemukan
  if (
    text.includes("EMAIL NOT FOUND") ||
    text.includes("NOT FOUND") ||
    text.includes("0 successful")
  ) {
    return null;
  }

  // Berbagai format kode
  const patterns = [
    /Login Code[:\s]+(\d{4,8})/i,
    /Verification Code[:\s]+(\d{4,8})/i,
    /Sign.in Code[:\s]+(\d{4,8})/i,
    /Code[:\s]+(\d{4,8})/i,
    /\b(\d{6})\b/,   // 6 digit standalone
    /\b(\d{4})\b/,   // 4 digit standalone
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ── Klik tombol inline keyboard ───────────────────────────
/**
 * Klik tombol inline keyboard pada pesan menggunakan client.invoke
 * @param {TelegramClient} client
 * @param {import('telegram').Api.Message} message
 * @param {string} buttonText
 * @returns {Promise<boolean>}
 */
async function clickButton(client, message, buttonText) {
  if (!message.replyMarkup) return false;

  const { Api } = require("telegram");
  const rows = message.replyMarkup.rows ?? [];

  for (const row of rows) {
    for (const btn of row.buttons) {
      const label = btn.text ?? "";
      if (label.toLowerCase().includes(buttonText.toLowerCase())) {
        console.log(`[mahesh] Klik tombol: "${label}"`);
        try {
          await client.invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer:  message.peerId,
              msgId: message.id,
              data:  btn.data,
            })
          );
          return true;
        } catch (err) {
          console.warn(`[mahesh] Error klik tombol: ${err.message}`);
          return false;
        }
      }
    }
  }
  return false;
}

// ── Fetch kode utama ──────────────────────────────────────
/**
 * Kirim email ke bot Mahesh, pilih kategori, ambil kode.
 *
 * @param {string} email       - email akun Netflix (misal: jack01@maheshpro.com)
 * @param {string} codeType    - tipe kode: "signin" | "signin6" | "verify" | dll
 * @param {object} opts
 *   - retries: jumlah retry (default 2)
 *   - retryDelay: jeda retry ms (default 5000)
 * @returns {Promise<string>}  kode yang ditemukan
 */
async function fetchFromMaheshBot(email, codeType = "signin", opts = {}) {
  const retries    = opts.retries    ?? 2;
  const retryDelay = opts.retryDelay ?? 5000;

  const buttonLabel = BUTTON_MAP[codeType];
  if (!buttonLabel) {
    throw new Error(`Tipe kode tidak dikenal: "${codeType}". Pilih: ${Object.keys(BUTTON_MAP).join(", ")}`);
  }

  const sessionStr = loadSession();
  if (!sessionStr) {
    throw new Error(
      "Session belum ada. Jalankan setup dulu:\n" +
      "  node mahesh-fetcher.js --setup"
    );
  }

  const client = createClient(sessionStr);

  try {
    await client.connect();

    // Simpan session terbaru setelah connect
    const newSession = client.session.save();
    if (newSession !== sessionStr) saveSession(newSession);

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      console.log(`[mahesh] Fetch "${codeType}" untuk ${email} (attempt ${attempt})...`);

      // Kirim email ke bot
      await client.sendMessage(BOT_USERNAME, { message: email });

      // Tunggu balasan dengan tombol SELECT CATEGORY
      const categoryMsg = await waitForMessage(client, BOT_USERNAME, {
        contains:   "SELECT CATEGORY",
        timeoutMs:  TIMEOUT_MS,
      });

      if (!categoryMsg) {
        console.warn(`[mahesh] Bot tidak balas dengan SELECT CATEGORY — timeout.`);
        if (attempt <= retries) {
          console.log(`[mahesh] Retry dalam ${retryDelay / 1000}s...`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        throw new Error(`Bot @${BOT_USERNAME} tidak merespons untuk ${email}`);
      }

      // Klik tombol kategori yang sesuai
      const clicked = await clickButton(client, categoryMsg, buttonLabel);
      if (!clicked) {
        throw new Error(`Tombol "${buttonLabel}" tidak ditemukan. Pastikan akun sudah diberi akses.`);
      }

      // Tunggu balasan dengan kode
      const resultMsg = await waitForMessage(client, BOT_USERNAME, {
        contains:  "CODE",
        timeoutMs: TIMEOUT_MS,
      });

      if (!resultMsg) {
        console.warn(`[mahesh] Bot tidak balas dengan kode — timeout.`);
        if (attempt <= retries) {
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        throw new Error(`Kode tidak diterima dari bot untuk ${email}`);
      }

      const code = parseCodeFromMessage(resultMsg.text);

      if (code) {
        console.log(`[mahesh] ✓ Kode ditemukan: ${code}`);
        return code;
      }

      // Kode tidak ditemukan (EMAIL NOT FOUND)
      console.warn(`[mahesh] Kode tidak ditemukan di balasan bot.`);
      console.warn(`[mahesh] Pesan bot: ${resultMsg.text?.slice(0, 150)}`);

      if (attempt <= retries) {
        console.log(`[mahesh] Retry dalam ${retryDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        throw new Error(`Kode tidak ditemukan untuk ${email} (${codeType}) setelah ${retries + 1} percobaan`);
      }
    }

  } finally {
    await client.disconnect();
  }
}

// ── Tunggu pesan dari bot ─────────────────────────────────
/**
 * Tunggu pesan baru dari bot yang mengandung teks tertentu.
 * @param {TelegramClient} client
 * @param {string}         fromUsername  - username bot (tanpa @)
 * @param {{ contains: string, timeoutMs: number }} opts
 * @returns {Promise<import('telegram').Api.Message | null>}
 */
function waitForMessage(client, fromUsername, opts) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, new NewMessage({}));
      resolve(null);
    }, opts.timeoutMs);

    const handler = async (event) => {
      const msg    = event.message;
      const sender = await msg.getSender().catch(() => null);
      const uname  = sender?.username?.toLowerCase() ?? "";

      if (uname !== fromUsername.toLowerCase()) return;

      const text = msg.text ?? "";
      if (!opts.contains || text.toUpperCase().includes(opts.contains.toUpperCase())) {
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve(msg);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
  });
}

// ── CLI ───────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--setup")) {
    await setupSession();
    return;
  }

  if (args.length >= 1) {
    const email    = args[0];
    const codeType = args[1] ?? "signin";

    try {
      const code = await fetchFromMaheshBot(email, codeType, { retries: 2, retryDelay: 5000 });
      console.log(`\nKode: ${code}`);
    } catch (err) {
      console.error(`\n✗ Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`
Mahesh Bot Fetcher
==================
Setup (pertama kali):
  node mahesh-fetcher.js --setup

Fetch kode:
  node mahesh-fetcher.js <email> [tipe]

Tipe yang tersedia:
  signin    → Sign-in Code (4 digit)
  signin6   → Verification code after login (6 digit)
  verify    → Verify Email
  household → Household Code
  reset     → Reset Password
  tvlogin   → TV Login Link
  vercode   → Verification Code

Contoh:
  node mahesh-fetcher.js "jack01@maheshpro.com" signin
  node mahesh-fetcher.js "jack01@maheshpro.com" signin6
  `);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { fetchFromMaheshBot };
