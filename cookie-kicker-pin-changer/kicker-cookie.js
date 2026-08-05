/**
 * kicker-cookie.js — Kick device Netflix via Cookie Injection
 *
 * Perbedaan dari kicker.js:
 *  - TIDAK ada proses login (tidak perlu email + password)
 *  - Cookie di-inject langsung ke browser context
 *  - Jika cookie expired → throw CookieExpiredError (bukan crash)
 *  - Logic kick device SAMA persis dengan kicker.js
 *
 * SETUP AWAL:
 *   node cookie-helper.js save-interactive "email@gmail.com"
 *
 * PEMAKAIAN:
 *   const { kickDevicesForProfilesCookie } = require("./kicker-cookie");
 *   await kickDevicesForProfilesCookie("email@gmail.com", ["Profil A", "Profil B"]);
 */

"use strict";

require("dotenv").config();
const { requestCodeFromTelegram } = require("./tg-bridge");
const { chromium } = require("playwright");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
} = require("./cookie-helper");
const fs = require("fs");

const HEADLESS = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;

const URL_DEVICES = "https://www.netflix.com/manageaccountaccess";

// ── Custom Errors ─────────────────────────────────────────
class CookieExpiredError extends Error {
  constructor(email) {
    super(
      `Cookie expired untuk ${email}. Jalankan: node cookie-helper.js save-interactive "${email}"`,
    );
    this.name = "CookieExpiredError";
    this.email = email;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Ekstrak nama profil dari teks card Netflix ────────────
/**
 * Netflix menampilkan info profil di card device dalam format:
 *   "3 - baca snk! (terakhir ditonton)"
 *   "1 - LATTE☕ (terakhir ditonton)"
 *   "2 - BAI LU🐰 (terakhir ditonton)"
 *   "1 - DOOR 1 (terakhir ditonton)"
 *   "1 - snk baca!! (terakhir ditonton)"
 *
 * Fungsi ini mengekstrak HANYA nama profil bersih tanpa prefix angka,
 * tanpa teks "(terakhir ditonton)", dan tanpa spasi berlebih.
 *
 * Output contoh:
 *   "baca snk!"  |  "latte☕"  |  "bai lu🐰"  |  "door 1"
 *
 * @param {string} profileLine - satu baris teks dari card yang mengandung "terakhir ditonton"
 * @returns {string} nama profil bersih (lowercase), atau "" jika gagal parse
 */
function extractProfileName(profileLine) {
  if (!profileLine) return "";

  // 1. Ambil bagian sebelum "(" → buang "(terakhir ditonton ...)"
  const beforeParen = profileLine.split("(")[0];

  // 2. Strip prefix angka + dash: "3 - " atau "12 - "
  //    Hati-hati: jangan strip angka yang bagian dari nama seperti "DOOR 1", "HOME2", "AAA1"
  //    Format prefix Netflix SELALU: <angka> <spasi> <dash> <spasi> <nama>
  const stripped = beforeParen.replace(/^\d+\s+-\s+/, "");

  // 3. Normalize: lowercase, trim, collapse multiple whitespace
  return stripped.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cek apakah nama profil dari card Netflix cocok dengan nama target dari spreadsheet.
 * Aman untuk semua jenis nama: emoji, tanda baca, angka, spasi, karakter khusus.
 *
 * Strategi matching (dari paling ketat ke paling longgar):
 *  1. Exact match setelah normalize
 *  2. Target mengandung nameOnCard (guard: min 3 char) — antisipasi Netflix tambah spasi
 *  3. nameOnCard mengandung target (guard: min 3 char) — antisipasi nama profil dipotong
 *
 * TIDAK pakai substring match yang terlalu bebas untuk menghindari false positive
 * pada nama mirip: "DOOR 1" vs "DOOR 2", "HOME1" vs "HOME2", "PAWPAW 1" vs "PAWPAW 2"
 *
 * @param {string} nameOnCard  - hasil extractProfileName() — sudah lowercase
 * @param {string} targetName  - nama profil dari spreadsheet (kolom C)
 * @returns {boolean}
 */
function profileNameMatches(nameOnCard, targetName, rawProfileText = "") {
  if (!nameOnCard || !targetName) return false;

  // Normalisasi: lowercase + collapse whitespace, pertahankan emoji/simbol
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

  // Normalisasi tanpa emoji — untuk fallback kalau target di sheet tidak pakai emoji
  const normNoEmoji = (s) =>
    s
      .toLowerCase()
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  const a = norm(nameOnCard);
  const b = norm(targetName);

  // 1. Exact match dengan emoji
  if (a === b) return true;

  // 2. Exact match tanpa emoji (salah satu sisi punya emoji, satunya tidak)
  const aNoEmoji = normNoEmoji(nameOnCard);
  const bNoEmoji = normNoEmoji(targetName);
  const aHasEmoji = a !== aNoEmoji;
  const bHasEmoji = b !== bNoEmoji;
  if ((aHasEmoji || bHasEmoji) && aNoEmoji === bNoEmoji && aNoEmoji.length > 0) return true;

  // 3. Substring match dengan word-boundary
  //    Guard: tidak diakhiri angka (hindari "DOOR 1" vs "DOOR 2", "PAWPAW 1" vs "PAWPAW 2")
  if (a.length >= 4 && b.length >= 4) {
    const shorterEndsWithDigit = (s) => /\d$/.test(s);
    const isWordBoundaryMatch = (longer, shorter) => {
      const idx = longer.indexOf(shorter);
      if (idx === -1) return false;
      const before = idx === 0 ? " " : longer[idx - 1];
      const after = idx + shorter.length >= longer.length ? " " : longer[idx + shorter.length];
      return before === " " && after === " ";
    };
    if (!shorterEndsWithDigit(b) && isWordBoundaryMatch(a, b)) return true;
    if (!shorterEndsWithDigit(a) && isWordBoundaryMatch(b, a)) return true;
  }

  // 4. Fallback: regex word-boundary pada teks mentah Netflix (seperti kode lama)
  //    Menangani nama pendek (< 4 char) dan karakter khusus yang lolos dari cek di atas
  //    Contoh: "dnd", "yah okay", "aint over", "fine", "shyt"
  if (rawProfileText) {
    try {
      const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(rawProfileText)) return true;
    } catch {
      // regex invalid (karakter aneh) — abaikan
    }
  }

  return false;
}

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

// ── Launch Browser ────────────────────────────────────────
async function launchBrowser() {
  const proxyConfig = process.env.PROXY_SERVER
    ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  return chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,
    proxy: proxyConfig,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--lang=id-ID",
    ],
  });
}

