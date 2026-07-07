/**
 * nfpro.js — Fetch kode Netflix secara otomatis dari nfpro.store/cecilionss
 *
 * Flow:
 *   POST /cecilionss  { check_mode: "recheck", choice: CHOICE, email: EMAIL }
 *   → redirect ke GET /cecilionss/result
 *   → parse kode dari: [data-nf-otp] atau .otp-value--hero
 *
 * Choice mapping:
 *   "signin"   → 4-Digit Code (login Netflix via kode email)
 *   "signin6"  → 6-Digit Code (verifikasi identitas di manageaccountaccess)
 *   "login"    → 2FA Code
 *   "household"→ Household link/code
 */

"use strict";

const https  = require("https");
const http   = require("http");
const { URL } = require("url");

const BASE_URL  = "https://nfpro.store/cecilionss";
const RESULT_URL = "https://nfpro.store/cecilionss/result";

// ─── Helper: HTTP request sederhana (tanpa library eksternal) ──
/**
 * Kirim HTTP request, kembalikan { status, headers, body }.
 * @param {string} url
 * @param {{ method?, headers?, body? }} options
 * @param {string[]} cookieJar  - mutable array untuk simpan/kirim cookie
 * @returns {Promise<{ status: number, headers: object, body: string, finalUrl: string }>}
 */
function request(url, options = {}, cookieJar = []) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...(options.headers ?? {}),
    };

    if (cookieJar.length > 0) {
      headers["Cookie"] = cookieJar.join("; ");
    }

    if (options.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(options.body);
      headers["Origin"] = "https://nfpro.store";
      headers["Referer"] = BASE_URL;
    }

    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method ?? "GET",
      headers,
    };

    const req = lib.request(reqOptions, (res) => {
      // Simpan Set-Cookie ke jar
      const setCookie = res.headers["set-cookie"];
      if (setCookie) {
        setCookie.forEach((c) => {
          const cookiePart = c.split(";")[0].trim();
          const name = cookiePart.split("=")[0];
          // Update atau tambah cookie (hindari duplikat)
          const idx = cookieJar.findIndex((existing) =>
            existing.startsWith(name + "=")
          );
          if (idx >= 0) cookieJar[idx] = cookiePart;
          else cookieJar.push(cookiePart);
        });
      }

      // Handle redirect (302)
      if (
        (res.statusCode === 301 || res.statusCode === 302) &&
        res.headers.location
      ) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://nfpro.store${res.headers.location}`;
        // Consume body lalu follow redirect
        res.resume();
        request(redirectUrl, { method: "GET" }, cookieJar)
          .then(resolve)
          .catch(reject);
        return;
      }

      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          finalUrl: url,
        })
      );
    });

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Parse kode dari HTML result ──────────────────────────
/**
 * Ekstrak kode OTP dari HTML halaman result.
 * Prioritas:
 *   1. [data-nf-otp="XXXX"] — paling reliable
 *   2. .otp-value--hero text content
 *   3. Regex fallback: cari 4-6 digit di area kode
 *
 * @param {string} html
 * @returns {string|null}  kode sebagai string, null jika tidak ditemukan
 */
function parseCodeFromHtml(html) {
  // 1. data-nf-otp attribute (paling akurat)
  const attrMatch = html.match(/data-nf-otp="(\d{4,6})"/);
  if (attrMatch) return attrMatch[1];

  // 2. .otp-value--hero text content
  const heroMatch = html.match(
    /class="otp-value[^"]*otp-value--hero[^"]*"[^>]*>\s*(\d{4,6})\s*</
  );
  if (heroMatch) return heroMatch[1];

  // 3. otp-value tanpa --hero
  const otpMatch = html.match(/class="otp-value[^"]*"[^>]*>\s*(\d{4,6})\s*</);
  if (otpMatch) return otpMatch[1];

  // 4. Cek apakah ada "No code found" atau error
  if (html.toLowerCase().includes("no code") ||
      html.toLowerCase().includes("not found") ||
      html.toLowerCase().includes("chip-fail") ||
      html.toLowerCase().includes("no result")) {
    return null;
  }

  return null;
}

/**
 * Cek apakah result menunjukkan sukses atau gagal.
 * @param {string} html
 * @returns {"success"|"not_found"|"error"}
 */
function parseResultStatus(html) {
  if (html.includes("chip-success") || html.includes("Succeeded")) return "success";
  if (html.includes("chip-fail") || html.includes("Failed")) return "not_found";
  if (html.includes("result-card")) return "success"; // ada result card = ada hasil
  return "error";
}

// ─── Fungsi Utama ─────────────────────────────────────────

/**
 * Fetch kode Netflix dari nfpro.store secara otomatis.
 *
 * @param {string} email   - email akun Netflix
 * @param {"signin"|"signin6"|"login"|"household"} choice
 *   - "signin"   → 4-digit login code
 *   - "signin6"  → 6-digit verification code
 *   - "login"    → 2FA code
 *   - "household"→ household code/link
 * @param {object} opts
 *   - retries: jumlah retry jika kode belum ada (default: 3)
 *   - retryDelay: jeda antar retry dalam ms (default: 4000)
 * @returns {Promise<string>}  kode yang ditemukan
 * @throws {Error} jika kode tidak ditemukan setelah semua retry
 */
async function fetchNetflixCode(email, choice, opts = {}) {
  const retries    = opts.retries    ?? 3;
  const retryDelay = opts.retryDelay ?? 4000;

  const cookieJar = [];

  // Step 1: GET halaman utama dulu untuk dapat session cookie
  console.log(`  [nfpro] Inisialisasi session...`);
  await request(BASE_URL, { method: "GET" }, cookieJar);

  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`  [nfpro] Fetch "${choice}" untuk ${email} (attempt ${attempt}/${retries})...`);

    // Step 2: POST form dengan timestamp untuk hindari cache
    const body =
      `check_mode=recheck` +
      `&choice=${encodeURIComponent(choice)}` +
      `&email=${encodeURIComponent(email)}` +
      `&_t=${Date.now()}`;

    const res = await request(
      BASE_URL,
      {
        method: "POST",
        body,
        headers: {
          "Cache-Control": "no-cache, no-store",
          "Pragma": "no-cache",
        },
      },
      cookieJar
    );

    // Setelah POST + redirect, kita di /result
    const status = parseResultStatus(res.body);
    const code   = parseCodeFromHtml(res.body);

    if (code) {
      console.log(`  [nfpro] ✅ Kode ditemukan: ${code}`);
      return code;
    }

    if (status === "not_found" && attempt < retries) {
      console.log(`  [nfpro] Kode belum ada, retry dalam ${retryDelay / 1000}s...`);
      await new Promise((r) => setTimeout(r, retryDelay));
      continue;
    }

    if (attempt === retries) {
      // Debug: simpan body terakhir
      if (process.env.NFPRO_DEBUG === "true") {
        require("fs").writeFileSync(`nfpro-debug-${choice}.html`, res.body);
        console.log(`  [nfpro] Debug HTML disimpan ke nfpro-debug-${choice}.html`);
      }
      throw new Error(
        `Kode Netflix tidak ditemukan untuk ${email} (${choice}) setelah ${retries} percobaan.`
      );
    }
  }
}

module.exports = { fetchNetflixCode };
