"use strict";

/**
 * tv-login-cookie.js — Login-kan TV Netflix pakai kode 8 digit yang tampil
 * di layar TV pelanggan (fitur "Masukkan kode yang ditampilkan di TV" di
 * netflix.com/tv9), lewat sesi cookie yang sama dengan kick/ganti-PIN.
 *
 * Dipicu manual oleh admin lewat /login_tv di bot Telegram, KAPAN SAJA
 * setelah pelanggan share kode dari TV-nya — bukan otomatis saat order,
 * karena kodenya baru muncul waktu pelanggan buka app Netflix di TV.
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
  fillCodeInputs,
} = require("./kicker-cookie");

const TIMEOUT_NAV = 45_000;
const URL_TV = "https://www.netflix.com/tv9";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Login TV pakai kode 8 digit ───────────────────────────
async function loginTvWithCode(email, code) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) throw new CookieExpiredError(email);

  const ctx = await launchAccountContext(email, { cookieData });
  const page = await ctx.newPage();

  try {
    console.log(`  [tv-login] Membuka ${URL_TV} ...`);
    await page.goto(URL_TV, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

    const url = page.url();
    if (url.includes("/login") || url.includes("/LoginHelp")) {
      deleteCookieForEmail(email);
      throw new CookieExpiredError(email);
    }

    // Netflix kadang minta verifikasi tambahan sebelum halaman sensitif bisa
    // dipakai. isMahesh selalu false di sini — command ini tidak tahu block
    // label (MAHESH/ROSE/MEET) akun-nya, jadi kalau MFA muncul untuk akun
    // MAHESH, fetch kode otomatisnya bakal salah sumber (coba nfpro, bukan
    // Mahesh Bot) dan otomatis fallback ke "minta kode manual via Telegram" —
    // tetap jalan, cuma kurang optimal. TODO kalau ini sering kejadian:
    // lookup block label dari spreadsheet sebelum panggil fungsi ini.
    await checkForExtraVerification(page, email, false);

    if (page.url() !== URL_TV) {
      console.log(`  [tv-login] Navigate ulang ke ${URL_TV} setelah verifikasi...`);
      await page.goto(URL_TV, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
    }

    // Tunggu form kode TV muncul
    const codeForm = page.locator('[data-uia="witcher-code-form"]');
    if (!(await codeForm.isVisible({ timeout: 15_000 }).catch(() => false))) {
      throw new Error(
        `Form input kode TV tidak ditemukan di ${page.url()} — mungkin akun sudah login atau halaman berubah.`,
      );
    }

    console.log(`  [tv-login] Isi kode: ${code}`);
    await fillCodeInputs(page, code);
    await sleep(500);

    // Tombol submit mulai dalam keadaan disabled, baru aktif setelah 8 digit
    // terisi lengkap. Playwright otomatis nunggu elemen "actionable" (termasuk
    // enabled) sebelum click(), jadi tidak perlu polling manual di sini.
    const submitBtn = page.locator('[data-uia="witcher-code-submit"]');
    await submitBtn.click({ timeout: 10_000 });

    // Verifikasi hasil lewat 2 sinyal pasti dari Netflix:
    // - Gagal (kode salah/kadaluarsa): [data-uia="witcher-code-input-error"]
    //   keisi pesan seperti "Kode tersebut salah. Coba lagi."
    // - Sukses: redirect ke /tv/out/success + [data-uia="tv-success-title"]
    //   ("Kamu siap menonton di TV!")
    const errorContent = page.locator(
      '[data-uia="witcher-code-input-error"] [data-uia="UIMessage-content"]',
    );
    const successTitle = page.locator('[data-uia="tv-success-title"]');

    await Promise.race([
      errorContent.waitFor({ state: "visible", timeout: 15_000 }),
      successTitle.waitFor({ state: "visible", timeout: 15_000 }),
      page.waitForURL((u) => u.toString().includes("/tv/out/success"), { timeout: 15_000 }),
    ]).catch(() => {});

    const errorText = ((await errorContent.textContent({ timeout: 3000 }).catch(() => "")) || "").trim();
    if (errorText) {
      // Contoh pesan asli Netflix: "Kode tersebut salah. Coba lagi." —
      // diteruskan apa adanya supaya admin tau harus minta kode baru ke
      // pelanggan (kode salah ATAU sudah kadaluarsa, sama-sama pesan ini).
      throw new Error(`Kode ditolak Netflix: "${errorText}" — minta pelanggan cek ulang kode di layar TV (kode bisa juga sudah kadaluarsa).`);
    }

    const isSuccess =
      page.url().includes("/tv/out/success") ||
      (await successTitle.isVisible({ timeout: 2000 }).catch(() => false));

    if (!isSuccess) {
      throw new Error(
        `Status tidak jelas setelah submit kode (URL: ${page.url()}) — tidak ada pesan error maupun halaman sukses terdeteksi, cek manual.`,
      );
    }

    const finalUrl = page.url();
    console.log(`  [tv-login] ✅ TV berhasil login! URL akhir: ${finalUrl}`);
    return { success: true, finalUrl };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── CLI ───────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "login": {
      // node tv-login-cookie.js login <email> <kode8digit>
      const [email, code] = args;
      if (!email || !code) {
        console.error("Usage: node tv-login-cookie.js login <email> <kode8digit>");
        process.exit(1);
      }
      const digitsOnly = code.replace(/\D/g, "");
      if (digitsOnly.length !== 8) {
        console.error(`Kode harus 8 digit angka, dapat: "${code}" (${digitsOnly.length} digit)`);
        process.exit(1);
      }
      try {
        await loginTvWithCode(email, digitsOnly);
        console.log(`[tv-login] SUKSES untuk ${email}`);
        process.exit(0);
      } catch (err) {
        console.error(`[tv-login] GAGAL untuk ${email}: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`
Netflix TV Login Helper
========================
Perintah:
  login <email> <kode8digit>   Login-kan TV pakai kode dari layar TV
      `);
  }
}

// Jalankan CLI hanya jika dipanggil langsung (bukan di-require)
if (require.main === module) {
  main().catch((err) => {
    console.error(`[tv-login] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { loginTvWithCode };