// ── Buat Context + Inject Cookie ─────────────────────────
/**
 * Buat browser context baru, inject cookie Netflix, lalu buka halaman target.
 * @param {import('playwright').Browser} browser
 * @param {string} email
 * @param {string} targetUrl
 * @returns {Promise<import('playwright').Page>}
 * @throws {CookieExpiredError} jika redirect ke /login
 */
async function newCookiePage(browser, email, targetUrl) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new CookieExpiredError(email);
  }

  const proxyConfig = process.env.PROXY_SERVER
    ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "id-ID",
    extraHTTPHeaders: { "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8" },
    proxy: proxyConfig,
  });

  // Inject cookie SEBELUM navigate
  await ctx.addCookies(buildPlaywrightCookies(cookieData));

  const page = await ctx.newPage();

  // Langsung ke halaman target
  console.log(`  [cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });

  // Cek apakah Netflix redirect ke login (cookie expired)
  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    await debugShot(page, `cookie_expired_${email.split("@")[0]}`);
    deleteCookieForEmail(email);
    await page.close();
    throw new CookieExpiredError(email);
  }

  // MFA ditangani oleh checkForExtraVerification — jangan throw di sini
  console.log(`  [cookie] Berhasil akses: ${url}`);
  return page;
}

// ── Verifikasi MFA (jika muncul) ─────────────────────────
/**
 * Handle halaman /mfa yang muncul saat akses halaman sensitif.
 * Cookie masih valid — Netflix hanya minta verifikasi tambahan untuk IP baru.
 * Strategi: klik "Email a code", fetch kode otomatis via nfpro.js, submit.
 * Auto-retry jika kode salah (klik "Kirim Ulang Kode").
 */
async function checkForExtraVerification(page, email, isMahesh = false) {
  await sleep(1000);
  const url = page.url();
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const needsMfa =
    url.includes("/mfa") ||
    bodyText.toLowerCase().includes("verifikasi identitas") ||
    bodyText.toLowerCase().includes("verify your identity") ||
    bodyText.toLowerCase().includes("email a code") ||
    bodyText.toLowerCase().includes("kirim kode");

  if (!needsMfa) return; // tidak perlu verifikasi

  console.log(`  [mfa] Halaman verifikasi terdeteksi (${url})`);

  // ── Loop retry jika kode salah ──────────────────────────
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  [mfa] Attempt ${attempt}/3`);

    // Klik tombol kirim kode via email (atau "Kirim Ulang" jika retry)
    const emailCodeBtn = page
      .locator(
        'button:has-text("Email a code"), button:has-text("Kirim kode"), button:has-text("Kirim Ulang Kode"), [data-uia="account-mfa-button-OTP_EMAIL"] button',
      )
      .first();

    if (await emailCodeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol kirim kode...`);
      await emailCodeBtn.click();
    }

    // Tunggu form OTP muncul
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll(
            'input[inputmode="numeric"], input[maxlength="1"]',
          ).length >= 4 ||
          document.body.innerText.toLowerCase().includes("code will expire") ||
          document.body.innerText
            .toLowerCase()
            .includes("kode tersebut akan kedaluwarsa"),
        { timeout: 15_000, polling: 500 },
      )
      .catch(() => {});

    console.log(`  [mfa] Tunggu 10 detik agar email terkirim...`);
    await sleep(10_000);

    // Coba auto-fetch kode
    let code6 = null;
    try {
      if (isMahesh) {
        // Akun MAHESH: fetch via bot Telegram @Maheshshoppiebot
        // Tombol "Verification Code" (vercode) — bukan "Verification code after login" (signin6)
        const { fetchFromMaheshBot } = require("./mahesh-fetcher");

        const maheshExtraRetries = 2; // percobaan tambahan: kirim ulang di Netflix + tunggu 5s + minta lagi
        for (let mAttempt = 1; mAttempt <= maheshExtraRetries + 1; mAttempt++) {
          console.log(
            `  [mfa] Fetch kode via Mahesh Bot (percobaan ${mAttempt}/${maheshExtraRetries + 1})...`,
          );
          try {
            code6 = await fetchFromMaheshBot(email, "vercode", {
              retries: 0,
              retryDelay: 5000,
            });
            break; // sukses, keluar dari loop mahesh
          } catch (maheshErr) {
            console.warn(
              `  [mfa] Mahesh Bot gagal (percobaan ${mAttempt}): ${maheshErr.message}`,
            );

            if (mAttempt <= maheshExtraRetries) {
              // Kirim ulang kode di halaman Netflix
              const resendBtn = page
                .locator(
                  'button:has-text("Kirim Ulang Kode"), button:has-text("Resend"), button:has-text("Email a code"), button:has-text("Kirim kode")',
                )
                .first();
              if (
                await resendBtn.isVisible({ timeout: 3000 }).catch(() => false)
              ) {
                console.log(`  [mfa] Klik kirim ulang kode di Netflix...`);
                await resendBtn.click();
              } else {
                console.warn(
                  `  [mfa] Tombol kirim ulang tidak ditemukan di halaman Netflix.`,
                );
              }
              console.log(
                `  [mfa] Tunggu 5 detik sebelum minta kode lagi ke Mahesh Bot...`,
              );
              await sleep(5000);
            } else {
              throw maheshErr; // habis semua percobaan, lempar ke catch luar → fallback Telegram
            }
          }
        }
      } else {
        // Akun lain: fetch via nfpro.js
        const { fetchNetflixCode } = require("./nfpro");
        console.log(`  [mfa] Auto-fetch kode 6 digit via nfpro...`);
        code6 = await fetchNetflixCode(email, "signin6", {
          retries: 2,
          retryDelay: 5000,
        });
      }
      console.log(`  [mfa] Kode: ${code6}`);
    } catch (err) {
      console.warn(`  [mfa] Auto-fetch gagal: ${err.message}`);
      // Fallback: minta kode via Telegram bot (bukan terminal lagi)
      console.log(`  [mfa] Minta kode manual via Telegram...`);
      try {
        code6 = await requestCodeFromTelegram(
          email,
          "6digit",
          isMahesh ? "MAHESH" : "",
        );
      } catch (tgErr) {
        console.error(
          `  [mfa] Gagal dapat kode dari Telegram: ${tgErr.message}`,
        );
        throw new Error(
          `MFA gagal untuk ${email}: auto-fetch dan Telegram fallback sama-sama gagal.`,
        );
      }
    }

    if (!code6) {
      throw new Error(`Kode MFA tidak tersedia untuk ${email}`);
    }

    // ── Isi kotak OTP — tiru fillOtpBoxes dari kicker.js ──
    const digits = code6.replace(/\D/g, "").split("");
    console.log(`  [mfa] Isi ${digits.length} digit: ${code6}`);

    // Cari input dengan urutan prioritas sama seperti kicker.js
    const selectors = [
      'input[inputmode="numeric"]',
      'input[maxlength="1"]',
      'input[autocomplete="one-time-code"]',
    ];

    let inputs = [];
    for (const sel of selectors) {
      inputs = await page.$$(sel);
      if (inputs.length >= digits.length) break;
    }

    console.log(`  [mfa] Input boxes ditemukan: ${inputs.length}`);

    if (inputs.length === 0) {
      // Fallback: satu input field
      console.log(`  [mfa] Fallback ke single input...`);
      const single = page
        .locator('input[type="text"], input[type="number"]')
        .first();
      if (await single.isVisible({ timeout: 2000 }).catch(() => false)) {
        await single.fill(code6);
      }
    } else if (inputs.length === 1) {
      // Single input — isi sekaligus (Netflix /mfa pakai satu input autocomplete)
      console.log(`  [mfa] Single input — isi sekaligus: ${code6}`);
      await inputs[0].click();
      await sleep(100);
      // Clear dulu
      await inputs[0].evaluate((el) => {
        el.value = "";
      });
      // Set value via React-compatible setter
      await inputs[0].evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, code6);
      await sleep(300);
    } else {
      // Multiple boxes — isi digit per digit
      for (let i = 0; i < digits.length && i < inputs.length; i++) {
        await inputs[i].click();
        await inputs[i].press(digits[i]);
        await sleep(100);
      }
    }

    // Tunggu sebentar sebelum submit (agar React state update selesai)
    await sleep(500);

    // Submit
    const submitBtn = page
      .locator('button[type="submit"], button:has-text("Kirim")')
      .first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol Kirim...`);
      await submitBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Tunggu response dari server
    await sleep(3000);

    // ── Cek apakah kode salah ──────────────────────────────
    const bodyAfter = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const urlAfter = page.url();

    // Sukses: keluar dari /mfa
    if (!urlAfter.includes("/mfa")) {
      console.log(`  [mfa] ✅ Verifikasi berhasil! URL: ${urlAfter}`);
      return;
    }

    // Kode salah: ada error message
    const isWrongCode =
      bodyAfter.toLowerCase().includes("kode tersebut salah") ||
      bodyAfter.toLowerCase().includes("code is incorrect") ||
      bodyAfter.toLowerCase().includes("kode salah");

    if (isWrongCode && attempt < 3) {
      console.warn(`  [mfa] ❌ Kode salah. Coba lagi...`);
      await sleep(2000);
      continue; // retry loop
    }

    if (attempt === 3) {
      throw new Error(`MFA gagal setelah 3 percobaan untuk ${email}`);
    }
  }
}

