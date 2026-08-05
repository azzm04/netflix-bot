/**
 * device-auditor.js — Audit & Kick Device Netflix berdasarkan data Spreadsheet
 *
 * Jalankan sekali sehari (via cron atau manual):
 *   node device-auditor.js --run-now
 */

"use strict";

require("dotenv").config();
const cron = require("node-cron");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
  refreshAndSaveCookies: _refreshAndSaveCookies,
} = require("./cookie-helper");
const {
  checkForExtraVerification,
  refreshAndSaveCookies,
  waitForKickToastMatch,
  extractProfileName,
  profileNameMatches,
  CookieExpiredError,
} = require("./kicker-cookie");
const { sendTelegram } = require("./notify");

const HEADLESS = process.env.HEADLESS !== "false";
const TIMEOUT_NAV = 45_000;
const URL_DEVICES = "https://www.netflix.com/manageaccountaccess";
const RUN_NOW = process.argv.includes("--run-now");
const CRON_SCHEDULE =
  process.env.AUDIT_CRON_SCHEDULE ?? process.env.CRON_SCHEDULE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Kolom index (sama dengan sheets.js) ──────────────────
const COL_EMAIL = parseInt(process.env.COL_EMAIL ?? "0"); // A
const COL_PASSWORD = parseInt(process.env.COL_PASSWORD ?? "1"); // B
const COL_PROFILE = parseInt(process.env.COL_PROFILE ?? "2"); // C
const COL_LOGOUT = parseInt(process.env.COL_LOGOUT ?? "4"); // E
const COL_PHONE = COL_LOGOUT + 1; // F
const COL_DEVICE = COL_LOGOUT + 2; // G

// ── Deteksi tipe slot ─────────────────────────────────────
/**
 * @param {string} logoutText - isi kolom E, contoh: "21 Agustus (sempriv)"
 * @returns {boolean}
 */
function isSemiPrivate(logoutText) {
  if (!logoutText) return false;
  const lower = logoutText.toLowerCase().replace(/[\s_-]/g, "");
  return (
    lower.includes("sempriv") ||
    lower.includes("semiprivate") ||
    lower.includes("semiprib") ||
    lower.includes("semi private")
  );
}

/**
 * Jumlah device yang diizinkan berdasarkan tipe slot.
 * @param {string} logoutText
 * @returns {number} 1 atau 2
 */
function allowedDeviceCount(logoutText) {
  return isSemiPrivate(logoutText) ? 2 : 1;
}

// ── Parse nama device yang diizinkan dari kolom G ─────────
/**
 * @param {string} colG
 * @returns {string[]} array nama device (lowercase, sudah di-trim)
 */
