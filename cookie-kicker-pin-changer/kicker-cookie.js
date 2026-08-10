/**
 * kicker-cookie.js — Kick device Netflix via Cookie Injection
 * Logic kick: validasi semua device berdasarkan data spreadsheet (seperti device-auditor.js)
 */
"use strict";

require("dotenv").config();
const { requestCodeFromTelegram } = require("./tg-bridge");
const {
  getCookieForEmail,
  deleteCookieForEmail,
  launchAccountContext,
} = require("./cookie-helper");
const fs = require("fs");

const TIMEOUT_NAV = 45_000;
const URL_DEVICES = "https://www.netflix.com/manageaccountaccess";

// Kalau device "tidak ada aktivitas" (jejak bot sendiri: keep-alive/kick/pin-changer
const MASS_LOGOUT_THRESHOLD = parseInt(process.env.MASS_LOGOUT_THRESHOLD, 10) || 20;

// Resource yang aman diblokir untuk mempercepat load — TIDAK termasuk "stylesheet"
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

const DEBUG_SHOT_RETENTION_MS =
  (parseInt(process.env.DEBUG_SHOT_RETENTION_DAYS, 10) || 7) * 24 * 60 * 60 * 1000;

// ── Custom Errors ─────────────────────────────────────────
class CookieExpiredError extends Error {
  constructor(email) {
    super(`Cookie expired untuk ${email}. Jalankan: node cookie-helper.js save-interactive "${email}"`);
    this.name  = "CookieExpiredError";
    this.email = email;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Sembunyikan sebagian besar kode OTP sebelum masuk log ────
function maskCode(code) {
  if (!code) return code;
  const visible = 2;
  return code.length <= visible
    ? "*".repeat(code.length)
    : "*".repeat(code.length - visible) + code.slice(-visible);
}

// ── Debug Screenshot (dengan retensi, biar tidak menumpuk selamanya) ─
function pruneOldDebugShots(dir) {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(dir)) {
      const filePath = `${dir}/${file}`;
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > DEBUG_SHOT_RETENTION_MS) fs.unlinkSync(filePath);
    }
  } catch {}
}

function debugShot(page, name) {
  const dir = process.env.DEBUG_SHOT_DIR ?? "/tmp/nfdebug";
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  pruneOldDebugShots(dir);
  return page.screenshot({ path: `${dir}/${name}_${Date.now()}.png`, fullPage: true }).catch(() => {});
}

// ── Ekstrak nama profil dari teks card Netflix ────────────
function extractProfileName(profileLine) {
  if (!profileLine) return "";
  const beforeParen = profileLine.split("(")[0];
  const stripped    = beforeParen.replace(/^\d+\s+-\s+/, "");
  return stripped.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Cocokkan nama profil card dengan target spreadsheet ───
function profileNameMatches(nameOnCard, targetName, rawProfileText = "") {
  if (!nameOnCard || !targetName) return false;

  const norm        = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normNoEmoji = (s) =>
    s.toLowerCase()
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
      .replace(/\s+/g, " ").trim();

  const a = norm(nameOnCard);
  const b = norm(targetName);

  if (a === b) return true;

  const aNoEmoji  = normNoEmoji(nameOnCard);
  const bNoEmoji  = normNoEmoji(targetName);
  const aHasEmoji = a !== aNoEmoji;
  const bHasEmoji = b !== bNoEmoji;
  if ((aHasEmoji || bHasEmoji) && aNoEmoji === bNoEmoji && aNoEmoji.length > 0) return true;

  if (a.length >= 4 && b.length >= 4) {
    const endsDigit = (s) => /\d$/.test(s);
    const wbMatch   = (longer, shorter) => {
      const idx = longer.indexOf(shorter);
      if (idx === -1) return false;
      const before = idx === 0 ? " " : longer[idx - 1];
      const after  = idx + shorter.length >= longer.length ? " " : longer[idx + shorter.length];
      return before === " " && after === " ";
    };
    if (!endsDigit(b) && wbMatch(a, b)) return true;
    if (!endsDigit(a) && wbMatch(b, a)) return true;
  }

  if (rawProfileText) {
    try {
      const escaped = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(rawProfileText)) return true;
    } catch {}
  }

  return false;
}

