/**
 * capture-api.js — Capture endpoint Netflix API saat ganti PIN / kick device
 *
 * Cara pakai:
 *   node capture-api.js pin   "email@gmail.com" "passwordAkun"
 *   node capture-api.js kick  "email@gmail.com"
 *
 * Script ini akan:
 *   1. Inject cookie (sama seperti pin-changer-cookie.js)
 *   2. Monitor SEMUA request POST/PUT/DELETE yang keluar saat operasi berlangsung
 *   3. Print endpoint + headers + body ke konsol
 *   4. Simpan hasil ke api-capture.json untuk referensi
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs");
const { getCookieForEmail, buildPlaywrightCookies } = require("./cookie-helper");

const HEADLESS    = false; // Harus false agar bisa lihat apa yang terjadi
const TIMEOUT_NAV = 45_000;
const OUTPUT_FILE = "api-capture.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureRequests(email, password, mode) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    console.error(`Cookie tidak ditemukan untuk ${email}`);
    console.error(`Jalankan dulu: node cookie-helper.js save-interactive "${email}"`);
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const captured = [];

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(buildPlaywrightCookies(cookieData));

    // ── Intercept semua request keluar ──────────────────────
    await ctx.route("**/*", async (route) => {
      const req    = route.request();
      const method = req.method();
      const url    = req.url();

      // Filter hanya POST/PUT/DELETE ke netflix.com (bukan asset statis)
      if (
        ["POST", "PUT", "DELETE", "PATCH"].includes(method) &&
        url.includes("netflix.com") &&
        !url.includes(".js") &&
        !url.includes(".css") &&
        !url.includes(".png")
      ) {
        let body = null;
        try { body = req.postData(); } catch {}

        let bodyParsed = null;
        try { bodyParsed = body ? JSON.parse(body) : null; } catch { bodyParsed = body; }

        const headers = req.headers();

        const entry = {
          method,
          url,
          headers: {
            // Header yang relevan saja
            "content-type":    headers["content-type"]    ?? null,
            "x-netflix-csrf":  headers["x-netflix-csrf"]  ?? null,
            "x-netflix.request.client.user.guid": headers["x-netflix.request.client.user.guid"] ?? null,
            "cookie":          "(dari context — tidak diprint)",
          },
          body: bodyParsed,
          rawBody: body,
          timestamp: new Date().toISOString(),
        };

        captured.push(entry);

        console.log(`\n${"─".repeat(60)}`);
        console.log(`[CAPTURE] ${method} ${url}`);
        if (headers["x-netflix-csrf"]) {
          console.log(`  CSRF Token: ${headers["x-netflix-csrf"]}`);
        }
        if (bodyParsed) {
          console.log(`  Body: ${JSON.stringify(bodyParsed, null, 2)}`);
        }
      }

      await route.continue();
    });

    const page = await ctx.newPage();

    if (mode === "pin") {
      // ── Mode PIN: buka settings/migration ─────────────────
      console.log(`\n[capture] Mode: PIN CHANGER`);
      console.log(`[capture] Buka /settings/migration ...`);
      await page.goto("https://www.netflix.com/settings/migration", {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_NAV,
      });

      const url = page.url();
      if (url.includes("/login")) {
        console.error("[capture] Cookie expired! Refresh cookie dulu.");
        process.exit(1);
      }

      // Isi password parental control jika ada
      const pwRestrict = page.locator('[data-uia="input-account-content-restrictions"]').first();
      if (await pwRestrict.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log("[capture] Isi password parental control...");
        await pwRestrict.fill(password);
        await sleep(300);
        await page.locator('[data-uia="btn-account-pin-submit"]').click();
        await page.waitForSelector(".parental-control-profile", { timeout: 20000 });
        await sleep(1000);
      }

      // Baca profil yang tersedia
      const profiles = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".parental-control-profile")).map((li) => ({
          name: li.querySelector("h3")?.textContent?.trim() ?? "",
          pins: Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
            .sort((a, b) => +a.getAttribute("data-uia").slice(-1) - +b.getAttribute("data-uia").slice(-1))
            .map((i) => i.value),
        }))
      );

      console.log(`\n[capture] Profil ditemukan: ${profiles.map((p) => p.name).join(", ")}`);
      console.log(`[capture] Ganti PIN profil PERTAMA untuk capture endpoint...`);

      if (profiles.length === 0) {
        console.error("[capture] Tidak ada profil ditemukan.");
        process.exit(1);
      }

      const target = profiles[0];
      const oldPin = target.pins.join("");
      let newPin;
      do { newPin = String(Math.floor(1000 + Math.random() * 9000)); } while (newPin === oldPin);

      console.log(`[capture] "${target.name}": ${oldPin} → ${newPin}`);

      // Ubah PIN via evaluate
      await page.evaluate(({ profileName, newPin }) => {
        for (const li of document.querySelectorAll(".parental-control-profile")) {
          const h3 = li.querySelector("h3");
          if (!h3?.textContent?.toLowerCase().includes(profileName.toLowerCase())) continue;
          const inputs = Array.from(li.querySelectorAll('[data-uia^="pin-number-"]'))
            .sort((a, b) => +a.getAttribute("data-uia").slice(-1) - +b.getAttribute("data-uia").slice(-1));
          newPin.split("").forEach((d, i) => {
            if (!inputs[i]) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(inputs[i], d);
            inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
            inputs[i].dispatchEvent(new Event("change", { bubbles: true }));
          });
          return;
        }
      }, { profileName: target.name, newPin });

      await sleep(400);

      console.log(`[capture] Klik Terapkan — perhatikan Network tab...`);
      await page.locator('[data-uia="profile-hub-migration-apply"]').click();

      // Tunggu request keluar
      await sleep(4000);

    } else if (mode === "kick") {
      // ── Mode KICK: buka manageaccountaccess ───────────────
      console.log(`\n[capture] Mode: DEVICE KICKER`);
      console.log(`[capture] Buka /manageaccountaccess ...`);
      await page.goto("https://www.netflix.com/manageaccountaccess", {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_NAV,
      });

      const url = page.url();
      if (url.includes("/login")) {
        console.error("[capture] Cookie expired! Refresh cookie dulu.");
        process.exit(1);
      }

      await sleep(2000);

      // Expand kartu pertama
      const cards = page.locator('li[data-uia^="device-list+"]');
      const count = await cards.count();
      console.log(`[capture] ${count} device ditemukan.`);

      if (count === 0) {
        console.log("[capture] Tidak ada device untuk dikick.");
      } else {
        // Cari device yang BUKAN current
        for (let i = 0; i < count; i++) {
          const card = cards.nth(i);
          const isCurrent = (await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0;
          if (isCurrent) continue;

          // Expand
          const dropBtn = card.locator('[data-uia$="+dropdown-button"]').first();
          if (await dropBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            await dropBtn.click();
            await sleep(800);
          }

          // Klik Keluar/Sign Out
          const keluarBtn = card.locator('button:has-text("Keluar"), button:has-text("Sign Out")').first();
          if (await keluarBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            const cardText = await card.innerText().catch(() => "");
            console.log(`\n[capture] Klik Sign Out pada:\n${cardText.split("\n").slice(0, 3).join(" | ")}`);
            await keluarBtn.click();
            await sleep(3000);
            break;
          }
        }
      }
    }

    // ── Simpan hasil ──────────────────────────────────────
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[capture] Total ${captured.length} request ter-capture.`);

    if (captured.length > 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2), "utf-8");
      console.log(`[capture] Disimpan ke: ${OUTPUT_FILE}`);
      console.log(`\nRingkasan endpoint:`);
      for (const c of captured) {
        console.log(`  ${c.method} ${c.url}`);
      }
    } else {
      console.log("[capture] Tidak ada request API yang ter-capture.");
      console.log("         Coba buka DevTools > Network secara manual saat operasi.");
    }

  } finally {
    console.log("\n[capture] Selesai. Browser ditutup dalam 3 detik...");
    await sleep(3000);
    await browser.close();
  }
}

// ── Main ──────────────────────────────────────────────────
const [,, mode, email, password] = process.argv;

if (!mode || !email) {
  console.log(`
Capture Netflix API Endpoints
==============================
Usage:
  node capture-api.js pin  <email> <password>   Capture endpoint ganti PIN
  node capture-api.js kick <email>               Capture endpoint kick device

Syarat: cookie sudah tersimpan via cookie-helper.js
  `);
  process.exit(0);
}

captureRequests(email, password ?? "", mode).catch(console.error);