function parseAllowedDevices(colG) {
  if (!colG || colG.trim() === "") return [];
  // Split by "dan" (word boundary) atau koma
  return colG
    .split(/\bdan\b|[,&]/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ── Kategorikan tipe device dari teks (nama device Netflix ATAU teks Kolom G) ──
function classifyDeviceCategory(text) {
  const t = (text || "").toLowerCase();

  // Sinyal TV (cek paling awal, paling spesifik)
  if (/\btv\b|smart\s*tv|android\s*tv|tv\s*box/.test(t)) return "tv";

  // Sinyal tablet
  if (/\btab(let)?\b|ipad/.test(t)) return "tablet";

  // Sinyal PC / laptop / browser session
  if (
    /\bpc\b|browser\s*web|laptop|notebook|macbook|thinkpad|zenbook|chrome\s*-|windows|mac\s*os/.test(
      t,
    )
  ) {
    return "pc";
  }

  // Sinyal HP/ponsel eksplisit ("Hp" di sini = Handphone, bukan brand HP)
  if (/\bhp\b|handphone|ponsel|\biphone\b|\bip\b|\bIp\b/.test(t))
    return "phone";

  // Merek yang HANYA dipakai utk HP → langsung phone
  if (
    /\b(redmi|xiaomi|oppo|vivo|itel|infinix|realme|poco|iphone|ip)\b/.test(t)
  ) {
    return "phone";
  }

  return "unknown";
}

// ── Levenshtein distance sederhana (toleransi typo 1-2 huruf) ──
function levenshteinDistance(a, b) {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

// ── Ambil kata kunci bermakna dari teks (buang stopword umum) ──
const STOPWORDS = new Set([
  "dan",
  "browser",
  "web",
  "android",
  "ios",
  "ponsel",
  "smart",
  "antarmuka",
  "interface",
  "hp",
  "handphone",
  "pc",
  "the",
  "a",
  "an",
  "tv",
  "tab",
  "tablet",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[.,()-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// ── Cek 2 kata "mirip" (exact, substring, atau typo 1-2 huruf) ──
function wordsSimilar(a, b) {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const maxLen = Math.max(a.length, b.length);
  const maxDist = maxLen <= 4 ? 1 : 2;
  return levenshteinDistance(a, b) <= maxDist;
}

/**
 * Cek apakah nama device dari Netflix cocok dengan salah satu entry di kolom G.
 * @param {string} netflixDeviceName  - nama device dari Netflix (baris pertama card)
 * @param {string[]} allowedDevices   - array dari parseAllowedDevices()
 * @returns {boolean}
 */
const CATEGORY_ONLY_DEVICE_TYPES = new Set(["pc", "tv"]);

function deviceMatchesAllowed(netflixDeviceName, allowedDevices) {
  if (allowedDevices.length === 0) return false;

  const catDevice = classifyDeviceCategory(netflixDeviceName);
  const deviceWords = tokenize(netflixDeviceName);

  return allowedDevices.some((allowed) => {
    const catAllowed = classifyDeviceCategory(allowed);

    if (CATEGORY_ONLY_DEVICE_TYPES.has(catDevice)) {
      if (catAllowed !== "unknown" && catAllowed !== catDevice) {
        return false; // kolom G eksplisit bilang tipe lain → jelas beda device
      }
      return true; // kategori sama (atau kolom G ambigu) → anggap cocok
    }

    // Device Netflix punya kategori jelas & merek keliatan → kategori harus kompatibel
    if (
      catDevice !== "unknown" &&
      catAllowed !== "unknown" &&
      catDevice !== catAllowed
    ) {
      return false;
    }

    const allowedWords = tokenize(allowed);
    if (allowedWords.length === 0 || deviceWords.length === 0) return false;

    return allowedWords.some((aw) =>
      deviceWords.some((dw) => wordsSimilar(aw, dw)),
    );
  });
}

// ── Baca akun AKTIF dari spreadsheet ─────────────────────
/**
 * @returns {Promise<Array<{
 *   sheetName: string,
 *   rowIndex: number,
 *   email: string,
 *   profile: string,
 *   logoutText: string,
 *   allowedDeviceCount: number,
 *   allowedDevices: string[],
 *   blockLabel: string,
 *   isMahesh: boolean,
 * }>>}
 */
async function getActiveAccounts() {
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_PATH);
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const drive = google.drive({ version: "v3", auth: client });

  // Cari spreadsheet ID
  const name = process.env.SPREADSHEET_NAME;
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const driveRes = await drive.files.list({
    q: `name='${escaped}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  const files = driveRes.data.files ?? [];
  if (files.length === 0)
    throw new Error(`Spreadsheet "${name}" tidak ditemukan.`);
  const spreadsheetId = files[0].id;

  const sheetNames = process.env.SHEETS_TO_CHECK.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const results = [];

  for (const sheetName of sheetNames) {
    console.log(`[audit-sheets] Membaca sheet: ${sheetName}`);
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetName,
      });
      rows = res.data.values ?? [];
    } catch (err) {
      console.warn(
        `[audit-sheets] Sheet "${sheetName}" tidak bisa dibaca: ${err.message}`,
      );
      continue;
    }

    let currentBlockLabel = "";
    let currentBlockIsMahesh = false;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const colA = row[COL_EMAIL]?.trim() ?? "";

      // Deteksi baris header blok (tidak ada '@' di kolom A)
      if (!colA.includes("@")) {
        const fullText = row.join(" ").toUpperCase();
        if (fullText.includes("MAHESH")) {
          currentBlockLabel = "MAHESH";
          currentBlockIsMahesh = true;
        } else if (fullText.includes("ROSE")) {
          currentBlockLabel = "ROSE";
          currentBlockIsMahesh = false;
        } else if (row.some((c) => c && c.trim().length > 2)) {
          currentBlockLabel = "";
          currentBlockIsMahesh = false;
        }
        continue;
      }

      // Lewati baris header kolom
      if (colA.toLowerCase() === "email") continue;

      const email = colA;
      const profile = row[COL_PROFILE]?.trim() ?? "";
      const logoutText = row[COL_LOGOUT]?.trim() ?? "";
      const colG = row[COL_DEVICE]?.trim() ?? "";

      // Slot kosong = kolom E kosong (berwarna hijau di spreadsheet)
      // → Tetap masukkan sebagai "empty slot" agar device yang masuk profil ini bisa dikick
      const isEmptySlot = !logoutText || logoutText.toUpperCase() === "EXPIRED";

      // Skip jika profil juga kosong (baris benar-benar tidak terpakai)
      if (isEmptySlot && !profile) continue;

      // Skip baris aktif yang sudah EXPIRED (sudah lewat, tidak relevan untuk audit device)
      // tapi empty slot (kolom E kosong) tetap dimasukkan
      if (!isEmptySlot) {
        // baris aktif normal — lanjut diproses
      }

      results.push({
        sheetName,
        rowIndex: i + 1,
        email,
        profile,
        logoutText: isEmptySlot ? "" : logoutText,
        allowedDeviceCount: isEmptySlot ? 0 : allowedDeviceCount(logoutText),
        allowedDevices: isEmptySlot ? [] : parseAllowedDevices(colG),
        colGRaw: isEmptySlot ? "" : colG,
        blockLabel: currentBlockLabel,
        isMahesh: currentBlockIsMahesh,
        isEmptySlot,
      });
    }

    console.log(
      `[audit-sheets] → ${results.filter((r) => r.sheetName === sheetName).length} akun aktif di ${sheetName}`,
    );
  }

  // ── Deduplicate: email + profile yang sama di beberapa sheet hanya ambil SATU ──
  // Prioritas: sheet yang pertama ditemukan (urutan SHEETS_TO_CHECK)
  const seen = new Set();
  const deduplicated = results.filter((r) => {
    const key = `${r.email.toLowerCase()}||${r.profile.trim().toLowerCase()}`;
    if (seen.has(key)) {
      console.log(
        `[audit-sheets] ⚠ Duplikat dibuang: "${r.email}" / "${r.profile}" (${r.sheetName} baris ${r.rowIndex})`,
      );
      return false;
    }
    seen.add(key);
    return true;
  });

  if (deduplicated.length !== results.length) {
    console.log(
      `[audit-sheets] Deduplication: ${results.length} → ${deduplicated.length} entri`,
    );
  }

  return deduplicated;
}

// ── Launch Browser (sama persis dengan kicker-cookie.js) ──
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

// ── Buat Context + Inject Cookie ──────────────────────────
async function newCookiePage(browser, email, targetUrl) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) throw new CookieExpiredError(email);

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

  await ctx.addCookies(buildPlaywrightCookies(cookieData));
  const page = await ctx.newPage();

  console.log(`  [cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_NAV,
  });

  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    await debugShot(page, `cookie_expired_${email.split("@")[0]}`);
    deleteCookieForEmail(email);
    await page.close();
    throw new CookieExpiredError(email);
  }

  console.log(`  [cookie] Berhasil akses: ${url}`);
  return page;
}

// ── Scan semua device SEKALI — expand semua card sekaligus ──
/**
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{
 *   index: number,
 *   deviceName: string,
 *   profileText: string|null,
 *   noActivity: boolean,
 *   isCurrent: boolean,
 * }>>}
 */
async function scanAllDevicesOnce(page) {
  await sleep(1500);

  // Expand "Tampilkan Lainnya" sampai habis — sama persis kicker-cookie.js
  let more = true;
  while (more) {
    const showMore = page.locator('[data-uia="device-list+show-more-button"]');
    if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showMore.click();
      console.log("  [audit-scan] Klik Tampilkan Lainnya...");
      await sleep(1200);
    } else {
      more = false;
    }
  }

  const cards = page.locator('li[data-uia^="device-list+"]');
  const count = await cards.count();
  console.log(`  [audit-scan] Total card ditemukan: ${count}`);

  const devices = [];

  // Pass 1: expand SEMUA card terlebih dahulu sebelum baca teks apapun.
  // Ini memastikan semua info profil ("Terakhir ditonton") sudah muncul.
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;

    const isCurrent =
      (await card
        .locator('[data-uia$="+current-device-badge+ANNOUNCE"]')
        .count()) > 0;
    if (isCurrent) continue; // current device tidak perlu di-expand

    const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
    if (await dropBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await dropBtn.click();
      await sleep(600); // jeda agar animasi expand selesai
    }
  }

  // Jeda tambahan setelah expand semua card agar DOM settle
  await sleep(1000);

  // Pass 2: baca teks SEMUA card setelah semuanya ter-expand
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;

    const isCurrent =
      (await card
        .locator('[data-uia$="+current-device-badge+ANNOUNCE"]')
        .count()) > 0;

    const cardText = await card.innerText().catch(() => "");
    const lowerText = cardText.toLowerCase();
    const lines = cardText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const deviceName = lines[0] ?? "";

    let profileText = null;
    for (const line of lines) {
      if (
        line.toLowerCase().includes("terakhir ditonton") ||
        line.toLowerCase().includes("last watched")
      ) {
        profileText = line;
        break;
      }
    }

    // "tidak ada aktivitas" bukan berarti tidak ada profil — set ke null
    if (
      profileText &&
      (profileText.toLowerCase().includes("tidak ada aktivitas") ||
        profileText.toLowerCase().includes("no activity"))
    ) {
      profileText = null;
    }

    const noActivity =
      lowerText.includes("tidak ada aktivitas") ||
      lowerText.includes("no activity");

    devices.push({ index: i, deviceName, profileText, noActivity, isCurrent });
    console.log(
      `  [audit-scan] [${i}] "${deviceName}" | profil: ${profileText ?? (noActivity ? "no activity" : "—")} | current: ${isCurrent}`,
    );
  }

  return devices;
}

// ── Kick satu device berdasarkan index card ───────────────
/**
 * @param {import('playwright').Page} page
 * @param {string} deviceName - nama device (untuk verifikasi toast)
 * @returns {Promise<boolean>} true jika berhasil dikick
 */
async function kickOneDevice(page, deviceName) {
  // Re-fetch semua cards (DOM mungkin bergeser setelah scan)
  const MAX_ROUNDS = 50;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();
    let kickedThisRound = false;

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      if (!(await card.isVisible().catch(() => false))) continue;

      // Skip current device
      const isCurrent =
        (await card
          .locator('[data-uia$="+current-device-badge+ANNOUNCE"]')
          .count()) > 0;
      if (isCurrent) continue;

      const cardText = await card.innerText().catch(() => "");
      const lines = cardText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const cardDeviceName = lines[0] ?? "";

      // Cocokkan nama device yang mau di-kick
      if (cardDeviceName !== deviceName) continue;

      // Expand card dulu
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
          await sleep(1800);
          isExpanded = await keluarBtn
            .isVisible({ timeout: 1500 })
            .catch(() => false);
        }
        if (!isExpanded) continue;
      }

      const keluarVisible = await keluarBtn
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (!keluarVisible) continue;

      await keluarBtn.scrollIntoViewIfNeeded().catch(() => {});

      try {
        await keluarBtn.click({ timeout: 10000 });
      } catch (clickErr) {
        console.warn(`  [audit-kick] ⚠ Klik normal gagal, coba force click...`);
        await debugShot(
          page,
          `click_blocked_${deviceName.replace(/\s+/g, "_")}`,
        );
        await keluarBtn.click({ force: true, timeout: 10000 });
      }

      // Verifikasi via toast (sama persis kicker-cookie.js)
      const toastText = await waitForKickToastMatch(page, deviceName, 10000);
      if (toastText) {
        console.log(`  [audit-kick] ✅ Dikick: "${deviceName}"`);

        // Tutup toast
        const closeToastBtn = page
          .locator('button[aria-label="Tutup Toast"]')
          .first();
        if (
          await closeToastBtn.isVisible({ timeout: 3000 }).catch(() => false)
        ) {
          await closeToastBtn.click();
        }

        console.log(`  [audit-kick] ⏳ Menunggu DOM stabil (4 detik)...`);
        await sleep(4000);
        return true;
      } else {
        console.warn(
          `  [audit-kick] ⚠ MISS: "${deviceName}" — toast tidak muncul!`,
        );
        await sleep(2000);
        kickedThisRound = true;
        break;
      }
    }

    if (!kickedThisRound) break;
  }

  return false;
}