// ── Buat Context (persistent, per akun) + Buka Halaman ────
async function newCookiePage(email, targetUrl) {
  const cookieData = getCookieForEmail(email);
  if (!cookieData) throw new CookieExpiredError(email);

  const ctx = await launchAccountContext(email, { cookieData });

  await ctx.route("**/*", (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await ctx.newPage();
  console.log(`  [cookie] Membuka ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });

  const url = page.url();
  if (url.includes("/login") || url.includes("/LoginHelp")) {
    await debugShot(page, `cookie_expired_${email.split("@")[0]}`);
    deleteCookieForEmail(email);
    await ctx.close().catch(() => {});
    throw new CookieExpiredError(email);
  }
  console.log(`  [cookie] Berhasil akses: ${url}`);
  return page;
}

// ── Verifikasi MFA ────────────────────────────────────────
async function checkForExtraVerification(page, email, isMahesh = false) {
  await sleep(1000);
  const url      = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const needsMfa =
    url.includes("/mfa") ||
    bodyText.toLowerCase().includes("verifikasi identitas") ||
    bodyText.toLowerCase().includes("verify your identity") ||
    bodyText.toLowerCase().includes("email a code") ||
    bodyText.toLowerCase().includes("kirim kode");

  if (!needsMfa) return;
  console.log(`  [mfa] Halaman verifikasi terdeteksi (${url})`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  [mfa] Attempt ${attempt}/3`);

    const emailCodeBtn = page.locator(
      'button:has-text("Email a code"), button:has-text("Kirim kode"), button:has-text("Kirim Ulang Kode"), [data-uia="account-mfa-button-OTP_EMAIL"] button'
    ).first();
    if (await emailCodeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol kirim kode...`);
      await emailCodeBtn.click();
    }

    await page.waitForFunction(
      () => document.querySelectorAll('input[inputmode="numeric"], input[maxlength="1"]').length >= 4 ||
            document.body.innerText.toLowerCase().includes("code will expire") ||
            document.body.innerText.toLowerCase().includes("kode tersebut akan kedaluwarsa"),
      { timeout: 15_000, polling: 500 }
    ).catch(() => {});

    console.log(`  [mfa] Tunggu 10 detik agar email terkirim...`);
    await sleep(10_000);

    let code6 = null;
    try {
      if (isMahesh) {
        const { fetchFromMaheshBot } = require("./mahesh-fetcher");
        for (let mA = 1; mA <= 3; mA++) {
          console.log(`  [mfa] Fetch kode via Mahesh Bot (percobaan ${mA}/3)...`);
          try { code6 = await fetchFromMaheshBot(email, "vercode", { retries: 0, retryDelay: 5000 }); break; }
          catch (mErr) {
            console.warn(`  [mfa] Mahesh Bot gagal (percobaan ${mA}): ${mErr.message}`);
            if (mA < 3) {
              const resend = page.locator('button:has-text("Kirim Ulang Kode"), button:has-text("Resend"), button:has-text("Email a code"), button:has-text("Kirim kode")').first();
              if (await resend.isVisible({ timeout: 3000 }).catch(() => false)) await resend.click();
              await sleep(5000);
            } else throw mErr;
          }
        }
      } else {
        const { fetchNetflixCode } = require("./nfpro");
        console.log(`  [mfa] Auto-fetch kode 6 digit via nfpro...`);
        code6 = await fetchNetflixCode(email, "signin6", { retries: 2, retryDelay: 5000 });
      }
      console.log(`  [mfa] Kode: ${maskCode(code6)}`);
    } catch (err) {
      console.warn(`  [mfa] Auto-fetch gagal: ${err.message}`);
      console.log(`  [mfa] Minta kode manual via Telegram...`);
      try {
        code6 = await requestCodeFromTelegram(email, "6digit", isMahesh ? "MAHESH" : "");
      } catch (tgErr) {
        throw new Error(`MFA gagal untuk ${email}: ${tgErr.message}`);
      }
    }

    if (!code6) throw new Error(`Kode MFA tidak tersedia untuk ${email}`);

    const digits = code6.replace(/\D/g, "").split("");
    console.log(`  [mfa] Isi ${digits.length} digit: ${maskCode(code6)}`);

    let inputs = [];
    for (const sel of ['input[inputmode="numeric"]', 'input[maxlength="1"]', 'input[autocomplete="one-time-code"]']) {
      inputs = await page.$$(sel);
      if (inputs.length >= digits.length) break;
    }
    console.log(`  [mfa] Input boxes ditemukan: ${inputs.length}`);

    if (inputs.length === 0) {
      const single = page.locator('input[type="text"], input[type="number"]').first();
      if (await single.isVisible({ timeout: 2000 }).catch(() => false)) await single.fill(code6);
    } else if (inputs.length === 1) {
      console.log(`  [mfa] Single input — isi sekaligus: ${code6}`);
      await inputs[0].click(); await sleep(100);
      await inputs[0].evaluate((el) => { el.value = ""; });
      await inputs[0].evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, code6);
      await sleep(300);
    } else {
      for (let i = 0; i < digits.length && i < inputs.length; i++) {
        await inputs[i].click(); await inputs[i].press(digits[i]); await sleep(100);
      }
    }

    await sleep(500);
    const submitBtn = page.locator('button[type="submit"], button:has-text("Kirim")').first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  [mfa] Klik tombol Kirim...`); await submitBtn.click();
    } else { await page.keyboard.press("Enter"); }

    await sleep(3000);
    const bodyAfter = await page.locator("body").innerText().catch(() => "");
    const urlAfter  = page.url();
    if (!urlAfter.includes("/mfa")) { console.log(`  [mfa] ✅ Verifikasi berhasil! URL: ${urlAfter}`); return; }

    const isWrong = bodyAfter.toLowerCase().includes("kode tersebut salah") ||
                    bodyAfter.toLowerCase().includes("code is incorrect") ||
                    bodyAfter.toLowerCase().includes("kode salah");
    if (isWrong && attempt < 3) { console.warn(`  [mfa] ❌ Kode salah. Coba lagi...`); await sleep(2000); continue; }
    if (attempt === 3) throw new Error(`MFA gagal setelah 3 percobaan untuk ${email}`);
  }
}

