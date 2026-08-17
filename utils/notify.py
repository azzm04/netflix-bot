# ============================================================
#  utils/notify.py — Notifikasi admin & auto closing job
# ============================================================

import logging
from datetime import datetime
from telegram.ext import ContextTypes
from telegram.helpers import escape_markdown
from config import ADMIN_ID, NOTIF_ORDER_IDS
from sheets_handler import closing_hari, rekap_invest_harian

logger = logging.getLogger(__name__)


async def kirim_notif_admin(context: ContextTypes.DEFAULT_TYPE, data: dict):
    """Kirim notifikasi order berhasil ke semua ID di NOTIF_ORDER_IDS."""
    now = datetime.now()
    tanggal = now.strftime("%d/%b/%Y")
    waktu = now.strftime("%H:%M")

    # pelanggan & device berasal dari teks bebas yang diketik user — escape supaya
    # karakter Markdown (_, *, `, [) tidak bikin Telegram gagal parse pesan ini.
    pelanggan_aman = escape_markdown(str(data['pelanggan']), version=1)
    device_aman = escape_markdown(str(data['device']), version=1)

    teks = (
        f"🎬 *Order Baru Masuk*\n"
        f"┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"
        f"📦 Paket     : `{data['produk']}`\n"
        f"💰 Harga     : {data['harga']}\n"
        f"👤 Pelanggan : {pelanggan_aman}\n"
        f"✉️ Akun      : {data['email']}\n"
        f"📲 Device    : {device_aman}\n"
        f"⏳ Logout    : {data['logout']}\n"
        f"┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"
        f"🕐 {tanggal}, {waktu} WIB"
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
    now = datetime.now()

    try:
        result = closing_hari()

        if result is None:
            teks = (
                "⚠️ *Closing Harian Belum Bisa Diproses*\n\n"
                "Tanggal hari ini belum ada di sheet REKAPAN MODAL.\n"
                "Tambahkan di kolom A — job ini otomatis coba lagi besok jam 23:59."
            )
        elif result["total"] == 0:
            teks = (
                "📭 *Closing Harian*\n\n"
                "Belum ada pendapatan yang masuk hari ini — tidak ada yang perlu ditutup."
            )
        else:
            teks = (
                f"🧾 *Closing Harian — {now.strftime('%d %b %Y')}*\n"
                f"┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"
                f"🎬 Total Order    : *{result['total_order']}*\n"
                f"💰 Pendapatan     : Rp{result['total']:,}\n"
                f"📉 Pajak Merchant : -Rp{result['pajak']:,} (0.7%)\n"
                f"┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"
                f"✅ Masuk REKAPAN MODAL: *Rp{result['setelah_pajak']:,}*"
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
                text=f"❌ *Closing Harian Gagal*\n\nProsesnya berhenti karena error:\n`{str(e)}`",
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
    now = datetime.now()

    try:
        hasil = rekap_invest_harian()

        if not hasil:
            teks = (
                "📭 *Rekap Invest Harian*\n\n"
                "Tidak ada transaksi dari email ena/umi yang masuk hari ini."
            )
        else:
            detail_lines = []
            for nama_sheet, info in hasil.items():
                if "error" in info:
                    detail_lines.append(f"❌ `{nama_sheet}` — {info['error']}")
                else:
                    line = f"✅ `{nama_sheet}` — {info['ditulis']} baris, Rp{info['total']:,}"
                    if info["skip_duplikat"] > 0:
                        line += f" (skip {info['skip_duplikat']} duplikat)"
                    detail_lines.append(line)

            teks = (
                f"📈 *Rekap Invest Harian — {now.strftime('%d %b %Y')}*\n"
                f"┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n"
                + "\n".join(detail_lines)
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
                text=f"❌ *Rekap Invest Gagal*\n\nProsesnya berhenti karena error:\n`{str(e)}`",
                parse_mode="Markdown"
            )
        except Exception:
            pass
