"use strict";

/**
 * password-changer-cookie.js — Ganti password akun Netflix lewat
 * netflix.com/password, pakai sesi cookie yang sama dengan kick/ganti-PIN.
 *
 * Dipicu manual oleh admin lewat /gantipw di bot Telegram. Password lama
 * WAJIB ada di kolom B spreadsheet (bukan "PAKE KODE") — form ini butuh
 * "Current Password" asli, tidak ada jalur "Email a code" seperti di ganti
 * PIN, jadi akun tanpa password asli langsung ditolak sebelum buka browser
 * sama sekali (lihat main() di bawah).
 */

require("dotenv").config();
const {
  getCookieForEmail,
  deleteCookieForEmail,
  launchAccountContext,
} = require("./cookie-helper");
const {
  CookieExpiredError,
  checkForExtraVerification,
  refreshAndSaveCookies,
} = require("./kicker-cookie");

const TIMEOUT_NAV = 45_000;
const URL_PASSWORD = "https://www.netflix.com/password";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CurrentPasswordWrongError extends Error {
  constructor(email) {
    super(`Password lama ditolak Netflix untuk ${email} — kemungkinan password di sheet sudah tidak sesuai.`);
    this.name = "CurrentPasswordWrongError";
    this.email = email;
  }
}

// ── Buka netflix.com/password lewat sesi cookie ───────────
// Sama seperti newCookiePage() di pin-changer-cookie.js — diduplikasi di sini
// (bukan diimpor) karena masing-masing file punya URL target & log prefix
// sendiri, mengikuti pola yang sudah ada di codebase ini.
async function newCookiePage(email, isMahesh = false) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) throw new CookieExpiredError(email);

  const ctx = await launchAccountContext(email, { cookieData });
  const page = await ctx.newPage();

  console.log(`  [password-cookie] Membuka ${URL_PASSWORD} ...`);
  await page.goto(URL_PASSWORD, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    deleteCookieForEmail(email);
    await ctx.close().catch(() => {});
    throw new CookieExpiredError(email);
  }

  // Halaman security-sensitive kadang minta verifikasi tambahan dulu
  // sebelum bisa diakses lewat sesi cookie (sama seperti /account/profiles).
  await checkForExtraVerification(page, email, isMahesh);

  if (page.url() !== URL_PASSWORD) {
    console.log(`  [password-cookie] Navigate ulang ke ${URL_PASSWORD} setelah verifikasi...`);
    await page.goto(URL_PASSWORD, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
  }

  console.log(`  [password-cookie] Berhasil akses: ${page.url()}`);
  return { ctx, page };
}