// ── Verifikasi toast setelah kick ────────────────────────
async function waitForKickToastMatch(page, deviceName, timeoutMs = 10000) {
  try {
    const toast = page.locator('div[role="alert"]').last();
    await toast.waitFor({ state: "visible", timeout: timeoutMs });
    const text  = await toast.innerText().catch(() => "");
    const lower = text.toLowerCase();
    const isKickPhrase =
      lower.includes("dihentikan aksesnya") ||
      lower.includes("kini telah dihentikan") ||
      (lower.includes("device") && lower.includes("signed out")) ||
      lower.includes("is now signed out");
    const nameMatches = deviceName && text.includes(deviceName);
    if (isKickPhrase && nameMatches) return text.trim();
    if (isKickPhrase && !nameMatches)
      console.warn(`  [kick-verify] ⚠ Toast nama tidak cocok. Toast: "${text.trim()}" | Diharapkan: "${deviceName}"`);
    return null;
  } catch { return null; }
}

// ── Sign Out of All Devices (mass logout untuk backlog device parah) ─────
// Beda dari kickDeviceByName: ini juga ikut logout device pelanggan asli yang
// masih aktif — tradeoff yang disengaja saat jumlah device "tidak ada aktivitas"
// sudah separah MASS_LOGOUT_THRESHOLD (biasanya jejak bot lama, lihat komentar
// di atas). Session yang dipakai untuk klik tombol ini TIDAK ikut ke-logout.
async function signOutAllDevices(page) {
  const soadBtn = page.locator('[data-uia="manage-account-access-page+soad-button"]');
  if (!(await soadBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    console.warn(`  [kick] ⚠ Tombol "Sign Out of All Devices" tidak ditemukan — fallback ke kick satu-satu.`);
    return false;
  }

  console.log(`  [kick] Klik "Sign Out of All Devices"...`);
  await soadBtn.click();
  await sleep(1200);

  // Modal konfirmasi biasanya punya tombol dengan teks yang sama persis —
  // prioritaskan tombol di dalam dialog kalau ada, baru fallback ke text-match umum.
  const inDialog = page
    .locator('[role="dialog"] button:has-text("Sign Out"), [role="dialog"] button:has-text("Keluar")')
    .first();
  const anyConfirm = page
    .locator('button:has-text("Sign Out of All Devices"), button:has-text("Keluar dari Semua Perangkat")')
    .last();

  const confirmBtn = (await inDialog.isVisible({ timeout: 3000 }).catch(() => false)) ? inDialog : anyConfirm;
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log(`  [kick] Konfirmasi mass sign-out...`);
    await confirmBtn.click().catch(() => {});
  }

  await sleep(4000);
  console.log(`  [kick] ✅ Sign Out of All Devices selesai.`);
  return true;
}

