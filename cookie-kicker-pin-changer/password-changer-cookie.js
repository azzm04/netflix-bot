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
const fs = require("fs");
const path = require("path");
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

// Berapa lama menunggu Netflix memberi kepastian setelah tombol Save diklik.
// Lebih longgar dari 15s versi awal: halaman ini kadang lama merender hasilnya,
// dan kalau Netflix menyelipkan verifikasi tambahan, alur kodenya butuh waktu.
const TIMEOUT_OUTCOME = 40_000;

// Frasa yang menandakan password BENAR-BENAR terganti (EN + ID).
// "sandimu telah diperbarui" adalah bunyi toast asli Netflix ID setelah
// submit — toast itu dirender sebagai div[role="alert"], selector yang sama
// dengan yang dipakai membaca pesan error, jadi frasa ini WAJIB dikenali
// duluan supaya sukses tidak salah dibaca sebagai kegagalan.
const TEXT_SUCCESS = [
  "password has been changed",
  "password was changed",
  "password has been updated",
  "password is updated",
  "password updated",
  "kata sandi anda telah diubah",
  "kata sandi telah diubah",
  "kata sandi anda berhasil",
  "kata sandi berhasil diubah",
  "kata sandi telah diperbarui",
  "kata sandimu telah diperbarui",
  "sandi anda telah diperbarui",
  "sandimu telah diperbarui",
  "sandi kamu telah diperbarui",
  "sandimu telah diubah",
];

// Netflix melempar ke halaman "konfigurasikan nomor pemulihan sandi" setelah
// ganti password sukses. URL-nya mengandung kata "password" di query string
// (?confirm=password) — makanya pengecekan URL di bawah spesifik, bukan
// sekadar "apakah masih ada kata password".
const URL_SUCCESS_HINTS = [
  "/addphone",
  "confirm=password",
  "passwordchanged",
  "password=changed",
];

// Frasa error yang berarti password lama (kolom B sheet) sudah tidak cocok.
const TEXT_WRONG_CURRENT = [
  "current password",
  "kata sandi saat ini",
  "password saat ini",
  "sandi saat ini",
  "sandi salah",
  "password salah",
  "incorrect",
  "does not match",
  "doesn't match",
  "tidak cocok",
];

// Frasa yang menandakan Netflix minta verifikasi identitas lagi SETELAH submit
// (aksi sensitif). Dulu ini yang bikin bot lapor "status tidak jelas": form
// hilang, URL tetap di /password, dan tidak ada pesan error sama sekali.
const TEXT_VERIFY = [
  "verify your identity",
  "verifikasi identitas",
  "email a code",
  "kirim kode",
  "code will expire",
  "kode tersebut akan kedaluwarsa",
  "let's make sure it's you",
  "pastikan ini benar-benar kamu",
];

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

// ── Baca pesan error yang sedang tampil di halaman ─────────
// Netflix tidak konsisten menaruh pesan error di satu data-uia saja, jadi
// selectornya dilebarkan (termasuk role="alert") dan hasilnya diklasifikasi
// di pemanggil — sebuah alert bisa saja justru pesan sukses.
async function readAlertText(page) {
  const loc = page.locator(
    [
      '[data-uia="input-message-error"]',
      ".ui-message-error",
      '[data-uia="change-password-page+error"]',
      '[data-uia$="+error"]',
      '[data-uia*="error-message"]',
      '[role="alert"]',
    ].join(", "),
  );

  const total = await loc.count().catch(() => 0);
  const texts = [];
  for (let i = 0; i < total && i < 8; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = ((await el.innerText().catch(() => "")) || "").trim();
    if (t) texts.push(t.replace(/\s+/g, " "));
  }
  return [...new Set(texts)].join(" | ");
}

// ── Simpan bukti halaman saat hasilnya tidak bisa disimpulkan ────
// Tanpa ini, kegagalan seperti "status tidak jelas" mentok jadi pesan Telegram
// tanpa petunjuk apa pun. Screenshot + teks halaman bikin kasus berikutnya
// bisa didiagnosis tanpa harus reproduce manual.
async function saveDebugSnapshot(page, email) {
  try {
    const dir = path.join(__dirname, "debug");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = email.replace(/[^a-z0-9]+/gi, "_");
    const base = path.join(dir, `gantipw-${slug}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const body = await page.locator("body").innerText().catch(() => "");
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${body}`, "utf8");
    return `${base}.png`;
  } catch (err) {
    console.warn(`  [password-cookie] ⚠ Gagal simpan snapshot debug: ${err.message}`);
    return "";
  }
}

