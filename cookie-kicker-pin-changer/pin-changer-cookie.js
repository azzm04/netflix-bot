"use strict";

require("dotenv").config();
const fs = require("fs");
const {
  getCookieForEmail,
  deleteCookieForEmail,
  launchAccountContext,
} = require("./cookie-helper");
const { CookieExpiredError, checkForExtraVerification } = require("./kicker-cookie");

const TIMEOUT_NAV = 45_000;
const URL_PIN_SETTINGS = "https://www.netflix.com/settings/migration";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Debug Screenshot ──────────────────────────────────────
function debugShot(page, name) {
  const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return page
    .screenshot({ path: `${dir}/${name}_${Date.now()}.png`, fullPage: true })
    .catch(() => {});
}

class WrongPasswordError extends Error {
  constructor(email) {
    super(`Password salah untuk ${email} (Kontrol Orang Tua).`);
    this.name = "WrongPasswordError";
    this.email = email;
  }
}

// ── Generate PIN Baru ─────────────────────────────────────
function generateNewPin(oldPin) {
  let pin;
  let attempts = 0;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    // Setelah 100 percobaan, terima apapun (sangat tidak mungkin terjadi)
    if (attempts > 100) break;
  } while (pin === oldPin || /^(.)\1{3}$/.test(pin)); // Hindari juga 1111, 2222, dst.
  return pin;
}

