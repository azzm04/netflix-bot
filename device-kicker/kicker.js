"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer");
const { fetchNetflixCode } = require("./nfpro");
const { requestCodeFromTelegram } = require("./tg-bridge");

// Mode: "terminal" (lokal) atau "telegram" (server)
const CODE_INPUT_MODE = process.env.CODE_INPUT_MODE ?? "terminal";

const HEADLESS      = process.env.HEADLESS !== "false";
const TIMEOUT_NAV   = 45_000;
const TIMEOUT_SEL   = 20_000;
const DELAY_TYPE    = 80;
const DELAY_KICK    = 2_000;

const URL_CLEARCOOKIES = "https://www.netflix.com/clearcookies";
const URL_DEVICES      = "https://www.netflix.com/manageaccountaccess";

// shouldSkip: no-op, deteksi skip dilakukan di sheets.js via header blok
function shouldSkip(_email) { return false; }

/**
 * Cek apakah password menunjukkan mode "PAKE KODE" (login via kode email).
 * MEET selalu pakai kode, terlepas isi kolom B.
 * @param {string} password
 * @param {boolean} isMeet
 * @returns {boolean}
 */
function isPakeKode(password, isMeet = false) {
  if (isMeet) return true; // MEET selalu pakai 4-digit kode
  if (!password) return true;
  const up = password.toUpperCase().trim();
  return up === "PAKE KODE" || up === "PAKE KODE MASUK" || up === "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minta kode OTP — otomatis pilih input mode:
 * - "terminal"  → input dari keyboard (mode lokal/debug)
 * - "telegram"  → kirim request ke bot Telegram, tunggu reply admin
 *
 * @param {string} email
 * @param {"4digit"|"6digit"} codeType
 * @param {string} accountLabel - "MAHESH" | "ROSE" | ""
 * @returns {Promise<string>}
 */
async function getCodeFromUser(email, codeType, accountLabel = "") {
  if (CODE_INPUT_MODE === "telegram") {
    return requestCodeFromTelegram(email, codeType, accountLabel);
  }
  // Terminal mode (default lokal)
  const readline = require("readline");
  const label = codeType === "4digit" ? "4 digit" : "6 digit";
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  👉 [${email}] Masukkan ${label} kode: `, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

// -------------------------------------------------------
// fillOtpBoxes: isi kode digit per digit ke input OTP
// -------------------------------------------------------
async function fillOtpBoxes(page, code) {
  const digits = code.replace(/\D/g, "").split("");
  const sels = [
    'input[data-uia*="otp"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[maxlength="1"]',
  ];
  let inputs = [];
  for (const sel of sels) {
    inputs = await page.$$(sel);
    if (inputs.length >= digits.length) break;
  }
  if (inputs.length === 0) {
    const single = await page.$('input[type="text"], input[type="number"]');
    if (single) {
      await single.click({ clickCount: 3 });
      await single.type(code, { delay: DELAY_TYPE });
      return;
    }
    throw new Error("Input OTP tidak ditemukan.");
  }
  for (let i = 0; i < digits.length && i < inputs.length; i++) {
    await inputs[i].click();
    await sleep(100);
    await inputs[i].type(digits[i], { delay: 80 });
    await sleep(150);
  }
}

async function submitOtp(page) {
  const sels = [
    'button[data-uia="continue-btn"]',
    'button[type="submit"]',
    'button[data-uia*="submit"]',
    'button[data-uia*="verify"]',
  ];
  for (const sel of sels) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); return; }
  }
  await page.keyboard.press("Enter");
}

// -------------------------------------------------------
// _switchToPasswordLogin
// -------------------------------------------------------
async function _switchToPasswordLogin(page) {
  // Klik "Get Help"
  const clicked = await page.evaluate(() => {
    const all = document.querySelectorAll("button, span, a, div");
    for (const el of all) {
      const t = el.textContent.trim().toLowerCase();
      if (t === "get help" || t === "get help ^") { el.click(); return true; }
    }
    const byUia = document.querySelector(
      '[data-uia="help-menu-toggle"], [data-uia="help-menu-toggle-expanded"]'
    );
    if (byUia) { byUia.click(); return true; }
    return false;
  });

  if (!clicked) { console.log('  [login] "Get Help" tidak ditemukan.'); return false; }
  console.log('  [login] "Get Help" diklik, tunggu expand...');

  // Tunggu "Use password instead" muncul
  try {
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll("a, button, span"))
        .some(el => el.textContent.trim().toLowerCase().includes("use password instead"));
    }, { timeout: 5000 });
  } catch {
    console.log('  [login] "Use password instead" tidak tersedia.');
    return false;
  }

  await page.evaluate(() => {
    for (const el of document.querySelectorAll("a, button, span")) {
      if (el.textContent.trim().toLowerCase().includes("use password instead")) {
        el.click(); return;
      }
    }
  });
  await sleep(800);

  try {
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    console.log('  [login] Beralih ke halaman password berhasil.');
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------
// loginNetflix
// -------------------------------------------------------
async function loginNetflix(browser, email, password, forcePakeKode = false, accountLabel = "") {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });

  console.log("  [login] Membersihkan cookies...");
  await page.goto(URL_CLEARCOOKIES, { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  await sleep(1000);

  try {
    await page.waitForSelector('a[href*="/login"], button[data-uia*="sign-in"]', { timeout: 8000 });
    await page.click('a[href*="/login"], button[data-uia*="sign-in"]');
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  } catch {
    await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
  }
  await sleep(800);

  console.log(`  [login] Mengisi email: ${email}`);
  try {
    await page.waitForSelector(
      'input[name="userLoginId"], input[type="email"], input[autocomplete="email"]',
      { timeout: TIMEOUT_SEL }
    );
  } catch {
    throw new Error("Halaman login tidak ditemukan.");
  }

  const emailInput = await page.$('input[name="userLoginId"], input[type="email"], input[autocomplete="email"]')
    ?? await page.$("input");
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: DELAY_TYPE });
  await sleep(500);

  const contBtn = await page.$('button[data-uia="login-continue-btn"], button[type="submit"]');
  if (contBtn) {
    const t = await contBtn.evaluate(b => b.textContent.trim().toLowerCase());
    if (t.includes("continue") || t.includes("lanjut")) {
      console.log(`  [login] Klik Continue...`);
      await contBtn.click();
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
      await sleep(1500);
    }
  } else {
    // Fallback: tekan Enter
    console.log(`  [login] Tidak ada tombol Continue, tekan Enter...`);
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
    await sleep(1500);
  }

  console.log(`  [login] URL setelah email: ${page.url()}`);

  const isOtpPage = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]');
    const body = document.body.innerText.toLowerCase();
    return inputs.length >= 3 || body.includes("code we sent") || body.includes("enter the code");
  });

  // forcePakeKode = true (MEET) → skip coba password, langsung OTP
  const effectivePakeKode = forcePakeKode || isPakeKode(password);

  let usedOtp = false;

  if (isOtpPage) {
    if (!effectivePakeKode) {
      console.log("  [login] Halaman OTP, coba beralih ke password...");
      const switched = await _switchToPasswordLogin(page);
      if (!switched) {
        console.log("  [login] Netflix paksa OTP untuk akun ini, fallback ke 4-digit kode.");
        usedOtp = true;
      }
    } else {
      // isPakeKode atau forcePakeKode → langsung OTP
      usedOtp = true;
    }

    if (usedOtp) {
      console.log("  [login] Tunggu 10 detik agar email Netflix terkirim...");
      await sleep(10_000);

      let code4;
      if (accountLabel === "MAHESH") {
        // MAHESH: tidak bisa auto-fetch → minta via Telegram atau terminal
        console.log("  [login] MAHESH — minta kode via input...");
        code4 = await getCodeFromUser(email, "4digit", "MAHESH");
      } else {
        // MEET / akun lain → coba auto-fetch dulu, fallback ke input jika gagal
        console.log("  [login] Auto-fetch 4-digit kode dari nfpro.store...");
        try {
          code4 = await fetchNetflixCode(email, "signin", { retries: 3, retryDelay: 5000 });
        } catch (fetchErr) {
          console.warn(`  [login] Auto-fetch gagal: ${fetchErr.message}`);
          console.log("  [login] Fallback: minta kode via input...");
          code4 = await getCodeFromUser(email, "4digit", accountLabel);
        }
      }

      console.log(`  [login] Mengisi kode 4 digit: ${code4}`);
      await fillOtpBoxes(page, code4);
      await submitOtp(page);
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
      await sleep(1500);
    }
  }

  const isPassPage = await page.evaluate(() =>
    !!document.querySelector('input[name="password"], input[type="password"]')
  );

  if (isPassPage && !effectivePakeKode && !usedOtp) {
    console.log("  [login] Mengisi password...");
    const pw = await page.$('input[name="password"], input[type="password"]');
    await pw.click({ clickCount: 3 });
    await pw.type(password, { delay: DELAY_TYPE });
    await sleep(300);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }),
      page.click('button[data-uia="login-submit-button"], button[type="submit"]'),
    ]);
    await sleep(1000);
  }

  const urlAfter = page.url();
  if (urlAfter.includes("/login") || urlAfter.includes("/loginHelp")) {
    throw new Error(`Login gagal untuk ${email}.`);
  }
  console.log(`  [login] Login berhasil: ${urlAfter}`);
  return page;
}

// -------------------------------------------------------
// handleDeviceVerification: verifikasi 6-digit di manageaccountaccess
// -------------------------------------------------------
async function handleDeviceVerification(page, email, accountLabel = "") {
  await sleep(1500);

  // Cek URL dulu — Netflix kadang redirect ke /mfa sebelum manageaccountaccess
  const currentUrl = page.url();
  const isMfaUrl = currentUrl.includes("/mfa") || currentUrl.includes("mfa");

  const needsVerify = isMfaUrl || await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return (
      t.includes("verifikasi identitas") ||
      t.includes("verify your identity") ||
      t.includes("first, let's make sure") ||
      t.includes("make sure it's you") ||
      t.includes("kirim kode") ||
      t.includes("send code") ||
      t.includes("email a code")
    );
  });

  if (!needsVerify) {
    console.log("  [verify] Tidak perlu verifikasi.");
    return;
  }
  console.log(`  [verify] Halaman verifikasi terdeteksi (URL: ${currentUrl})`);

  // Tunggu tombol "Email a code" muncul di DOM
  try {
    await page.waitForSelector(
      '[data-uia="account-mfa-button-OTP_EMAIL"] button, [data-uia*="OTP_EMAIL"]',
      { timeout: 10000 }
    );
  } catch {
    console.log("  [verify] Tombol email code tidak muncul dalam 10 detik, coba lanjut...");
  }
  await sleep(500);

  // Klik tombol "Kirim kode melalui email" / "Email a code"
  // Selector spesifik dari HTML: data-uia="account-mfa-button-OTP_EMAIL"
  // Fallback: cari berdasarkan teks
  const clicked = await page.evaluate(() => {
    // Struktur: <div data-uia="account-mfa-button-OTP_EMAIL"><button ...>
    // Harus klik <button> di dalam div, bukan div-nya langsung
    const container = document.querySelector('[data-uia="account-mfa-button-OTP_EMAIL"]');
    if (container) {
      const btn = container.querySelector("button") ?? container;
      btn.click();
      return "by-uia";
    }

    // Fallback: cari berdasarkan teks di dalam button
    for (const btn of document.querySelectorAll("button, a")) {
      const t = btn.textContent.toLowerCase();
      if (
        t.includes("email a code") ||
        t.includes("kirim kode melalui email") ||
        t.includes("send code via email") ||
        t.includes("kirim kode")
      ) {
        btn.click();
        return "by-text";
      }
    }
    return null;
  });

  if (!clicked) {
    throw new Error("Tombol 'Email a code' tidak ditemukan di halaman verifikasi.");
  }
  console.log(`  [verify] Tombol kode diklik (${clicked}).`);

  // Tunggu Netflix proses klik dan kirim email (beri jeda 2 detik)
  await sleep(2000);

  // Netflix TIDAK melakukan navigasi setelah klik "Email a code"
  // Halaman yang sama akan menampilkan form OTP (kotak input kode)
  console.log("  [verify] Menunggu form OTP muncul...");
  try {
    await page.waitForFunction(() => {
      const inputs = document.querySelectorAll(
        'input[maxlength="1"], input[inputmode="numeric"], input[autocomplete="one-time-code"]'
      );
      const bodyText = document.body.innerText.toLowerCase();
      return inputs.length >= 3 ||
             bodyText.includes("enter the code") ||
             bodyText.includes("masukkan kode") ||
             bodyText.includes("code we sent") ||
             bodyText.includes("code will expire");
    }, { timeout: 20000 });
    console.log("  [verify] Form OTP terdeteksi.");
  } catch {
    console.log("  [verify] Form OTP tidak muncul dalam 20 detik, coba navigasi ulang...");
    // Coba klik ulang tombol
    await page.evaluate(() => {
      const container = document.querySelector('[data-uia="account-mfa-button-OTP_EMAIL"]');
      if (container) {
        const btn = container.querySelector("button") ?? container;
        btn.click();
      }
    });
    await sleep(3000);
    // Tunggu lagi
    await page.waitForFunction(() => {
      const inputs = document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]');
      const bodyText = document.body.innerText.toLowerCase();
      return inputs.length >= 3 || bodyText.includes("code we sent") ||
             bodyText.includes("code will expire");
    }, { timeout: 15000 }).catch(() => {
      console.log("  [verify] Form OTP masih tidak muncul, lanjut dengan asumsi kode sudah terkirim.");
    });
  }
  await sleep(1000);

  console.log("  [verify] Tunggu 10 detik agar email Netflix terkirim...");
  await sleep(10_000);

  let code6;
  if (accountLabel === "MAHESH") {
    console.log("  [verify] MAHESH — minta 6-digit kode via input...");
    code6 = await getCodeFromUser(email, "6digit", "MAHESH");
  } else {
    // Coba auto-fetch dulu, fallback ke input jika gagal
    console.log("  [verify] Auto-fetch 6-digit kode dari nfpro.store...");
    try {
      code6 = await fetchNetflixCode(email, "signin6", { retries: 3, retryDelay: 5000 });
    } catch (fetchErr) {
      console.warn(`  [verify] Auto-fetch gagal: ${fetchErr.message}`);
      console.log("  [verify] Fallback: minta kode via input...");
      code6 = await getCodeFromUser(email, "6digit", accountLabel);
    }
  }
  console.log(`  [verify] Mengisi kode 6 digit: ${code6}`);
  await fillOtpBoxes(page, code6);
  await sleep(400);
  await submitOtp(page);

  // Tunggu navigasi ke manageaccountaccess (atau halaman lain setelah verifikasi)
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
  await sleep(1500);

  // Jika masih di halaman OTP/mfa, coba submit sekali lagi
  const urlAfterSubmit = page.url();
  if (urlAfterSubmit.includes("/mfa") || urlAfterSubmit.includes("otp") ||
      urlAfterSubmit.includes("verify")) {
    console.log(`  [verify] Masih di ${urlAfterSubmit}, coba submit ulang...`);
    await submitOtp(page);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUT_NAV }).catch(() => {});
    await sleep(1500);
  }

  console.log(`  [verify] Verifikasi selesai. URL: ${page.url()}`);
}

// -------------------------------------------------------
// kickDevicesByProfile
//
// Struktur HTML Netflix (dari debug):
//   <ul>
//     <li data-uia="device-list+NFCDCH-0">          ← satu card
//       <button data-uia="device-list+NFCDCH-0+dropdown-button">  ← chevron
//       <span data-uia="..+current-device-badge+ANNOUNCE">PERANGKAT SAAT INI</span> (opsional)
//       [setelah klik dropdown-button]:
//         nama profil "(terakhir ditonton)"
//         <button>Keluar</button>
//     </li>
//   </ul>
//
// PENTING: dropdown-button TIDAK punya aria-expanded.
// Kita track dengan Set<deviceId> mana yang sudah diproses.
// -------------------------------------------------------
async function kickDevicesByProfile(page, profileName) {
  const target = profileName.trim().toLowerCase();
  let totalKicked = 0;
  const processedIds = new Set();

  await sleep(2000);

  // Step 0: Klik "Tampilkan Lainnya" jika ada, sampai tidak ada lagi
  // Selector: data-uia="device-list+show-more-button"
  let showMoreClicks = 0;
  for (let i = 0; i < 10; i++) {
    const hasMore = await page.evaluate(() => {
      const btn = document.querySelector('[data-uia="device-list+show-more-button"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!hasMore) break;
    showMoreClicks++;
    console.log(`  [kick] Klik "Tampilkan Lainnya" (${showMoreClicks})...`);
    await sleep(1500);
  }
  if (showMoreClicks > 0) {
    console.log(`  [kick] Semua card dimuat (${showMoreClicks}x tampilkan lainnya).`);
    await sleep(1000);
  }

  for (let round = 0; round < 20; round++) {

    // Ambil semua device card + cari yang belum diproses
    const nextCard = await page.evaluate((processedArr) => {
      const processed = new Set(processedArr);

      // Semua <li data-uia="device-list+...">
      const cards = Array.from(
        document.querySelectorAll('li[data-uia^="device-list+"]')
      );

      for (let i = 0; i < cards.length; i++) {
        const li = cards[i];
        const deviceId = li.getAttribute("data-uia");
        // Gunakan kombinasi deviceId+index sebagai unique key
        const uniqueKey = `${deviceId}::${i}`;
        if (processed.has(uniqueKey)) continue;

        // Cek apakah card ini sudah expanded (ada tombol Keluar atau ada teks profil)
        const hasKeluar = Array.from(li.querySelectorAll("button"))
          .some(b => b.textContent.trim().toLowerCase() === "keluar" ||
                     b.textContent.trim().toLowerCase() === "sign out");

        if (!hasKeluar) {
          // Belum expanded — klik dropdown button
          const dropBtn = li.querySelector('[data-uia$="+dropdown-button"]');
          if (dropBtn) {
            dropBtn.click();
            return { action: "clicked_expand", deviceId, uniqueKey, index: i };
          }
          return { action: "skip_no_btn", deviceId, uniqueKey, index: i };
        }

        // Sudah expanded — langsung evaluasi
        return { action: "already_expanded", deviceId, uniqueKey, index: i };
      }

      return { action: "all_done" };
    }, [...processedIds]);

    if (nextCard.action === "all_done") {
      console.log(`  [kick] Semua card selesai diproses.`);
      break;
    }

    if (nextCard.action === "skip_no_btn") {
      console.log(`  [kick] Skip ${nextCard.deviceId}[${nextCard.index}] — tidak ada dropdown button`);
      processedIds.add(nextCard.uniqueKey);
      continue;
    }

    // Tunggu expand render (hanya jika baru diklik)
    if (nextCard.action === "clicked_expand") {
      await sleep(1000);
    }

    // Evaluasi isi card setelah expand
    const result = await page.evaluate((deviceId, cardIndex, targetProfile) => {
      const cards = Array.from(document.querySelectorAll('li[data-uia^="device-list+"]'));
      const li = cards[cardIndex];
      if (!li) return { action: "li_not_found" };

      const liText = (li.innerText ?? li.textContent ?? "").toLowerCase();

      // 1. PERANGKAT SAAT INI → SKIP
      const isCurrent = !!li.querySelector('[data-uia$="+current-device-badge+ANNOUNCE"]');
      if (isCurrent) {
        return { action: "skip_current" };
      }

      // Cek apakah sudah expanded (ada tombol Keluar)
      const keluarBtn = Array.from(li.querySelectorAll("button"))
        .find(b => b.textContent.trim().toLowerCase() === "keluar" ||
                   b.textContent.trim().toLowerCase() === "sign out");

      if (!keluarBtn) {
        return { action: "not_expanded_yet" };
      }

      // 2. Deteksi profil ("terakhir ditonton")
      let profileText = null;
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let node2;
      while ((node2 = walker.nextNode())) {
        const t = node2.textContent.trim();
        if (t.toLowerCase().includes("terakhir ditonton") ||
            t.toLowerCase().includes("last watched")) {
          profileText = node2.parentElement.textContent.trim();
          break;
        }
      }

      // Jika profileText adalah pesan "tidak ada aktivitas" → treat sebagai null (kick juga)
      if (profileText && (
        profileText.toLowerCase().includes("tidak ada aktivitas") ||
        profileText.toLowerCase().includes("no activity") ||
        profileText.toLowerCase().includes("no recent activity")
      )) {
        profileText = null;
      }

      const noActivity = liText.includes("tidak ada aktivitas") ||
                         liText.includes("no activity") ||
                         profileText === null;

      // Skip hanya jika: ada profil DAN tidak cocok target
      if (profileText && !profileText.toLowerCase().includes(targetProfile)) {
        return { action: "skip_wrong_profile", profileText };
      }

      // Kick: profil cocok, ATAU tidak ada profil / tidak ada aktivitas
      keluarBtn.click();
      const display = profileText ?? (noActivity ? "tidak ada aktivitas" : "no profile");
      return { action: "kicked", display };

    }, nextCard.deviceId, nextCard.index, target);

    if (result.action === "kicked") {
      totalKicked++;
      console.log(`  [kick] Dikick — "${result.display}" (${nextCard.deviceId}[${nextCard.index}])`);
      processedIds.add(nextCard.uniqueKey);
      await sleep(DELAY_KICK);

    } else if (result.action === "skip_current") {
      console.log(`  [kick] Skip — PERANGKAT SAAT INI (${nextCard.deviceId}[${nextCard.index}])`);
      processedIds.add(nextCard.uniqueKey);

    } else if (result.action === "skip_wrong_profile") {
      console.log(`  [kick] Skip — profil "${result.profileText}" bukan target`);
      processedIds.add(nextCard.uniqueKey);

    } else if (result.action === "not_expanded_yet") {
      // Retry expand sekali lagi tanpa increment
      console.log(`  [kick] Belum expand, retry...`);
      await page.evaluate((cardIndex) => {
        const cards = Array.from(document.querySelectorAll('li[data-uia^="device-list+"]'));
        const li = cards[cardIndex];
        const btn = li?.querySelector('[data-uia$="+dropdown-button"]');
        if (btn) btn.click();
      }, nextCard.index);
      await sleep(1000);

    } else if (result.action === "li_not_found") {
      processedIds.add(nextCard.uniqueKey);

    } else {
      console.log(`  [kick] ${result.action} — skip`);
      processedIds.add(nextCard.uniqueKey);
    }
  }

  return totalKicked;
}

// -------------------------------------------------------
// kickDevicesForProfiles — kick BEBERAPA profil dalam 1 sesi browser
// Login sekali, kick semua profil expired dari email yang sama
// isMeet = true → paksa login via 4-digit kode (skip coba password)
// -------------------------------------------------------
async function kickDevicesForProfiles(email, password, profileNames, isMeet = false, accountLabel = "") {
  if (shouldSkip(email)) {
    return { skipped: true, kicked: 0, reason: "MAHESH/ROSE — no email access." };
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  let totalKicked = 0;
  try {
    const page = await loginNetflix(browser, email, password, isMeet, accountLabel);

    console.log("  [devices] Navigasi ke /manageaccountaccess...");
    await page.goto(URL_DEVICES, { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });

    await handleDeviceVerification(page, email, accountLabel);

    const urlAfterVerify = page.url();
    if (!urlAfterVerify.includes("manageaccountaccess")) {
      console.log(`  [devices] Navigasi ulang dari ${urlAfterVerify}...`);
      await page.goto(URL_DEVICES, { waitUntil: "networkidle2", timeout: TIMEOUT_NAV });
      await sleep(1500);
      await handleDeviceVerification(page, email, accountLabel);
    }

    console.log(`  [devices] Kick ${profileNames.length} profil: ${profileNames.join(", ")}`);
    totalKicked = await kickDevicesByProfiles(page, profileNames);
    console.log(`  [devices] Total ${totalKicked} device dikick untuk ${profileNames.length} profil.`);

  } finally {
    await browser.close();
  }

  return { skipped: false, kicked: totalKicked };
}

async function kickDevicesForProfile(email, password, profileName, isMeet = false, accountLabel = "") {
  return kickDevicesForProfiles(email, password, [profileName], isMeet, accountLabel);
}

// kickDevicesByProfiles — multi profil, logic sama tapi target adalah array
async function kickDevicesByProfiles(page, profileNames) {
  // Normalisasi semua nama profil ke lowercase untuk matching
  const targets = profileNames.map(p => p.trim().toLowerCase());
  let totalKicked = 0;
  const processedIds = new Set();

  await sleep(2000);

  // Klik "Tampilkan Lainnya" sampai habis
  let showMoreClicks = 0;
  for (let i = 0; i < 10; i++) {
    const hasMore = await page.evaluate(() => {
      const btn = document.querySelector('[data-uia="device-list+show-more-button"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!hasMore) break;
    showMoreClicks++;
    console.log(`  [kick] Klik "Tampilkan Lainnya" (${showMoreClicks})...`);
    await sleep(1500);
  }
  if (showMoreClicks > 0) await sleep(1000);

  for (let round = 0; round < 50; round++) {
    const nextCard = await page.evaluate((processedArr) => {
      const processed = new Set(processedArr);
      const cards = Array.from(document.querySelectorAll('li[data-uia^="device-list+"]'));
      for (let i = 0; i < cards.length; i++) {
        const li = cards[i];
        const deviceId = li.getAttribute("data-uia");
        const uniqueKey = `${deviceId}::${i}`;
        if (processed.has(uniqueKey)) continue;
        const hasKeluar = Array.from(li.querySelectorAll("button"))
          .some(b => b.textContent.trim().toLowerCase() === "keluar" ||
                     b.textContent.trim().toLowerCase() === "sign out");
        if (!hasKeluar) {
          const dropBtn = li.querySelector('[data-uia$="+dropdown-button"]');
          if (dropBtn) { dropBtn.click(); return { action: "clicked_expand", deviceId, uniqueKey, index: i }; }
          return { action: "skip_no_btn", deviceId, uniqueKey, index: i };
        }
        return { action: "already_expanded", deviceId, uniqueKey, index: i };
      }
      return { action: "all_done" };
    }, [...processedIds]);

    if (nextCard.action === "all_done") break;
    if (nextCard.action === "skip_no_btn") { processedIds.add(nextCard.uniqueKey); continue; }
    if (nextCard.action === "clicked_expand") await sleep(1000);

    const result = await page.evaluate((cardIndex, targetsArr) => {
      const cards = Array.from(document.querySelectorAll('li[data-uia^="device-list+"]'));
      const li = cards[cardIndex];
      if (!li) return { action: "li_not_found" };
      const liText = (li.innerText ?? li.textContent ?? "").toLowerCase();

      const isCurrent = !!li.querySelector('[data-uia$="+current-device-badge+ANNOUNCE"]');
      if (isCurrent) return { action: "skip_current" };

      const keluarBtn = Array.from(li.querySelectorAll("button"))
        .find(b => b.textContent.trim().toLowerCase() === "keluar" ||
                   b.textContent.trim().toLowerCase() === "sign out");
      if (!keluarBtn) return { action: "not_expanded_yet" };

      let profileText = null;
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (t.toLowerCase().includes("terakhir ditonton") || t.toLowerCase().includes("last watched")) {
          profileText = node.parentElement.textContent.trim();
          break;
        }
      }
      if (!profileText) {
        const pEl = li.querySelector('[data-uia*="profile"]');
        if (pEl) profileText = pEl.textContent.trim();
      }

      // Jika profileText adalah pesan "tidak ada aktivitas", treat sebagai null
      if (profileText && (
        profileText.toLowerCase().includes("tidak ada aktivitas") ||
        profileText.toLowerCase().includes("no activity") ||
        profileText.toLowerCase().includes("no recent activity")
      )) {
        profileText = null;
      }

      const noActivity = liText.includes("tidak ada aktivitas") ||
                         liText.includes("no activity") ||
                         profileText === null;

      // Cocokkan ke SALAH SATU dari targets
      const matchedTarget = targetsArr.find(t => profileText && profileText.toLowerCase().includes(t));
      // Skip hanya jika: ada profil DAN profil tidak cocok dengan target manapun
      if (profileText && !matchedTarget) return { action: "skip_wrong_profile", profileText };

      // Kick: profil cocok, ATAU tidak ada profil (no activity / belum login ke profil apapun)
      keluarBtn.click();
      const display = profileText ?? (noActivity ? "tidak ada aktivitas" : "no profile");
      return { action: "kicked", display, matchedTarget: matchedTarget ?? "no-activity" };
    }, nextCard.index, targets);

    if (result.action === "kicked") {
      totalKicked++;
      console.log(`  [kick] Dikick — "${result.display}" (target: ${result.matchedTarget})`);
      processedIds.add(nextCard.uniqueKey);
      await sleep(DELAY_KICK);
    } else if (result.action === "skip_current") {
      processedIds.add(nextCard.uniqueKey);
    } else if (result.action === "skip_wrong_profile") {
      console.log(`  [kick] Skip — profil "${result.profileText}" bukan target`);
      processedIds.add(nextCard.uniqueKey);
    } else if (result.action === "not_expanded_yet") {
      await page.evaluate((i) => {
        const cards = Array.from(document.querySelectorAll('li[data-uia^="device-list+"]'));
        cards[i]?.querySelector('[data-uia$="+dropdown-button"]')?.click();
      }, nextCard.index);
      await sleep(1000);
    } else {
      processedIds.add(nextCard.uniqueKey);
    }
  }

  return totalKicked;
}

module.exports = { kickDevicesForProfile, kickDevicesForProfiles, shouldSkip, isPakeKode };
