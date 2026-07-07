/**
 * scheduler-keepalive.js — Jalankan keep-alive otomatis via node-cron
 *
 * Cara pakai:
 *   node scheduler-keepalive.js        → jalan terus di background, keep-alive tiap 3 hari
 *   node scheduler-keepalive.js --now  → langsung jalankan sekali sekarang
 *
 * Di server Ubuntu, jalankan dengan PM2:
 *   pm2 start scheduler-keepalive.js --name "netflix-keepalive"
 *   pm2 save
 */

"use strict";

require("dotenv").config();
const cron    = require("node-cron");
const { execSync } = require("child_process");
const path    = require("path");
const fs      = require("fs");

// Jadwal: jam 03:00 setiap hari ke-1, 4, 7, 10, ... (tiap 3 hari)
// Ganti ke "0 3 * * *" jika mau tiap hari
const SCHEDULE = process.env.KEEPALIVE_SCHEDULE ?? "0 3 1-31/3 * *";
const RUN_NOW  = process.argv.includes("--now");
const LOG_FILE = path.resolve(__dirname, "keepalive.log");

function log(msg) {
  const line = `[${new Date().toLocaleString("id-ID")}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

async function runKeepAlive() {
  log("=== Keep-Alive mulai ===");
  try {
    // Import langsung (lebih reliable daripada spawn)
    const { loadAllCookies, saveCookieForEmail, buildPlaywrightCookies, deleteCookieForEmail } = require("./cookie-helper");
    const { chromium } = require("playwright");

    const all    = loadAllCookies();
    const emails = Object.keys(all);

    if (emails.length === 0) {
      log("Tidak ada cookie di cookies.json.");
      return;
    }

    log(`Proses ${emails.length} akun...`);

    let ok = 0, expired = 0, failed = 0;

    for (let i = 0; i < emails.length; i++) {
      const email      = emails[i];
      const cookieData = all[email];

      if (!cookieData?.netflixId) {
        log(`[${i + 1}/${emails.length}] ${email} — skip (no netflixId)`);
        failed++;
        continue;
      }

      log(`[${i + 1}/${emails.length}] ${email}`);

      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });

        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await ctx.addCookies(buildPlaywrightCookies(cookieData));
        const page = await ctx.newPage();

        await page.goto("https://www.netflix.com/browse", {
          waitUntil: "domcontentloaded",
          timeout:   30_000,
        });

        const url = page.url();
        if (url.includes("/login")) {
          log(`  ✗ Expired — hapus cookie`);
          deleteCookieForEmail(email);
          expired++;
          continue;
        }

        // Aktivitas ringan
        await page.evaluate(() => window.scrollBy(0, 400));
        await new Promise((r) => setTimeout(r, 1000));
        await page.evaluate(() => window.scrollBy(0, -200));
        await new Promise((r) => setTimeout(r, 500));

        // Simpan cookie yang di-refresh
        const allCookies = await ctx.cookies("https://www.netflix.com");
        const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));
        if (cm["NetflixId"]) {
          saveCookieForEmail(email, {
            netflixId:       cm["NetflixId"],
            secureNetflixId: cm["SecureNetflixId"] ?? cookieData.secureNetflixId,
            memclid:         cm["memclid"]  ?? null,
            nfvdid:          cm["nfvdid"]   ?? null,
          });
          log(`  ✓ Cookie diperbarui`);
          ok++;
        } else {
          log(`  ✓ Sesi aktif (cookie tidak berubah)`);
          ok++;
        }
      } catch (err) {
        log(`  ✗ Error: ${err.message}`);
        failed++;
      } finally {
        if (browser) await browser.close().catch(() => {});
      }

      // Jeda 2 detik antar akun
      if (i < emails.length - 1) await new Promise((r) => setTimeout(r, 2000));
    }

    log(`=== Selesai: ${ok} ok, ${expired} expired, ${failed} gagal ===`);
  } catch (err) {
    log(`ERROR: ${err.message}`);
  }
}

// ── Jalankan ──────────────────────────────────────────────
if (RUN_NOW) {
  log("Mode: --now (jalankan sekali langsung)");
  runKeepAlive().catch(console.error);
} else {
  log(`Scheduler aktif. Jadwal: "${SCHEDULE}"`);
  log(`Log disimpan di: ${LOG_FILE}`);

  // Jalankan sekali saat start
  runKeepAlive().catch(console.error);

  // Jadwalkan berikutnya
  cron.schedule(SCHEDULE, () => {
    runKeepAlive().catch(console.error);
  });

  log("Tekan Ctrl+C untuk berhenti.");
}