/**
 * Tentukan keputusan kick untuk semua profil dari snapshot
 * @param {Array} snapshot         - hasil dari scanAllDevicesOnce()
 * @param {Array} profileRows      - semua profil untuk akun ini
 * @returns {{
 *   toKick: string[],             - device name yang harus dikick
 *   perProfile: Array<{
 *     profile: string,
 *     logoutText: string,
 *     kicked: string[],
 *     kept: string[],
 *     violations: string[],
 *   }>,
 *   accountNoActivityDevices: string[] - device no-activity di level akun
 * }}
 */
function decideAuditActions(snapshot, profileRows) {
  const claimedDevices = new Set();
  const toKick = [];
  const perProfile = [];

  // Wadah khusus untuk device "No Activity" di level akun
  const accountNoActivityDevices = [];

  // ── STEP 1: Evaluasi Device Berdasarkan Profil (Hanya yang ada aktivitasnya) ──
  for (const row of profileRows) {
    const {
      profile,
      logoutText,
      allowedDeviceCount: maxDevices,
      allowedDevices,
      colGRaw,
      isEmptySlot,
    } = row;

    const kicked = [];
    const kept = [];
    const violations = [];

    // ── EMPTY SLOT: profil kosong (tidak ada customer) → kick SEMUA device ──
    if (isEmptySlot) {
      console.log(
        `\n  [audit-decide] Profil: "${profile}" | ⚠️ SLOT KOSONG — kick semua device yang masuk`,
      );

      const intruders = snapshot.filter((d) => {
        if (d.isCurrent || !d.profileText) return false;
        return profileNameMatches(extractProfileName(d.profileText), profile, d.profileText);
      });

      for (const d of intruders) {
        violations.push(
          `"${d.deviceName}" → masuk ke slot KOSONG (tidak ada customer)`,
        );
        toKick.push(d.deviceName);
        kicked.push(d.deviceName);
        console.log(
          `  [audit-decide] ✗ INTRUDER di slot kosong → kick: "${d.deviceName}"`,
        );
      }

      perProfile.push({
        profile,
        logoutText: "(slot kosong)",
        kicked,
        kept,
        violations,
        isEmptySlot: true,
      });
      continue; // skip logic normal
    }

    console.log(
      `\n  [audit-decide] Profil: "${profile}" | Max: ${maxDevices} | Kolom G: "${colGRaw || "(kosong)"}"`,
    );

    // Device yang login di profil ini (cocokkan nama sebelum tanda kurung)
    const profileDevices = snapshot.filter((d) => {
      if (d.isCurrent || d.noActivity || !d.profileText) return false;
      return profileNameMatches(extractProfileName(d.profileText), profile, d.profileText);
    });

    // ── Case 1: Kolom G ada isinya → matching-based ──────
    if (allowedDevices.length > 0) {
      const matching = profileDevices.filter((d) =>
        deviceMatchesAllowed(d.deviceName, allowedDevices),
      );
      const notMatching = profileDevices.filter(
        (d) => !deviceMatchesAllowed(d.deviceName, allowedDevices),
      );

      const scored = matching.map((d) => {
        const dw = tokenize(d.deviceName);
        const hasBrandMatch = allowedDevices.some((allowed) => {
          const aw = tokenize(allowed);
          return (
            aw.length > 0 &&
            dw.length > 0 &&
            aw.some((a) => dw.some((x) => wordsSimilar(a, x)))
          );
        });
        return { ...d, brandScore: hasBrandMatch ? 1 : 0 };
      });
      scored.sort((a, b) => b.brandScore - a.brandScore || a.index - b.index);

      for (let i = 0; i < scored.length; i++) {
        const d = scored[i];
        if (i < maxDevices) {
          kept.push(d.deviceName);
          claimedDevices.add(d.deviceName);
          console.log(
            `  [audit-decide] ✓ Diizinkan (match kolom G): "${d.deviceName}"`,
          );
        } else {
          violations.push(
            `"${d.deviceName}" → melebihi batas ${maxDevices} device`,
          );
          toKick.push(d.deviceName);
          kicked.push(d.deviceName);
          console.log(
            `  [audit-decide] ✗ Akan dikick: "${d.deviceName}" (melebihi batas ${maxDevices} device)`,
          );
        }
      }

      for (const d of notMatching) {
        violations.push(
          `"${d.deviceName}" → tidak cocok kolom G: "${colGRaw}"`,
        );
        toKick.push(d.deviceName);
        kicked.push(d.deviceName);
        console.log(
          `  [audit-decide] ✗ Akan dikick: "${d.deviceName}" (tidak cocok kolom G: "${colGRaw}")`,
        );
      }
    } else {
      // ── Case 2: Kolom G kosong → posisi-based ──────────
      const sorted = [...profileDevices].sort((a, b) => a.index - b.index);
      for (let i = 0; i < sorted.length; i++) {
        const d = sorted[i];
        if (i < maxDevices) {
          kept.push(d.deviceName);
          claimedDevices.add(d.deviceName);
          console.log(
            `  [audit-decide] ✓ Dipertahankan (posisi ${i + 1}/${maxDevices}): "${d.deviceName}"`,
          );
        } else {
          violations.push(
            `"${d.deviceName}" melebihi batas ${maxDevices} (kolom G kosong)`,
          );
          toKick.push(d.deviceName);
          kicked.push(d.deviceName);
          console.log(
            `  [audit-decide] ✗ Akan dikick: "${d.deviceName}" (melebihi batas)`,
          );
        }
      }
    }

    perProfile.push({ profile, logoutText, kicked, kept, violations });
  }

  // ── STEP 2: Evaluasi Device "No Activity" (Dieksekusi SEKALI level akun) ──
  // Pakai index sebagai identitas — nama device bisa duplikat (misal 4x "PC Chrome")
  const noActList = snapshot.filter(
    (d) => !d.isCurrent && d.noActivity && !d.profileText,
  );
  for (const d of noActList) {
    accountNoActivityDevices.push(d.deviceName);
  }

  // Cetak log terminal secara efisien
  if (accountNoActivityDevices.length > 0) {
    console.log(
      `\n  [audit-decide] Device dengan "No activity" ada: ${accountNoActivityDevices.length} device`,
    );
    for (const dev of accountNoActivityDevices) {
      console.log(`    - ${dev}`);
    }
  }

  // Deduplicate toKick (device yang muncul di beberapa profil hanya dikick sekali)
  const uniqueToKick = [...new Set(toKick)];

  return {
    toKick: uniqueToKick,
    perProfile,
    accountNoActivityDevices,
  };
}

