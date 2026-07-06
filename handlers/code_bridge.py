# ============================================================
#  handlers/code_bridge.py — Handler untuk meneruskan kode OTP
#  dari admin Telegram ke Node.js device-kicker via file bridge
# ============================================================
#
# Flow:
#   1. Node.js tulis /tmp/netflix_code_request.json
#   2. Python bot baca file, kirim pesan ke ADMIN_ID
#   3. Admin balas dengan kode (misal: "1234")
#   4. Python tulis /tmp/netflix_code_response.json
#   5. Node.js baca response dan lanjut proses
#
# Command yang didukung:
#   /kode 1234      → reply kode langsung
#   (atau reply pesan bot dengan angka)
# ============================================================

import asyncio
import json
import os
import tempfile
import logging
from telegram import Update
from telegram.ext import ContextTypes, CommandHandler, MessageHandler, filters

from config import ADMIN_ID

logger = logging.getLogger(__name__)

BRIDGE_DIR    = os.environ.get("BRIDGE_DIR", tempfile.gettempdir())
REQUEST_FILE  = os.path.join(BRIDGE_DIR, "netflix_code_request.json")
RESPONSE_FILE = os.path.join(BRIDGE_DIR, "netflix_code_response.json")

# Simpan request_id yang sedang aktif (untuk validasi reply)
_pending_request: dict | None = None


def _read_request() -> dict | None:
    """Baca request file dari Node.js jika ada."""
    try:
        if not os.path.exists(REQUEST_FILE):
            return None
        with open(REQUEST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_response(request_id: str, code: str):
    """Tulis response untuk Node.js."""
    data = {"id": request_id, "code": code}
    with open(RESPONSE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


async def check_and_notify_admin(context: ContextTypes.DEFAULT_TYPE):
    """
    Job yang berjalan setiap 5 detik.
    Cek apakah ada request dari Node.js, jika ada kirim notifikasi ke admin.
    """
    global _pending_request

    req = _read_request()
    if not req:
        return

    # Hindari kirim notifikasi berulang untuk request yang sama
    if _pending_request and _pending_request.get("id") == req.get("id"):
        return

    _pending_request = req
    email   = req.get("email", "?")
    code_type = req.get("type", "?")
    label   = req.get("label", "")

    digits = "4" if code_type == "4digit" else "6"
    akun_info = f"[{label}] " if label else ""

    msg = (
        f"🔑 *Device Kicker butuh kode OTP*\n\n"
        f"Akun: `{akun_info}{email}`\n"
        f"Tipe: *{digits}-digit kode*\n\n"
        f"Balas pesan ini dengan kode {digits} digit dari email akun.\n"
        f"Atau ketik: `/kode <angka>`"
    )

    try:
        await context.bot.send_message(
            chat_id=ADMIN_ID,
            text=msg,
            parse_mode="Markdown"
        )
        logger.info(f"[code_bridge] Notifikasi dikirim ke admin untuk {email}")
    except Exception as e:
        logger.error(f"[code_bridge] Gagal kirim notifikasi: {e}")


async def handle_kode_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Handler untuk command /kode <angka>.
    Hanya bisa digunakan oleh ADMIN_ID.
    """
    global _pending_request

    if update.effective_user.id != ADMIN_ID:
        return

    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("Format: /kode 1234")
        return

    code = context.args[0].strip()
    await _process_code_input(update, code)


async def handle_code_reply(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Handler untuk reply pesan dengan angka (4 atau 6 digit).
    Hanya proses jika ada pending request dan pengirim adalah admin.
    """
    global _pending_request

    if update.effective_user.id != ADMIN_ID:
        return

    if not _pending_request:
        return

    text = (update.message.text or "").strip()
    # Hanya proses jika pesan berisi angka 4-6 digit
    if not text.isdigit() or len(text) not in (4, 6):
        return

    await _process_code_input(update, text)


async def _process_code_input(update: Update, code: str):
    """Tulis kode ke response file dan konfirmasi ke admin."""
    global _pending_request

    req = _pending_request or _read_request()
    if not req:
        await update.message.reply_text("❌ Tidak ada request aktif dari device kicker.")
        return

    expected_len = 4 if req.get("type") == "4digit" else 6
    if len(code) != expected_len:
        await update.message.reply_text(
            f"❌ Kode harus {expected_len} digit, kamu masukkan {len(code)} digit."
        )
        return

    _write_response(req["id"], code)
    _pending_request = None

    email = req.get("email", "?")
    await update.message.reply_text(
        f"✅ Kode `{code}` diteruskan ke device kicker untuk akun `{email}`.",
        parse_mode="Markdown"
    )
    logger.info(f"[code_bridge] Kode {code} ditulis untuk {email}")


def register_handlers(application):
    """Daftarkan semua handler ke Telegram bot."""
    application.add_handler(CommandHandler("kode", handle_kode_command))
    application.add_handler(
        MessageHandler(
            filters.TEXT & filters.User(ADMIN_ID) & ~filters.COMMAND,
            handle_code_reply
        )
    )
    # Job: cek request file setiap 5 detik
    application.job_queue.run_repeating(
        check_and_notify_admin,
        interval=5,
        first=5,
        name="check_code_request"
    )
    logger.info("[code_bridge] Handler terdaftar.")
