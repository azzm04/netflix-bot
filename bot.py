# ============================================================
#  bot.py — Entry point bot Netflix Telegram
# ============================================================

import logging
from datetime import time as dt_time
from zoneinfo import ZoneInfo
from telegram import Update, BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ConversationHandler,
    filters,
)
from config import BOT_TOKEN, ADMIN_ID

# ── Handlers ─────────────────────────────────────────────────
from handlers.states import (
    TANYA_TIPE, TANYA_DURASI, TANYA_NOMOR, TANYA_DEVICE,
    TANYA_PAKET_BULANAN, TANYA_NOMOR_BULANAN, TANYA_DEVICE_BULANAN,
    TANYA_QUICK_ORDER,
    FEE_TANYA_TANGGAL, FEE_TANYA_NOMINAL, FEE_KONFIRMASI,
    GESTUN_PILIH_MODE,
    GESTUN_TANYA_TANGGAL, GESTUN_TANYA_NOMINAL, GESTUN_TANYA_PERSEN, GESTUN_KONFIRMASI,
    GESTUN_QUICK,
    MODAL_PILIH_MODE,
    MODAL_TANYA_TANGGAL, MODAL_TANYA_NOMINAL, MODAL_TANYA_KET, MODAL_KONFIRMASI,
    MODAL_QUICK,
)
from handlers.auth import adduser, removeuser, listuser
from handlers.order import (
    start,
    callback_tipe, callback_back_tipe, callback_back_durasi, callback_back_paket,
    callback_durasi, terima_nomor, callback_device,
    callback_paket_bulanan, terima_nomor_bulanan, callback_device_bulanan,
    terima_quick_order,
    callback_order_lagi,
)
from handlers.admin import (
    stok, ceklogout, cmd_gantihari,
    cmd_rekap, callback_rekap,
    cmd_closing,
    cancel, timeout_handler, pesan_tidak_dikenal,
)
from handlers.group import (
    cmd_feeadmin, callback_fee_pilih_tanggal, terima_tanggal_fee,
    terima_nominal_fee, callback_konfirmasi_fee, cancel_fee,
    cmd_gestun, callback_gestun_pilih_mode, terima_quick_gestun,
    callback_gestun_pilih_tanggal, terima_tanggal_gestun, terima_nominal_gestun,
    callback_gestun_persen, terima_persen_gestun, callback_konfirmasi_gestun,
    cancel_gestun,
    cmd_modal_netflix, callback_modal_pilih_mode, terima_quick_modal,
    callback_modal_pilih_tanggal, terima_tanggal_modal, terima_nominal_modal,
    callback_modal_ket, terima_ket_modal, callback_konfirmasi_modal,
    cancel_modal,
)
from utils.notify import auto_closing

# Setup logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Sembunyikan token dari log httpx (mencegah token terekspos di log)
logging.getLogger("httpx").setLevel(logging.WARNING)


# ─── post_init ─────────────────────────────────────────────

async def post_init(application):
    """Set menu commands berbeda untuk admin, user biasa, dan group."""
    from telegram import BotCommandScopeChat, BotCommandScopeAllGroupChats

    # Menu untuk semua user di PRIVATE chat (default)
    await application.bot.set_my_commands([
        BotCommand("start", "Mulai cari akun Netflix"),
        BotCommand("stok", "Cek stok slot kosong"),
        BotCommand("ceklogout", "Cek akun yang perlu di-logout"),
        BotCommand("gantihari", "Ganti hari & ubah warna besok"),
        BotCommand("cancel", "Batalkan proses"),
    ])

    # Menu khusus di GROUP — hanya command ini
    await application.bot.set_my_commands(
        [
            BotCommand("rekap", "Lihat rekap pendapatan"),
            BotCommand("closing", "Closing hari & tulis ke REKAPAN MODAL"),
            BotCommand("feeadmin", "Input fee admin ke REKAPAN MODAL"),
            BotCommand("gestun", "Input data gestun ke REKAPAN MODAL"),
            BotCommand("modal_netflix", "Input modal Netflix ke REKAPAN MODAL"),
        ],
        scope=BotCommandScopeAllGroupChats()
    )

    # Menu khusus admin di PRIVATE (lebih lengkap)
    try:
        await application.bot.set_my_commands(
            [
                BotCommand("start", "Mulai cari akun Netflix"),
                BotCommand("stok", "Cek stok slot kosong"),
                BotCommand("ceklogout", "Cek akun yang perlu di-logout"),
                BotCommand("gantihari", "Ganti hari & ubah warna besok"),
                BotCommand("adduser", "Tambah user"),
                BotCommand("removeuser", "Hapus user"),
                BotCommand("listuser", "Lihat daftar user"),
                BotCommand("cancel", "Batalkan proses"),
            ],
            scope=BotCommandScopeChat(chat_id=ADMIN_ID)
        )
    except Exception:
        pass  # Gagal set scope admin tidak fatal