// ── Audit satu akun (satu email, semua profil sekaligus) ──
/**
 * @param {Array} profileRows - semua baris dari email yang sama
 */
async function auditAccount(profileRows) {
  const email = profileRows[0].email;
  const isMahesh = profileRows[0].isMahesh;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`[audit] Akun: ${email} (${profileRows.length} profil)`);
  console.log("─".repeat(60));

  const result = {
    email,
    totalKicked: 0,
    noActivityReport: [],
    violationReport: [],
    error: null,
  };

  if (!getCookieForEmail(email)) {
    result.error = "Cookie tidak ditemukan";
    console.warn(`[audit]   ⚠ Cookie tidak ada — skip.`);
    return result;
  }

  const browser = await launchBrowser();
  try {
    const page = await newCookiePage(browser, email, URL_DEVICES);
    await checkForExtraVerification(page, email, isMahesh);

    if (!page.url().includes("manageaccountaccess")) {
      console.log("  [audit] Redirect tidak terduga, navigate ulang...");
      await page.goto(URL_DEVICES, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_NAV,
      });
      await checkForExtraVerification(page, email, isMahesh);
    }

    // ── STEP 1: Scan semua device SEKALI untuk semua profil ──
    console.log(
      `\n  [audit] Scan semua device (sekali untuk ${profileRows.length} profil)...`,
    );
    const snapshot = await scanAllDevicesOnce(page);
    console.log(`  [audit] Snapshot: ${snapshot.length} card terbaca`);

    // ── STEP 2: Tentukan semua keputusan kick dari snapshot ──
    const { toKick, perProfile, accountNoActivityDevices } = decideAuditActions(
      snapshot,
      profileRows,
    );
    console.log(`\n  [audit] Keputusan: ${toKick.length} device akan dikick`);

    // ── STEP 3: Eksekusi kick satu per satu ─────────────────
    // kickOneDevice selalu re-fetch DOM fresh — aman setelah card collapse
    const actuallyKicked = [];
    for (const deviceName of toKick) {
      console.log(`\n  [audit] Kick: "${deviceName}"`);
      const ok = await kickOneDevice(page, deviceName);
      if (ok) actuallyKicked.push(deviceName);
    }

    result.totalKicked = actuallyKicked.length;

    // ── STEP 4: Susun laporan per profil ────────────────────

    // 1. Simpan no-activity di level akun (satu entry per akun, bukan per profil)
    if (accountNoActivityDevices.length > 0) {
      result.noActivityReport.push({
        profile: "(akun)",
        logoutText: "",
        devices: accountNoActivityDevices,
      });
    }

    // 2. Loop hanya untuk pelanggaran / kick
    for (const pp of perProfile) {
      const confirmedKicked = pp.kicked.filter((d) =>
        actuallyKicked.includes(d),
      );

      if (pp.violations.length > 0 || confirmedKicked.length > 0) {
        result.violationReport.push({
          profile: pp.profile,
          logoutText: pp.logoutText,
          kicked: confirmedKicked,
          kept: pp.kept,
          violations: pp.violations,
        });
      }
    }

    // Simpan cookie terbaru
    await refreshAndSaveCookies(page.context(), email);
  } catch (err) {
    if (
      err instanceof CookieExpiredError ||
      err.name === "CookieExpiredError"
    ) {
      result.error = "Cookie expired";
      console.warn(`[audit]   ✗ Cookie expired.`);
    } else {
      result.error = err.message;
      console.error(`[audit]   ✗ Error: ${err.message}`);
    }
  } finally {
    await browser.close();
  }

  return result;
}

