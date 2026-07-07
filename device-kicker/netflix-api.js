/**
 * netflix-api.js — Direct API calls ke Netflix (tanpa browser UI)
 *
 * Endpoint (hasil capture): POST /api/shakti/mre/profilehub
 * Content-Type: application/json (bukan urlencoded)
 *
 * Flow ganti PIN:
 *   1. Playwright headless buka halaman, isi password parental, extract:
 *      - authURL (dari window.netflix.reactContext)
 *      - setiap profil: { guid, name, pin }
 *      Browser langsung tutup setelah data didapat (~5-8 detik)
 *   2. POST profilehub { task: "auth" }    → verifikasi password
 *   3. POST profilehub { task: "migrate" } → simpan PIN baru
 *
 * Data profil (GUID + PIN) di-cache di cookies.json agar extract
 * berikutnya tidak perlu buka browser lagi.
 */

"use strict";

require("dotenv").config();
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const {
  getCookieForEmail,
  buildPlaywrightCookies,
  deleteCookieForEmail,
} = require("./cookie-helper");

// ── Cache profil (disimpan bersama cookie di cookies.json) ─
const COOKIE_FILE = path.resolve(__dirname, process.env.COOKIE_FILE ?? "cookies.json");

function loadAllCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8")); } catch { return {}; }
}

function saveAllCookies(data) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

/** Simpan cache profil { guid, name, pin } ke cookies.json */
function cacheProfiles(email, profiles, authURL) {
  const all = loadAllCookies();
  if (!all[email.toLowerCase()]) return;
  all[email.toLowerCase()].profileCache = {
    profiles,
    authURL,
    cachedAt: new Date().toISOString(),
  };
  saveAllCookies(all);
}

/** Ambil cache profil jika ada dan belum lebih dari 12 jam */
function getCachedProfiles(email) {
  const all     = loadAllCookies();
  const entry   = all[email.toLowerCase()]?.profileCache;
  if (!entry) return null;
  const age = Date.now() - new Date(entry.cachedAt).getTime();
  if (age > 12 * 60 * 60 * 1000) return null; // expired setelah 12 jam
  return entry; // { profiles, authURL, cachedAt }
}

/** Invalidate cache profil (setelah PIN berhasil diganti) */
function invalidateProfileCache(email) {
  const all = loadAllCookies();
  if (all[email.toLowerCase()]) {
    delete all[email.toLowerCase()].profileCache;
    saveAllCookies(all);
  }
}

// ── Cookie string untuk header ────────────────────────────
function buildCookieHeader(cookieData) {
  const pairs = [
    `NetflixId=${cookieData.netflixId}`,
    `SecureNetflixId=${cookieData.secureNetflixId}`,
  ];
  if (cookieData.memclid) pairs.push(`memclid=${cookieData.memclid}`);
  if (cookieData.nfvdid)  pairs.push(`nfvdid=${cookieData.nfvdid}`);
  return pairs.join("; ");
}

// ── HTTP POST helper ──────────────────────────────────────
function httpPost(path, cookieData, jsonBody) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(jsonBody);
    const req = https.request(
      {
        hostname: "www.netflix.com",
        path,
        method:   "POST",
        headers: {
          "Content-Type":     "application/json",
          "Content-Length":   Buffer.byteLength(bodyStr),
          "Cookie":            buildCookieHeader(cookieData),
          "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
          "Accept":           "application/json, text/javascript, */*; q=0.01",
          "Accept-Language":  "id-ID,id;q=0.9,en-US;q=0.8",
          "Origin":           "https://www.netflix.com",
          "Referer":          "https://www.netflix.com/settings/migration",
          "X-Requested-With": "XMLHttpRequest",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body:   data,
            json()  { try { return JSON.parse(data); } catch { return null; } },
          })
        );
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Extract authURL + profil via Playwright ───────────────
/**
 * Buka halaman /settings/migration dengan Playwright (headless),
 * isi password parental control, extract authURL + profil GUID + PIN.
 * Browser ditutup segera setelah data didapat.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ authURL: string, profiles: Array<{guid,name,pin}> }>}
 */