// ── Ganti Password ─────────────────────────────────────────
// isMahesh selalu false di sini (default) — command ini tidak tahu block
// label (MAHESH/ROSE/MEET) akun-nya, sama seperti keterbatasan yang sudah
// ada di tv-login-cookie.js. Kalau MFA muncul untuk akun MAHESH, fetch kode
// otomatisnya bakal salah sumber dan fallback ke "minta kode manual via
// Telegram" — tetap jalan, cuma kurang optimal.
async function changePasswordCookie(email, currentPassword, newPassword, isMahesh = false) {
  let ctx, page;

  try {
    ({ ctx, page } = await newCookiePage(email, isMahesh));
    await sleep(1500);

    const currentPwInput = page.locator(
      '[data-uia="change-password-form+current-password-input"]',
    );
    if (!(await currentPwInput.isVisible({ timeout: 10_000 }).catch(() => false))) {
      throw new Error(
        `Form ganti password tidak ditemukan di ${page.url()} — halaman mungkin berubah, cek manual.`,
      );
    }

    console.log(`  [password-cookie] Mengisi form ganti password...`);
    await currentPwInput.fill(currentPassword);

    const newPwInput = page.locator(
      '[data-uia="change-password-form+new-password-input"]',
    );
    await newPwInput.fill(newPassword);

    const reenterPwInput = page.locator(
      '[data-uia="change-password-form+reeneter-new-password-input"]',
    );
    await reenterPwInput.fill(newPassword);

    // "Sign out all devices" dicentang default oleh Netflix — dimatikan
    // supaya sesi/device pelanggan yang lagi nonton tidak ke-logout paksa.
    const soadCheckbox = page.locator(
      '[data-uia="change-password-form+soad-checkbox"]',
    );
    if (await soadCheckbox.isChecked({ timeout: 3000 }).catch(() => false)) {
      // Klik labelnya, bukan input-nya langsung — checkbox custom Netflix
      // sering butuh event klik di elemen yang benar-benar visible.
      await soadCheckbox.click({ force: true });
      await sleep(300);
    }

    await sleep(300);
    const saveBtn = page.locator('[data-uia="change-password-form+save-button"]');
    console.log(`  [password-cookie] Menyimpan password baru...`);
    await saveBtn.click();

    // Sinyal error umum yang dipakai berulang kali di form-form Netflix lain
    // (lihat pin-changer-cookie.js) — dipakai lagi di sini karena belum ada
    // konfirmasi DOM sukses/error yang spesifik untuk halaman ini.
    const errorMsg = page.locator(
      '[data-uia="input-message-error"], .ui-message-error, [data-uia="change-password-page+error"]',
    );

    await Promise.race([
      errorMsg.waitFor({ state: "visible", timeout: 15_000 }),
      currentPwInput.waitFor({ state: "detached", timeout: 15_000 }),
      currentPwInput.waitFor({ state: "hidden", timeout: 15_000 }),
      page.waitForURL((u) => !u.toString().includes("/password"), { timeout: 15_000 }),
    ]).catch(() => {});

    if (await errorMsg.isVisible({ timeout: 2000 }).catch(() => false)) {
      const errText = ((await errorMsg.textContent().catch(() => "")) || "").trim();
      const lower = errText.toLowerCase();
      if (
        lower.includes("current password") ||
        lower.includes("password saat ini") ||
        lower.includes("sandi salah") ||
        lower.includes("incorrect")
      ) {
        throw new CurrentPasswordWrongError(email);
      }
      throw new Error(`Netflix menolak ganti password: "${errText || "(pesan error kosong)"}"`);
    }

    // Tidak ada error terlihat & form current-password sudah tidak ada lagi
    // (hilang dari DOM atau URL pindah dari /password) → dianggap sukses.
    const stillOnForm = await currentPwInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (stillOnForm) {
      throw new Error(
        `Status tidak jelas setelah submit (masih di form, URL: ${page.url()}, tidak ada pesan error) — cek manual.`,
      );
    }

    console.log(`  [password-cookie] ✅ Password berhasil diganti untuk ${email}.`);

    // Dynamic Update: password change berpotensi merotasi cookie sesi —
    // simpan cookie terbaru dari server supaya request berikutnya tetap valid.
    await refreshAndSaveCookies(ctx, email);

    return { success: true };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

// ── CLI ───────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "change": {
      // node password-changer-cookie.js change <email> <newPassword>
      const [email, newPassword] = args;
      if (!email || !newPassword) {
        console.error("Usage: node password-changer-cookie.js change <email> <newPassword>");
        process.exit(1);
      }
      if (newPassword.length < 6 || newPassword.length > 60) {
        console.error(`Password baru harus 6-60 karakter, dapat: ${newPassword.length} karakter.`);
        process.exit(1);
      }

      const { getPasswordForEmail, updatePasswordForEmail, findSpreadsheetId } = require("./sheets");

      let info;
      try {
        info = await getPasswordForEmail(email);
      } catch (err) {
        console.error(`[password-cookie] Gagal baca spreadsheet: ${err.message}`);
        process.exit(1);
      }

      if (!info.found) {
        console.error(`Akun ${email} tidak ditemukan di spreadsheet.`);
        process.exit(1);
      }
      if (info.noPassword) {
        console.error("Itu tidak ada passwordnya");
        process.exit(1);
      }

      try {
        await changePasswordCookie(email, info.password, newPassword, false);

        // Sinkronkan sheet dengan password baru supaya tidak ada admin lain
        // yang masih pakai password lama untuk request berikutnya.
        try {
          const spreadsheetId = await findSpreadsheetId();
          await updatePasswordForEmail(spreadsheetId, info.sheetName, info.rowIndex, newPassword);
        } catch (sheetErr) {
          console.error(
            `[password-cookie] ⚠ Password sukses diganti di Netflix TAPI gagal update spreadsheet: ${sheetErr.message}`,
          );
          console.error(
            `[password-cookie] Update manual kolom B (${info.sheetName} baris ${info.rowIndex}) ke: ${newPassword}`,
          );
          process.exit(1);
        }

        console.log(`[password-cookie] SUKSES untuk ${email}`);
        process.exit(0);
      } catch (err) {
        console.error(`[password-cookie] GAGAL untuk ${email}: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`
Netflix Password Changer Helper
================================
Perintah:
  change <email> <newPassword>   Ganti password akun via netflix.com/password
      `);
  }
}

// Jalankan CLI hanya jika dipanggil langsung (bukan di-require)
if (require.main === module) {
  main().catch((err) => {
    console.error(`[password-cookie] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { changePasswordCookie, CurrentPasswordWrongError };