// ── Helper: kirim teks panjang dalam beberapa chunk ──────
/**
 * Telegram membatasi pesan maksimal 4096 karakter.
 * Fungsi ini memecah teks per baris agar tidak putus di tengah kalimat.
 * @param {string} text
 * @param {string} [header] - header yang diulang di setiap chunk
 */
async function sendChunked(text, header = "") {
  const MAX = 3800; // sedikit di bawah 4096 untuk safety margin
  const lines = text.split("\n");
  let chunk = header;

  for (const line of lines) {
    const addition = line + "\n";
    if (chunk.length + addition.length > MAX) {
      await sendTelegram(chunk.trimEnd());
      await sleep(400);
      chunk = header ? `${header}_(lanjutan)_\n` : "";
    }
    chunk += addition;
  }

  if (chunk.trim()) {
    await sendTelegram(chunk.trimEnd());
    await sleep(400);
  }
}

// ── Notifikasi hasil audit ────────────────────────────────
/**
 * Kirim laporan audit lengkap ke Telegram dalam beberapa pesan terpisah:
 *
 *  Pesan 1 — Ringkasan eksekutif (selalu dikirim)
 *  Pesan 2 — Akun BERSIH (tidak ada kick, tidak ada no-activity)
 *  Pesan 3+ — Detail kick per akun (satu pesan per akun yang ada kick)
 *  Pesan N — No-activity report: semua akun + profil + device
 *             (dibagi per akun jika >10 no-activity, chunk jika panjang)
 *  Pesan N+1 — Akun gagal diaudit
 */