async function extractViaPlaywright(email, password) {
  const { chromium } = require("playwright");
  const cookieData   = getCookieForEmail(email);
  if (!cookieData) throw new Error(`Cookie tidak ada untuk ${email}`);

  console.log("  [api] Buka browser headless untuk extract data (~5-8 detik)...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  let result = null;

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(buildPlaywrightCookies(cookieData));
    const page = await ctx.newPage();

    await page.goto("https://www.netflix.com/settings/migration", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });

    // Cookie expired check
    if (page.url().includes("/login")) {
      deleteCookieForEmail(email);
      throw new Error(`Cookie expired. Jalankan: node cookie-helper.js save-interactive "${email}"`);
    }

    // Isi password parental control jika form muncul
    const pwInput = page.locator('[data-uia="input-account-content-restrictions"]').first();
    if (await pwInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log("  [api] Isi password parental control...");
      await pwInput.fill(password);
      await new Promise((r) => setTimeout(r, 300));
      await page.locator('[data-uia="btn-account-pin-submit"]').click();

      // Tunggu profil muncul — gunakan waitForFunction yang lebih fleksibel
      await page.waitForFunction(
        () => {
          // Cek berbagai kemungkinan selector
          return (
            document.querySelectorAll(".parental-control-profile").length > 0 ||
            document.querySelectorAll('[data-uia^="pin-number-"]').length > 0 ||
            document.querySelectorAll('[class*="profile-hub"]').length > 0
          );
        },
        { timeout: 20_000, polling: 500 }
      ).catch(() => {
        console.warn("  [api] waitForFunction timeout — coba ambil data apa adanya...");
      });

      await new Promise((r) => setTimeout(r, 1000));
    }

    // Extract authURL dari window.netflix.reactContext
    const authURL = await page.evaluate(() => {
      function findKey(obj, keyName, depth = 0) {
        if (depth > 8 || !obj || typeof obj !== "object") return null;
        for (const k of Object.keys(obj)) {
          if ((k === "authURL" || k === "authUrl") && typeof obj[k] === "string" && obj[k].startsWith("c1.")) {
            return obj[k];
          }
          const found = findKey(obj[k], keyName, depth + 1);
          if (found) return found;
        }
        return null;
      }
      return findKey(window?.netflix?.reactContext ?? {});
    });

    // Extract profil dari DOM
    const profiles = await page.evaluate(() => {
      const items = [];

      // Cara 1: selector .parental-control-profile
      document.querySelectorAll(".parental-control-profile").forEach((li) => {
        const nameEl = li.querySelector("h3, h2, [class*='profile-name'], [class*='profileName']");
        const name   = nameEl?.textContent?.trim() ?? "";
        const pinInputs = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
          .sort((a, b) => +a.getAttribute("data-uia").slice(-1) - +b.getAttribute("data-uia").slice(-1));
        const pin = pinInputs.map((i) => i.value ?? "").join("");

        // GUID: coba berbagai sumber
        const guid =
          li.getAttribute("data-profile-guid") ??
          li.getAttribute("data-uia")?.match(/[A-Z0-9]{26}/)?.[0] ??
          li.id?.match(/[A-Z0-9]{26}/)?.[0] ??
          "";

        if (name) items.push({ guid, name, pin });
      });

      // Cara 2: cari dari reactContext jika cara 1 kosong
      if (items.length === 0) {
        function findProfiles(obj, depth = 0) {
          if (depth > 8 || !obj || typeof obj !== "object") return null;
          if (Array.isArray(obj)) {
            const valid = obj.filter(
              (i) => i && typeof i === "object" &&
                (i.id || i.guid || i.token) &&
                (i.profileName || i.name)
            );
            if (valid.length > 0) return valid;
          }
          for (const k of Object.keys(obj)) {
            const found = findProfiles(obj[k], depth + 1);
            if (found) return found;
          }
          return null;
        }
        const raw = findProfiles(window?.netflix?.reactContext ?? {}) ?? [];
        for (const p of raw) {
          items.push({
            guid: p.id ?? p.guid ?? p.token ?? "",
            name: p.profileName ?? p.name ?? "",
            pin:  p.profileLockPin ?? p.pin ?? "",
          });
        }
      }

      return items;
    });

    console.log(`  [api] authURL: ${authURL ? authURL.substring(0, 35) + "..." : "TIDAK DITEMUKAN"}`);
    console.log(`  [api] Profil dari DOM: ${profiles.length > 0 ? profiles.map((p) => `${p.name}${p.guid ? `(${p.guid.slice(0, 8)}...)` : "(no GUID)"}`).join(", ") : "TIDAK ADA"}`);

    if (!authURL) {
      // Screenshot debug
      const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      await page.screenshot({ path: `${dir}/api_extract_fail_${Date.now()}.png`, fullPage: true }).catch(() => {});
      throw new Error(
        "authURL tidak bisa di-extract dari reactContext.\n" +
        "Kemungkinan: (1) cookie expired, (2) halaman render berbeda.\n" +
        `Screenshot disimpan di ${dir}`
      );
    }

    result = { authURL, profiles };
  } finally {
    await browser.close();
  }

  return result;
}

// ── Custom Error ──────────────────────────────────────────
class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name   = "ApiError";
    this.status = status;
  }
}

// ── Ganti PIN via API ─────────────────────────────────────
/**
 * Ganti PIN profil tertentu via direct API.
 * Extract data pakai Playwright headless sekali (lalu di-cache 12 jam).
 *
 * @param {string}   email
 * @param {string}   password
 * @param {string[]} targetProfiles  - nama profil yang mau diganti
 * @param {object}   [forceHints]    - { authURL, profiles } untuk skip extract
 * @returns {Promise<Map<string, string>>} profil → PIN baru
 */
