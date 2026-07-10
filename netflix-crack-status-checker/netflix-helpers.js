"use strict";

// ── Parse cookie string "NetflixId=xxx;SecureNetflixId=yyy;" ──
function parseCookieString(raw) {
  if (!raw) return null;
  const map = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  if (!map.NetflixId || !map.SecureNetflixId) return null;
  return map;
}

function buildPlaywrightCookies(cookieMap) {
  const base = {
    domain: ".netflix.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
  };
  return [
    { ...base, name: "NetflixId", value: cookieMap.NetflixId },
    { ...base, name: "SecureNetflixId", value: cookieMap.SecureNetflixId },
  ];
}

function buildCookieRawString(cookieMap) {
  return `NetflixId=${cookieMap.NetflixId};SecureNetflixId=${cookieMap.SecureNetflixId};`;
}

module.exports = { parseCookieString, buildPlaywrightCookies, buildCookieRawString };