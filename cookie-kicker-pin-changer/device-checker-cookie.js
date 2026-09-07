"use strict";

/**
 * device-checker-cookie.js — Cek device Netflix TANPA kick apa pun.
 *
 * Dipicu admin lewat /cekdevice di bot Telegram. Alurnya sengaja identik
 * dengan kicker-cookie.js (sesi cookie → netflix.com/manageaccountaccess →
 * MFA kalau muncul → scan semua device → cocokkan dengan spreadsheet), tapi
 * berhenti tepat sebelum eksekusi: tidak ada tombol "Keluar" yang diklik,
 * tidak ada mass sign-out.
 *
 * Keputusan "sesuai / tidak sesuai" diambil dari auditDevices() milik
 * kicker-cookie.js — fungsi yang sama persis yang dipakai kicker untuk
 * memutuskan kick — supaya hasil /cekdevice selalu mencerminkan apa yang
 * BAKAL dilakukan kicker, bukan aturan tandingan yang gampang beda.
 */

require("dotenv").config();
const {
  newCookiePage,
  scanAllDevices,
  auditDevices,
  checkForExtraVerification,
  refreshAndSaveCookies,
  CookieExpiredError,
  URL_DEVICES,
} = require("./kicker-cookie");

const TIMEOUT_NAV = 45_000;

// ── Rapikan teks profil dari kartu device untuk ditampilkan ───────
// extractProfileName() mengembalikan baris apa adanya ("terakhir ditonton
// oleh budi"); untuk laporan cukup nama profilnya saja.
function tidyProfileText(text) {
  if (!text) return "";
  return text
    .replace(/^.*?(?:ditonton oleh|watched by)\s*/i, "")
    .replace(/\s+pada\s+.*$/i, "")
    .trim();
}

/**
 * Baca semua device sebuah akun dan bandingkan dengan aturan di spreadsheet.
 *
 * @param {string}  email
 * @param {boolean} [isMaheshHint] - kalau tidak diisi, diambil dari blok sheet
 * @returns {Promise<object>} ringkasan siap dikirim ke Telegram
 */
async function checkDevicesForEmail(email, isMaheshHint = null) {
  let page;

  try {
    // Baca spreadsheet DULU: selain jadi acuan audit, dari sini juga ketahuan
    // akun ini ada di blok MAHESH atau bukan — menentukan sumber kode MFA.
    let profileRows = [];
    let sheetError = null;
    try {
      const { getAllProfilesForEmail } = require("./sheets");
      profileRows = await getAllProfilesForEmail(email);
      console.log(`  [cekdevice] Data spreadsheet: ${profileRows.length} profil untuk ${email}`);
    } catch (err) {
      sheetError = err.message;
      console.warn(`  [cekdevice] Gagal baca spreadsheet: ${err.message} — laporan tanpa pembanding.`);
    }

    const isMahesh = isMaheshHint ?? profileRows.some((r) => r.isMahesh);

    page = await newCookiePage(email, URL_DEVICES);
    await checkForExtraVerification(page, email, isMahesh);

    if (!page.url().includes("manageaccountaccess")) {
      console.log("  [cekdevice] Redirect tidak terduga, navigate ulang...");
      await page.goto(URL_DEVICES, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV });
      await checkForExtraVerification(page, email, isMahesh);
    }

    const snapshot = await scanAllDevices(page);
    console.log(`  [cekdevice] Snapshot: ${snapshot.length} device terbaca`);

    // expiredTargets sengaja kosong: /cekdevice memotret kondisi SEKARANG.
    // Profil yang slot-nya sudah kosong/EXPIRED di sheet tetap ketahuan lewat
    // isEmptySlot, jadi intruder di slot kosong tetap ketangkep.
    const { verdicts, kickNames } = auditDevices(snapshot, [], profileRows);

    const devices = verdicts.map((v) => ({
      nama: v.deviceName,
      profil: v.profile || tidyProfileText(v.profileOnNetflix),
      status: v.action, // keep | kick | unknown
      alasan: v.reason,
      isCurrent: v.isCurrent,
      noActivity: v.noActivity,
    }));

    // Ringkasan per profil sheet: berapa device yang benar-benar terdeteksi.
    const perProfil = profileRows.map((r) => ({
      profil: r.profile,
      batas: r.allowedDeviceCount,
      colG: r.colGRaw,
      slotKosong: r.isEmptySlot,
      jumlahDevice: verdicts.filter((v) => v.profile === r.profile).length,
    }));

    const hasil = {
      email,
      totalDevice: devices.length,
      sesuai: devices.filter((d) => d.status === "keep" && !d.isCurrent).length,
      tidakSesuai: devices.filter((d) => d.status === "kick").length,
      takDikenal: devices.filter((d) => d.status === "unknown").length,
      devices,
      perProfil,
      profilTanpaDevice: perProfil.filter((p) => !p.slotKosong && p.jumlahDevice === 0).map((p) => p.profil),
      sheetError,
      isMahesh,
    };

    console.log(
      `  [cekdevice] ${hasil.totalDevice} device — ${hasil.sesuai} sesuai, ` +
        `${hasil.tidakSesuai} tidak sesuai, ${hasil.takDikenal} tidak dikenali.`,
    );
    if (kickNames.length) {
      console.log(`  [cekdevice] Kalau dikick sekarang: [${kickNames.join(", ")}] (TIDAK dieksekusi)`);
    }

    // Dynamic Update: cookie bisa dirotasi server saat halaman dibuka.
    await refreshAndSaveCookies(page.context(), email);

    return hasil;
  } finally {
    if (page) await page.context().close().catch(() => {});
  }
}

// ── CLI ───────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case "check": {
      // node device-checker-cookie.js check <email>
      const [email] = args;
      if (!email) {
        console.error("Usage: node device-checker-cookie.js check <email>");
        process.exit(1);
      }

      try {
        const hasil = await checkDevicesForEmail(email);
        // Satu baris JSON dengan penanda — handler /cekdevice di bot yang
        // merangkainya jadi pesan Telegram.
        console.log(`<<<CEKDEVICE_JSON>>>${JSON.stringify(hasil)}`);
        process.exit(0);
      } catch (err) {
        if (err instanceof CookieExpiredError) {
          console.error(`[cekdevice] COOKIE_EXPIRED untuk ${email}: ${err.message}`);
        } else {
          console.error(`[cekdevice] GAGAL untuk ${email}: ${err.message}`);
        }
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`
Netflix Device Checker (read-only)
==================================
Perintah:
  check <email>   Tampilkan semua device akun & kesesuaiannya dengan spreadsheet
      `);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[cekdevice] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { checkDevicesForEmail };
