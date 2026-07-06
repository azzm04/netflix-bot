/**
 * debug-login.js — Debug halaman OTP Netflix
 * Buka browser, masuk ke halaman OTP, dump semua link dan button yang ada
 * Jalankan: node debug-login.js
 */
"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer");
const readline  = require("readline");

const ask = (q) => new Promise((r) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); r(a.trim()); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36"
  );

  // Buka clearcookies dulu
  await page.goto("https://www.netflix.com/clearcookies", { waitUntil: "networkidle2" });
  await sleep(1000);

  // Ke halaman login
  await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2" });
  await sleep(1000);

  // Isi email
  const email = "ankiee565@nfpro.store";
  console.log(`Mengisi email: ${email}`);
  await page.waitForSelector('input', { timeout: 10000 });
  
  const inputs = await page.$$('input');
  await inputs[0].type(email, { delay: 80 });
  await sleep(400);

  // Klik Continue
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
  await sleep(2000);

  console.log(`\nURL sekarang: ${page.url()}`);
  console.log("Halaman OTP muncul. Mendump semua elemen interaktif...\n");

  // Dump semua link dan button yang visible
  const elements = await page.evaluate(() => {
    const result = [];
    const all = document.querySelectorAll('a, button, [role="button"], [data-uia]');
    all.forEach((el) => {
      const text = el.textContent.trim();
      const tag  = el.tagName.toLowerCase();
      const uia  = el.getAttribute("data-uia") ?? "";
      const href = el.getAttribute("href") ?? "";
      const cls  = el.className ?? "";
      if (text && text.length < 100) {
        result.push({ tag, text, uia, href, cls: cls.toString().substring(0, 60) });
      }
    });
    return result;
  });

  console.log("=== Semua elemen interaktif ===");
  elements.forEach((e, i) => {
    console.log(`${i + 1}. <${e.tag}> text="${e.text}" data-uia="${e.uia}" href="${e.href}"`);
  });

  // Dump khusus yang mengandung kata "password"
  console.log("\n=== Elemen yang mengandung 'password' ===");
  const pwEls = await page.evaluate(() => {
    const result = [];
    const all = document.querySelectorAll('*');
    all.forEach((el) => {
      const text = el.textContent.trim().toLowerCase();
      if (text.includes("password") && text.length < 80) {
        const tag  = el.tagName.toLowerCase();
        const uia  = el.getAttribute("data-uia") ?? "";
        const href = el.getAttribute("href") ?? "";
        result.push({ tag, text: el.textContent.trim(), uia, href });
      }
    });
    return result;
  });
  pwEls.forEach((e, i) => {
    console.log(`${i + 1}. <${e.tag}> text="${e.text}" data-uia="${e.uia}" href="${e.href}"`);
  });

  // Simpan screenshot + HTML untuk analisis
  await page.screenshot({ path: "debug-otp-page.png", fullPage: true });
  const html = await page.content();
  require("fs").writeFileSync("debug-otp-page.html", html);
  console.log("\nScreenshot: debug-otp-page.png");
  console.log("HTML: debug-otp-page.html");

  await ask("\nTekan Enter untuk tutup browser...");
  await browser.close();
}

main().catch(console.error);
