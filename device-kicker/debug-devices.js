/**
 * debug-devices.js — Dump HTML halaman manageaccountaccess setelah login
 * Jalankan: node debug-devices.js
 * Edit EMAIL dan PASSWORD di bawah sebelum jalankan
 */
"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer");
const readline  = require("readline");
const fs        = require("fs");

const ask = (q) => new Promise((r) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); r(a.trim()); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── EDIT INI ──────────────────────────────────────────────
const EMAIL    = "ankiee565@nfpro.store";
const PASSWORD = "Cecilionss17"; // password akun
// ─────────────────────────────────────────────────────────

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36"
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // ── Login manual dulu ─────────────────────────────────
  await page.goto("https://www.netflix.com/clearcookies", { waitUntil: "networkidle2" });
  await sleep(1000);
  await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2" });
  await sleep(1000);

  // Isi email
  await page.waitForSelector("input", { timeout: 10000 });
  const inputs = await page.$$("input");
  await inputs[0].type(EMAIL, { delay: 80 });
  await page.keyboard.press("Enter");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
  await sleep(2000);

  // Cek apakah OTP atau password
  const isOtp = await page.evaluate(() => {
    return document.body.innerText.toLowerCase().includes("code we sent");
  });

  if (isOtp) {
    console.log("Halaman OTP — klik Get Help lalu Use password instead...");
    // Klik Get Help
    await page.evaluate(() => {
      document.querySelectorAll("button").forEach(b => {
        if (b.textContent.trim().toLowerCase() === "get help") b.click();
      });
    });
    await sleep(1000);
    // Klik Use password instead
    await page.evaluate(() => {
      document.querySelectorAll("a, button").forEach(b => {
        if (b.textContent.toLowerCase().includes("use password instead")) b.click();
      });
    });
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  }

  // Isi password
  const pwInput = await page.$('input[type="password"], input[name="password"]');
  if (pwInput) {
    await pwInput.type(PASSWORD, { delay: 80 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
  }
  await sleep(1000);
  console.log("Login selesai, URL:", page.url());

  // ── Navigasi ke manageaccountaccess ──────────────────
  await page.goto("https://www.netflix.com/manageaccountaccess", { waitUntil: "networkidle2" });
  await sleep(2000);

  // Handle verifikasi identitas jika muncul
  const needsVerify = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes("verifikasi identitas") ||
    document.body.innerText.toLowerCase().includes("verify your identity")
  );

  if (needsVerify) {
    console.log("Halaman verifikasi muncul — klik Kirim kode...");
    await page.evaluate(() => {
      document.querySelectorAll("a, button, div, li").forEach(el => {
        if (el.textContent.toLowerCase().includes("kirim kode") ||
            el.textContent.toLowerCase().includes("send code via email")) el.click();
      });
    });
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await sleep(2000);

    const code = await ask("Masukkan 6-digit kode verifikasi: ");
    // Isi kode
    const otpInputs = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
    for (let i = 0; i < code.length && i < otpInputs.length; i++) {
      await otpInputs[i].type(code[i]);
    }
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await sleep(2000);
  }

  console.log("URL sekarang:", page.url());
  console.log("\n=== SEBELUM EXPAND — dump semua device cards ===");

  // Dump structure device list sebelum expand
  const beforeExpand = await page.evaluate(() => {
    const items = document.querySelectorAll(
      '[data-uia*="device-list"], [class*="device"], [class*="accountDevice"], li, article'
    );
    const result = [];
    items.forEach(el => {
      const text = el.textContent.trim().substring(0, 200);
      if (text.length > 5) {
        result.push({
          tag: el.tagName,
          uia: el.getAttribute("data-uia") ?? "",
          cls: el.className?.toString().substring(0, 100),
          text: text,
        });
      }
    });
    return result.slice(0, 30);
  });

  beforeExpand.forEach((e, i) => {
    console.log(`\n${i + 1}. <${e.tag}> data-uia="${e.uia}"`);
    console.log(`   class: ${e.cls}`);
    console.log(`   text: ${e.text.substring(0, 100)}`);
  });

  // Dump semua element dengan data-uia yang mengandung "device"
  console.log("\n=== Semua elemen dengan data-uia mengandung 'device' ===");
  const deviceUia = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll("[data-uia]").forEach(el => {
      const uia = el.getAttribute("data-uia");
      if (uia && uia.includes("device")) {
        result.push({
          tag: el.tagName,
          uia,
          text: el.textContent.trim().substring(0, 80),
          cls: el.className?.toString().substring(0, 80),
        });
      }
    });
    return result;
  });

  deviceUia.forEach((e, i) => {
    console.log(`${i + 1}. <${e.tag}> data-uia="${e.uia}" text="${e.text}"`);
  });

  // Klik semua chevron / expand button
  console.log("\n=== Klik semua expand button ===");
  const expandCount = await page.evaluate(() => {
    // Cari semua button dengan SVG ChevronDownSmall atau aria-expanded=false
    let count = 0;
    const btns = document.querySelectorAll(
      'button[aria-expanded="false"], [data-uia*="dropdown-button"], [data-icon="ChevronDownSmall"]'
    );
    btns.forEach(btn => {
      // Jangan klik yang sudah expanded
      const closest = btn.closest('button') ?? btn;
      closest.click();
      count++;
    });
    return count;
  });
  console.log(`Klik ${expandCount} expand button`);
  await sleep(2000);

  // Dump setelah expand
  console.log("\n=== SETELAH EXPAND — dump semua data-uia ===");
  const afterExpand = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll("[data-uia]").forEach(el => {
      const uia = el.getAttribute("data-uia");
      if (uia) {
        result.push({
          tag: el.tagName,
          uia,
          text: el.textContent.trim().substring(0, 100),
        });
      }
    });
    return result;
  });

  afterExpand.forEach((e, i) => {
    console.log(`${i + 1}. [${e.tag}] data-uia="${e.uia}" | "${e.text}"`);
  });

  // Simpan HTML lengkap
  const html = await page.content();
  fs.writeFileSync("debug-devices.html", html);
  await page.screenshot({ path: "debug-devices.png", fullPage: true });
  console.log("\nHTML: debug-devices.html");
  console.log("Screenshot: debug-devices.png");

  await ask("\nTekan Enter untuk tutup...");
  await browser.close();
}

main().catch(console.error);
