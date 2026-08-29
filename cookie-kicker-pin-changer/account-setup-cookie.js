"use strict";

require("dotenv").config();
const { launchAccountContext, getCookieForEmail } = require("./cookie-helper");

const TIMEOUT_NAV = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE_NAMES = [
  "CUSTARD", "ELLIOT", "DEXTER", "BLAIR", "NOVA",
  "COSMO", "JASPER", "FELIX", "LUNA", "MILO",
  "FINN", "PIP", "RORY", "TATE", "ZANE",
  "AXEL", "CLEO", "ELODIE", "FREYA", "HUGO",
  "IRIS", "JUNO", "KIRA", "LEVI", "MILA",
  "RUBY", "CORA", "THEO", "OTTO", "SILAS"
];

function getRandomNames(count) {
  const shuffled = [...PROFILE_NAMES].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

async function setupAccountProfiles(email) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) {
    throw new Error(`Cookie tidak ditemukan untuk ${email}`);
  }

  const ctx = await launchAccountContext(email, { cookieData });
  const page = await ctx.newPage();

  try {
    console.error(`[account-setup] Membuka Netflix untuk ${email}...`);
    await page.goto("https://www.netflix.com/browse", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_NAV,
    });

    const url = page.url();
    if (url.includes("/login") || url.includes("/LoginHelp")) {
      throw new Error("Cookie expired.");
    }

    // Step 1: New Profiles
    console.error(`[account-setup] Navigasi ke simpleSetup/newprofiles...`);
    await page.goto("https://www.netflix.com/simpleSetup/newprofiles", {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_NAV,
    });
    
    // Generate 5 names
    const names = getRandomNames(5);
    console.error(`[account-setup] Generated names: ${names.join(", ")}`);
    
    // Tunggu input ownerName muncul
    await page.waitForSelector('input[name="ownerName"]', { timeout: 15000 });
    
    const fields = [
      "ownerName",
      "profile1Name",
      "profile2Name",
      "profile3Name",
      "profile4Name"
    ];

    for (let i = 0; i < 5; i++) {
      const input = page.locator(`input[name="${fields[i]}"]`);
      if (await input.isVisible().catch(() => false)) {
        await input.fill(names[i]);
      }
    }
    
    await sleep(1000);
    const nextBtn1 = page.locator('button[data-uia="cta_profiles_form"]');
    await nextBtn1.click();
    
    // Step 2: Kids Profiles
    console.error(`[account-setup] Menunggu halaman kidsprofiles...`);
    await page.waitForURL("**/simpleSetup/kidsprofiles", { timeout: 15000 }).catch(() => {});
    await sleep(2000);
    
    if (page.url().includes("kidsprofiles")) {
      console.error(`[account-setup] Memeriksa status Kids...`);
      const kidsFields = [
        "profile1IsKids",
        "profile2IsKids",
        "profile3IsKids",
        "profile4IsKids"
      ];
      for (const field of kidsFields) {
        const checkbox = page.locator(`input[name="${field}"]`);
        if (await checkbox.isVisible().catch(() => false)) {
          const isChecked = await checkbox.isChecked();
          if (isChecked) {
            // Click to uncheck via the label (works better with Netflix custom styled checkboxes)
            const id = await checkbox.getAttribute("id");
            if (id) {
                await page.locator(`label[for="${id}"]`).click().catch(() => {});
            }
          }
        }
      }
      await sleep(1000);
      const nextBtn2 = page.locator('button[data-uia="cta_profiles_form"]');
      if (await nextBtn2.isVisible().catch(() => false)) {
          await nextBtn2.click();
      }
    }
    
    // Step 3: Secondary Languages
    console.error(`[account-setup] Menunggu halaman secondarylanguages...`);
    await page.waitForURL("**/simpleSetup/secondarylanguages", { timeout: 15000 }).catch(() => {});
    await sleep(2000);
    
    if (page.url().includes("secondarylanguages")) {
      console.error(`[account-setup] Mengatur bahasa...`);
      // Check ID
      const idCheckbox = page.locator('input[name="allLanguages_id"]');
      if (await idCheckbox.isVisible().catch(() => false)) {
          if (!(await idCheckbox.isChecked())) {
              const id = await idCheckbox.getAttribute("id");
              if (id) {
                  await page.locator(`label[for="${id}"]`).click().catch(() => {});
              }
          }
      }
      
      // Uncheck others (except en and id)
      const allCheckboxes = page.locator('.languages-container input[type="checkbox"]');
      const count = await allCheckboxes.count();
      for (let i = 0; i < count; i++) {
          const cb = allCheckboxes.nth(i);
          const nameAttr = await cb.getAttribute("name");
          if (nameAttr !== "preferredLanguages_en" && nameAttr !== "allLanguages_en" && nameAttr !== "allLanguages_id") {
             const disabled = await cb.isDisabled();
             if (!disabled && (await cb.isChecked())) {
                 const id = await cb.getAttribute("id");
                 if (id) {
                     await page.locator(`label[for="${id}"]`).click().catch(() => {});
                 }
             }
          }
      }
      
      await sleep(1000);
      const nextBtn3 = page.locator('button[data-uia="cta-secondary-languages-inline"], button[data-uia="cta-secondary-languages-fixed"]');
      if (await nextBtn3.first().isVisible().catch(() => false)) {
          await nextBtn3.first().click();
      }
    }

    // Biarkan proses submit form sebelumnya (Kids/Language) selesai terlebih dahulu
    // agar tidak terjadi bentrok navigasi (ERR_ABORTED).
    await sleep(4000);

    // Step 4: Menyiapkan PIN
    console.error(`[account-setup] Menyiapkan PIN untuk setiap profil...`);
    const { fetchVerificationCode, fillCodeInputs } = require("./kicker-cookie");
    const pinData = [];

    // Cek apakah akun ini adalah MAHESH/ROSE
    const { getAllProfilesForEmail } = require("./sheets");
    let isMaheshAccount = false;
    try {
        const pList = await getAllProfilesForEmail(email);
        if (pList && pList.length > 0) {
            isMaheshAccount = pList[0].isMahesh;
        }
    } catch (e) {
        console.error(`[account-setup] Cek tipe akun gagal: ${e.message}`);
    }
    console.error(`[account-setup] Tipe akun: ${isMaheshAccount ? "MAHESH" : "MEET/NFPRO"}`);

    const safeGoto = async (url) => {
        for (let r = 0; r < 3; r++) {
            try {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
                return;
            } catch (err) {
                if (err.message.includes("ERR_ABORTED") && r < 2) {
                    console.error(`[account-setup] Navigasi aborted, retry ${r+1}...`);
                    await sleep(2000);
                } else {
                    throw err;
                }
            }
        }
    };

    await safeGoto("https://www.netflix.com/account/profiles");
    
    await sleep(2000);
    
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      console.error(`[account-setup] Memproses PIN untuk profil: ${name}`);
      
      if (!page.url().includes("/account/profiles")) {
        await safeGoto("https://www.netflix.com/account/profiles");
        await sleep(2000);
      }

      // 1. Klik nama profil (aria-label) di daftar profiles
      const profileBtn = page.locator(`button[aria-label="${name}"]`).first();
      if (!(await profileBtn.isVisible().catch(() => false))) {
        console.error(`[account-setup] Tidak dapat menemukan profil: ${name}`);
        continue;
      }
      await profileBtn.click();
      
      // 2. Tunggu redirect ke detail profil
      await page.waitForURL("**/settings/**", { timeout: 10000 }).catch(() => {});
      await sleep(1000);
      
      // 3. Klik "Profile Lock"
      const lockBtn = page.locator('button[data-uia="menu-card+profile-lock"]');
      if (!(await lockBtn.isVisible().catch(() => false))) {
        console.error(`[account-setup] Tombol Profile Lock tidak ditemukan untuk ${name}`);
        continue;
      }
      await lockBtn.click();
      
      // 4. Tunggu ke halaman lock
      await page.waitForURL("**/settings/lock/**", { timeout: 10000 }).catch(() => {});
      await sleep(2000);
      
      // 5. Cek apakah button Create a Profile Lock ada
      const createLockBtn = page.locator('button[data-uia="profile-lock-off+add-button"]');
      if (await createLockBtn.isVisible().catch(() => false)) {
        await createLockBtn.click();
        await sleep(2000);
        
        // Cek "First, let's make sure it's you" -> Email a code
        const emailCodeBtn = page.locator('[data-uia="account-mfa-button-OTP_EMAIL"] button').first();
        if (await emailCodeBtn.isVisible().catch(() => false)) {
          console.error(`[account-setup] Meminta OTP email untuk ${name}...`);
          await emailCodeBtn.click();
          
          await page.waitForFunction(
            () => document.querySelectorAll('input[inputmode="numeric"], input[maxlength="1"]').length >= 4 ||
                  document.body.innerText.toLowerCase().includes("code will expire") ||
                  document.body.innerText.toLowerCase().includes("kode tersebut akan kedaluwarsa"),
            { timeout: 15000, polling: 500 }
          ).catch(() => {});
          
          const code6 = await fetchVerificationCode(page, email, isMaheshAccount);
          if (code6) {
              await fillCodeInputs(page, code6);
              await sleep(500);
              const submitBtn = page.locator('button[data-uia="collect-input-submit-cta"], button[type="submit"]').first();
              if (await submitBtn.isVisible().catch(() => false)) {
                await submitBtn.click();
              } else {
                await page.keyboard.press("Enter");
              }
              await sleep(3000);
          } else {
              console.error(`[account-setup] Gagal mendapatkan OTP untuk ${name}. Melewati profil ini.`);
              continue; // Skip profil ini jika gagal OTP
          }
        }
      }
      
      // 6. Masukkan PIN 4 digit
      const pinInput = page.locator('[data-uia="profile-lock+pin-input"]');
      if (await pinInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        // Generate random 4-digit PIN
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        await pinInput.fill(pin);
        
        const savePinBtn = page.locator('button[data-uia="profile-lock-pin-entry-page+save-button"]');
        if (await savePinBtn.isVisible().catch(() => false)) {
          await savePinBtn.click();
          
          // Tunggu toast sukses
          const toast = page.locator('div[role="alert"]:has-text("Profile Lock on"), div[role="alert"]:has-text("Kunci Profil nyala")');
          await toast.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
          
          pinData.push({ name: name, pin: pin });
          console.error(`[account-setup] Berhasil set PIN ${pin} untuk profil ${name}`);
          await sleep(2000);
        }
      } else {
        console.error(`[account-setup] Halaman input PIN tidak terbuka untuk ${name}`);
      }
    }

    console.error(`[account-setup] Selesai setup profil.`);
    
    // Return profiles output as JSON on stdout for python to read
    console.log(JSON.stringify({
      success: true,
      profiles: names,
      pinData: pinData
    }));
    
  } catch (error) {
    console.error(`[account-setup] Error: ${error.message}`);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  } finally {
    await ctx.close().catch(() => {});
  }
}

const args = process.argv.slice(2);
const email = args[0];

if (!email) {
  console.error("Usage: node account-setup-cookie.js <email>");
  process.exit(1);
}

setupAccountProfiles(email).catch(err => {
    console.error(err);
    process.exit(1);
});