// ── Scan semua device (2 pass: expand lalu baca) ─────────
async function scanAllDevices(page) {
  await sleep(1500);
  let more = true;
  while (more) {
    const showMore = page.locator('[data-uia="device-list+show-more-button"]');
    if (await showMore.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showMore.click(); console.log("  [kick] Klik Tampilkan Lainnya..."); await sleep(1200);
    } else { more = false; }
  }

  const cards = page.locator('li[data-uia^="device-list+"]');
  const count = await cards.count();

  // Pass 1: expand semua
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;
    if ((await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0) continue;
    const drop = card.locator('[data-uia$="+dropdown-button"]').first();
    if (await drop.isVisible({ timeout: 1500 }).catch(() => false)) { await drop.click(); await sleep(600); }
  }
  await sleep(1000);

  // Pass 2: baca teks
  const devices = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;
    const isCurrent  = (await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0;
    const cardText   = await card.innerText().catch(() => "");
    const lowerText  = cardText.toLowerCase();
    const lines      = cardText.split("\n").map((l) => l.trim()).filter(Boolean);
    const deviceName = lines[0] ?? "";

    let profileText = null;
    for (const line of lines) {
      if (line.toLowerCase().includes("terakhir ditonton") || line.toLowerCase().includes("last watched")) {
        profileText = line; break;
      }
    }
    if (profileText && (profileText.toLowerCase().includes("tidak ada aktivitas") || profileText.toLowerCase().includes("no activity")))
      profileText = null;

    const noActivity = lowerText.includes("tidak ada aktivitas") || lowerText.includes("no activity");
    devices.push({ index: i, deviceName, profileText, noActivity, isCurrent });
    console.log(`  [kick] 📋 [${i}] "${deviceName}" | profil: ${profileText ? extractProfileName(profileText) : (noActivity ? "no activity" : "—")} | current: ${isCurrent}`);
  }
  return devices;
}

// ── Helper device matching (inline, sama seperti device-auditor) ──
function _tokenize(text) {
  const SW = new Set(["dan","browser","web","android","ios","ponsel","smart","hp","handphone","pc","the","a","an","tv","tab","tablet"]);
  return (text||"").toLowerCase().replace(/[.,()-]/g," ").split(/\s+/).map((w)=>w.trim()).filter((w)=>w.length>2&&!SW.has(w));
}
function _levenshtein(a,b) {
  if(!a.length)return b.length; if(!b.length)return a.length;
  const dp=Array.from({length:a.length+1},()=>new Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)dp[i][0]=i; for(let j=0;j<=b.length;j++)dp[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
    const c=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c);
  }
  return dp[a.length][b.length];
}
function _wordsSimilar(a,b){
  if(a===b||a.includes(b)||b.includes(a))return true;
  const mx=Math.max(a.length,b.length); return _levenshtein(a,b)<=(mx<=4?1:2);
}
function _classifyDevice(text){
  const t=(text||"").toLowerCase();
  if(/\btv\b|smart\s*tv|android\s*tv|tv\s*box/.test(t))return"tv";
  if(/\btab(let)?\b|ipad/.test(t))return"tablet";
  if(/\bpc\b|browser\s*web|laptop|notebook|macbook|chrome\s*-|windows|mac\s*os/.test(t))return"pc";
  if(/\bhp\b|handphone|\biphone\b|redmi|xiaomi|oppo|vivo|infinix|realme|poco/.test(t))return"phone";
  return"unknown";
}
function _deviceMatchesAllowed(netflixName, allowedDevices){
  if(!allowedDevices.length)return false;
  const catDev=_classifyDevice(netflixName), devWords=_tokenize(netflixName);
  return allowedDevices.some((allowed)=>{
    const catA=_classifyDevice(allowed);
    if(new Set(["pc","tv"]).has(catDev)){ if(catA!=="unknown"&&catA!==catDev)return false; return true; }
    if(catDev!=="unknown"&&catA!=="unknown"&&catDev!==catA)return false;
    const aw=_tokenize(allowed);
    if(!aw.length||!devWords.length)return false;
    return aw.some((a)=>devWords.some((d)=>_wordsSimilar(a,d)));
  });
}