async function sendAuditReport(allResults, elapsed) {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const totalKicked = allResults.reduce((s, r) => s + r.totalKicked, 0);
  const totalErrors = allResults.filter((r) => r.error).length;
  const totalClean = allResults.filter(
    (r) => !r.error && r.totalKicked === 0 && r.noActivityReport.length === 0,
  ).length;

  const totalNoActDevices = allResults.reduce(
    (s, r) =>
      s + r.noActivityReport.reduce((ss, na) => ss + na.devices.length, 0),
    0,
  );
  // Akun yang punya no-activity
  const noActAccounts = allResults.filter((r) => r.noActivityReport.length > 0);

  // ─────────────────────────────────────────────────────────
  // PESAN 1 — Ringkasan Eksekutif
  // ─────────────────────────────────────────────────────────
  const kickedAccounts = allResults.filter((r) => r.totalKicked > 0);
  const violationAccounts = allResults.filter(
    (r) => r.violationReport.length > 0 && r.totalKicked === 0,
  );

  let summary =
    `🔍 *Laporan Audit Device — ${now}*\n` +
    `${"─".repeat(30)}\n\n` +
    `📊 *Ringkasan*\n` +
    `  • Total akun diproses : *${allResults.length}*\n` +
    `  • Akun bersih         : *${totalClean}*\n` +
    `  • Akun ada kick       : *${kickedAccounts.length}*\n` +
    `  • Akun ada no-activity: *${noActAccounts.length}*\n` +
    `  • Akun gagal diaudit  : *${totalErrors}*\n\n` +
    `🔴 *Total device dikick : ${totalKicked}*\n` +
    `⚠️ *Total device no-activity : ${totalNoActDevices}* (di ${noActAccounts.length} akun)\n` +
    `⏱ Waktu selesai: ${elapsed}s\n`;

  // Jika ada akun yang dikick, tampilkan daftar singkatnya di ringkasan
  if (kickedAccounts.length > 0) {
    summary += `\n📋 *Akun yang ada kick:*\n`;
    for (const r of kickedAccounts) {
      summary += `  • \`${r.email}\` — ${r.totalKicked} device dikick\n`;
    }
  }

  // Jika ada no-activity, tampilkan daftar akun di ringkasan
  if (noActAccounts.length > 0) {
    summary += `\n📋 *Akun dengan no-activity (perlu audit manual):*\n`;
    for (const r of noActAccounts) {
      // devices ada di r.noActivityReport[0].devices (satu entry per akun)
      const totalDev = r.noActivityReport.reduce(
        (s, na) => s + na.devices.length,
        0,
      );
      summary += `  • \`${r.email}\` — ${totalDev} device no-activity\n`;
    }
  }

  await sendTelegram(summary);
  await sleep(600);

  // ─────────────────────────────────────────────────────────
  // PESAN 2+ — Detail kick per akun (satu pesan per akun)
  // ─────────────────────────────────────────────────────────
  let allKickDetailsText = "";

  for (const r of allResults) {
    if (r.violationReport.length === 0) continue;

    allKickDetailsText += `🔓 *Detail Kick — \`${r.email}\`*\n`;

    for (const v of r.violationReport) {
      const sempriv = isSemiPrivate(v.logoutText) ? " 〔Sempriv〕" : "";
      const emptyLabel = v.isEmptySlot ? " 🚫〔SLOT KOSONG〕" : "";
      allKickDetailsText += `👤 *${v.profile}*${sempriv}${emptyLabel} _(${v.logoutText || "tidak ada customer"})_\n`;

      if (v.kept.length > 0) {
        allKickDetailsText += `  ✅ Diizinkan : ${v.kept.map((d) => `\`${d}\``).join(", ")}\n`;
      }
      if (v.kicked.length > 0) {
        allKickDetailsText += `  🔴 Dikick    : ${v.kicked.map((d) => `\`${d}\``).join(", ")}\n`;
      }
      if (v.violations.length > 0) {
        allKickDetailsText += `  ⚠️ Alasan    :\n`;
        for (const viol of v.violations) {
          allKickDetailsText += `    — ${viol}\n`;
        }
      }
      allKickDetailsText += "\n";
    }
    allKickDetailsText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  if (allKickDetailsText !== "") {
    await sendChunked(allKickDetailsText);
  }

  // ─────────────────────────────────────────────────────────
  // PESAN N — No-activity report (per akun, agar mudah audit manual)
  // ─────────────────────────────────────────────────────────
  if (noActAccounts.length > 0) {
    await sendTelegram(
      `ℹ️ *Laporan "Tidak Ada Aktivitas" — Perlu Audit Manual*\n\n` +
        `_Device berikut terdeteksi login di akun Netflix tapi tidak ada aktivitas di profil manapun._\n\n` +
        `*Total: ${noActAccounts.length} akun*`,
    );
    await sleep(500);

    let allNoActDetailsText = "";

    for (const r of noActAccounts) {
      const totalDev = r.noActivityReport.reduce(
        (s, na) => s + na.devices.length,
        0,
      );
      allNoActDetailsText += `📧 *\`${r.email}\`*\n`;
      allNoActDetailsText += `⚠️ *Terdapat ${totalDev} device tidak ada aktivitas:*\n`;

      // noActivityReport = [{ profile, logoutText, devices: string[] }]
      for (const na of r.noActivityReport) {
        for (const dev of na.devices) {
          allNoActDetailsText += `  • \`${dev}\`\n`;
        }
      }

      allNoActDetailsText += `\n🔎 _Aksi: Cek manual apakah device di atas milik salah satu customer._\n`;
      allNoActDetailsText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    if (allNoActDetailsText !== "") {
      await sendChunked(allNoActDetailsText);
    }
  }

  // ─────────────────────────────────────────────────────────
  // PESAN TERAKHIR — Akun yang gagal diaudit
  // ─────────────────────────────────────────────────────────
  const errorResults = allResults.filter((r) => r.error);
  if (errorResults.length > 0) {
    let errMsg =
      `❌ *Akun Gagal Diaudit (${errorResults.length})*\n\n` +
      `_Akun berikut tidak bisa diproses dan perlu pengecekan manual:_\n\n`;
    for (const r of errorResults) {
      errMsg += `• \`${r.email}\`\n  Alasan: _${r.error}_\n\n`;
    }
    errMsg +=
      `💡 Kemungkinan penyebab:\n` +
      `  — Cookie expired → jalankan \`node cookie-helper.js save-interactive "email"\`\n` +
      `  — MFA gagal → update cookie secara manual`;
    await sendTelegram(errMsg);
  }
}