/**
 * Tunggu toast konfirmasi dari Netflix setelah klik "Keluar",
 * DAN pastikan toast tersebut menyebut nama device yang SAMA
 * dengan yang barusan kita proses — bukan toast lama/device lain.
 *
 * @param {import('playwright').Page} page
 * @param {string} deviceName  - nama device yang diharapkan (misal "PC Chrome - Browser Web")
 * @param {number} timeoutMs
 * @returns {Promise<string|null>} teks toast jika cocok, null jika tidak
 */
async function waitForKickToastMatch(page, deviceName, timeoutMs = 10000) {
  try {
    const toast = page.locator('div[role="alert"]').last();
    await toast.waitFor({ state: "visible", timeout: timeoutMs });
    const text = await toast.innerText().catch(() => "");
    const lower = text.toLowerCase();

    const isKickPhrase =
      lower.includes("dihentikan aksesnya") ||
      lower.includes("kini telah dihentikan") ||
      (lower.includes("device") && lower.includes("signed out")) ||
      lower.includes("is now signed out");

    const nameMatches = deviceName && text.includes(deviceName);

    if (isKickPhrase && nameMatches) {
      return text.trim();
    }

    if (isKickPhrase && !nameMatches) {
      console.warn(
        `  [kick-verify] ⚠ Toast muncul tapi NAMA DEVICE TIDAK COCOK. Toast: "${text.trim()}" | Diharapkan: "${deviceName}"`,
      );
    }

    return null;
  } catch {
    return null;
  }
}

