# ============================================================
#  utils/pin_manager.py — Manajemen PIN verifikasi
#  - pin_invest.json : untuk /rekap_invest, /rekap_invest_ulang
#  - pin_admin.json  : untuk /rekap, /closing
# ============================================================

import json
import os

PIN_INVEST_FILE  = "pin_invest.json"
PIN_ADMIN_FILE   = "pin_admin.json"

_DEFAULT_PIN_INVEST = "erni040969"
_DEFAULT_PIN_ADMIN  = "Lherys123"


def _baca(filepath: str, default: str) -> str:
    """Baca PIN dari file. Buat file dengan default jika belum ada."""
    if not os.path.exists(filepath):
        _tulis(filepath, default)
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f).get("pin", default)
    except Exception:
        return default


def _tulis(filepath: str, pin: str):
    """Tulis PIN ke file."""
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump({"pin": pin}, f)


# ── PIN Invest (/rekap_invest, /rekap_invest_ulang) ─────────

def baca_pin() -> str:
    return _baca(PIN_INVEST_FILE, _DEFAULT_PIN_INVEST)


def verifikasi_pin(input_pin: str) -> bool:
    return input_pin.strip() == baca_pin()


def ganti_pin(pin_lama: str, pin_baru: str) -> dict:
    if not verifikasi_pin(pin_lama):
        return {"ok": False, "reason": "PIN lama salah."}
    if len(pin_baru.strip()) < 6:
        return {"ok": False, "reason": "PIN baru minimal 6 karakter."}
    _tulis(PIN_INVEST_FILE, pin_baru.strip())
    return {"ok": True}


# ── PIN Admin (/rekap, /closing) ────────────────────────────

def baca_pin_admin() -> str:
    return _baca(PIN_ADMIN_FILE, _DEFAULT_PIN_ADMIN)


def verifikasi_pin_admin(input_pin: str) -> bool:
    return input_pin.strip() == baca_pin_admin()


def ganti_pin_admin(pin_lama: str, pin_baru: str) -> dict:
    if not verifikasi_pin_admin(pin_lama):
        return {"ok": False, "reason": "PIN lama salah."}
    if len(pin_baru.strip()) < 6:
        return {"ok": False, "reason": "PIN baru minimal 6 karakter."}
    _tulis(PIN_ADMIN_FILE, pin_baru.strip())
    return {"ok": True}
