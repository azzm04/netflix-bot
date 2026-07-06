/**
 * debug-nfpro.js — Intercept network request dari nfpro.store
 * untuk mengetahui struktur API call ketika submit email + verification type
 * Jalankan: node debug-nfpro.js
 */
"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer");

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();

  // Intercept semua request
  const requests = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    requests.push({
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      postData: req.postData(),
    });
    req.continue();
  });

  // Intercept semua response
  const responses = [];
  page.on("response", async (res) => {
    const url = res.url();
    // Hanya simpan response dari nfpro.store (bukan CDN/static)
    if (url.includes("nfpro.store") && !url.match(/\.(js|css|png|ico|woff)/)) {
      try {
        const body = await res.text().catch(() => "");
        responses.push({
          status: res.status(),
          url,
          body: body.substring(0, 2000),
        });
      } catch {}
    }
  });

  console.log("Membuka nfpro.store...");
  await page.goto("https://nfpro.store/cecilionss#fetch", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await new Promise((r) => setTimeout(r, 2000));

  // Isi email
  const testEmail = "ankiee565@nfpro.store";
  console.log(`\nMengisi email: ${testEmail}`);

  // Cari input email
  await page.waitForSelector('input[type="email"], input[type="text"], input[placeholder*="email" i]', {
    timeout: 10000,
  });

  const emailInput = await page.$('input[type="email"]') ??
                     await page.$('input[type="text"]') ??
                     await page.$('input[placeholder*="email" i]');

  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(testEmail, { delay: 80 });
    console.log("Email terisi.");
  } else {
    console.log("Input email tidak ditemukan!");
  }

  // Dump semua elemen verification type
  const vtElements = await page.evaluate(() => {
    const result = [];
    document.querySelectorAll("button, [role='radio'], [role='button'], label, .option, [class*='type'], [class*='choice']").forEach((el) => {
      const t = el.textContent.trim();
      if (t && t.length < 50) {
        result.push({
          tag: el.tagName,
          text: t,
          class: el.className?.toString().substring(0, 80),
          dataAttr: el.dataset ? JSON.stringify(el.dataset).substring(0, 100) : "",
        });
      }
    });
    return result;
  });

  console.log("\n=== Elemen Verification Type ===");
  vtElements.forEach((e, i) => {
    console.log(`${i + 1}. <${e.tag}> "${e.text}" | class="${e.class}" | data=${e.dataAttr}`);
  });

  // Klik "4-Digit Code"
  console.log('\nMencoba klik "4-Digit Code"...');
  const clicked = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const t = el.textContent.trim().toLowerCase();
      if (t === "4-digit code" || t === "4 digit code" || t === "4-digit") {
        el.click();
        return el.tagName + ": " + el.className;
      }
    }
    return null;
  });
  console.log("Klik result:", clicked);

  await new Promise((r) => setTimeout(r, 1000));

  // Klik Continue
  console.log('\nMencoba klik "Continue"...');
  const continueBtnText = await page.evaluate(() => {
    const btns = document.querySelectorAll("button");
    for (const btn of btns) {
      if (btn.textContent.toLowerCase().includes("continue")) {
        btn.click();
        return btn.textContent.trim();
      }
    }
    return null;
  });
  console.log("Continue klik:", continueBtnText);

  // Tunggu response
  await new Promise((r) => setTimeout(r, 5000));

  // Dump semua request ke nfpro.store
  console.log("\n=== Request ke nfpro.store ===");
  requests
    .filter((r) => r.url.includes("nfpro.store"))
    .forEach((r, i) => {
      console.log(`\n${i + 1}. ${r.method} ${r.url}`);
      if (r.postData) console.log("   Body:", r.postData.substring(0, 500));
      const headers = Object.entries(r.headers)
        .filter(([k]) => !["sec-", "accept-", "user-agent"].some(p => k.startsWith(p)))
        .map(([k, v]) => `${k}: ${v}`).join("\n   ");
      console.log("   Headers:", headers);
    });

  console.log("\n=== Response dari nfpro.store ===");
  responses.forEach((r, i) => {
    console.log(`\n${i + 1}. [${r.status}] ${r.url}`);
    console.log("   Body:", r.body.substring(0, 500));
  });

  // Screenshot hasil
  await page.screenshot({ path: "debug-nfpro.png", fullPage: true });
  console.log("\nScreenshot: debug-nfpro.png");

  // Dump HTML halaman hasil (jika ada redirect/response)
  const finalUrl = page.url();
  const finalHtml = await page.content();
  require("fs").writeFileSync("debug-nfpro-result.html", finalHtml);
  console.log("Final URL:", finalUrl);
  console.log("HTML: debug-nfpro-result.html");

  await new Promise((r) => setTimeout(r, 3000));
  await browser.close();
}

main().catch(console.error);
