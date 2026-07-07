/**
 * test-api.js — Test direct API (tanpa full browser UI)
 *
 * CARA PAKAI:
 *   node test-api.js pin "email@gmail.com" "passwordAkun" "Nama Profil"
 *   node test-api.js pin "email@gmail.com" "passwordAkun" "Profil1" "Profil2"
 */

"use strict";

require("dotenv").config();
const { changePinsViaApi, ApiError } = require("./netflix-api");

async function main() {
  const [,, cmd, email, password, ...profiles] = process.argv;

  if (cmd === "pin") {
    if (!email || !password || profiles.length === 0) {
      console.error('Usage: node test-api.js pin <email> <password> <profil1> [profil2 ...]');
      process.exit(1);
    }

    console.log(`\nGanti PIN via Direct API`);
    console.log(`Email  : ${email}`);
    console.log(`Profil : ${profiles.join(", ")}\n`);

    try {
      const t0         = Date.now();
      const pinChanges = await changePinsViaApi(email, password, profiles);
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
      console.error(`\n✗ Error: ${err.message}`);
      process.exit(1);
    }

  } else {
    console.log(`
Netflix Direct API Test
========================
Perintah:
  pin <email> <password> <profil...>   Ganti PIN via API

Contoh:
  node test-api.js pin "akun@gmail.com" "pass123" "DOLCE"
    `);
  }
}

main().catch(console.error);