// ── Kick Device Logic ─────────────────────────────────────
// (Sama persis dengan kicker.js — dipindah ke sini agar file ini standalone)
// ── Kick Device Logic ─────────────────────────────────────
async function kickDevicesByProfiles(page, profileNames) {
  const targets = profileNames.map((p) => p.trim().toLowerCase());
  let totalKicked = 0;

  await sleep(1500);

  // Expand "Tampilkan Lainnya" sampai habis sebelum mulai proses scan
  let more = true;
  while (more) {
    const showMore = page.locator('[data-uia="device-list+show-more-button"]');
    if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showMore.click();
      console.log("  [kick] Klik Tampilkan Lainnya...");
      await sleep(1200);
    } else {
      more = false;
    }
  }

  const MAX_ROUNDS = 100;
  let hitRoundLimit = true;

  // Scan dari atas setiap round untuk menghindari bug pergeseran posisi DOM
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 1. Ambil state DOM paling segar (fresh)
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();

    // Jika tidak ada card sama sekali, berarti list kosong / sudah habis
    if (count === 0) {
      hitRoundLimit = false;
      break;
    }

    let kickedInThisRound = false;

    // 2. Scan pelan-pelan dari urutan paling atas
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);

      // Pastikan card masih ter-render di DOM
      if (!(await card.isVisible().catch(() => false))) {
        continue;
      }

      // Skip PERANGKAT SAAT INI (abaikan dan lanjut cek card di bawahnya)
      const isCurrent =
        (await card
          .locator('[data-uia$="+current-device-badge+ANNOUNCE"]')
          .count()) > 0;
      if (isCurrent) {
        continue;
      }

      // Expand card jika belum ada tombol Keluar
      const keluarBtn = card
        .locator('button:has-text("Keluar"), button:has-text("Sign Out")')
        .first();
      let isExpanded = await keluarBtn
        .isVisible({ timeout: 500 })
        .catch(() => false);

      if (!isExpanded) {
        const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
        if (await dropBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await dropBtn.click();
          await sleep(1800); // Jeda sebentar agar animasi expand selesai
          isExpanded = await keluarBtn
            .isVisible({ timeout: 1500 })
            .catch(() => false);
        }

        // Jika tetap tidak bisa di-expand, skip ke card berikutnya
        if (!isExpanded) {
          continue;
        }
      }

      // 3. Baca teks card untuk deteksi nama profil
      const cardText = await card.innerText().catch(() => "");
      const lowerText = cardText.toLowerCase();

      let profileText = null;
      const lines = cardText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const deviceName = lines[0] ?? "";

      for (const line of lines) {
        if (
          line.toLowerCase().includes("terakhir ditonton") ||
          line.toLowerCase().includes("last watched")
        ) {
          profileText = line;
          break;
        }
      }

      if (
        profileText &&
        (profileText.toLowerCase().includes("tidak ada aktivitas") ||
          profileText.toLowerCase().includes("no activity"))
      ) {
        profileText = null;
      }

      const nameOnCard = extractProfileName(profileText ?? "");
      const matchedTarget = profileText
        ? targets.find((t) => profileNameMatches(nameOnCard, t, profileText))
        : undefined;

      // Debug: log hasil matching untuk memudahkan diagnosis
      if (profileText) {
        console.log(
          `  [kick] 🔍 Card "${deviceName}" → profil: "${nameOnCard}" | targets: [${targets.join(", ")}] | match: ${matchedTarget ?? "❌ tidak ada"}`,
        );
      }

      // Filter: Jika ada profil tapi tidak cocok dengan target, skip
      if (profileText && !matchedTarget) {
        continue;
      }

      // Filter: Jika tidak ada profil (tidak ada aktivitas):
      // Kick HANYA jika tidak ada profil non-target yang masih aktif di akun ini.
      // Alasan: device tanpa aktivitas bisa milik profil yang belum expired.
      // Kalau semua profil yang teridentifikasi adalah target → aman untuk dikick.
      if (!profileText) {
        const allCards = page.locator('li[data-uia^="device-list+"]');
        const allCount = await allCards.count();
        let hasNonTargetProfile = false;
        for (let ci = 0; ci < allCount; ci++) {
          const c = allCards.nth(ci);
          const cText = await c.innerText().catch(() => "");
          let cProfileLine = null;
          for (const cl of cText.split("\n").map((l) => l.trim()).filter(Boolean)) {
            if (
              cl.toLowerCase().includes("terakhir ditonton") ||
              cl.toLowerCase().includes("last watched")
            ) {
              if (
                !cl.toLowerCase().includes("tidak ada aktivitas") &&
                !cl.toLowerCase().includes("no activity")
              ) {
                cProfileLine = cl;
              }
              break;
            }
          }
          if (!cProfileLine) continue;
          const cName = extractProfileName(cProfileLine);
          const isTarget = targets.some((t) => profileNameMatches(cName, t, cProfileLine));
          if (!isTarget) {
            hasNonTargetProfile = true;
            console.log(
              `  [kick] ⏭ Skip "${deviceName}" (tidak ada aktivitas) — ada profil aktif non-target: "${cName}"`,
            );
            break;
          }
        }
        if (hasNonTargetProfile) continue;
        console.log(
          `  [kick] 🎯 "${deviceName}" tidak ada aktivitas & semua profil teridentifikasi adalah target — lanjut kick.`,
        );
      }

      // 4. Proses Kick! (profil match target, atau tidak ada aktivitas & aman dikick)
      const keluarVisible = await keluarBtn
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      const display = profileText ?? "tidak ada aktivitas";

      if (keluarVisible) {
        await keluarBtn.scrollIntoViewIfNeeded().catch(() => {});

        // Pastikan tidak ada toast lama yang menghalangi sebelum klik
        const blockingToast = page.locator('div[role="alert"]').last();
        if (await blockingToast.isVisible({ timeout: 500 }).catch(() => false)) {
          const closeBtn = page
            .locator(
              'button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]',
            )
            .first();
          if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await closeBtn.click().catch(() => {});
          } else {
            await blockingToast
              .waitFor({ state: "hidden", timeout: 5000 })
              .catch(() => {});
          }
          await sleep(500);
        }

        try {
          await keluarBtn.click({ timeout: 10000 });
        } catch (clickErr) {
          console.warn(
            `  [kick] ⚠ Klik normal gagal (${clickErr.message.split("\n")[0]}), coba force click...`,
          );
          await debugShot(
            page,
            `click_blocked_${deviceName.replace(/\s+/g, "_")}`,
          );
          await keluarBtn.click({ force: true, timeout: 10000 });
        }

        // Verifikasi: toast HARUS muncul
        const toastText = await waitForKickToastMatch(page, deviceName, 10000);
        if (toastText) {
          totalKicked++;
          console.log(
            `  [kick] ✅ Dikick & terverifikasi: "${deviceName}" (profil: ${display})`,
          );

          // 5. Tutup Toast (menangani bug penumpukan / menghalangi elemen)
          const closeToastBtn = page
            .locator(
              'button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]',
            )
            .first();
          if (
            await closeToastBtn.isVisible({ timeout: 3000 }).catch(() => false)
          ) {
            await closeToastBtn.click().catch(() => {});
            console.log(`  [kick] ℹ️ Toast ditutup.`);
          } else {
            // Tunggu sampai toast menghilang sendiri sebelum lanjut
            await page
              .locator('div[role="alert"]')
              .last()
              .waitFor({ state: "hidden", timeout: 6000 })
              .catch(() => {});
          }

          // 6. JEDA PANJANG: Beri waktu agar card yang dikick menghilang & DOM bergeser rapi
          console.log(`  [kick] ⏳ Menunggu DOM stabil (4 detik)...`);
          await sleep(4000);

          // BREAK: Karena DOM berubah (ada device yang terhapus), reset scan dari indeks 0
          kickedInThisRound = true;
          break;
        } else {
          console.warn(
            `  [kick] ⚠ MISS: "${deviceName}" (profil: ${display}) — toast tidak muncul!`,
          );
          // Tutup toast lama yang mungkin masih ada dan menghalangi klik berikutnya
          const staleToast = page.locator(
            'button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]',
          ).first();
          if (await staleToast.isVisible({ timeout: 1000 }).catch(() => false)) {
            await staleToast.click().catch(() => {});
          } else {
            await page
              .locator('div[role="alert"]')
              .last()
              .waitFor({ state: "hidden", timeout: 4000 })
              .catch(() => {});
          }
          await sleep(1500);
          // JANGAN set kickedInThisRound = true — agar loop bisa lanjut scan card berikutnya
          // JANGAN break — lanjut cek card lain di round ini
        }
      } else {
        console.warn(
          `  [kick] ⚠ MISS: "${deviceName}" (profil: ${display}) — tombol Keluar tidak muncul!`,
        );
      }
    }

    // Jika dalam 1 putaran full tidak ada satupun yang di-kick, berarti semua target sudah bersih
    if (!kickedInThisRound) {
      hitRoundLimit = false;
      break;
    }
  }

  if (hitRoundLimit) {
    console.warn(
      `  [kick] ⚠ Mencapai batas ${MAX_ROUNDS} putaran — mungkin masih ada device tersisa. ` +
        `Pertimbangkan menjalankan ulang untuk akun ini.`,
    );
  }

  return totalKicked;
}