// ── Buat Context (persistent, per akun) + Buka Halaman ────
async function newCookiePage(email, targetUrl, isMahesh = false) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new CookieExpiredError(email);
  }

  const ctx = await launchAccountContext(email, { cookieData });
  const page = await ctx.newPage();

  console.log(`  [pin-cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });

  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    deleteCookieForEmail(email);
    await ctx.close().catch(() => {});
    throw new CookieExpiredError(email);
  }

  // Handle MFA / verifikasi tambahan jika muncul. checkForExtraVerification
  // mendeteksi lewat isi halaman juga (bukan cuma URL "/mfa"), dan untuk akun
  // MAHESH kode diambil dari Mahesh Bot, bukan nfpro — jadi isMahesh WAJIB dioper.
  await checkForExtraVerification(page, email, isMahesh);

  if (page.url() !== targetUrl) {
    console.log(`  [pin-cookie] Navigate ulang ke ${targetUrl} setelah verifikasi...`);
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_NAV,
    });
  }

  console.log(`  [pin-cookie] Berhasil akses: ${page.url()}`);
  return page;
}

// ── Ganti PIN ─────────────────────────────────────────────
async function changePinsForProfilesCookie(
  email,
  password,
  targetProfiles,
  isMahesh = false,
) {
  const pinChanges = new Map();
  let page;

  try {
    const startUrl = "https://www.netflix.com/account/profiles";
    page = await newCookiePage(email, startUrl, isMahesh);
    await sleep(2000);

    const targets = targetProfiles.map((t) => t.trim().toLowerCase());

    for (const target of targets) {
      console.log(`\n  [pin-cookie] ➔ Memproses profil target: "${target}"`);

      // 1. Pastikan selalu mulai dari halaman daftar profil di setiap iterasi
      if (!page.url().includes("/account/profiles")) {
        await page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT_NAV,
        });
        await sleep(2000);
      }

      // Cari tombol profil yang namanya persis dengan target
      const profileButtons = page.locator(
        'button[data-uia^="menu-card+account-profiles-page+profiles-menu-card+"]',
      );
      const count = await profileButtons.count();
      let targetBtn = null;

      for (let i = 0; i < count; i++) {
        const btn = profileButtons.nth(i);
        const text = (await btn.textContent()) || "";

        // Bersihkan teks Netflix dan target: jadikan huruf kecil, ubah spasi ganda jadi spasi tunggal, dan hilangkan spasi ujung
        const cleanText = text.toLowerCase().replace(/\s+/g, " ").trim();
        const cleanTarget = target.toLowerCase().replace(/\s+/g, " ").trim();

        // Gunakan .includes() untuk mengabaikan teks tambahan tersembunyi dari Netflix (seperti "Now Watching")
        if (cleanText.includes(cleanTarget)) {
          targetBtn = btn;
          break;
        }
      }

      if (!targetBtn) {
        console.warn(
          `  [pin-cookie] ⚠ Profil "${target}" tidak ditemukan di halaman ini.`,
        );
        continue;
      }

      // 2. Klik profil (Masuk ke halaman Manage profile and preferences)
      console.log(`  [pin-cookie] Klik profil "${target}"...`);
      await targetBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1500);

      // 3. Klik tombol Profile Lock / Kunci Profil
      const profileLockBtn = page.locator(
        '[data-uia="menu-card+profile-lock"]',
      );
      if (
        !(await profileLockBtn.isVisible({ timeout: 5000 }).catch(() => false))
      ) {
        console.warn(
          `  [pin-cookie] ⚠ Tombol Profile Lock tidak ditemukan untuk "${target}".`,
        );
        continue;
      }
      console.log(`  [pin-cookie] Masuk ke pengaturan Profile Lock...`);
      await profileLockBtn.click();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1500);

      // 4. Klik Edit PIN (Jika PIN sudah aktif sebelumnya)
      const editPinBtn = page.locator(
        '[data-uia="profile-lock-page+edit-button"]',
      );
      if (await editPinBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  [pin-cookie] Klik tombol Edit PIN...`);
        await editPinBtn.click();
        await sleep(1500);
      }

      // 5. Cek Form MFA (Confirm Password / Email Code)
      const confirmPwBtn = page.locator(
        'button:has([data-uia="account-mfa-button-PASSWORD+label"])',
      );
      if (await confirmPwBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(
          `  [pin-cookie] MFA Terdeteksi, memilih Confirm Password...`,
        );
        await confirmPwBtn.click();
        await sleep(1000);

        // 6. Masukkan Password Akun
        const pwInput = page.locator(
          '[data-uia="collect-password-input-modal-entry"]',
        );
        const konfirmPwButtons = page.locator(
        '[data-uia="collect-input-submit-cta"]',
      );
        console.log(`  [pin-cookie] Memasukkan password akun...`);
        await pwInput.fill(password);
        await sleep(500);

        // Tekan Enter untuk submit modal password
        await konfirmPwButtons.click();

        // Tunggu hingga masuk ke input PIN atau muncul error password
        await Promise.race([
          page
            .locator('[data-uia="profile-lock+pin-input"]')
            .waitFor({ state: "visible", timeout: 10_000 }),
          page
            .locator('[data-uia="input-message-error"]')
            .waitFor({ state: "visible", timeout: 10_000 }),
        ]).catch(() => {});

        const pwError = page.locator(
          '[data-uia="input-message-error"], .ui-message-error',
        );
        if (await pwError.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.error(`  [pin-cookie] ✗ Password ditolak.`);
          throw new WrongPasswordError(email);
        }
      }

      // 7. Input PIN Baru (Format input tunggal)
      const pinInput = page.locator('[data-uia="profile-lock+pin-input"]');
      if (!(await pinInput.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.warn(
          `  [pin-cookie] ⚠ Form input PIN gagal dimuat untuk "${target}".`,
        );
        continue;
      }

      // PIN lama tidak bisa dibaca (masked) — langsung generate PIN baru acak
      const newPin = generateNewPin("????"); // "????" tidak akan pernah sama dengan 4-digit angka
      console.log(`  [pin-cookie] "${target}" ➔ PIN baru: ${newPin}`);

      // Bersihkan dan ketik PIN baru, lalu verifikasi nilai ter-set dengan benar
      await pinInput.fill("");
      await pinInput.fill(newPin);
      await sleep(300);

      // Triple-check: pastikan input benar-benar berisi newPin sebelum save
      // Beberapa implementasi React mungkin butuh click+type alih-alih fill
      const currentVal = await pinInput.inputValue().catch(() => "");
      if (currentVal !== newPin) {
        console.log(`  [pin-cookie] fill() tidak ter-set, coba click+selectAll+type...`);
        await pinInput.click({ clickCount: 3 });
        await pinInput.type(newPin, { delay: 80 });
        await sleep(300);
      }

      // Centang "Require PIN to add new profiles" jika muncul dan kamu butuh (Opsional)
      // await page.locator('input[type="checkbox"]').check().catch(()=>{});

      // 8. Simpan PIN
      console.log("  [pin-cookie] Menyimpan PIN...");
      const savePinBtn = page.locator(
        '[data-uia="profile-lock-pin-entry-page+save-button"]',
      );
      await savePinBtn.click();

      // Tunggu hingga URL berpindah keluar dari halaman pin-entry
      await page
        .waitForURL((url) => !url.toString().includes("pin-entry"), {
          timeout: TIMEOUT_NAV,
        })
        .catch(() => {});
      await sleep(1000);

      // 9. Verifikasi: pastikan tidak ada error message (PIN tidak tersimpan)
      const saveError = page.locator(
        '[data-uia="input-message-error"], .ui-message-error, [data-uia="profile-lock-page+error"]',
      );
      if (await saveError.isVisible({ timeout: 2000 }).catch(() => false)) {
        const errText = (await saveError.textContent().catch(() => "")) || "";
        console.error(`  [pin-cookie] ✗ Gagal simpan PIN untuk "${target}": ${errText.trim()}`);
        continue; // skip — jangan set pinChanges agar tidak tulis PIN salah ke sheet
      }

      // 10. Verifikasi: pastikan sudah kembali ke halaman profile lock (bukan masih di pin-entry)
      const finalUrl = page.url();
      if (finalUrl.includes("pin-entry")) {
        console.error(`  [pin-cookie] ✗ Masih di halaman pin-entry setelah save untuk "${target}" — skip.`);
        continue;
      }

      console.log(`  [pin-cookie] ✓ PIN "${target}" berhasil disimpan: ${newPin}`);
      pinChanges.set(target, newPin);
    }

    // Dynamic Update: simpan cookie terbaru dari server setelah semua selesai
    if (pinChanges.size > 0) {
      console.log(
        `\n  [pin-cookie] Selesai! Update PIN sukses untuk: ${[...pinChanges.keys()].join(", ")}`,
      );
      const { refreshAndSaveCookies } = require("./kicker-cookie");
      await refreshAndSaveCookies(page.context(), email);
    } else {
      console.log("\n  [pin-cookie] Tidak ada profil yang berhasil diubah.");
      await debugShot(page, `pin_no_changes_${email.split("@")[0]}`);
    }
  } finally {
    if (page) await page.context().close().catch(() => {});
  }

  return pinChanges;
}

module.exports = {
  changePinsForProfilesCookie,
  CookieExpiredError,
  WrongPasswordError,
};
