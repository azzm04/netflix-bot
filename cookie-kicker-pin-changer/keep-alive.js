/**
 * keep-alive.js — Jaga cookie tetap hidup tanpa login
 *
 * Cara kerja:
 *   1. Baca semua email dari cookies.json
 *   2. Untuk tiap email: load cookie -> buka Netflix (headless) -> scroll -> tutup
 *   3. Server Netflix refresh token di latar belakang -> simpan cookie baru
 *
 * TIDAK perlu password. TIDAK ada login. Murni pakai cookie yang sudah ada.
 *
 * Cara pakai:
 *   node keep-alive.js                  -> semua email di cookies.json
 *   node keep-alive.js "email@..."      -> satu email saja
 *
 * Jadwal di server Ubuntu (tambahkan ke crontab dengan: crontab -e):
 *   0 3 1-31/3 * * cd /path/to/device-kicker && node keep-alive.js >> /var/log/keepalive.log 2>&1
 */

"use strict";

require("dotenv").config();
const {
  loadAllCookies,
  saveCookieForEmail,
  deleteCookieForEmail,
  launchAccountContext,
} = require("./cookie-helper");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resource yang tidak perlu dimuat cuma untuk refresh sesi (hemat waktu + bandwidth proxy)
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

// ── Keep-alive satu akun ───────────────────────────────────
// Pakai persistent context (profile per akun) — bukan context sekali-pakai —
// supaya Netflix ngenalin ini device yang sama tiap keep-alive jalan, bukan
// device baru yang numpuk di daftar "Kelola Akses & Perangkat".
async function keepAliveOne(email, cookieData) {
  let ctx;
  try {
    ctx = await launchAccountContext(email, { cookieData });

    await ctx.route("**/*", (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await ctx.newPage();

    // Buka halaman browse
    await page.goto("https://www.netflix.com/browse", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });

    const url = page.url();

    // Cookie expired jika redirect ke /login
    if (url.includes("/login") || url.includes("/LoginHelp")) {
      console.warn(`  [keep-alive] ✗ Cookie expired untuk ${email}`);
      deleteCookieForEmail(email);
      return { success: false, reason: "cookie_expired" };
    }

    console.log(`  [keep-alive] Berhasil buka browse: ${url}`);

    // Aktivitas ringan agar server catat sebagai sesi aktif
    await sleep(1500);
    await page.evaluate(() => window.scrollBy(0, 400));
    await sleep(800);
    await page.evaluate(() => window.scrollBy(0, -200));
    await sleep(500);

    // Ambil cookie yang sudah di-refresh server
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));

    const netflixId       = cm["NetflixId"];
    const secureNetflixId = cm["SecureNetflixId"];

    if (!netflixId || !secureNetflixId) {
      console.warn(`  [keep-alive] Cookie tidak di-refresh server untuk ${email}`);
      return { success: true, reason: "no_refresh" };
    }

    // Simpan cookie terbaru
    saveCookieForEmail(email, {
      netflixId,
      secureNetflixId,
      memclid:         cm["memclid"]         ?? cookieData.memclid  ?? null,
      nfvdid:          cm["nfvdid"]           ?? cookieData.nfvdid   ?? null,
      clSharedContext: cm["clSharedContext"]  ?? null,
    });

    return { success: true, reason: "refreshed" };
  } catch (err) {
    console.error(`  [keep-alive] Error: ${err.message}`);
    return { success: false, reason: err.message };
  } finally {
    await ctx?.close().catch(() => {});
  }
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const targetEmail = process.argv[2] ?? null;
  const all         = loadAllCookies();
  const emails      = targetEmail
    ? [targetEmail.toLowerCase()]
    : Object.keys(all);

  if (emails.length === 0) {
    console.log("Tidak ada cookie di cookies.json.");
    return;
  }

  console.log(`\nNetflix Keep-Alive`);
  console.log(`${new Date().toLocaleString("id-ID")}`);
  console.log(`Proses ${emails.length} akun...\n`);

  let ok = 0, expired = 0, failed = 0;

  for (let i = 0; i < emails.length; i++) {
    const email      = emails[i];
    const cookieData = all[email];

    if (!cookieData?.netflixId) {
      console.log(`[${i + 1}/${emails.length}] ${email} — skip (tidak ada netflixId)`);
      failed++;
      continue;
    }

    console.log(`[${i + 1}/${emails.length}] ${email}`);
    const result = await keepAliveOne(email, cookieData);

    if (result.success) {
      const label = result.reason === "refreshed" ? "✓ Cookie diperbarui" : "✓ Sesi aktif";
      console.log(`  ${label}`);
      ok++;
    } else if (result.reason === "cookie_expired") {
      console.log(`  ✗ Cookie expired — perlu harvest ulang`);
      expired++;
    } else {
      console.log(`  ✗ Gagal: ${result.reason}`);
      failed++;
    }

    // Jeda antar akun agar tidak terlihat bot
    if (i < emails.length - 1) await sleep(2000);
  }

  console.log(`\n${"═".repeat(45)}`);
  console.log(`KEEP-ALIVE SELESAI`);
  console.log(`  ✓ Berhasil  : ${ok}`);
  console.log(`  ✗ Expired   : ${expired} (perlu harvest)`);
  console.log(`  ✗ Gagal     : ${failed}`);
  if (expired > 0) {
    console.log(`\nUntuk akun expired, jalankan:`);
    console.log(`  node harvest-cookies.js HARIAN`);
  }
  console.log("═".repeat(45));
}

main().catch(console.error);
