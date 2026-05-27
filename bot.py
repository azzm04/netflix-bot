# ============================================================
#  bot.py — Main bot Telegram Netflix
# ============================================================

import logging
from telegram import Update, BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ConversationHandler,
    ContextTypes,
    filters,
)
from config import BOT_TOKEN
from sheets_handler import (
    cari_slot_kosong,
    hitung_tanggal_logout,
    tulis_logout_ke_sheet,
    tulis_rekapan,
    format_template,
)

# Setup logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# State untuk ConversationHandler
TANYA_DURASI, TANYA_NOMOR, TANYA_DEVICE = range(3)

# Durasi yang diperbolehkan
DURASI_VALID = [1, 2, 3, 7]

# Mapping device
DEVICE_MAP = {
    "1": "TV",
    "2": "HP / TAB",
    "3": "PC / LAPTOP",
}


# ─── /start ────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Mulai percakapan, tanya durasi."""
    await update.message.reply_text(
        "🍿 *Bot Netflix Otomatis*\n\n"
        "Halo! Saya akan bantu carikan akun Netflix.\n\n"
        "Silakan masukkan *durasi sewa*:\n"
        "• `1` — 1 Hari (HARIAN)\n"
        "• `2` — 2 Hari (HARIAN)\n"
        "• `3` — 3 Hari (HARIAN)\n"
        "• `7` — 7 Hari (MINGGUAN)\n",
        parse_mode="Markdown"
    )
    return TANYA_DURASI


# ─── Terima input durasi ────────────────────────────────────

async def terima_durasi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Validasi durasi lalu tanya nomor pelanggan."""
    teks = update.message.text.strip()

    # Validasi: harus angka dan salah satu dari durasi valid
    if not teks.isdigit() or int(teks) not in DURASI_VALID:
        await update.message.reply_text(
            "❌ Durasi tidak valid.\n\n"
            "Pilih salah satu:\n"
            "• `1` — 1 Hari (HARIAN)\n"
            "• `2` — 2 Hari (HARIAN)\n"
            "• `3` — 3 Hari (HARIAN)\n"
            "• `7` — 7 Hari (MINGGUAN)\n",
            parse_mode="Markdown"
        )
        return TANYA_DURASI

    durasi = int(teks)
    context.user_data["durasi"] = durasi

    # Info sheet yang akan dipakai
    sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"

    await update.message.reply_text(
        f"✅ Durasi: *{durasi} hari* (Sheet: {sheet_info})\n\n"
        f"Sekarang masukkan *nomor pelanggan*:\n"
        f"_(contoh: 081234567890)_",
        parse_mode="Markdown"
    )
    return TANYA_NOMOR


# ─── Terima nomor pelanggan ────────────────────────────────

async def terima_nomor(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima nomor pelanggan, lalu tanya device."""
    nomor_pelanggan = update.message.text.strip()
    context.user_data["nomor_pelanggan"] = nomor_pelanggan

    await update.message.reply_text(
        f"✅ No. Pelanggan: *{nomor_pelanggan}*\n\n"
        f"Login device apa?\n"
        f"• `1` — TV\n"
        f"• `2` — HP / TAB\n"
        f"• `3` — PC / LAPTOP\n",
        parse_mode="Markdown"
    )
    return TANYA_DEVICE


# ─── Terima device & proses ────────────────────────────────

async def terima_device(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima pilihan device, cari slot kosong, tulis ke sheet, kirim template."""
    teks = update.message.text.strip()

    # Validasi device
    if teks not in DEVICE_MAP:
        await update.message.reply_text(
            "❌ Pilihan tidak valid.\n\n"
            "Pilih salah satu:\n"
            "• `1` — TV\n"
            "• `2` — HP / TAB\n"
            "• `3` — PC / LAPTOP\n",
            parse_mode="Markdown"
        )
        return TANYA_DEVICE

    device = DEVICE_MAP[teks]
    nomor_pelanggan = context.user_data.get("nomor_pelanggan", "")
    durasi = context.user_data.get("durasi", 1)

    # Loading message
    pesan_loading = await update.message.reply_text("🔍 Sedang mencari slot kosong...")

    try:
        # 1. Cari slot kosong di sheet yang sesuai (HARIAN / MINGGUAN)
        slot = cari_slot_kosong(durasi, device)

        if slot is None:
            sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"
            await pesan_loading.edit_text(
                f"😔 *Maaf, stok akun di sheet {sheet_info} sedang habis.*\n\n"
                "Semua slot sudah terisi. Hubungi admin untuk info lebih lanjut.",
                parse_mode="Markdown"
            )
            return ConversationHandler.END

        # 2. Hitung tanggal logout (sekarang + durasi hari, jam 19:00)
        tanggal_logout = hitung_tanggal_logout(durasi)

        # 3. Tulis ke Google Sheets (kolom E = logout, kolom F = nomor)
        tulis_logout_ke_sheet(
            nama_sheet=slot["nama_sheet"],
            nomor_baris=slot["nomor_baris"],
            tanggal_logout=tanggal_logout,
            nomor_pelanggan=nomor_pelanggan
        )

        # 4. Tulis rekapan otomatis ke sheet REKAPAN
        tulis_rekapan(
            nomor_pelanggan=nomor_pelanggan,
            durasi=durasi,
            email_akun=slot["email"]
        )

        # 5. Format dan kirim template ke pelanggan
        # 5. Format dan kirim template ke pelanggan
        template = format_template(slot, tanggal_logout, nomor_pelanggan, durasi, device)

        await pesan_loading.edit_text(template, parse_mode="Markdown")

        # Log untuk admin
        logger.info(
            f"[OK] Sheet: {slot['nama_sheet']} | "
            f"Baris: {slot['nomor_baris']} | "
            f"Pelanggan: {nomor_pelanggan} | "
            f"Device: {device} | "
            f"Logout: {tanggal_logout}"
        )

    except Exception as e:
        logger.error(f"Error: {e}")
        await pesan_loading.edit_text(
            "⚠️ Terjadi kesalahan. Coba beberapa saat lagi atau hubungi admin."
        )

    return ConversationHandler.END


# ─── /cancel ───────────────────────────────────────────────

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Batalkan proses."""
    await update.message.reply_text(
        "❌ Proses dibatalkan. Ketik /start untuk memulai lagi."
    )
    return ConversationHandler.END


# ─── Pesan tidak dikenal ────────────────────────────────────

async def pesan_tidak_dikenal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Balas pesan di luar alur percakapan."""
    await update.message.reply_text("Ketik /start untuk memulai.")


# ─── Main ──────────────────────────────────────────────────

async def post_init(application):
    """Set menu commands yang muncul di tombol menu Telegram."""
    await application.bot.set_my_commands([
        BotCommand("start", "Mulai cari akun Netflix"),
        BotCommand("cancel", "Batalkan proses"),
    ])


def main():
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()

    conv_handler = ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            TANYA_DURASI: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_durasi)
            ],
            TANYA_NOMOR: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_nomor)
            ],
            TANYA_DEVICE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_device)
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    app.add_handler(conv_handler)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, pesan_tidak_dikenal))

    print("✅ Bot berjalan... Tekan Ctrl+C untuk berhenti.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