async function changePinsViaApi(email, password, targetProfiles, forceHints = null) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new Error(`Cookie tidak ada untuk ${email}. Jalankan: node cookie-helper.js save-interactive "${email}"`);
  }

  // ── Step 1: Dapat authURL + profil ──────────────────────
  let authURL, profiles;

  if (forceHints?.authURL && forceHints?.profiles?.length > 0) {
    ({ authURL, profiles } = forceHints);
    console.log("  [api] Pakai hints yang diberikan.");
  } else {
    // Cek cache dulu
    const cached = getCachedProfiles(email);
    if (cached) {
      console.log(`  [api] Pakai cache profil (disimpan ${new Date(cached.cachedAt).toLocaleString("id-ID")})`);
      ({ authURL, profiles } = cached);

      // authURL mengandung timestamp — bisa expired setelah beberapa jam
      // Ekstrak ulang authURL tapi tetap pakai GUID dari cache
      console.log("  [api] Re-extract authURL (GUID dari cache, authURL fresh)...");
      const fresh = await extractViaPlaywright(email, password);
      authURL  = fresh.authURL;
      // Update PIN lama dari fresh extract jika ada
      if (fresh.profiles.length > 0) {
        profiles = fresh.profiles;
      }
    } else {
      const extracted = await extractViaPlaywright(email, password);
      ({ authURL, profiles } = extracted);
    }
  }

  if (!authURL) throw new Error("authURL tidak bisa didapatkan.");
  if (!profiles.length) throw new Error("Profil tidak bisa didapatkan.");

  // ── Step 2: Auth parental control ───────────────────────
  console.log("  [api] Auth parental control...");
  const authRes = await httpPost("/api/shakti/mre/profilehub", cookieData, {
    task:        "auth",
    password:    password,
    destination: "parentalControlHub",
    authURL:     authURL,
  });

  console.log(`  [api] Auth: ${authRes.status} — ${JSON.stringify(authRes.json() ?? authRes.body.slice(0, 80))}`);

  if (authRes.status !== 200) {
    throw new ApiError(`Auth gagal (${authRes.status}): ${authRes.body.slice(0, 200)}`, authRes.status);
  }

  // ── Step 3: Build profilesToChange ──────────────────────
  const targets    = targetProfiles.map((t) => t.trim().toLowerCase());
  const pinChanges = new Map();
  const profilesToChange = {};

  for (const prof of profiles) {
    const isTarget = targets.some(
      (t) => prof.name.toLowerCase().includes(t) || t.includes(prof.name.toLowerCase())
    );

    let finalPin = prof.pin;

    if (isTarget) {
      let newPin;
      do { newPin = String(Math.floor(1000 + Math.random() * 9000)); }
      while (newPin === prof.pin);

      finalPin = newPin;
      pinChanges.set(prof.name, newPin);
      console.log(`  [api] "${prof.name}": ${prof.pin || "?"} → ${newPin}`);
    }

    // Jika GUID tidak ada, skip profil ini dari payload
    if (!prof.guid) {
      console.warn(`  [api] GUID tidak ada untuk "${prof.name}" — skip dari payload`);
      continue;
    }

    profilesToChange[prof.guid] = {
      maturity:       1000000,
      experience:     "standard",
      profileLockPin: finalPin,
      locked:         true,
      addedTitles:    [],
      removedTitles:  [],
    };
  }

  if (pinChanges.size === 0) {
    console.log(`  [api] Tidak ada profil yang cocok: ${targetProfiles.join(", ")}`);
    return pinChanges;
  }

  if (Object.keys(profilesToChange).length === 0) {
    throw new Error(
      "Semua profil tidak punya GUID. " +
      "Cache mungkin tidak lengkap — hapus cache dengan: node cookie-helper.js delete \"" + email + "\" lalu coba lagi."
    );
  }

  // ── Step 4: Migrate (simpan PIN baru) ───────────────────
  console.log("  [api] Kirim PIN baru...");
  const migrateRes = await httpPost("/api/shakti/mre/profilehub", cookieData, {
    profilesToChange: JSON.stringify(profilesToChange),
    task:             "migrate",
    authURL:          authURL,
  });

  console.log(`  [api] Migrate: ${migrateRes.status} — ${JSON.stringify(migrateRes.json() ?? migrateRes.body.slice(0, 80))}`);

  if (migrateRes.status !== 200) {
    throw new ApiError(`Migrate gagal (${migrateRes.status}): ${migrateRes.body.slice(0, 300)}`, migrateRes.status);
  }

  // Update cache dengan PIN terbaru
  const updatedProfiles = profiles.map((p) => ({
    ...p,
    pin: pinChanges.get(p.name) ?? p.pin,
  }));
  cacheProfiles(email, updatedProfiles, authURL);

  console.log(`  [api] Selesai! ${[...pinChanges.keys()].join(", ")}`);
  return pinChanges;
}

module.exports = { changePinsViaApi, extractViaPlaywright, ApiError };