// ── Putuskan device mana yang harus dikick ────────────────
/**
 * @param {Array}    snapshot        - hasil scanAllDevices()
 * @param {string[]} expiredTargets  - profil yang expired (lowercase)
 * @param {Array}    allProfileRows  - semua profil akun dari getAllProfilesForEmail()
 *                                     [] = gunakan logic target-only (fallback)
 * @returns {string[]} device names yang harus dikick
 */
function decideKickTargets(snapshot, expiredTargets, allProfileRows) {
  // Pakai array of index, bukan Set nama — karena bisa ada banyak device dengan nama sama
  const toKickIndices = new Set(); // Set of snapshot index
  const toKick        = [];        // hasil akhir: array { deviceName, snapshotIndex }

  // Helper: tambahkan device ke toKick berdasarkan index (hindari duplikat index)
  const addToKick = (d) => {
    if (!toKickIndices.has(d.index)) {
      toKickIndices.add(d.index);
      toKick.push({ deviceName: d.deviceName, snapshotIndex: d.index });
    }
  };

  // ── Fallback: tidak ada data spreadsheet ─────────────────
  if (!allProfileRows || allProfileRows.length === 0) {
    console.log("  [kick] ⚠ Tidak ada data profil lengkap — pakai logic target saja.");
    for (const d of snapshot) {
      if (d.isCurrent) continue;
      if (!d.profileText) { addToKick(d); continue; }
      if (expiredTargets.some((t) => profileNameMatches(extractProfileName(d.profileText), t, d.profileText)))
        addToKick(d);
    }
    return toKick.map((x) => x.deviceName);
  }

  // ── Evaluasi tiap profil dari spreadsheet ─────────────────
  for (const row of allProfileRows) {
    const { profile, allowedDeviceCount: maxDev, allowedDevices, colGRaw, isEmptySlot } = row;
    const isExpired = expiredTargets.some((t) => profileNameMatches(profile.toLowerCase(), t, profile));

    // SLOT KOSONG → kick semua intruder
    if (isEmptySlot) {
      snapshot.filter((d) => !d.isCurrent && d.profileText &&
        profileNameMatches(extractProfileName(d.profileText), profile, d.profileText)
      ).forEach((d) => {
        console.log(`  [kick] ✗ Slot kosong "${profile}" — kick intruder: "${d.deviceName}"`);
        addToKick(d);
      });
      continue;
    }

    // PROFIL EXPIRED → kick semua device yang pakai profil ini
    if (isExpired) {
      snapshot.filter((d) => !d.isCurrent && d.profileText &&
        profileNameMatches(extractProfileName(d.profileText), profile, d.profileText)
      ).forEach((d) => {
        console.log(`  [kick] ✗ Profil expired "${profile}" → kick: "${d.deviceName}"`);
        addToKick(d);
      });
      continue;
    }

    // PROFIL AKTIF → validasi jumlah & device yang diizinkan
    const profileDevices = snapshot.filter((d) =>
      !d.isCurrent && !d.noActivity && d.profileText &&
      profileNameMatches(extractProfileName(d.profileText), profile, d.profileText)
    );

    if (allowedDevices.length > 0) {
      // Ada kolom G → matching-based
      const scoring = profileDevices.map((d) => ({
        ...d,
        brandScore: allowedDevices.some((a) => {
          const aw = _tokenize(a), dw = _tokenize(d.deviceName);
          return aw.length && dw.length && aw.some((av) => dw.some((dv) => _wordsSimilar(av, dv)));
        }) ? 1 : 0,
      })).sort((a, b) => b.brandScore - a.brandScore || a.index - b.index);

      scoring.forEach((d, i) => {
        if (!_deviceMatchesAllowed(d.deviceName, allowedDevices)) {
          console.log(`  [kick] ✗ "${d.deviceName}" tidak cocok kolom G "${colGRaw}" → kick`);
          addToKick(d);
        } else if (i < maxDev) {
          console.log(`  [kick] ✓ "${d.deviceName}" diizinkan (match kolom G, posisi ${i+1}/${maxDev})`);
        } else {
          console.log(`  [kick] ✗ "${d.deviceName}" melebihi batas ${maxDev} → kick`);
          addToKick(d);
        }
      });
    } else {
      // Tidak ada kolom G → posisi-based
      [...profileDevices].sort((a, b) => a.index - b.index).forEach((d, i) => {
        if (i < maxDev) {
          console.log(`  [kick] ✓ "${d.deviceName}" dipertahankan (posisi ${i+1}/${maxDev})`);
        } else {
          console.log(`  [kick] ✗ "${d.deviceName}" melebihi batas ${maxDev} → kick`);
          addToKick(d);
        }
      });
    }
  }

  // Device "tidak ada aktivitas" → selalu kick
  snapshot.filter((d) => !d.isCurrent && d.noActivity && !d.profileText).forEach((d) => {
    console.log(`  [kick] ✗ "${d.deviceName}" tidak ada aktivitas → kick`);
    addToKick(d);
  });

  return toKick.map((x) => x.deviceName);
}

