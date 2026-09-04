# ============================================================
#  handlers/apkprem.py — /apkprem: FORM ORDER aplikasi selain
#  Netflix → tulis otomatis ke sheet "REKAPAN APK PREM"
# ============================================================

import asyncio
import logging

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, ConversationHandler
from telegram.helpers import escape_markdown

from handlers.auth import is_allowed
from handlers.states import APK_TUNGGU_FORM, APK_KONFIRMASI
from sheets_handler import (
    APK_FIELDS,
    parse_form_apk,
    normalisasi_form_apk,
    tulis_rekapan_apk,
)

logger = logging.getLogger(__name__)

# Template yang dikirim bot untuk di-copy admin (tap untuk copy di Telegram)
TEMPLATE_APK = (
    "───••• FORM ORDER ◟♡\n"
    "\n"
    "𖥻 NO CUST : \n"
    "𖥻 TANGGAL ORDER : \n"
    "𖥻 APLIKASI : \n"
    "𖥻 PLAN : \n"
    "𖥻 DURASI : \n"
    "𖥻 DATA AKUN : \n"
    "𖥻 NAMA FH : \n"
    "𖥻 HARGA JUAL : \n"
    "𖥻 HARGA BELI : \n"
    "𖥻 UNTUNG : \n"
    "𖥻 NOTES : "
)

# Ikon per field untuk tampilan preview
_IKON = {
    "no_cust": "👤",
    "tanggal": "📅",
    "aplikasi": "📱",
    "plan": "📦",
    "durasi": "⏳",
    "data_akun": "✉️",
    "nama_fh": "🧑",
    "harga_jual": "💰",
    "harga_beli": "🧾",
    "untung": "📈",
    "notes": "🗒️",
}


def _tampil_nilai(key: str, nilai) -> str:
    """Format nilai field untuk ditampilkan di preview."""
    if key in ("harga_jual", "harga_beli", "untung") and isinstance(nilai, int):
        return f"Rp{nilai:,}"
    return str(nilai)


def _teks_preview(data: dict) -> str:
    """Susun preview form sebelum disimpan."""
    teks = "📝 *ORDER APK PREM*\n━━━━━━━━━━━━━━━━\n"
    for key, label in APK_FIELDS:
        nilai = escape_markdown(_tampil_nilai(key, data.get(key, "")), version=1)
        teks += f"{_IKON.get(key, '•')} *{label}* : {nilai}\n"
    teks += "━━━━━━━━━━━━━━━━\n"

    for catatan in data.get("_catatan", []):
        teks += f"⚠️ {catatan}\n"

    teks += "\nSimpan ke sheet *REKAPAN APK PREM*?"
    return teks


async def cmd_apkprem(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Kirim template FORM ORDER apk prem, lalu tunggu admin paste isinya."""
    if not is_allowed(update.effective_user.id):
        await update.message.reply_text("⛔ Akses ditolak.")
        return ConversationHandler.END

    await update.message.reply_text(
        "🧾 *FORM ORDER APK PREM*\n\n"
        "Copy template di bawah, isi semua field, lalu kirim balik ke sini.\n"
        "_(Boleh juga langsung paste form tanpa ketik command ini.)_\n\n"
        f"```\n{TEMPLATE_APK}\n```",
        parse_mode="Markdown",
    )
    return APK_TUNGGU_FORM


async def terima_form_apk(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """
    Terima form yang di-paste admin: parse, validasi, tampilkan preview
    + tombol konfirmasi. Jadi entry point juga (auto-deteksi paste form).
    """
    if not is_allowed(update.effective_user.id):
        return ConversationHandler.END

    data_mentah = parse_form_apk(update.message.text)
    if data_mentah is None:
        await update.message.reply_text(
            "❌ Form tidak terbaca. Copy template ini, isi, lalu kirim balik:\n\n"
            f"```\n{TEMPLATE_APK}\n```",
            parse_mode="Markdown",
        )
        return APK_TUNGGU_FORM

    data = normalisasi_form_apk(data_mentah)

    if data["_kosong"]:
        daftar = "\n".join(f"• {label}" for label in data["_kosong"])
        await update.message.reply_text(
            f"❌ *Masih ada field yang kosong:*\n{daftar}\n\n"
            "Lengkapi dulu, lalu kirim ulang formnya.",
            parse_mode="Markdown",
        )
        return APK_TUNGGU_FORM

    context.user_data["apk_data"] = data

    keyboard = [[
        InlineKeyboardButton("✅ Simpan", callback_data="apk_simpan"),
        InlineKeyboardButton("❌ Batal", callback_data="apk_batal"),
    ]]
    await update.message.reply_text(
        _teks_preview(data),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return APK_KONFIRMASI


async def callback_konfirmasi_apk(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Tombol Simpan / Batal pada preview form apk prem."""
    query = update.callback_query
    await query.answer()

    if query.data == "apk_batal":
        context.user_data.pop("apk_data", None)
        await query.edit_message_text("❌ Order dibatalkan, tidak ada yang ditulis ke sheet.")
        return ConversationHandler.END

    data = context.user_data.get("apk_data")
    if not data:
        await query.edit_message_text("⚠️ Data form sudah kedaluwarsa. Kirim ulang formnya ya.")
        return ConversationHandler.END

    await query.edit_message_text("🔄 Menulis ke sheet REKAPAN APK PREM...")

    try:
        hasil = await asyncio.to_thread(tulis_rekapan_apk, data)
    except Exception as e:
        logger.error(f"Gagal tulis rekapan apk prem: {e}", exc_info=True)
        await query.edit_message_text(
            "⚠️ Gagal menulis ke sheet. Coba kirim ulang formnya sebentar lagi."
        )
        return ConversationHandler.END

    context.user_data.pop("apk_data", None)

    aplikasi = escape_markdown(str(data.get("aplikasi", "")), version=1)
    plan = escape_markdown(str(data.get("plan", "")), version=1)
    durasi = escape_markdown(str(data.get("durasi", "")), version=1)
    no_cust = escape_markdown(str(data.get("no_cust", "")), version=1)

    teks = (
        "✅ *TERSIMPAN DI REKAPAN APK PREM*\n"
        "━━━━━━━━━━━━━━━━\n"
        f"📅 {data['tanggal']} — baris {hasil['baris']}\n"
        f"👤 {no_cust}\n"
        f"📱 {aplikasi} · {plan} · {durasi}\n"
        f"💰 Harga jual: Rp{data['harga_jual']:,}\n"
        f"📈 Untung: Rp{data['untung']:,}\n"
        "━━━━━━━━━━━━━━━━"
    )
    if hasil.get("blok_baru"):
        teks += f"\n🆕 Blok tanggal *{data['tanggal']}* baru dibuat di sheet."

    await query.edit_message_text(teks, parse_mode="Markdown")
    return ConversationHandler.END


async def cancel_apk(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """/cancel di tengah proses form apk prem."""
    context.user_data.pop("apk_data", None)
    await update.message.reply_text("❌ Form order apk prem dibatalkan.")
    return ConversationHandler.END
