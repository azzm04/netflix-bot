/**
 * mahesh-fetcher.js — Fetch kode Netflix dari @Maheshshoppiebot di Telegram
 *
 * SETUP AWAL (sekali saja):
 *   node mahesh-fetcher.js --setup
 *
 * TEST:
 *   node mahesh-fetcher.js "jack01@maheshpro.com" signin
 *   node mahesh-fetcher.js "jack01@maheshpro.com" signin6
 *
 * Tipe kode → label tombol bot:
 *   signin    → "Sign-in Code"
 *   signin6   → "Verification code after login"
 *   verify    → "Verify Email"
 *   household → "Household Code"
 *   reset     → "Reset Password"
 */

"use strict";

require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────
const API_ID = parseInt(process.env.MAHESH_API_ID ?? "0");
const API_HASH = process.env.MAHESH_API_HASH ?? "";
const PHONE = process.env.MAHESH_PHONE ?? "";
const SESSION_FILE = path.resolve(
  __dirname,
  process.env.MAHESH_SESSION_FILE ?? "mahesh.session",
);
const BOT_USERNAME = process.env.MAHESH_BOT_USERNAME ?? "Maheshshoppiebot";
const TIMEOUT_MS = parseInt(process.env.MAHESH_TIMEOUT ?? "30000");

const BUTTON_MAP = {
  signin: "Sign-in Code",
  signin6: "Verification code after login",
  verify: "Verify Email",
  household: "Household Code",
  reset: "Reset Password",
  tvlogin: "TV Login Link",
  vercode: "Verification Code",
};

// ── Session ───────────────────────────────────────────────
function loadSession() {
  if (fs.existsSync(SESSION_FILE))
    return fs.readFileSync(SESSION_FILE, "utf-8").trim();
  return "";
}

function saveSession(str) {
  fs.writeFileSync(SESSION_FILE, str, "utf-8");
  console.log(`[mahesh] Session tersimpan: ${SESSION_FILE}`);
}

// ── Client ────────────────────────────────────────────────
function createClient(sessionStr = "") {
  if (!API_ID || !API_HASH) {
    throw new Error("MAHESH_API_ID dan MAHESH_API_HASH belum diset di .env");
  }
  return new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
    connectionRetries: 3,
  });
}

// ── Input terminal ────────────────────────────────────────
function prompt(text) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(text, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

// ── Setup session ─────────────────────────────────────────
async function setupSession() {
  console.log("\n=== Setup Session Telegram ===\n");
  if (!PHONE) {
    console.error("Set MAHESH_PHONE di .env dulu");
    process.exit(1);
  }

  const client = createClient("");
  await client.start({
    phoneNumber: async () => PHONE,
    password: async () => prompt("Password 2FA (Enter jika tidak ada): "),
    phoneCode: async () => prompt("Kode OTP Telegram: "),
    onError: (err) => console.error("[mahesh] Auth error:", err.message),
  });

  saveSession(client.session.save());
  console.log("\n✓ Setup berhasil! Test dengan:");
  console.log(`  node mahesh-fetcher.js "email@mahesh.co" signin`);
  await client.disconnect();
}

// ── Parse kode dari teks pesan ────────────────────────────
function parseCode(text) {
  if (!text) return null;
  if (text.includes("NOT FOUND") || text.includes("0 successful")) return null;

  const patterns = [
    /Login Code[:\s]+(\d{4,8})/i,
    /Verification Code[:\s]+(\d{4,8})/i,
    /Sign.in Code[:\s]+(\d{4,8})/i,
    /Code[:\s]+(\d{4,8})/i,
    /\b(\d{6})\b/,
    /\b(\d{4})\b/,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── Tunggu pesan dari bot ─────────────────────────────────
function waitForBotMessage(client, botUsername, containsText, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, new NewMessage({}));
      resolve(null);
    }, timeoutMs);

    const handler = async (event) => {
      const msg = event.message;
      const sender = await msg.getSender().catch(() => null);
      const uname = (sender?.username ?? "").toLowerCase();
      if (uname !== botUsername.toLowerCase()) return;

      const text = msg.text ?? "";
      if (
        !containsText ||
        text.toUpperCase().includes(containsText.toUpperCase())
      ) {
        clearTimeout(timer);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve(msg);
      }
    };

    client.addEventHandler(handler, new NewMessage({}));
  });
}