// ── Kick satu device berdasarkan nama ────────────────────
async function kickDeviceByName(page, deviceName) {
  for (let round = 0; round < 10; round++) {
    const cards = page.locator('li[data-uia^="device-list+"]');
    const count = await cards.count();
    let found   = false;

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      if (!(await card.isVisible().catch(() => false))) continue;
      if ((await card.locator('[data-uia$="+current-device-badge+ANNOUNCE"]').count()) > 0) continue;

      const lines      = (await card.innerText().catch(() => "")).split("\n").map((l) => l.trim()).filter(Boolean);
      const cardDevice = lines[0] ?? "";
      if (cardDevice !== deviceName) continue;

      found = true;
      const keluarBtn = card.locator('button:has-text("Keluar"), button:has-text("Sign Out")').first();
      let expanded = await keluarBtn.isVisible({ timeout: 500 }).catch(() => false);
      if (!expanded) {
        const drop = card.locator('[data-uia$="+dropdown-button"]').first();
        if (await drop.isVisible({ timeout: 1500 }).catch(() => false)) { await drop.click(); await sleep(1800); }
        expanded = await keluarBtn.isVisible({ timeout: 1500 }).catch(() => false);
        if (!expanded) break;
      }
      if (!(await keluarBtn.isVisible({ timeout: 2000 }).catch(() => false))) break;
      await keluarBtn.scrollIntoViewIfNeeded().catch(() => {});

      // Bersihkan toast lama
      const staleAlert = page.locator('div[role="alert"]').last();
      if (await staleAlert.isVisible({ timeout: 500 }).catch(() => false)) {
        const closeBtn = page.locator('button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]').first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) await closeBtn.click().catch(() => {});
        else await staleAlert.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
        await sleep(500);
      }

      try { await keluarBtn.click({ timeout: 10000 }); }
      catch { await debugShot(page, `click_blocked_${deviceName.replace(/\s+/g,"_")}`); await keluarBtn.click({ force: true, timeout: 10000 }); }

      const toastText = await waitForKickToastMatch(page, deviceName, 10000);
      if (toastText) {
        console.log(`  [kick] ✅ Dikick: "${deviceName}"`);
        const closeBtn = page.locator('button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]').first();
        if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) await closeBtn.click().catch(() => {});
        else await page.locator('div[role="alert"]').last().waitFor({ state: "hidden", timeout: 6000 }).catch(() => {});
        await sleep(4000);
        return true;
      } else {
        console.warn(`  [kick] ⚠ MISS: "${deviceName}" — toast tidak muncul.`);
        const closeBtn = page.locator('button[aria-label="Tutup Toast"], button[aria-label="Close"], button[aria-label="Dismiss"]').first();
        if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) await closeBtn.click().catch(() => {});
        await sleep(1500);
        return false;
      }
    }
    if (!found) break;
  }
  return false;
}

// ── Dynamic Update: simpan cookie terbaru ────────────────
async function refreshAndSaveCookies(ctx, email) {
  try {
    const allCookies = await ctx.cookies("https://www.netflix.com");
    const cm = Object.fromEntries(allCookies.map((c) => [c.name, c.value]));
    const netflixId       = cm["NetflixId"];
    const secureNetflixId = cm["SecureNetflixId"];
    if (!netflixId || !secureNetflixId) {
      console.log("  [cookie] Dynamic update: cookie baru tidak ditemukan, skip."); return;
    }
    const { saveCookieForEmail } = require("./cookie-helper");
    saveCookieForEmail(email, {
      netflixId, secureNetflixId,
      memclid:        cm["memclid"]        ?? null,
      nfvdid:         cm["nfvdid"]         ?? null,
      clSharedContext: cm["clSharedContext"] ?? null,
    });
    console.log("  [cookie] ✓ Dynamic update: cookie terbaru disimpan.");
  } catch (err) {
    console.warn(`  [cookie] Dynamic update gagal: ${err.message}`);
  }
}

