# ============================================================
#  handlers/admin.py — Admin commands: stok, ceklogout,
#                       gantihari, rekap, closing
# ============================================================

import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, ConversationHandler
from config import ADMIN_ID, NOTIF_ORDER_IDS
from sheets_handler import cek_stok, cek_logout, gantihari, rekap_pendapatan, closing_hari, rekap_invest_harian, rekap_invest_ulang, rekap_invest_range_custom
from handlers.auth import is_allowed

logger = logging.getLogger(__name__)


# ─── /stok ─────────────────────────────────────────────────

async def stok(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cek stok slot kosong di tiap sheet."""
    if not is_allowed(update.effective_user.id):
        await update.message.reply_text("⛔ Akses ditolak.")
        return

    pesan = await update.message.reply_text("🔍 Mengecek stok...")

    try:
        hasil = cek_stok()
        teks = "📊 *STOK SLOT KOSONG*\n\n"
        for sheet, jumlah in hasil.items():
            teks += f"• {sheet}: *{jumlah}* slot\n"
        await pesan.edit_text(teks, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error cek stok: {e}", exc_info=True)
        await pesan.edit_text("⚠️ Gagal mengecek stok.")


# ─── /ceklogout ────────────────────────────────────────────

async def ceklogout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cek akun yang sudah melewati batas waktu logout."""
    if not is_allowed(update.effective_user.id):
        await update.message.reply_text("⛔ Akses ditolak.")
        return

    pesan = await update.message.reply_text("🔍 Mengecek akun expired...")

    try:
        expired = cek_logout()

        if not expired:
            await pesan.edit_text("✅ Tidak ada akun yang perlu di-logout saat ini.")
            return

        # Group by sheet
        by_sheet = {}
        for item in expired:
            sheet = item["sheet"]
            if sheet not in by_sheet:
                by_sheet[sheet] = []
            by_sheet[sheet].append(item)

        teks = f"⚠️ *AKUN PERLU DI-LOGOUT ({len(expired)} akun)*\n"
        teks += "━━━━━━━━━━━━━━━━\n"

        for sheet, items in by_sheet.items():
            teks += f"\n📌 *{sheet}:*\n"
            for item in items[:15]:  # Max 15 per sheet biar tidak kepanjangan
                teks += (
                    f"• Baris {item['baris']}: `{item['email']}`\n"
                    f"  🔖 {item['profil']} | ⏰ {item['logout_text']}\n"
                    f"  👤 {item['pelanggan']}\n\n"
                )
            if len(items) > 15:
                teks += f"  _...dan {len(items) - 15} lainnya_\n"

        teks += "━━━━━━━━━━━━━━━━"

        # Telegram max 4096 chars, split jika perlu
        if len(teks) > 4000:
            teks = teks[:4000] + "\n\n_...terpotong, terlalu banyak_"

        await pesan.edit_text(teks, parse_mode="Markdown")

    except Exception as e:
        logger.error(f"Error cek logout: {e}", exc_info=True)
        await pesan.edit_text("⚠️ Gagal mengecek logout.")


# ─── /gantihari ────────────────────────────────────────────

async def cmd_gantihari(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Ganti hari: cek semua sudah logout, lalu ubah warna biru untuk besok."""
    if not is_allowed(update.effective_user.id):
        await update.message.reply_text("⛔ Akses ditolak.")
        return

    pesan = await update.message.reply_text("🔄 Memeriksa akun hari ini...")

    try:
        status, data = gantihari()

        if status == "belum_selesai":
            teks = f"❌ *Belum bisa ganti hari!*\n\n"
            teks += f"Masih ada *{len(data)} akun* yang belum lewat waktu logout:\n\n"
            for item in data[:10]:
                teks += (
                    f"• Baris {item['baris']} ({item['sheet']})\n"
                    f"  `{item['email']}` — {item['profil']}\n"
                    f"  ⏰ {item['logout_text']}\n\n"
                )
            if len(data) > 10:
                teks += f"_...dan {len(data) - 10} lainnya_\n"
            teks += "Tunggu sampai semua akun melewati waktu logout."
            await pesan.edit_text(teks, parse_mode="Markdown")

        elif status == "berhasil":
            await pesan.edit_text(
                f"✅ *Ganti hari berhasil!*\n\n"
                f"Semua akun hari ini sudah lewat waktu logout.\n"
                f"Warna font biru diterapkan ke *{data} akun* untuk tanggal besok.",
                parse_mode="Markdown"
            )

    except Exception as e:
        logger.error(f"Error gantihari: {e}", exc_info=True)
        await pesan.edit_text("⚠️ Gagal proses ganti hari.")


# ─── /rekap ────────────────────────────────────────────────

async def cmd_rekap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Lihat rekap pendapatan."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return

    # Hanya bisa dijalankan di group/supergroup
    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("⛔ Command ini hanya bisa digunakan di dalam group.")
        return

    keyboard = [
        [InlineKeyboardButton("📅 Hari Ini", callback_data="rekap_hari_ini")],
        [InlineKeyboardButton("📆 Minggu Ini", callback_data="rekap_minggu_ini")],
        [InlineKeyboardButton("📊 Bulan Ini", callback_data="rekap_bulan_ini")],
    ]
    await update.message.reply_text(
        "📊 *REKAP PENDAPATAN*\n\nPilih periode:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


async def callback_rekap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle pilihan periode rekap."""
    query = update.callback_query
    await query.answer()

    periode_map = {
        "rekap_hari_ini": "hari_ini",
        "rekap_minggu_ini": "minggu_ini",
        "rekap_bulan_ini": "bulan_ini",
    }
    periode = periode_map.get(query.data)
    if not periode:
        return

    await query.edit_message_text("🔍 Menghitung rekap...")

    try:
        rekap = rekap_pendapatan(periode)

        if rekap is None:
            await query.edit_message_text("⚠️ Sheet rekapan tidak ditemukan.")
            return

        if rekap["total_order"] == 0:
            await query.edit_message_text("ℹ️ Belum ada order untuk periode ini.")
            return

        label = {"hari_ini": "HARI INI", "minggu_ini": "MINGGU INI", "bulan_ini": "BULAN INI"}
        teks = f"📊 *REKAP {label[periode]}*\n"
        teks += f"_{rekap['tanggal_range']}_\n"
        teks += "━━━━━━━━━━━━━━━━\n"
        teks += f"📦 Total Order: *{rekap['total_order']}*\n\n"
        teks += "Detail:\n"

        for durasi, info in sorted(rekap["detail"].items()):
            teks += f"• {durasi}: {info['count']}x (Rp{info['total']:,})\n"

        teks += f"\n💰 *Total Pendapatan: Rp{rekap['total_pendapatan']:,}*\n"
        teks += "━━━━━━━━━━━━━━━━"

        await query.edit_message_text(teks, parse_mode="Markdown")

    except Exception as e:
        logger.error(f"Error rekap: {e}", exc_info=True)
        await query.edit_message_text("⚠️ Gagal menghitung rekap.")


# ─── /closing ──────────────────────────────────────────────

async def cmd_closing(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Closing hari: hitung pendapatan, potong pajak 0.7%, tulis ke REKAPAN MODAL."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return

    # Hanya bisa dijalankan di group/supergroup
    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("⛔ Command ini hanya bisa digunakan di dalam group.")
        return

    pesan = await update.message.reply_text("🔄 Proses closing hari ini...")

    try:
        result = closing_hari()

        if result is None:
            await pesan.edit_text(
                "❌ Tanggal hari ini tidak ditemukan di spreadsheet REKAPAN MODAL.\n"
                "Pastikan tanggal sudah ada di kolom A."
            )
            return

        if result["total"] == 0:
            await pesan.edit_text("ℹ️ Belum ada pendapatan hari ini.")
            return

        teks = (
            f"✅ *CLOSING HARI INI BERHASIL*\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"📦 Total Order: *{result['total_order']}*\n"
            f"💰 Total Pendapatan: Rp{result['total']:,}\n"
            f"📉 Pajak Merchant (0.7%): -Rp{result['pajak']:,}\n"
            f"✅ *Ditulis ke REKAPAN MODAL: Rp{result['setelah_pajak']:,}*\n"
            f"━━━━━━━━━━━━━━━━"
        )
        await pesan.edit_text(teks, parse_mode="Markdown")

        # Kirim juga ke grup
        for chat_id in NOTIF_ORDER_IDS:
            try:
                await context.bot.send_message(
                    chat_id=chat_id, text=teks, parse_mode="Markdown"
                )
            except Exception:
                pass

    except Exception as e:
        logger.error(f"Error closing: {e}", exc_info=True)
        await pesan.edit_text("⚠️ Gagal proses closing.")


# ─── /rekap_invest_ulang ───────────────────────────────────

async def cmd_rekap_invest_ulang(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    Rekap ulang data ke invest_netflix. Admin only, private.

    Usage:
      /rekap_invest_ulang
          → rekap ulang seluruh bulan ini (Juni 2026)

      /rekap_invest_ulang 31 Mei - 30 Juni
          → rekap ulang dengan rentang tanggal custom (lintas bulan)

    Format argumen: DD BULAN - DD BULAN  (tahun otomatis = sekarang)
    Contoh: /rekap_invest_ulang 31 Mei - 30 Juni
    """
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return

    from datetime import datetime as _dt
    from sheets_handler import BULAN_REKAP as _BR, BULAN_ID_REVERSE as _BIR

    now = _dt.now()
    args_text = " ".join(context.args).strip() if context.args else ""

    # ── Parse argumen range jika ada ─────────────────────────
    rentang_info = ""
    use_custom_range = False

    if args_text and "-" in args_text:
        try:
            bagian = [b.strip() for b in args_text.split("-", 1)]
            if len(bagian) == 2:
                def _parse_tgl(s):
                    parts = s.strip().split()
                    hari = int(parts[0])
                    bulan_nama = parts[1].lower().strip()
                    bulan_num = _BIR.get(bulan_nama)
                    if bulan_num is None:
                        raise ValueError(f"Bulan tidak dikenal: {parts[1]}")
                    tahun = now.year
                    # Jika bulan sudah lewat, kemungkinan tahun sama; jika bulan > bulan sekarang, anggap tahun lalu
                    return hari, bulan_num, tahun

                tgl_m_hari, tgl_m_bln, tgl_m_thn = _parse_tgl(bagian[0])
                tgl_a_hari, tgl_a_bln, tgl_a_thn = _parse_tgl(bagian[1])
                use_custom_range = True
                rentang_info = f"{bagian[0].title()} – {bagian[1].title()} {now.year}"
        except Exception as parse_err:
            await update.message.reply_text(
                f"❌ Format salah: `{args_text}`\n\n"
                f"Contoh yang benar:\n"
                f"`/rekap_invest_ulang 31 Mei - 30 Juni`",
                parse_mode="Markdown"
            )
            return

    if not use_custom_range:
        nama_bulan = _BR.get(now.month, str(now.month))
        rentang_info = f"1 – {now.day} {nama_bulan} {now.year}"

    pesan = await update.message.reply_text(
        f"🔄 Rekap ulang *{rentang_info}* sedang diproses...\n"
        f"_(Ini mungkin butuh beberapa detik)_",
        parse_mode="Markdown"
    )

    try:
        if use_custom_range:
            hasil = rekap_invest_range_custom(
                tgl_m_hari, tgl_m_bln, tgl_m_thn,
                tgl_a_hari, tgl_a_bln, tgl_a_thn,
            )
        else:
            hasil = rekap_invest_ulang()

        if not hasil:
            await pesan.edit_text(
                f"ℹ️ Tidak ada data untuk rentang *{rentang_info}* yang cocok untuk rekap invest.",
                parse_mode="Markdown"
            )
            return

        teks = f"✅ *REKAP ULANG {rentang_info.upper()} SELESAI*\n━━━━━━━━━━━━━━━━\n"
        for nama_sheet, info in hasil.items():
            if "error" in info:
                teks += f"\n❌ `{nama_sheet}`: gagal — {info['error']}\n"
            else:
                teks += (
                    f"\n📋 `{nama_sheet}`\n"
                    f"  • Ditulis: *{info['ditulis']} baris*\n"
                    f"  • Total: *Rp{info['total']:,}*\n"
                )
        teks += "━━━━━━━━━━━━━━━━"
        await pesan.edit_text(teks, parse_mode="Markdown")

    except Exception as e:
        logger.error(f"Error rekap_invest_ulang: {e}", exc_info=True)
        await pesan.edit_text(f"⚠️ Gagal rekap ulang.\n\n`{str(e)}`", parse_mode="Markdown")


# ─── /rekap_invest ─────────────────────────────────────────

async def cmd_rekap_invest(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Tulis rekapan invest hari ini ke spreadsheet invest_netflix. Admin only, private."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return

    pesan = await update.message.reply_text("🔄 Proses rekap invest hari ini...")

    try:
        hasil = rekap_invest_harian()

        if not hasil:
            await pesan.edit_text(
                "ℹ️ Tidak ada transaksi hari ini yang masuk rekap invest.\n"
                "(Tidak ada email ena/umi yang cocok di REKAPAN hari ini.)"
            )
            return

        teks = "✅ *REKAP INVEST BERHASIL*\n━━━━━━━━━━━━━━━━\n"
        for nama_sheet, info in hasil.items():
            if "error" in info:
                teks += f"\n❌ `{nama_sheet}`: gagal — {info['error']}\n"
            else:
                teks += (
                    f"\n📋 `{nama_sheet}`\n"
                    f"  • Ditulis: *{info['ditulis']} baris*\n"
                    f"  • Total: *Rp{info['total']:,}*\n"
                )
                if info["skip_duplikat"] > 0:
                    teks += f"  • Skip duplikat: {info['skip_duplikat']}\n"

        teks += "━━━━━━━━━━━━━━━━"
        await pesan.edit_text(teks, parse_mode="Markdown")

    except Exception as e:
        logger.error(f"Error rekap_invest: {e}", exc_info=True)
        await pesan.edit_text(f"⚠️ Gagal proses rekap invest.\n\n`{str(e)}`", parse_mode="Markdown")


# ─── /cancel, timeout, pesan tidak dikenal ─────────────────

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Batalkan proses."""
    await update.message.reply_text(
        "❌ Proses dibatalkan. Ketik /start untuk memulai lagi."
    )
    return ConversationHandler.END


async def timeout_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle timeout — conversation otomatis berakhir setelah 5 menit idle."""
    if update.message:
        await update.message.reply_text(
            "⏰ Sesi habis karena tidak ada aktivitas. Ketik /start untuk mulai lagi."
        )
    return ConversationHandler.END


async def pesan_tidak_dikenal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Balas pesan di luar alur percakapan."""
    if not is_allowed(update.effective_user.id):
        return  # Abaikan user yang tidak terdaftar
    await update.message.reply_text("Ketik /start untuk memulai.")