// ── Klik tombol inline keyboard ───────────────────────────
async function clickInlineButton(client, message, buttonText) {
  if (!message.replyMarkup) return false;

  const { Api } = require("telegram");
  const rows = message.replyMarkup.rows ?? [];
  const target = buttonText.toLowerCase().trim();
  // Pass 1: cari exact match dulu (hindari "Verification Code" ke-match
  for (const row of rows) {
    for (const btn of row.buttons) {
      const btnText = (btn.text ?? "").toLowerCase().trim();
      if (btnText === target) {
        console.log(`[mahesh] Klik tombol (exact match): "${btn.text}"`);
        client
          .invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer: message.peerId,
              msgId: message.id,
              data: btn.data,
            }),
          )
          .catch(() => {});
        return true;
      }
    }
  }
  // Pass 2: fallback ke substring match kalau tidak ada exact match
  for (const row of rows) {
    for (const btn of row.buttons) {
      if ((btn.text ?? "").toLowerCase().includes(target)) {
        console.log(`[mahesh] Klik tombol (substring match): "${btn.text}"`);
        client
          .invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer: message.peerId,
              msgId: message.id,
              data: btn.data,
            }),
          )
          .catch(() => {});
        return true;
      }
    }
  }
  return false;
}

// ── Fetch kode utama ──────────────────────────────────────
async function fetchFromMaheshBot(email, codeType = "signin", opts = {}) {
  const retries = opts.retries ?? 2;
  const retryDelay = opts.retryDelay ?? 5000;

  const buttonLabel = BUTTON_MAP[codeType];
  if (!buttonLabel) {
    throw new Error(
      `Tipe tidak dikenal: "${codeType}". Pilih: ${Object.keys(BUTTON_MAP).join(", ")}`,
    );
  }

  const sessionStr = loadSession();
  if (!sessionStr) {
    throw new Error(
      "Session belum ada. Jalankan: node mahesh-fetcher.js --setup",
    );
  }

  const client = createClient(sessionStr);
  await client.connect();

  // Simpan session terbaru
  const newSession = client.session.save();
  if (newSession !== sessionStr) saveSession(newSession);

  try {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      console.log(
        `[mahesh] Fetch "${codeType}" untuk ${email} (attempt ${attempt})...`,
      );

      // Step 0: Kirim /start dulu untuk reset state bot
      console.log(`[mahesh] Kirim /start untuk reset state bot...`);
      await client.sendMessage(BOT_USERNAME, { message: "/start" });
      await new Promise((r) => setTimeout(r, 1500));

      // Step 1: Kirim email
      await client.sendMessage(BOT_USERNAME, { message: email });

      // Step 2: Tunggu balasan SELECT CATEGORY
      const categoryMsg = await waitForBotMessage(
        client,
        BOT_USERNAME,
        "SELECT CATEGORY",
        TIMEOUT_MS,
      );

      if (!categoryMsg) {
        console.warn(`[mahesh] Tidak ada balasan SELECT CATEGORY.`);
        if (attempt <= retries) {
          await new Promise((r) => setTimeout(r, retryDelay));
          continue;
        }
        throw new Error(`Bot tidak merespons untuk ${email}`);
      }

      // Step 3: Klik tombol (non-blocking, bot balas via pesan baru)
      const found = await clickInlineButton(client, categoryMsg, buttonLabel);
      if (!found) {
        throw new Error(
          `Tombol "${buttonLabel}" tidak ada. Cek nama tombol di bot.`,
        );
      }

      // Step 4: Tunggu pesan balasan berisi kode
      console.log(`[mahesh] Menunggu kode dari bot...`);
      const resultMsg = await waitForBotMessage(
        client,
        BOT_USERNAME,
        "CODE",
        TIMEOUT_MS,
      );

      if (!resultMsg) {
        console.warn(`[mahesh] Tidak ada balasan kode.`);
        if (attempt <= retries) {
          await new Promise((r) => setTimeout(r, retryDelay));
          continue;
        }
        throw new Error(`Kode tidak diterima dari bot untuk ${email}`);
      }

      // Step 5: Parse kode
      const code = parseCode(resultMsg.text);
      if (code) {
        console.log(`[mahesh] ✓ Kode: ${code}`);
        return code;
      }

      console.warn(
        `[mahesh] Kode tidak ditemukan. Pesan: ${resultMsg.text?.slice(0, 100)}`,
      );
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, retryDelay));
      } else {
        throw new Error(
          `Kode tidak ditemukan untuk ${email} setelah ${retries + 1} percobaan`,
        );
      }
    }
  } finally {
    await client.disconnect();
  }
}

// ── CLI ───────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--setup")) {
    await setupSession();
    return;
  }

  if (args.length >= 1) {
    const [email, codeType = "signin"] = args;
    try {
      const code = await fetchFromMaheshBot(email, codeType, { retries: 2 });
      console.log(`\nKode: ${code}`);
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`
Mahesh Bot Fetcher — Cara pakai:
  node mahesh-fetcher.js --setup                          Setup session (sekali saja)
  node mahesh-fetcher.js <email> [tipe]                   Fetch kode

Tipe: signin | signin6 | verify | household | reset | tvlogin | vercode
  `);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { fetchFromMaheshBot };
