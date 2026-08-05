/**
 * Choice mapping:
 *   "signin"    → 4-Digit Code
 *   "signin6"   → 6-Digit Code
 *   "login"     → 2FA Code
 *   "household" → Household
 *   "reset"     → Reset Link
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");

const NFPRO_URL  = process.env.NFPRO_URL;
const HEADLESS   = process.env.HEADLESS !== "false";
const sleep      = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchNetflixCode(email, choice, opts = {}) {
  const retries    = opts.retries    ?? 3;
  const retryDelay = opts.retryDelay ?? 4000;

  const proxyConfig = process.env.PROXY_SERVER
    ? {
        server:   process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || undefined,
    proxy: proxyConfig,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const page = await ctx.newPage();

    console.log(`  [nfpro] Membuka ${NFPRO_URL} ...`);
    await page.goto(NFPRO_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(1500);

    for (let attempt = 1; attempt <= retries; attempt++) {
      console.log(`  [nfpro] Attempt ${attempt}/${retries} — email: ${email}, choice: ${choice}`);

      // ── Pastikan form aktif (bukan di halaman result) ──
      const newLookupBtn = page.locator('#home-new-lookup-btn');
      if (await newLookupBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  [nfpro] Klik "New lookup" untuk kembali ke form...`);
        await newLookupBtn.click();
        await sleep(800);
      }

      // ── Isi email ──────────────────────────────────────
      const emailInput = page.locator('#email-input');
      await emailInput.waitFor({ state: "visible", timeout: 10_000 });
      await emailInput.fill("");
      await emailInput.fill(email);
      await sleep(300);

      // ── Klik tile sesuai choice ────────────────────────
      const tile = page.locator(`button[data-choice="${choice}"]`);
      if (!(await tile.isVisible({ timeout: 5000 }).catch(() => false))) {
        throw new Error(`Tile choice "${choice}" tidak ditemukan di halaman nfpro.`);
      }
      await tile.click();
      await sleep(500);

      // ── Klik Continue ──────────────────────────────────
      const continueBtn = page.locator('#home-continue-btn');
      // Tunggu tombol enabled (tidak disabled lagi)
      await page.waitForFunction(
        () => !document.querySelector('#home-continue-btn')?.disabled,
        { timeout: 5000 }
      ).catch(() => {});

      if (!(await continueBtn.isEnabled({ timeout: 3000 }).catch(() => false))) {
        console.warn(`  [nfpro] Tombol Continue masih disabled — coba force click.`);
        await continueBtn.click({ force: true });
      } else {
        await continueBtn.click();
      }

      // ── Tunggu hasil muncul ────────────────────────────
      console.log(`  [nfpro] Menunggu hasil...`);
      try {
        await page.waitForFunction(
          () => {
            // Sukses: ada kode OTP
            const otp = document.querySelector('[data-nf-otp]');
            if (otp && /^\d{4,6}$/.test(otp.getAttribute('data-nf-otp') || '')) return true;
            // Sukses: ada teks di .otp-value--hero
            const hero = document.querySelector('.otp-value--hero');
            if (hero && /^\d{4,6}$/.test(hero.textContent?.trim() || '')) return true;
            // Gagal: chip-fail muncul
            if (document.querySelector('.chip-fail')) return true;
            // Gagal: "No match" teks
            if (document.body.innerText.toLowerCase().includes('no match')) return true;
            return false;
          },
          { timeout: 20_000, polling: 500 }
        );
      } catch {
        console.warn(`  [nfpro] Timeout menunggu hasil.`);
      }

      await sleep(500);

      // ── Ambil kode dari hasil ──────────────────────────
      // Prioritas 1: data-nf-otp attribute
      const otpAttr = await page.locator('[data-nf-otp]').first().getAttribute('data-nf-otp').catch(() => null);
      if (otpAttr && /^\d{4,6}$/.test(otpAttr)) {
        console.log(`  [nfpro] ✅ Kode ditemukan (attr): ${otpAttr}`);
        return otpAttr;
      }

      // Prioritas 2: teks .otp-value--hero
      const heroText = await page.locator('.otp-value--hero').first().textContent().catch(() => null);
      if (heroText && /^\d{4,6}$/.test(heroText.trim())) {
        console.log(`  [nfpro] ✅ Kode ditemukan (hero): ${heroText.trim()}`);
        return heroText.trim();
      }

      // Prioritas 3: isi #home-result-content (fallback HTML parse)
      const resultContent = await page.locator('#home-result-content').textContent().catch(() => "");
      const codeMatch = resultContent.match(/\b(\d{4,6})\b/);
      if (codeMatch) {
        console.log(`  [nfpro] ✅ Kode ditemukan (content): ${codeMatch[1]}`);
        return codeMatch[1];
      }

      // ── Gagal: cek apakah chip-fail ───────────────────
      const isFailed = await page.locator('.chip-fail').isVisible({ timeout: 1000 }).catch(() => false);
      if (isFailed) {
        console.warn(`  [nfpro] ✗ Hasil: FAILED (no match found).`);
      } else {
        console.warn(`  [nfpro] ✗ Kode tidak ditemukan di halaman hasil.`);
      }

      // Debug: simpan screenshot jika diminta
      if (process.env.NFPRO_DEBUG === "true") {
        const path = require("path");
        const shot = path.join(process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug", `nfpro-${choice}-attempt${attempt}-${Date.now()}.png`);
        require("fs").mkdirSync(require("path").dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        console.log(`  [nfpro] Screenshot disimpan: ${shot}`);
      }

      if (attempt < retries) {
        console.log(`  [nfpro] Retry dalam ${retryDelay / 1000}s...`);
        await sleep(retryDelay);
      }
    }

    throw new Error(`Kode Netflix tidak ditemukan untuk ${email} (${choice}) setelah ${retries} percobaan.`);
  } finally {
    await browser.close();
  }
}

module.exports = { fetchNetflixCode };