// ── Entry Point ───────────────────────────────────────────

/**
 * Kick devices untuk beberapa profil sekaligus (satu email).
 * @param {string}   email
 * @param {string[]} profileNames
 * @returns {Promise<{ kicked: number }>}
 * @throws {CookieExpiredError} jika cookie tidak ada / expired
 */
// ── Dynamic Update: simpan cookie terbaru dari server ─────
/**
 * Setelah setiap operasi berhasil, server Netflix sering refresh cookie.
 * Ambil cookie terbaru dari context dan timpa cookies.json.
 */
async function refreshAndSaveCookies(ctx, email) {
  try {
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

    const netflixId = cm["NetflixId"];
    const secureNetflixId = cm["SecureNetflixId"];

    if (!netflixId || !secureNetflixId) {
      console.log(
        "  [cookie] Dynamic update: cookie baru tidak ditemukan, skip.",
      );
      return;
    }

    const { saveCookieForEmail } = require("./cookie-helper");
    saveCookieForEmail(email, {
      netflixId,
      secureNetflixId,
      memclid: cm["memclid"] ?? null,
      nfvdid: cm["nfvdid"] ?? null,
      clSharedContext: cm["clSharedContext"] ?? null,
    });
    console.log("  [cookie] ✓ Dynamic update: cookie terbaru disimpan.");
  } catch (err) {
    console.warn(`  [cookie] Dynamic update gagal: ${err.message}`);
  }
}

