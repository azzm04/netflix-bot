/**
 * debug-cards.js — Dump struktur HTML semua device card
 * Jalankan SETELAH login manual di browser, lalu paste cookies
 * Atau jalankan langsung dan biarkan login otomatis dulu
 * 
 * Jalankan: node debug-cards.js
 */
"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");
const readline = require("readline");

const ask = (q) => new Promise(r => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); r(a.trim()); });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── EDIT INI ──
const EMAIL    = "fred50314@nfpro.store";
const PASSWORD = "Cecilionss17";
// ─────────────

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

  // Login
  await page.goto("https://www.netflix.com/clearcookies", { waitUntil: "networkidle2" });
  await sleep(1000);
  await page.goto("https://www.netflix.com/login", { waitUntil: "networkidle2" });
  await sleep(1000);

  await page.waitForSelector("input");
  const inputs = await page.$$("input");
  await inputs[0].type(EMAIL, { delay: 80 });
  await page.keyboard.press("Enter");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
  await sleep(2000);

  // Cek OTP vs password
  const isOtp = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes("code we sent")
  );
  if (isOtp) {
    // Klik Get Help → Use password instead
    await page.evaluate(() => {
      document.querySelectorAll("button").forEach(b => {
        if (b.textContent.trim().toLowerCase() === "get help") b.click();
      });
    });
    await sleep(1000);
    await page.evaluate(() => {
      document.querySelectorAll("a, button, span").forEach(b => {
        if (b.textContent.toLowerCase().includes("use password instead")) b.click();
      });
    });
    await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {});
  }

  const pwInput = await page.$('input[type="password"], input[name="password"]');
  if (pwInput) {
    await pwInput.type(PASSWORD, { delay: 80 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
  }
  await sleep(1000);
  console.log("Login URL:", page.url());

  // Ke manageaccountaccess
  await page.goto("https://www.netflix.com/manageaccountaccess", { waitUntil: "networkidle2" });
  await sleep(2000);

  // Cek verifikasi
  const needsVerify = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes("verifikasi identitas") ||
    document.body.innerText.toLowerCase().includes("verify your identity")
  );
  if (needsVerify) {
    const code = await ask("Masukkan 6-digit kode verifikasi: ");
    // klik kirim kode dulu
    await page.evaluate(() => {
      document.querySelectorAll("a, button, div, li").forEach(el => {
        if (el.textContent.toLowerCase().includes("kirim kode")) el.click();
      });
    });
    await sleep(2000);
    const otpInputs = await page.$$('input[maxlength="1"], input[inputmode="numeric"]');
    for (let i = 0; i < code.length && i < otpInputs.length; i++) {
      await otpInputs[i].type(code[i]);
    }
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await sleep(2000);
  }

  console.log("Halaman devices URL:", page.url());
  await sleep(1000);

  // ── DUMP semua button[aria-expanded] ──────────────────────
  console.log("\n=== Semua button[aria-expanded] ===");
  const ariaButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button[aria-expanded]")).map((btn, i) => ({
      index: i,
      ariaExpanded: btn.getAttribute("aria-expanded"),
      dataUia: btn.getAttribute("data-uia") ?? "",
      text: btn.textContent.trim().substring(0, 50),
      // Ambil teks parent card
      parentText: (btn.parentElement?.parentElement?.parentElement?.innerText ?? "")
        .substring(0, 100).replace(/\n/g, " | "),
    }));
  });
  ariaButtons.forEach(b => {
    console.log(`  [${b.index}] aria-expanded="${b.ariaExpanded}" | uia="${b.dataUia}" | parent="${b.parentText}"`);
  });

  // ── DUMP semua [data-uia*="dropdown"] ──────────────────────
  console.log("\n=== Semua [data-uia*='dropdown'] ===");
  const dropdownEls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("[data-uia*='dropdown']")).map((el, i) => ({
      index: i,
      tag: el.tagName,
      dataUia: el.getAttribute("data-uia"),
      ariaExpanded: el.getAttribute("aria-expanded"),
      text: el.textContent.trim().substring(0, 50),
      closestBtn: el.closest("button")?.getAttribute("data-uia") ?? "none",
    }));
  });
  dropdownEls.forEach(e => {
    console.log(`  [${e.index}] <${e.tag}> uia="${e.dataUia}" | aria="${e.ariaExpanded}" | closestBtn="${e.closestBtn}"`);
  });

  // ── Dump HTML card pertama (PERANGKAT SAAT INI) ──────────
  console.log("\n=== HTML card pertama (PERANGKAT SAAT INI) ===");
  const firstCardHtml = await page.evaluate(() => {
    // Cari elemen yang mengandung "perangkat saat ini"
    const all = document.querySelectorAll("*");
    for (const el of all) {
      if (el.textContent.trim().toLowerCase() === "perangkat saat ini") {
        // Naik ke container card
        let card = el;
        for (let i = 0; i < 5; i++) {
          card = card.parentElement;
          if (!card) break;
        }
        return card?.outerHTML?.substring(0, 2000) ?? "not found";
      }
    }
    return "PERANGKAT SAAT INI text not found";
  });
  console.log(firstCardHtml.substring(0, 2000));

  // ── Dump HTML card kedua ──────────────────────────────────
  console.log("\n=== HTML card kedua (collapsed) ===");
  const secondCardHtml = await page.evaluate(() => {
    const btns = document.querySelectorAll('button[aria-expanded="false"]');
    if (btns.length === 0) return "No collapsed cards found";
    const btn = btns[0];
    let card = btn;
    for (let i = 0; i < 6; i++) {
      card = card.parentElement;
      if (!card) break;
    }
    return card?.outerHTML?.substring(0, 2000) ?? "not found";
  });
  console.log(secondCardHtml.substring(0, 2000));

  fs.writeFileSync("debug-cards.html", await page.content());
  await page.screenshot({ path: "debug-cards.png", fullPage: true });
  console.log("\nHTML: debug-cards.html | Screenshot: debug-cards.png");

  await ask("\nTekan Enter untuk tutup...");
  await browser.close();
}

main().catch(console.error);
