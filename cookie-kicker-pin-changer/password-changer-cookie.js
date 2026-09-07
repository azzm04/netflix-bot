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

// ── Isi input yang dikelola React ─────────────────────────
// fill() menulis ke DOM tapi kadang tidak memicu onChange React, jadi Netflix
// menganggap field-nya masih kosong dan tombol Save tidak submit apa-apa.
// Pola verify + fallback click/type ini sama dengan yang dipakai untuk input
// PIN di pin-changer-cookie.js.
async function isiInputAndal(input, value, label) {
  await input.fill("");
  await input.fill(value);
  await sleep(200);

  let isi = await input.inputValue().catch(() => "");
  if (isi !== value) {
    console.log(`  [password-cookie] fill() tidak ter-set di ${label}, coba click+selectAll+type...`);
    await input.click({ clickCount: 3 });
    await input.type(value, { delay: 60 });
    await sleep(200);
    isi = await input.inputValue().catch(() => "");
  }

  if (isi !== value) {
    throw new Error(`Gagal mengisi field ${label} — nilai tidak ter-set di form.`);
  }
}

// ── Dump kondisi halaman saat hasilnya ambigu ─────────────
// Dipakai kalau setelah Save tidak ada pesan error DAN form-nya tidak hilang:
// tanpa ini errornya cuma "status tidak jelas" dan tidak bisa didiagnosis.
async function dumpDiagnostik(page, email, inputs) {
  const baris = [];

  for (const [label, loc] of Object.entries(inputs)) {
    const val = await loc.inputValue().catch(() => null);
    // Password tidak pernah di-log apa adanya — cukup panjangnya saja.
    baris.push(`${label}=${val === null ? "(tidak terbaca)" : `${val.length} karakter`}`);
  }

  const soad = page.locator('[data-uia="change-password-form+soad-checkbox"]');
  const soadChecked = await soad.isChecked().catch(() => null);
  baris.push(`soad-checkbox=${soadChecked === null ? "(tidak terbaca)" : soadChecked}`);

  const saveBtn = page.locator('[data-uia="change-password-form+save-button"]');
  const saveDisabled = await saveBtn.isDisabled().catch(() => null);
  baris.push(`save-button-disabled=${saveDisabled === null ? "(tidak terbaca)" : saveDisabled}`);

  console.error(`  [password-cookie] [diagnostik] ${baris.join(" | ")}`);

  const teksForm = await page
    .locator('[data-uia="change-password-page"]')
    .innerText()
    .catch(() => "");
  if (teksForm) {
    console.error(
      `  [password-cookie] [diagnostik] Teks form:\n${teksForm.trim().slice(0, 1200)}`,
    );
  }

  const path = `debug-gantipw-${email.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  console.error(`  [password-cookie] [diagnostik] Screenshot: ${path}`);
}

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

    const newPwInput = page.locator(
      '[data-uia="change-password-form+new-password-input"]',
    );
    const reenterPwInput = page.locator(
      '[data-uia="change-password-form+reeneter-new-password-input"]',
    );

    console.log(`  [password-cookie] Mengisi form ganti password...`);
    await isiInputAndal(currentPwInput, currentPassword, "current-password");
    await isiInputAndal(newPwInput, newPassword, "new-password");
    await isiInputAndal(reenterPwInput, newPassword, "reenter-new-password");

    // "Sign out all devices" dicentang default oleh Netflix — dimatikan
    // supaya sesi/device pelanggan yang lagi nonton tidak ke-logout paksa.
    const soadCheckbox = page.locator(
      '[data-uia="change-password-form+soad-checkbox"]',
    );
    if (await soadCheckbox.isChecked({ timeout: 3000 }).catch(() => false)) {
      // Input checkbox-nya sendiri ditumpuk elemen "chrome" milik design system
      // Netflix, jadi klik ke label — itu target yang benar-benar bisa diklik.
      await page
        .locator('[data-uia="change-password-form+soad-checkbox+label"]')
        .click()
        .catch(async () => {
          await soadCheckbox.click({ force: true });
        });
      await sleep(300);

      if (await soadCheckbox.isChecked().catch(() => false)) {
        console.warn(
          `  [password-cookie] ⚠ "Sign out all devices" masih tercentang — device pelanggan bisa ke-logout.`,
        );
      }
    }

    await sleep(300);
    const saveBtn = page.locator('[data-uia="change-password-form+save-button"]');
    if (await saveBtn.isDisabled().catch(() => false)) {
      throw new Error(
        "Tombol Save masih disabled setelah semua field terisi — Netflix menolak isi form (cek panjang/format password baru).",
      );
    }

    console.log(`  [password-cookie] Menyimpan password baru...`);
    await saveBtn.click();

    // Sinyal error umum yang dipakai berulang kali di form-form Netflix lain
    // (lihat pin-changer-cookie.js) — dipakai lagi di sini karena belum ada
    // konfirmasi DOM sukses/error yang spesifik untuk halaman ini.
    const errorMsg = page.locator(
      '[data-uia="input-message-error"], .ui-message-error, ' +
      '[data-uia="change-password-page+error"], [data-uia="UIMessage-content"], ' +
      '[data-uia$="+error"], [role="alert"]',
    ).first();

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
      await dumpDiagnostik(page, email, {
        "current-password": currentPwInput,
        "new-password": newPwInput,
        "reenter-new-password": reenterPwInput,
      });
      throw new Error(
        `Status tidak jelas setelah submit (masih di form, URL: ${page.url()}, tidak ada pesan error) — lihat baris [diagnostik] di log & screenshot yang tersimpan.`,
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