async function kickDevicesForProfilesCookie(
  email,
  profileNames,
  isMahesh = false,
) {
  const browser = await launchBrowser();
  let totalKicked = 0;

  try {
    const page = await newCookiePage(browser, email, URL_DEVICES);

    await checkForExtraVerification(page, email, isMahesh);

    // Jika halaman bukan manageaccountaccess, navigate ulang
    if (!page.url().includes("manageaccountaccess")) {
      console.log("  [kick] Redirect tidak terduga, navigate ulang...");
      await page.goto(URL_DEVICES, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_NAV,
      });
      await checkForExtraVerification(page, email, isMahesh);
    }

    totalKicked = await kickDevicesByProfiles(page, profileNames);
    console.log(`  [kick] Total ${totalKicked} device dikick.`);

    // Dynamic Update: simpan cookie terbaru
    await refreshAndSaveCookies(page.context(), email);
  } finally {
    await browser.close();
  }

  return { kicked: totalKicked };
}

/**
 * Kick devices untuk satu profil.
 * @param {string} email
 * @param {string} profileName
 */
async function kickDevicesForProfileCookie(
  email,
  profileName,
  isMahesh = false,
) {
  return kickDevicesForProfilesCookie(email, [profileName], isMahesh);
}

module.exports = {
  kickDevicesForProfileCookie,
  kickDevicesForProfilesCookie,
  CookieExpiredError,
  checkForExtraVerification,
  refreshAndSaveCookies,
  waitForKickToastMatch,
  extractProfileName,
  profileNameMatches,
};
