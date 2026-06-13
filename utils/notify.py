# ============================================================
#  utils/notify.py — Notifikasi admin & auto closing job
# ============================================================

import logging
from datetime import datetime
from telegram.ext import ContextTypes
from config import ADMIN_ID, NOTIF_ORDER_IDS
from sheets_handler import closing_hari, rekap_invest_harian

logger = logging.getLogger(__name__)


async def kirim_notif_admin(context: ContextTypes.DEFAULT_TYPE, data: dict):
    """Kirim notifikasi order berhasil ke semua ID di NOTIF_ORDER_IDS."""
    now = datetime.now()
    tanggal = now.strftime("%d/%b/%Y")
    waktu = now.strftime("%H:%M")

    teks = (
        f"✅ *ORDER BERHASIL*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📦 {data['produk']}\n"
        f"💰 {data['harga']}\n"
        f"👤 {data['pelanggan']}\n"
        f"💌 {data['email']}\n"
        f"📱 {data['device']}\n"
        f"⏰ Logout: {data['logout']}\n"
        f"🕐 {tanggal} {waktu}\n"
        f"━━━━━━━━━━━━━━━━"
    )

    for chat_id in NOTIF_ORDER_IDS:
        try:
            await context.bot.send_message(
                chat_id=chat_id,
                text=teks,
                parse_mode="Markdown"
            )
        except Exception as e:
            logger.error(f"Gagal kirim notif ke {chat_id}: {e}")


async def auto_closing(context: ContextTypes.DEFAULT_TYPE):
    """
    Job yang berjalan otomatis setiap hari jam 23:59.
    Menjalankan closing_hari() dan kirim laporan ke admin.
    """
    logger.info("[AUTO CLOSING] Mulai proses closing otomatis jam 23:59...")

    try:
        result = closing_hari()

        if result is None:
            teks = (
                "⚠️ *[AUTO CLOSING] Gagal*\n\n"
                "Tanggal hari ini tidak ditemukan di spreadsheet REKAPAN MODAL.\n"
                "Pastikan tanggal sudah ada di kolom A."
            )
        elif result["total"] == 0:
            teks = (
                "ℹ️ *[AUTO CLOSING] Selesai*\n\n"
                "Belum ada pendapatan hari ini yang perlu di-closing."
            )
        else:
            teks = (
                f"🤖 *AUTO CLOSING JAM 23:59*\n"
                f"━━━━━━━━━━━━━━━━\n"
                f"📦 Total Order: *{result['total_order']}*\n"
                f"💰 Total Pendapatan: Rp{result['total']:,}\n"
                f"📉 Pajak Merchant (0.7%): -Rp{result['pajak']:,}\n"
                f"✅ *Ditulis ke REKAPAN MODAL: Rp{result['setelah_pajak']:,}*\n"
                f"━━━━━━━━━━━━━━━━"
            )

        # Kirim ke admin
        await context.bot.send_message(
            chat_id=ADMIN_ID,
            text=teks,
            parse_mode="Markdown"
        )

        # Kirim juga ke grup notif
        for chat_id in NOTIF_ORDER_IDS:
            try:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=teks,
                    parse_mode="Markdown"
                )
            except Exception as e:
                logger.error(f"Gagal kirim notif auto closing ke {chat_id}: {e}")

        logger.info(f"[AUTO CLOSING] Selesai. Result: {result}")

    except Exception as e:
        logger.error(f"[AUTO CLOSING] Error: {e}", exc_info=True)
        try:
            await context.bot.send_message(
                chat_id=ADMIN_ID,
                text=f"⚠️ *[AUTO CLOSING] Error*\n\n`{str(e)}`",
                parse_mode="Markdown"
            )
        except Exception:
            pass


async def auto_rekap_invest(context: ContextTypes.DEFAULT_TYPE):
    """
    Job otomatis jam 23:59 — tulis rekapan hari ini ke invest_netflix.
    Berjalan bersamaan dengan auto_closing (dijadwalkan di bot.py).
    """
    logger.info("[AUTO REKAP INVEST] Mulai proses rekap invest otomatis jam 23:59...")

    try:
        hasil = rekap_invest_harian()

        if not hasil:
            teks = (
                "ℹ️ *[AUTO REKAP INVEST] Selesai*\n\n"
                "Tidak ada transaksi hari ini yang masuk ke rekap invest\n"
                "(tidak ada email ena/umi yang cocok)."
            )
        else:
            baris_detail = ""
            for nama_sheet, info in hasil.items():
                if "error" in info:
                    baris_detail += f"\n❌ `{nama_sheet}`: error — {info['error']}"
                else:
                    baris_detail += (
                        f"\n✅ `{nama_sheet}`: "
                        f"{info['ditulis']} baris ditulis"
                        f" | Total: Rp{info['total']:,}"
                    )
                    if info["skip_duplikat"] > 0:
                        baris_detail += f" | Skip duplikat: {info['skip_duplikat']}"

            teks = (
                f"📊 *AUTO REKAP INVEST JAM 23:59*\n"
                f"━━━━━━━━━━━━━━━━"
                f"{baris_detail}\n"
                f"━━━━━━━━━━━━━━━━"
            )

        await context.bot.send_message(
            chat_id=ADMIN_ID,
            text=teks,
            parse_mode="Markdown"
        )

        logger.info(f"[AUTO REKAP INVEST] Selesai. Hasil: {hasil}")

    except Exception as e:
        logger.error(f"[AUTO REKAP INVEST] Error: {e}", exc_info=True)
        try:
            await context.bot.send_message(
                chat_id=ADMIN_ID,
                text=f"⚠️ *[AUTO REKAP INVEST] Error*\n\n`{str(e)}`",
                parse_mode="Markdown"
            )
        except Exception:
            pass
