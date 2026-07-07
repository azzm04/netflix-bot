/**
 * test-cookie.js — Test kick device & ganti PIN via cookie injection
 *
 * CARA PAKAI:
 *   node test-cookie.js kick "email" "Profil1" ["Profil2"]
 *   node test-cookie.js pin  "email" "password" "Profil1" ["Profil2"]
 *   node test-cookie.js check [email]      → cek validitas cookie
 *   node test-cookie.js list               → lihat semua email di cookies.json
 */

"use strict";

require("dotenv").config();
const { kickDevicesForProfilesCookie, CookieExpiredError } = require("./kicker-cookie");
const { changePinsForProfilesCookie }                      = require("./pin-changer-cookie");
const { verifyCookie, loadAllCookies }                     = require("./cookie-helper");

async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {

    // ── Kick Device ───────────────────────────────────────
    case "kick": {
      const [email, ...profiles] = args;
      if (!email || profiles.length === 0) {
        console.error('Usage: node test-cookie.js kick "email" "Profil1" ["Profil2" ...]');
        process.exit(1);
      }
      console.log(`\nKick device`);
      console.log(`Email  : ${email}`);
      console.log(`Profil : ${profiles.join(", ")}\n`);
      try {
        const t0     = Date.now();
        const result = await kickDevicesForProfilesCookie(email, profiles);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n✓ Selesai (${elapsed}s) — ${result.kicked} device dikick.`);
      } catch (err) {
        if (err instanceof CookieExpiredError) {
          console.error(`\n✗ Cookie expired!`);
          console.error(`  Jalankan: node harvest-cookies.js HARIAN`);
        } else {
          console.error(`\n✗ Error: ${err.message}`);
        }
        process.exit(1);
      }
      break;
    }

    // ── Ganti PIN ─────────────────────────────────────────
    case "pin": {
      const [email, password, ...profiles] = args;
      if (!email || !password || profiles.length === 0) {
        console.error('Usage: node test-cookie.js pin "email" "password" "Profil1" ["Profil2" ...]');
        process.exit(1);
      }
      console.log(`\nGanti PIN`);
      console.log(`Email  : ${email}`);
      console.log(`Profil : ${profiles.join(", ")}\n`);
      try {
        const t0         = Date.now();
        const pinChanges = await changePinsForProfilesCookie(email, password, profiles);
        const elapsed    = ((Date.now() - t0) / 1000).toFixed(1);
        if (pinChanges.size > 0) {
          console.log(`\n✓ PIN berhasil diganti (${elapsed}s):`);
          for (const [profil, pin] of pinChanges) {
            console.log(`   ${profil}: ${pin}`);
          }
        } else {
          console.log(`\n⚠ Tidak ada profil yang cocok (${elapsed}s).`);
        }
      } catch (err) {
        if (err instanceof CookieExpiredError) {
          console.error(`\n✗ Cookie expired!`);
          console.error(`  Jalankan: node harvest-cookies.js HARIAN`);
        } else {
          console.error(`\n✗ Error: ${err.message}`);
        }
        process.exit(1);
      }
      break;
    }

    // ── Cek Cookie ────────────────────────────────────────
    case "check": {
      const [email] = args;
      const all     = loadAllCookies();
      const emails  = email ? [email] : Object.keys(all);

      if (emails.length === 0) {
        console.log("Belum ada cookie tersimpan.");
        break;
      }

      console.log(`\nCek ${emails.length} cookie...\n`);
      for (const e of emails) {
        const result = await verifyCookie(e);
        console.log(`${result.valid ? "✓" : "✗"} ${e}`);
        console.log(`   ${result.reason}`);
      }
      break;
    }

    // ── List ──────────────────────────────────────────────
    case "list": {
      const all    = loadAllCookies();
      const emails = Object.keys(all);
      if (emails.length === 0) {
        console.log("Belum ada cookie tersimpan.");
        break;
      }
      console.log(`\nCookie tersimpan (${emails.length} akun):`);
      for (const e of emails) {
        const d = all[e];
        const hasId = d.netflixId ? "✓" : "✗";
        console.log(`  ${hasId} ${e}  — disimpan: ${d.savedAt ?? "-"}`);
      }
      break;
    }

    default:
      console.log(`
Netflix Cookie Test
===================
Perintah:
  kick  <email> <profil...>            Kick device via cookie
  pin   <email> <password> <profil...> Ganti PIN via cookie
  check [email]                        Cek validitas (semua jika tanpa email)
  list                                 Lihat semua cookie tersimpan

Contoh:
  node test-cookie.js list
  node test-cookie.js check
  node test-cookie.js kick  "tunaik989@meetushop.us" "NamaProfil"
  node test-cookie.js pin   "humpadhis@stayhome.li" "harapjujurkk" "DOLCE"
      `);
  }
}

main().catch(console.error);