// ── Entry Point: Kick untuk beberapa profil ──────────────
/**
 * @param {string}   email
 * @param {string[]} profileNames  - profil yang EXPIRED (akan dikick)
 * @param {boolean}  isMahesh
 */
async function kickDevicesForProfilesCookie(email, profileNames, isMahesh = false) {
  let totalKicked = 0;
  let page;

  try {
    page = await newCookiePage(email, URL_DEVICES);
    await checkForExtraVerification(page, email, isMahesh);

    if (!page.url().includes("manageaccountaccess")) {
      console.log("  [kick] Redirect tidak terduga, navigate ulang...");
      await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
      await checkForExtraVerification(page, email, isMahesh);
    }

    // Ambil SEMUA profil akun dari spreadsheet untuk validasi penuh
    let allProfileRows = [];
    try {
      const { getAllProfilesForEmail } = require("./sheets");
      allProfileRows = await getAllProfilesForEmail(email);
      console.log(`  [kick] Data spreadsheet: ${allProfileRows.length} profil ditemukan untuk ${email}`);
    } catch (sheetErr) {
      console.warn(`  [kick] Gagal baca spreadsheet: ${sheetErr.message} — pakai logic target-only`);
    }

    // Scan semua device sekaligus
    const snapshot = await scanAllDevices(page);
    console.log(`  [kick] Snapshot: ${snapshot.length} device terbaca`);

    // Kalau device "tidak ada aktivitas" numpuk parah (jejak bot lama sebelum
    // persistent-context fix), mass sign-out jauh lebih cepat & aman daripada
    // kick satu-satu ratusan device (rawan race toast-verification).
    const noActivityCount = snapshot.filter((d) => !d.isCurrent && d.noActivity && !d.profileText).length;
    const useMassLogout   = noActivityCount > MASS_LOGOUT_THRESHOLD;
    if (useMassLogout) {
      console.log(`  [kick] ${noActivityCount} device "tidak ada aktivitas" (> ${MASS_LOGOUT_THRESHOLD}) — pakai Sign Out of All Devices.`);
    }
    const massDone = useMassLogout && (await signOutAllDevices(page));

    if (massDone) {
      totalKicked = snapshot.length - 1; // semua kecuali device sesi bot sendiri
      console.log(`  [kick] Total ${totalKicked} device dikick (mass sign-out).`);
    } else {
      if (useMassLogout) console.log(`  [kick] Mass sign-out gagal/tidak tersedia — fallback ke kick satu-satu.`);

      // Putuskan siapa yang dikick
      const expiredTargets = profileNames.map((p) => p.trim().toLowerCase());
      const toKickNames    = decideKickTargets(snapshot, expiredTargets, allProfileRows);
      console.log(`  [kick] Keputusan: ${toKickNames.length} device akan dikick → [${toKickNames.join(", ")}]`);

      // Eksekusi kick satu per satu (urut dari atas)
      for (const deviceName of toKickNames) {
        console.log(`\n  [kick] → Kick: "${deviceName}"`);
        const ok = await kickDeviceByName(page, deviceName);
        if (ok) totalKicked++;
      }

      console.log(`  [kick] Total ${totalKicked} device dikick.`);
    }

    await refreshAndSaveCookies(page.context(), email);
  } finally {
    if (page) await page.context().close().catch(() => {});
  }

  return { kicked: totalKicked };
}

async function kickDevicesForProfileCookie(email, profileName, isMahesh = false) {
  return kickDevicesForProfilesCookie(email, [profileName], isMahesh);
}

module.exports = {
  kickDevicesForProfileCookie,
  kickDevicesForProfilesCookie,
  CookieExpiredError,
  checkForExtraVerification,
  refreshAndSaveCookies,
  waitForKickToastMatch,
  extractProfileName,
  profileNameMatches,
};
