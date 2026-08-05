/**
 * Cara pakai:
 *   node scheduler-keepalive.js        → jalan terus di background, keep-alive tiap 3 hari
 *   node scheduler-keepalive.js --now  → langsung jalankan sekali sekarang
 */

"use strict";

require("dotenv").config();
const cron    = require("node-cron");
const path    = require("path");
const fs      = require("fs");
const { sendTelegram } = require("./notify");

// Jadwal: sekali sehari jam 02:00 dini hari (saat traffic rendah)
// Ganti via .env: KEEPALIVE_SCHEDULE="0 2 * * *"
const SCHEDULE = process.env.KEEPALIVE_SCHEDULE ?? "0 2 * * *";
const RUN_NOW  = process.argv.includes("--now");
const LOG_FILE = path.resolve(__dirname, "keepalive.log");

function log(msg) {
  const line = `[${new Date().toLocaleString("id-ID")}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

async function cleanupNoActivityDevices(page, email) {
  let cleaned = 0;
  try {
    await page.goto("https://www.netflix.com/manageaccountaccess", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    if (page.url().includes("/login") || page.url().includes("/mfa")) {
      // Cookie expired atau butuh MFA — jangan urus di sini, biarkan proses lain yang handle
      return 0;
    }

    for (let round = 0; round < 20; round++) {
      const cards = page.locator('li[data-uia^="device-list+"]');
      const count = await cards.count();
      if (count === 0) break;

      let didKick = false;
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);

        const isCurrent =
          (await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0;
        if (isCurrent) continue;

        const cardText = await card.innerText().catch(() => "");
        const isNoActivity =
          cardText.toLowerCase().includes("tidak ada aktivitas") ||
          cardText.toLowerCase().includes("no activity");
        if (!isNoActivity) continue;

        const keluarBtn = card.locator('button:has-text("Keluar"), button:has-text("Sign Out")').first();
        let visible = await keluarBtn.isVisible({ timeout: 500 }).catch(() => false);
        if (!visible) {
          const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
          if (await dropBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await dropBtn.click();
            await new Promise((r) => setTimeout(r, 800));
            visible = await keluarBtn.isVisible({ timeout: 1000 }).catch(() => false);
          }
        }

        if (visible) {
          await keluarBtn.click();
          cleaned++;
          didKick = true;
          await new Promise((r) => setTimeout(r, 1500));
          break; // 1 kick per round, cegah index basi
        }
      }
      if (!didKick) break;
    }

    if (cleaned > 0) {
      log(`  🧹 ${email}: ${cleaned} device "tidak ada aktivitas" dibersihkan`);
    }
  } catch (err) {
    log(`  ⚠ ${email}: cleanup gagal — ${err.message}`);
  }
  return cleaned;
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
        
        await cleanupNoActivityDevices(page, email);


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

    // ── Kirim notifikasi ke Telegram ──────────────────────
    const waktu = new Date().toLocaleString("id-ID");

    if (expired > 0) {
      // Ada cookie expired — perlu tindakan manual
      const expiredList = emails
        .filter((e) => {
          const d = loadAllCookies();
          return !d[e]?.netflixId; // sudah dihapus = expired
        })
        .join("\n• ");

      await sendTelegram(
        `⚠️ *Keep-Alive — Cookie Expired!*\n\n` +
        `📅 ${waktu}\n\n` +
        `Cookie berikut sudah tidak valid dan perlu diperbarui:\n` +
        `• ${expiredList || "(lihat log)"}\n\n` +
        `*Cara memperbarui:*\n` +
        `1. Di komputer lokal jalankan:\n` +
        `\`node harvest-cookies.js HARIAN\`\n` +
        `2. Login manual di browser yang terbuka\n` +
        `3. Copy \`cookies.json\` terbaru ke server`
      );
    }

    if (ok > 0 || failed > 0) {
      // Ringkasan rutin — kirim hanya jika ada yang perlu diperhatikan
      const adaMasalah = failed > 0 || expired > 0;
      if (adaMasalah) {
        await sendTelegram(
          `📊 *Keep-Alive — Ringkasan*\n\n` +
          `📅 ${waktu}\n` +
          `✅ Berhasil  : *${ok}*\n` +
          `⚠️ Expired   : *${expired}*\n` +
          `❌ Gagal     : *${failed}*`
        );
      }
      // Jika semua ok, tidak kirim notif (tidak perlu spam tiap hari)
    }
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