# ─── main ──────────────────────────────────────────────────

def main():
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()

    # ─── Scheduler: Auto Closing jam 23:59 WIB setiap hari ─────
    job_queue = app.job_queue
    if job_queue is not None:
        WIB = ZoneInfo("Asia/Jakarta")
        job_queue.run_daily(
            auto_closing,
            time=dt_time(hour=23, minute=59, second=0, tzinfo=WIB),
            name="auto_closing_harian",
        )
        logger.info("✅ Auto closing dijadwalkan setiap hari jam 23:59 WIB")
    else:
        logger.warning(
            "⚠️ JobQueue tidak tersedia (APScheduler belum ter-install). "
            "Auto closing jam 23:59 TIDAK aktif. "
            "Jalankan: pip install 'python-telegram-bot[job-queue]==20.7'"
        )
    # ────────────────────────────────────────────────────────

    conv_handler = ConversationHandler(
        entry_points=[
            # /start dan order flow: hanya di private chat
            CommandHandler("start", start, filters=filters.ChatType.PRIVATE),
            CallbackQueryHandler(callback_order_lagi, pattern="^order_lagi$"),
        ],
        states={
            TANYA_TIPE: [
                CallbackQueryHandler(callback_tipe, pattern="^tipe_")
            ],
            # Quick Order
            TANYA_QUICK_ORDER: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_quick_order)
            ],
            # Harian/Mingguan
            TANYA_DURASI: [
                CallbackQueryHandler(callback_durasi, pattern="^durasi_"),
                CallbackQueryHandler(callback_back_tipe, pattern="^back_tipe$"),
            ],
            TANYA_NOMOR: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_nomor)
            ],
            TANYA_DEVICE: [
                CallbackQueryHandler(callback_device, pattern="^(tv|hp|pc)$"),
                CallbackQueryHandler(callback_back_durasi, pattern="^back_durasi$"),
            ],
            # Bulanan
            TANYA_PAKET_BULANAN: [
                CallbackQueryHandler(callback_paket_bulanan, pattern="^b[12]_"),
                CallbackQueryHandler(callback_back_tipe, pattern="^back_tipe$"),
            ],
            TANYA_NOMOR_BULANAN: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, terima_nomor_bulanan)
            ],
            TANYA_DEVICE_BULANAN: [
                CallbackQueryHandler(callback_device_bulanan, pattern="^dev_"),
                CallbackQueryHandler(callback_back_paket, pattern="^back_paket$"),
            ],
            ConversationHandler.TIMEOUT: [
                MessageHandler(filters.ALL, timeout_handler)
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
        conversation_timeout=300,
        allow_reentry=True,
    )

    # ── Filter reusable ───────────────────────────────────────
    PRIVATE = filters.ChatType.PRIVATE
    GROUP = filters.ChatType.GROUPS

    app.add_handler(conv_handler)

    # Command khusus PRIVATE (tidak boleh dipakai di group)
    app.add_handler(CommandHandler("stok", stok, filters=PRIVATE))
    app.add_handler(CommandHandler("ceklogout", ceklogout, filters=PRIVATE))
    app.add_handler(CommandHandler("gantihari", cmd_gantihari, filters=PRIVATE))
    app.add_handler(CommandHandler("adduser", adduser, filters=PRIVATE))
    app.add_handler(CommandHandler("removeuser", removeuser, filters=PRIVATE))
    app.add_handler(CommandHandler("listuser", listuser, filters=PRIVATE))
    app.add_handler(CommandHandler("cancel", cancel, filters=PRIVATE))

    # Command khusus GROUP (rekap, closing, feeadmin)
    app.add_handler(CommandHandler("rekap", cmd_rekap, filters=GROUP))
    app.add_handler(CommandHandler("closing", cmd_closing, filters=GROUP))
    app.add_handler(CommandHandler("stok", stok, filters=GROUP))
    app.add_handler(CallbackQueryHandler(callback_rekap, pattern="^rekap_"))

    # ConversationHandler /feeadmin — group only
    fee_conv_handler = ConversationHandler(
        entry_points=[CommandHandler("feeadmin", cmd_feeadmin, filters=GROUP)],
        states={
            FEE_TANYA_TANGGAL: [
                CallbackQueryHandler(callback_fee_pilih_tanggal, pattern="^fee_tgl_"),
                CallbackQueryHandler(callback_fee_pilih_tanggal, pattern="^fee_batal$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_tanggal_fee),
            ],
            FEE_TANYA_NOMINAL: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_nominal_fee),
            ],
            FEE_KONFIRMASI: [
                CallbackQueryHandler(callback_konfirmasi_fee, pattern="^fee_konfirm_"),
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel_fee)],
        conversation_timeout=120,
        allow_reentry=True,
    )
    app.add_handler(fee_conv_handler)

    # ConversationHandler untuk /gestun (input data gestun di group)
    gestun_conv_handler = ConversationHandler(
        entry_points=[CommandHandler("gestun", cmd_gestun, filters=GROUP)],
        states={
            GESTUN_PILIH_MODE: [
                CallbackQueryHandler(callback_gestun_pilih_mode, pattern="^gestun_mode_"),
                CallbackQueryHandler(callback_gestun_pilih_mode, pattern="^gestun_batal$"),
            ],
            GESTUN_QUICK: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_quick_gestun),
            ],
            GESTUN_TANYA_TANGGAL: [
                CallbackQueryHandler(callback_gestun_pilih_tanggal, pattern="^gestun_tgl_"),
                CallbackQueryHandler(callback_gestun_pilih_tanggal, pattern="^gestun_batal_step$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_tanggal_gestun),
            ],
            GESTUN_TANYA_NOMINAL: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_nominal_gestun),
            ],
            GESTUN_TANYA_PERSEN: [
                CallbackQueryHandler(callback_gestun_persen, pattern="^gestun_persen_"),
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_persen_gestun),
            ],
            GESTUN_KONFIRMASI: [
                CallbackQueryHandler(callback_konfirmasi_gestun, pattern="^gestun_konfirm_"),
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel_gestun)],
        conversation_timeout=120,
        allow_reentry=True,
    )
    app.add_handler(gestun_conv_handler)

    # ConversationHandler untuk /modal_netflix (input modal di group)
    modal_conv_handler = ConversationHandler(
        entry_points=[CommandHandler("modal_netflix", cmd_modal_netflix, filters=GROUP)],
        states={
            MODAL_PILIH_MODE: [
                CallbackQueryHandler(callback_modal_pilih_mode, pattern="^modal_mode_"),
                CallbackQueryHandler(callback_modal_pilih_mode, pattern="^modal_batal$"),
            ],
            MODAL_QUICK: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_quick_modal),
            ],
            MODAL_TANYA_TANGGAL: [
                CallbackQueryHandler(callback_modal_pilih_tanggal, pattern="^modal_tgl_"),
                CallbackQueryHandler(callback_modal_pilih_tanggal, pattern="^modal_batal_step$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_tanggal_modal),
            ],
            MODAL_TANYA_NOMINAL: [
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_nominal_modal),
            ],
            MODAL_TANYA_KET: [
                CallbackQueryHandler(callback_modal_ket, pattern="^modal_ket_"),
                MessageHandler(filters.TEXT & ~filters.COMMAND & GROUP, terima_ket_modal),
            ],
            MODAL_KONFIRMASI: [
                CallbackQueryHandler(callback_konfirmasi_modal, pattern="^modal_konfirm_"),
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel_modal)],
        conversation_timeout=120,
        allow_reentry=True,
    )
    app.add_handler(modal_conv_handler)

    # Handler pesan tidak dikenal — private only (jangan spam balas di group)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND & PRIVATE, pesan_tidak_dikenal))

    print("✅ Bot berjalan... Tekan Ctrl+C untuk berhenti.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