// ── Tunggu kepastian hasil setelah tombol Save diklik ─────────
// Polling, bukan sekali cek: hasilnya bisa muncul sebagai perpindahan URL,
// banner sukses, pesan error, ATAU halaman verifikasi identitas yang baru
// muncul setelah submit. Yang terakhir ini ditangani di tempat (kode email
// diambil otomatis seperti alur MFA lain), lalu polling dilanjutkan.
async function waitForPasswordOutcome(page, email, isMahesh, currentPwInput) {
  const deadline = Date.now() + TIMEOUT_OUTCOME;
  let verificationHandled = false;
  let formGoneSince = 0;
  let lastBody = "";

  while (Date.now() < deadline) {
    await sleep(1000);

    const url = page.url();
    lastBody = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const lower = lastBody.toLowerCase();

    // 1a. Redirect ke halaman lanjutan khas pasca-ganti-password.
    if (URL_SUCCESS_HINTS.some((h) => url.toLowerCase().includes(h))) {
      return { status: "success", url };
    }

    // 1b. Keluar dari form /password → Netflix sudah menerima perubahan.
    if (!url.includes("/password")) return { status: "success", url };

    // 2. Konfirmasi sukses eksplisit walau URL belum pindah.
    if (TEXT_SUCCESS.some((t) => lower.includes(t))) return { status: "success", url };

    // 3. Pesan error / alert yang sedang tampil.
    const alertText = await readAlertText(page);
    if (alertText) {
      const al = alertText.toLowerCase();
      if (TEXT_SUCCESS.some((t) => al.includes(t))) return { status: "success", url };
      return { status: "error", message: alertText, url };
    }

    const formVisible = await currentPwInput.isVisible().catch(() => false);

    // 4. Netflix minta verifikasi identitas lagi setelah submit — selesaikan
    //    dulu (sekali saja), lalu lanjut menunggu hasil sebenarnya.
    if (!formVisible && !verificationHandled && TEXT_VERIFY.some((t) => lower.includes(t))) {
      console.log(`  [password-cookie] Verifikasi identitas muncul setelah submit — menyelesaikan...`);
      verificationHandled = true;
      await checkForExtraVerification(page, email, isMahesh);
      continue;
    }

    // 5. Form sudah hilang, tidak ada error & tidak ada verifikasi → anggap
    //    sukses setelah stabil beberapa detik (halaman konfirmasi Netflix).
    if (!formVisible) {
      if (!formGoneSince) formGoneSince = Date.now();
      if (Date.now() - formGoneSince >= 3000) return { status: "success", url };
    } else {
      formGoneSince = 0;
    }
  }

  return { status: "unknown", url: page.url(), excerpt: lastBody.slice(0, 300) };
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
      // Input-nya sering disembunyikan (checkbox custom), jadi klik label-nya
      // dulu — baru fallback ke klik paksa input-nya.
      const soadLabel = page.locator('label[for="change-password-form+soad-checkbox"]');
      if (await soadLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
        await soadLabel.click().catch(() => {});
      } else {
        await soadCheckbox.click({ force: true }).catch(() => {});
      }
      await sleep(300);

      // Jangan lanjut kalau gagal dimatikan: submit dengan checkbox ini aktif
      // bakal me-logout semua device pelanggan yang sedang nonton.
      if (await soadCheckbox.isChecked().catch(() => false)) {
        throw new Error(
          `Gagal mematikan opsi "sign out all devices" — dibatalkan supaya device pelanggan tidak ikut ter-logout. Cek manual.`,
        );
      }
    }

    await sleep(300);
    const saveBtn = page.locator('[data-uia="change-password-form+save-button"]');

    // Netflix baru mengaktifkan tombol Save kalau ketiga field lolos validasi.
    // Kalau masih disabled, klik-nya jadi no-op diam-diam — lebih jelas
    // dilaporkan di sini daripada berakhir sebagai "status tidak jelas".
    if (await saveBtn.isDisabled({ timeout: 3000 }).catch(() => false)) {
      throw new Error(
        `Tombol simpan masih nonaktif — form ditolak validasi Netflix (cek panjang/kerumitan password baru).`,
      );
    }

    console.log(`  [password-cookie] Menyimpan password baru...`);
    await saveBtn.click();

    const outcome = await waitForPasswordOutcome(page, email, isMahesh, currentPwInput);

    if (outcome.status === "error") {
      const lower = outcome.message.toLowerCase();
      if (TEXT_WRONG_CURRENT.some((t) => lower.includes(t))) {
        throw new CurrentPasswordWrongError(email);
      }
      throw new Error(`Netflix menolak ganti password: "${outcome.message}"`);
    }

    if (outcome.status !== "success") {
      const shot = await saveDebugSnapshot(page, email);
      throw new Error(
        `Status tidak jelas setelah submit (URL: ${outcome.url}). ` +
          `Cuplikan halaman: "${outcome.excerpt || "(kosong)"}"` +
          (shot ? ` — screenshot: ${shot}` : ""),
      );
    }

    console.log(`  [password-cookie] ✅ Password berhasil diganti untuk ${email}.`);

    // Netflix mengarahkan ke /addphone ("konfigurasikan nomor pemulihan
    // sandi"). Tutup dengan "Tidak, Terima Kasih" supaya alur selesai bersih
    // dan prompt-nya tidak menyangkut di sesi berikutnya. Sekadar best-effort:
    // password sudah terganti, jadi kegagalan di sini tidak boleh menggagalkan
    // apa pun — dan jangan sekali-kali klik "Tambahkan Nomor Ponsel".
    if (page.url().toLowerCase().includes("/addphone")) {
      const noThanks = page.locator(
        'button:has-text("Tidak, Terima Kasih"), button:has-text("No, Thanks"), button:has-text("Nanti Saja")',
      ).first();
      if (await noThanks.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`  [password-cookie] Menutup prompt nomor pemulihan sandi...`);
        await noThanks.click().catch(() => {});
        await sleep(1500);
      }
    }

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

      const { getPasswordForEmail, updatePasswordRows, findSpreadsheetId } = require("./sheets");

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

      // Baris-baris sheet untuk email yang sama bisa menyimpan password
      // berbeda (sisa update lama yang cuma kena sebagian baris). Kumpulkan
      // kandidat uniknya — urutan baris teratas dulu — supaya kalau yang
      // pertama ditolak Netflix, kandidat berikutnya masih dicoba sebelum
      // menyerah. Setelah sukses semua baris disamakan, jadi kasus ini
      // seharusnya hilang dengan sendirinya.
      const candidates = [
        ...new Set(
          info.rows
            .map((r) => r.password)
            .filter((pw) => pw && pw.toUpperCase() !== "PAKE KODE"),
        ),
      ].slice(0, 3);

      try {
        let lastWrongErr = null;
        let changed = false;

        for (let i = 0; i < candidates.length; i++) {
          try {
            if (i > 0) {
              console.log(
                `[password-cookie] Password lama #${i} ditolak — coba kandidat lain dari sheet (${i + 1}/${candidates.length})...`,
              );
            }
            await changePasswordCookie(email, candidates[i], newPassword, false);
            changed = true;
            break;
          } catch (err) {
            if (err instanceof CurrentPasswordWrongError && i < candidates.length - 1) {
              lastWrongErr = err;
              continue;
            }
            throw err;
          }
        }

        if (!changed) throw lastWrongErr ?? new Error("Gagal ganti password.");

        // Sinkronkan sheet dengan password baru supaya tidak ada admin lain
        // yang masih pakai password lama untuk request berikutnya.
        //
        // Satu akun dipakai banyak profil, jadi emailnya muncul di banyak
        // baris (bisa lintas sheet) — SEMUA baris itu ikut ditulis ulang,
        // bukan cuma baris pertama. Baris bertanda "PAKE KODE" sengaja
        // dilewati: itu penanda kebijakan login pakai kode, bukan password
        // basi, jadi jangan diubah jadi password asli.
        const targetRows = info.rows.filter(
          (r) => r.password.toUpperCase() !== "PAKE KODE",
        );
        const skipped = info.rows.length - targetRows.length;

        try {
          const spreadsheetId = await findSpreadsheetId();
          const updated = await updatePasswordRows(spreadsheetId, targetRows, newPassword);
          // Dibaca handler /gantipw di bot untuk lapor jumlah baris ke admin.
          console.log(
            `[password-cookie] SHEET_ROWS=${updated}${skipped ? ` SKIPPED_PAKEKODE=${skipped}` : ""}`,
          );
        } catch (sheetErr) {
          console.error(
            `[password-cookie] ⚠ Password sukses diganti di Netflix TAPI gagal update spreadsheet: ${sheetErr.message}`,
          );
          console.error(
            `[password-cookie] Update manual kolom B ke "${newPassword}" di baris: ${targetRows
              .map((r) => `${r.sheetName}!${r.rowIndex}`)
              .join(", ")}`,
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

module.exports = { changePasswordCookie, waitForPasswordOutcome, CurrentPasswordWrongError };
