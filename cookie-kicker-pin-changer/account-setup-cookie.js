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

async function setupAccountProfiles(email, accountType = "") {
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

    for (let i = 0; i < fields.length; i++) {
      const fieldName = fields[i];
      const nameVal = names[i];
      
      const input = page.locator(`input[name="${fieldName}"]`);
      if (await input.isVisible().catch(() => false)) {
        await input.fill(nameVal);
        await sleep(300);
      }
    }

    const nextBtn1 = page.locator('button[data-uia="action-submit-new-profiles"]');
    await nextBtn1.click();

    // Step 2: Kids Profiles
    console.error(`[account-setup] Menunggu halaman kidsprofiles...`);
    await page.waitForURL("**/simpleSetup/kidsprofiles**", { timeout: 20000 }).catch(() => {});
    await sleep(2000);

    console.error(`[account-setup] Memeriksa status Kids...`);
    const kidsCheckboxes = page.locator('input[type="checkbox"]');
    const count = await kidsCheckboxes.count();
    
    for (let i = 0; i < count; i++) {
      const cb = kidsCheckboxes.nth(i);
      const isChecked = await cb.isChecked().catch(() => false);
      if (isChecked) {
        await cb.uncheck({ force: true });
        await sleep(300);
      }
    }

    const nextBtn2 = page.locator('button[data-uia="cta-kids-profiles"]');
    if (await nextBtn2.isVisible().catch(() => false)) {
      await nextBtn2.click();
    }
    
    // Step 3: Secondary Languages
    console.error(`[account-setup] Menunggu halaman secondarylanguages...`);
    await page.waitForURL("**/simpleSetup/secondarylanguages**", { timeout: 20000 }).catch(() => {});
    await sleep(2000);

    console.error(`[account-setup] Mengatur bahasa...`);
    const langEng = page.locator('input[name="en"]');
    if (await langEng.isVisible().catch(() => false)) {
      if (!(await langEng.isChecked())) {
        await langEng.check({ force: true });
      }
    }

    const langId = page.locator('input[name="id"]');
    if (await langId.isVisible().catch(() => false)) {
      if (!(await langId.isChecked())) {
        await langId.check({ force: true });
      }
    }
    
    const nextBtn3 = page.locator('button[data-uia="cta-secondary-languages-inline"], button[data-uia="cta-secondary-languages-fixed"]');
    if (await nextBtn3.first().isVisible().catch(() => false)) {
        await nextBtn3.first().click();
    }

    // Biarkan proses submit form sebelumnya selesai
    await sleep(4000);

    // Step 4: Menyiapkan PIN
    console.error(`[account-setup] Menyiapkan PIN untuk setiap profil...`);
    const { fetchVerificationCode, fillCodeInputs } = require("./kicker-cookie");
    
    // Pre-generate PIN untuk semua 5 profil agar selalu lengkap
    const pinData = names.map(n => ({
      name: n,
      pin: String(Math.floor(1000 + Math.random() * 9000))
    }));

    // Tentukan tipe akun (MAHESH vs MEET/NFPRO)
    let isMaheshAccount = false;
    const typeLower = (accountType || "").trim().toLowerCase();
    if (typeLower === "mahesh" || typeLower === "rose") {
      isMaheshAccount = true;
    } else if (typeLower === "meet" || typeLower === "nfpro") {
      isMaheshAccount = false;
    } else {
      // Auto-detect dari sheets jika tidak dispesifikasikan di argumen
      try {
        const { getAllProfilesForEmail } = require("./sheets");
        const pList = await getAllProfilesForEmail(email);
        if (pList && pList.length > 0) {
          isMaheshAccount = pList[0].isMahesh;
        }
      } catch (e) {
        console.error(`[account-setup] Auto-detect tipe akun gagal: ${e.message}`);
      }
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
    
    for (let i = 0; i < pinData.length; i++) {
      const item = pinData[i];
      const name = item.name;
      const targetPin = item.pin;
      console.error(`[account-setup] Memproses PIN untuk profil: ${name} (PIN: ${targetPin})`);
      
      if (!page.url().includes("/account/profiles")) {
        await safeGoto("https://www.netflix.com/account/profiles");
        await sleep(2000);
      }

      // 1. Klik nama profil di daftar profiles
      const profileBtn = page.locator(`button[aria-label="${name}"], [data-uia*="${name}"]`).first();
      if (!(await profileBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.error(`[account-setup] Tidak dapat menemukan profil: ${name}`);
        continue;
      }
      await profileBtn.click();
      
      // 2. Tunggu redirect ke detail profil
      await page.waitForURL("**/settings/**", { timeout: 10000 }).catch(() => {});
      await sleep(1000);
      
      // 3. Klik "Profile Lock"
      const lockBtn = page.locator('button[data-uia="menu-card+profile-lock"], button:has-text("Profile Lock"), button:has-text("Kunci Profil")').first();
      if (!(await lockBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
        console.error(`[account-setup] Tombol Profile Lock tidak ditemukan untuk ${name}`);
        continue;
      }
      await lockBtn.click();
      
      // 4. Tunggu ke halaman lock
      await page.waitForURL("**/settings/lock/**", { timeout: 10000 }).catch(() => {});
      await sleep(2000);
      
      // 5. Cek apakah button Create a Profile Lock ada
      const createLockBtn = page.locator('button[data-uia="profile-lock-off+add-button"], button:has-text("Create a Profile Lock"), button:has-text("Kunci Profil")').first();
      if (await createLockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await createLockBtn.click();
        await sleep(2000);
      }
      
      // --- VERIFIKASI (Password / OTP) ---
      const passInput = page.locator('input[type="password"]');
      if (await passInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.error(`[account-setup] Netflix meminta konfirmasi password untuk ${name}...`);
          const fallbackLink = page.locator('button[data-uia="account-mfa-button-OTP_EMAIL"], a:has-text("Email a code"), button:has-text("Email a code"), a:has-text("Use a sign-in code"), button:has-text("Use a sign-in code")').first();
          if (await fallbackLink.isVisible({ timeout: 2000 }).catch(() => false)) {
              await fallbackLink.click();
              await sleep(2000);
          }
      }

      const emailCodeBtn = page.locator('button[data-uia="account-mfa-button-OTP_EMAIL"], [data-uia="account-mfa-button-OTP_EMAIL"] button, button:has-text("Email a code")').first();
      if (await emailCodeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
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
          console.error(`[account-setup] Gagal mendapatkan OTP untuk ${name}.`);
        }
      }
      
      // 6. Masukkan PIN 4 digit
      const pinInput = page.locator('[data-uia="profile-lock+pin-input"], input[name="PIN"]').first();
      if (await pinInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pinInput.fill(targetPin);
        
        const savePinBtn = page.locator('button[data-uia="profile-lock-pin-entry-page+save-button"], button:has-text("Save PIN"), button:has-text("Simpan PIN")').first();
        if (await savePinBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await savePinBtn.click();
          
          const toast = page.locator('div[role="alert"]:has-text("Profile Lock on"), div[role="alert"]:has-text("Kunci Profil nyala")');
          await toast.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
          
          console.error(`[account-setup] ✅ Berhasil set PIN ${targetPin} untuk profil ${name}`);
          await sleep(2000);
        }
      } else {
        console.error(`[account-setup] Halaman input PIN tidak terbuka untuk ${name}`);
      }
    }

    console.error(`[account-setup] Selesai setup profil.`);
    
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
const accountType = args[1] || "";

if (!email) {
  console.error("Usage: node account-setup-cookie.js <email> [accountType]");
  process.exit(1);
}

setupAccountProfiles(email, accountType).catch(err => {
    console.error(err);
    process.exit(1);
});
