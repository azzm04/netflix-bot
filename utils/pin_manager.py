# ============================================================
#  utils/pin_manager.py — Manajemen PIN verifikasi rekap invest
# ============================================================

import json
import os

PIN_FILE = "pin_invest.json"
_DEFAULT_PIN = "erni040969"


def baca_pin() -> str:
    """
    Baca PIN dari pin_invest.json.
    Jika file tidak ada, buat dengan PIN default.
    """
    if not os.path.exists(PIN_FILE):
        _tulis_pin(_DEFAULT_PIN)
        return _DEFAULT_PIN
    try:
        with open(PIN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("pin", _DEFAULT_PIN)
    except Exception:
        return _DEFAULT_PIN


def _tulis_pin(pin_baru: str):
    """Tulis PIN baru ke pin_invest.json."""
    with open(PIN_FILE, "w", encoding="utf-8") as f:
        json.dump({"pin": pin_baru}, f)


def verifikasi_pin(input_pin: str) -> bool:
    """Cek apakah input_pin cocok dengan PIN yang tersimpan."""
    return input_pin.strip() == baca_pin()


def ganti_pin(pin_lama: str, pin_baru: str) -> dict:
    """
    Ganti PIN jika pin_lama benar.
    Return: {'ok': True} atau {'ok': False, 'reason': str}
    """
    if not verifikasi_pin(pin_lama):
        return {"ok": False, "reason": "PIN lama salah."}
    if len(pin_baru.strip()) < 6:
        return {"ok": False, "reason": "PIN baru minimal 6 karakter."}
    _tulis_pin(pin_baru.strip())
    return {"ok": True}