// ── Main Process ──────────────────────────────────────────
let _isRunning = false;

async function runAudit() {
  if (_isRunning) {
    console.log("[audit] Proses sebelumnya masih berjalan — skip.");
    return;
  }
  _isRunning = true;

  const startTime = Date.now();
  const allResults = [];

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(
      `[audit] [${new Date().toLocaleString("id-ID")}] Mulai audit device...`,
    );
    console.log("=".repeat(60));

    // 1. Baca semua akun aktif dari spreadsheet
    let activeAccounts;
    try {
      activeAccounts = await getActiveAccounts();
    } catch (err) {
      console.error("[audit] Gagal baca spreadsheet:", err.message);
      await sendTelegram(
        `❌ *Audit Gagal — Tidak Bisa Baca Spreadsheet*\n\`${err.message}\``,
      );
      return;
    }

    if (activeAccounts.length === 0) {
      console.log("[audit] Tidak ada akun aktif ditemukan.");
      return;
    }

    console.log(`[audit] Total akun aktif: ${activeAccounts.length}`);

    // 2. Grup per email (satu akun bisa punya banyak profil di baris berbeda)
    const emailGroups = new Map();
    for (const row of activeAccounts) {
      const key = row.email.toLowerCase();
      if (!emailGroups.has(key)) emailGroups.set(key, []);
      emailGroups.get(key).push(row);
    }

    const groups = [...emailGroups.values()];
    console.log(`[audit] Jumlah email unik: ${groups.length}`);

    // 3. Proses satu per satu (tidak parallel — hindari overload Netflix)
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const email = group[0].email;

      console.log(`\n[audit] [${gi + 1}/${groups.length}] ${email}`);

      const result = await auditAccount(group);
      allResults.push(result);

      // Jeda antar akun agar tidak terlalu cepat
      if (gi < groups.length - 1) await sleep(5000);
    }

    // 4. Kirim laporan ke Telegram
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[audit] SELESAI dalam ${elapsed}s`);
    console.log(
      `  Total kick: ${allResults.reduce((s, r) => s + r.totalKicked, 0)}`,
    );
    console.log("=".repeat(60));

    await sendAuditReport(allResults, elapsed);
  } catch (fatalErr) {
    console.error("[audit] Fatal error:", fatalErr.message);
    await sendTelegram(`❌ *Audit Fatal Error*\n\`${fatalErr.message}\``);
  } finally {
    _isRunning = false;
  }
}

// ─── Run ──────────────────────────────────────────────────
if (RUN_NOW) {
  console.log("[audit] Mode: Run Now\n");
  runAudit().catch(console.error);
} else if (CRON_SCHEDULE) {
  console.log(`[audit] Scheduler aktif: "${CRON_SCHEDULE}"\n`);
  runAudit().catch(console.error); // jalankan sekali saat startup
  cron.schedule(CRON_SCHEDULE, () => {
    runAudit().catch(console.error);
  });
} else {
  console.log(
    "[audit] Tidak ada jadwal. Gunakan --run-now atau set AUDIT_CRON_SCHEDULE di .env\n",
  );
}

module.exports = {
  runAudit,
  getActiveAccounts,
  isSemiPrivate,
  allowedDeviceCount,
  parseAllowedDevices,
};
