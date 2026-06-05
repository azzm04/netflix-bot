# ============================================================
#  handlers/order.py — /start, alur order harian/bulanan/quick
# ============================================================

import logging
import gspread
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, ConversationHandler
from config import HARGA, HARGA_BULANAN
from sheets_handler import (
    cari_slot_kosong,
    hitung_tanggal_logout,
    tulis_logout_ke_sheet,
    tulis_rekapan,
    tulis_rekapan_quick,
    tulis_rekapan_bulanan_quick,
    format_template,
    cari_slot_kosong_bulanan,
    hitung_tanggal_logout_bulanan,
    tulis_rekapan_bulanan,
    format_template_bulanan,
    verifikasi_slot_masih_kosong,
    get_spreadsheet,
    _order_lock,
)
from handlers.auth import is_allowed
from handlers.states import (
    TANYA_TIPE, TANYA_DURASI, TANYA_NOMOR, TANYA_DEVICE,
    TANYA_PAKET_BULANAN, TANYA_NOMOR_BULANAN, TANYA_DEVICE_BULANAN,
    TANYA_QUICK_ORDER,
)
from utils.notify import kirim_notif_admin

logger = logging.getLogger(__name__)

# Mapping device
DEVICE_MAP = {
    "tv": "TV",
    "hp": "HP / TAB",
    "pc": "PC / LAPTOP",
}

# Mapping paket bulanan
PAKET_BULANAN_MAP = {
    "b1_1p1u": {"bulan": 1, "tipe": "1p1u", "label": "1 Bulan - 1P1U (Rp50.000)"},
    "b1_sempriv": {"bulan": 1, "tipe": "sempriv", "label": "1 Bulan - Semi Private (Rp60.000)"},
    "b2_1p1u": {"bulan": 2, "tipe": "1p1u", "label": "2 Bulan - 1P1U (Rp80.000)"},
    "b2_sempriv": {"bulan": 2, "tipe": "sempriv", "label": "2 Bulan - Semi Private (Rp95.000)"},
}


# ─── Parser helpers ────────────────────────────────────────

def _detect_device_type(device_text: str) -> str:
    """Deteksi tipe device dari teks merk.
    Return: 'TV', 'HP / TAB', atau 'PC / LAPTOP'
    """
    lower = device_text.lower()
    # TV keywords
    if any(kw in lower for kw in ["tv", "smart tv", "android tv", "fire stick"]):
        return "TV"
    # PC/Laptop keywords
    if any(kw in lower for kw in ["laptop", "pc", "komputer", "macbook", "notebook"]):
        return "PC / LAPTOP"
    # Default: HP/TAB (iPhone, Samsung, Xiaomi, iPad, tablet, dll)
    return "HP / TAB"


def _format_nomor(nomor: str) -> str:
    """
    Format nomor ke format XXX-XXXX-XXXX.
    081267664005 → 812-6766-4005
    +6281267664005 → 812-6766-4005
    856-4647-3850 → 856-4647-3850 (sudah benar, biarkan)
    Nomor tidak valid → return None (akan ditolak).
    """
    # Kalau sudah ada strip, kembalikan apa adanya
    if "-" in nomor:
        return nomor.strip()

    # Hapus semua non-digit
    digits = "".join(c for c in nomor if c.isdigit())

    # Hapus prefix 62 atau 0
    if digits.startswith("62") and len(digits) > 10:
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]

    # Hanya format jika panjang 9-12 digit (nomor Indonesia valid)
    if 9 <= len(digits) <= 12:
        return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"

    # Nomor tidak valid
    return None


def _parse_durasi(value: str) -> dict:
    lower = value.lower().strip()

    # Deteksi apakah ada kata "bulan"
    if "bulan" in lower:
        # Extract angka bulan
        angka = ""
        for ch in lower:
            if ch.isdigit():
                angka += ch
        if not angka:
            return None
        jumlah_bulan = int(angka)
        if jumlah_bulan not in [1, 2]:
            return None

        # Deteksi tipe: sempriv atau 1p1u (default)
        tipe = "1p1u"
        if any(kw in lower for kw in ["sempriv", "semi", "sp"]):
            tipe = "sempriv"

        return {
            "durasi": jumlah_bulan * 30,
            "mode": "bulanan",
            "bulan": jumlah_bulan,
            "tipe": tipe,
        }

    # Tidak ada kata "bulan" → ambil angka saja
    angka = ""
    for ch in value:
        if ch.isdigit():
            angka += ch
    if not angka:
        return None

    durasi_int = int(angka)

    # 14 hari = mingguan (bukan bulanan)
    if durasi_int == 14:
        return {"durasi": 14, "mode": "harian", "tipe": None}

    # Angka besar (>14) tanpa kata "bulan" → dianggap bulanan
    if durasi_int > 14:
        jumlah_bulan = 1 if durasi_int <= 30 else 2
        return {
            "durasi": durasi_int,
            "mode": "bulanan",
            "bulan": jumlah_bulan,
            "tipe": "1p1u",
        }

    # Harian/mingguan
    return {"durasi": durasi_int, "mode": "harian", "tipe": None}


def _parse_quick_order(teks: str) -> dict:
    """
    Parse form quick order.
    Format:
    𖥻 Durasi order : 3
    𖥻 Durasi order : 1 Bulan
    𖥻 Durasi order : 1 Bulan Sempriv
    𖥻 Nomor WhatsApp : 856-4647-3850
    𖥻 Merk & tipe device : iPhone 17
    𖥻 Lokasi login (kota) : Jakarta

    Return: dict {durasi_info, nomor, device, lokasi} atau None jika gagal.
    """
    result = {"durasi_info": None, "nomor": None, "device": None, "lokasi": None}

    for line in teks.strip().split("\n"):
        line = line.strip()
        if ":" not in line:
            continue

        # Ambil value setelah ":"
        value = line.split(":", 1)[1].strip()
        lower_line = line.lower()

        if "durasi" in lower_line:
            result["durasi_info"] = _parse_durasi(value)
        elif "nomor" in lower_line or "whatsapp" in lower_line:
            result["nomor"] = value
        elif "device" in lower_line or "merk" in lower_line:
            result["device"] = value
        elif "lokasi" in lower_line or "kota" in lower_line:
            result["lokasi"] = value

    # Validasi semua field terisi
    if result["durasi_info"] is None or not result["nomor"] or not result["device"] or not result["lokasi"]:
        return None
    return result


# ─── /start ────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Mulai percakapan, tanya tipe langganan."""
    user_id = update.effective_user.id
    if not is_allowed(user_id):
        await update.message.reply_text(
            f"⛔ Akses ditolak.\n\n"
            f"ID kamu: `{user_id}`\n"
            f"Minta admin untuk menambahkan ID ini.",
            parse_mode="Markdown"
        )
        return ConversationHandler.END

    keyboard = [
        [InlineKeyboardButton("⚡ Quick Order", callback_data="tipe_quick")],
        [InlineKeyboardButton("📅 Harian / Mingguan", callback_data="tipe_harian")],
        [InlineKeyboardButton("📆 Bulanan", callback_data="tipe_bulanan")],
    ]
    await update.message.reply_text(
        "🍿 *Bot Netflix Otomatis*\n\n"
        "Pilih mode order:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_TIPE


# ─── Pilih tipe ────────────────────────────────────────────

async def callback_tipe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Pilih harian/mingguan, bulanan, atau quick order."""
    query = update.callback_query
    await query.answer()

    if query.data == "tipe_quick":
        context.user_data["mode"] = "quick"
        msg = await query.edit_message_text(
            "⚡ *Quick Order*\n\n"
            "Paste form order dari customer:\n\n"
            "```\n"
            "𖥻 Durasi order : \n"
            "𖥻 Nomor WhatsApp : \n"
            "𖥻 Merk & tipe device : \n"
            "𖥻 Lokasi login (kota) : \n"
            "```",
            parse_mode="Markdown"
        )
        # Simpan message_id form untuk dihapus setelah order selesai
        context.user_data["quick_form_chat_id"] = msg.chat.id
        context.user_data["quick_form_msg_id"]  = msg.message_id
        return TANYA_QUICK_ORDER

    elif query.data == "tipe_harian":
        context.user_data["mode"] = "harian"
        keyboard = [
            [
                InlineKeyboardButton("1 Hari", callback_data="durasi_1"),
                InlineKeyboardButton("2 Hari", callback_data="durasi_2"),
            ],
            [
                InlineKeyboardButton("3 Hari", callback_data="durasi_3"),
                InlineKeyboardButton("7 Hari", callback_data="durasi_7"),
            ],
            [InlineKeyboardButton("14 Hari", callback_data="durasi_14")],
            [InlineKeyboardButton("⬅️ Kembali", callback_data="back_tipe")],
        ]
        await query.edit_message_text(
            "Pilih *durasi sewa*:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
        return TANYA_DURASI

    elif query.data == "tipe_bulanan":
        context.user_data["mode"] = "bulanan"
        keyboard = [
            [InlineKeyboardButton("1 Bulan - 1P1U (Rp50.000)", callback_data="b1_1p1u")],
            [InlineKeyboardButton("1 Bulan - Semi Private (Rp60.000)", callback_data="b1_sempriv")],
            [InlineKeyboardButton("2 Bulan - 1P1U (Rp80.000)", callback_data="b2_1p1u")],
            [InlineKeyboardButton("2 Bulan - Semi Private (Rp95.000)", callback_data="b2_sempriv")],
            [InlineKeyboardButton("⬅️ Kembali", callback_data="back_tipe")],
        ]
        await query.edit_message_text(
            "☆ *NETFLIX BULANAN* ☆\n\nPilih paket:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
        return TANYA_PAKET_BULANAN

    return TANYA_TIPE


async def callback_back_tipe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Kembali ke pilihan tipe langganan."""
    query = update.callback_query
    await query.answer()

    keyboard = [
        [InlineKeyboardButton("⚡ Quick Order", callback_data="tipe_quick")],
        [InlineKeyboardButton("📅 Harian / Mingguan", callback_data="tipe_harian")],
        [InlineKeyboardButton("📆 Bulanan", callback_data="tipe_bulanan")],
    ]
    await query.edit_message_text(
        "🍿 *Bot Netflix Otomatis*\n\n"
        "Pilih mode order:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_TIPE


async def callback_back_durasi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Kembali ke pilihan durasi (harian)."""
    query = update.callback_query
    await query.answer()

    keyboard = [
        [
            InlineKeyboardButton("1 Hari", callback_data="durasi_1"),
            InlineKeyboardButton("2 Hari", callback_data="durasi_2"),
        ],
        [
            InlineKeyboardButton("3 Hari", callback_data="durasi_3"),
            InlineKeyboardButton("7 Hari", callback_data="durasi_7"),
        ],
        [InlineKeyboardButton("14 Hari", callback_data="durasi_14")],
        [InlineKeyboardButton("⬅️ Kembali", callback_data="back_tipe")],
    ]
    await query.edit_message_text(
        "Pilih *durasi sewa*:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_DURASI


async def callback_back_paket(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Kembali ke pilihan paket bulanan."""
    query = update.callback_query
    await query.answer()

    keyboard = [
        [InlineKeyboardButton("1 Bulan - 1P1U (Rp50.000)", callback_data="b1_1p1u")],
        [InlineKeyboardButton("1 Bulan - Semi Private (Rp60.000)", callback_data="b1_sempriv")],
        [InlineKeyboardButton("2 Bulan - 1P1U (Rp80.000)", callback_data="b2_1p1u")],
        [InlineKeyboardButton("2 Bulan - Semi Private (Rp95.000)", callback_data="b2_sempriv")],
        [InlineKeyboardButton("⬅️ Kembali", callback_data="back_tipe")],
    ]
    await query.edit_message_text(
        "☆ *NETFLIX BULANAN* ☆\n\nPilih paket:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_PAKET_BULANAN


# ═══════════════════════════════════════════════════════════
#  ALUR QUICK ORDER
# ═══════════════════════════════════════════════════════════

async def terima_quick_order(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Parse form quick order dan proses."""
    teks = update.message.text

    # Parse form
    data = _parse_quick_order(teks)
    if data is None:
        await update.message.reply_text(
            "❌ Format tidak valid. Pastikan semua field terisi:\n\n"
            "```\n"
            "𖥻 Durasi order : 3\n"
            "𖥻 Nomor WhatsApp : 856-4647-3850\n"
            "𖥻 Merk & tipe device : iPhone 17\n"
            "𖥻 Lokasi login (kota) : Jakarta\n"
            "```\n\n"
            "ⓘ Durasi bisa diisi:\n"
            "• Harian: `1`, `2`, `3`, `7`\n"
            "• Bulanan: `1 Bulan`, `2 Bulan`\n"
            "• Semi Private: `1 Bulan Sempriv`, `2 Bulan Sempriv`",
            parse_mode="Markdown"
        )
        return TANYA_QUICK_ORDER

    durasi_info = data["durasi_info"]
    durasi = durasi_info["durasi"]
    nomor_pelanggan = _format_nomor(data["nomor"])
    device_text = data["device"]
    lokasi = data["lokasi"]

    # Validasi nomor
    if nomor_pelanggan is None:
        await update.message.reply_text(
            "❌ *Nomor WhatsApp tidak valid* (terlalu panjang/pendek).\n\n"
            "Cek kembali dan paste ulang form yang benar.",
            parse_mode="Markdown"
        )
        return TANYA_QUICK_ORDER

    # Deteksi tipe device untuk filter akun
    device_type = _detect_device_type(device_text)

    # Hapus pesan user (form yang di-paste) dan pesan bot berisi form kosong
    # try:
    #     await update.message.delete()
    # except Exception:
    #     pass
    try:
        form_chat_id = context.user_data.get("quick_form_chat_id")
        form_msg_id  = context.user_data.get("quick_form_msg_id")
        if form_chat_id and form_msg_id:
            await context.bot.delete_message(chat_id=form_chat_id, message_id=form_msg_id)
    except Exception:
        pass

    pesan_loading = await update.message.reply_text("🔍 Sedang mencari slot kosong...")

    try:
        async with _order_lock:
            # Pilih alur berdasarkan mode dari parsing durasi
            if durasi_info["mode"] == "harian":
                # HARIAN / MINGGUAN
                slot = None
                for attempt in range(3):
                    slot = cari_slot_kosong(durasi, device_type)
                    if slot is None:
                        break
                    if verifikasi_slot_masih_kosong(slot["nama_sheet"], slot["nomor_baris"]):
                        break
                    slot = None

                if slot is None:
                    await pesan_loading.edit_text(
                        "😔 *Stok habis.* Hubungi admin.",
                        parse_mode="Markdown"
                    )
                    return ConversationHandler.END

                tanggal_logout = hitung_tanggal_logout(durasi)
                harga = HARGA.get(durasi, "?")
                sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"

            else:
                # BULANAN
                jumlah_bulan = durasi_info.get("bulan", 1)
                tipe = durasi_info.get("tipe", "1p1u")
                is_sempriv = tipe == "sempriv"

                slot = None
                for attempt in range(3):
                    slot = cari_slot_kosong_bulanan(device_type)
                    if slot is None:
                        break
                    if verifikasi_slot_masih_kosong(slot["nama_sheet"], slot["nomor_baris"]):
                        break
                    slot = None

                if slot is None:
                    await pesan_loading.edit_text(
                        "😔 *Stok BULANAN habis.* Hubungi admin.",
                        parse_mode="Markdown"
                    )
                    return ConversationHandler.END

                tanggal_logout = hitung_tanggal_logout_bulanan(jumlah_bulan, is_sempriv)
                key = f"{jumlah_bulan}_{tipe}"
                harga = HARGA_BULANAN.get(key, "?")
                sheet_info = "BULANAN"

            # Tulis ke sheet HARIAN/MINGGUAN/BULANAN
            tulis_logout_ke_sheet(
                nama_sheet=slot["nama_sheet"],
                nomor_baris=slot["nomor_baris"],
                tanggal_logout=tanggal_logout,
                nomor_pelanggan=nomor_pelanggan
            )

            # Tulis merk device di kolom G
            spreadsheet = get_spreadsheet()
            sheet = spreadsheet.worksheet(slot["nama_sheet"])
            col_g = gspread.utils.rowcol_to_a1(slot["nomor_baris"], 7)  # Kolom G
            sheet.update_acell(col_g, device_text)

            # Tulis rekapan (kolom E = email + ", " + lokasi)
            try:
                if durasi_info["mode"] == "harian":
                    tulis_rekapan_quick(
                        nomor_pelanggan=nomor_pelanggan,
                        durasi=durasi,
                        email_akun=slot["email"],
                        lokasi=lokasi
                    )
                else:
                    tulis_rekapan_bulanan_quick(
                        nomor_pelanggan=nomor_pelanggan,
                        jumlah_bulan=jumlah_bulan,
                        tipe=tipe,
                        email_akun=slot["email"],
                        lokasi=lokasi
                    )
            except Exception as e:
                logger.warning(f"Gagal tulis rekapan: {e}")

        # Template tetap utuh, tombol Order Lagi di pesan terpisah
        if durasi_info["mode"] == "bulanan":
            template = format_template_bulanan(slot, tanggal_logout, tipe)
        else:
            template = format_template(slot, tanggal_logout, nomor_pelanggan, durasi, device_type)

        await pesan_loading.edit_text(template, parse_mode="Markdown")

        # Kirim pesan terpisah untuk tombol Order Lagi
        keyboard = [[InlineKeyboardButton("🔄 Order Lagi", callback_data="order_lagi")]]
        await context.bot.send_message(
            chat_id=update.effective_chat.id,
            text="✅ Selesai!",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        logger.info(
            f"[QUICK] Sheet: {slot['nama_sheet']} | Baris: {slot['nomor_baris']} | "
            f"Pelanggan: {nomor_pelanggan} | Device: {device_text} ({device_type}) | "
            f"Lokasi: {lokasi} | Logout: {tanggal_logout}"
        )

        # Notif admin
        if durasi_info["mode"] == "bulanan":
            tipe_label = "Semi Private" if tipe == "sempriv" else "1P1U"
            produk_label = f"Netflix BULANAN {jumlah_bulan} Bulan {tipe_label}"
        else:
            produk_label = f"Netflix {sheet_info} {durasi} Hari"

        await kirim_notif_admin(context, {
            "produk": produk_label,
            "harga": harga,
            "pelanggan": nomor_pelanggan,
            "email": slot["email"],
            "device": f"{device_text} ({device_type})",
            "logout": tanggal_logout,
        })

    except Exception as e:
        logger.error(f"Error quick order: {e}", exc_info=True)
        await pesan_loading.edit_text("⚠️ Terjadi kesalahan. Coba lagi atau hubungi admin.")

    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════
#  ALUR HARIAN / MINGGUAN
# ═══════════════════════════════════════════════════════════

async def callback_durasi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima pilihan durasi via button."""
    query = update.callback_query
    await query.answer()

    durasi = int(query.data.split("_")[1])
    context.user_data["durasi"] = durasi
    sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"

    await query.edit_message_text(
        f"✅ Durasi: *{durasi} hari* (Sheet: {sheet_info})\n\n"
        f"Masukkan *nomor / nama pelanggan*:",
        parse_mode="Markdown"
    )
    return TANYA_NOMOR


async def terima_nomor(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima nomor/nama pelanggan, tanya device."""
    nomor_pelanggan = update.message.text.strip()
    context.user_data["nomor_pelanggan"] = nomor_pelanggan

    keyboard = [
        [InlineKeyboardButton("📺 TV", callback_data="tv")],
        [InlineKeyboardButton("📱 HP / TAB", callback_data="hp")],
        [InlineKeyboardButton("💻 PC / LAPTOP", callback_data="pc")],
        [InlineKeyboardButton("⬅️ Kembali", callback_data="back_durasi")],
    ]
    await update.message.reply_text(
        f"✅ Pelanggan: *{nomor_pelanggan}*\n\n"
        f"Login device apa?",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_DEVICE


async def callback_device(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Proses harian/mingguan setelah pilih device."""
    query = update.callback_query
    await query.answer()

    device = DEVICE_MAP[query.data]
    nomor_pelanggan = context.user_data.get("nomor_pelanggan", "")
    durasi = context.user_data.get("durasi", 1)

    await query.edit_message_text("🔍 Sedang mencari slot kosong...")

    try:
        # Lock global: cegah race condition (2 order ambil slot sama)
        async with _order_lock:
            slot = None
            # Retry max 3x kalau slot keburu diambil order lain
            for attempt in range(3):
                slot = cari_slot_kosong(durasi, device)
                if slot is None:
                    break
                if verifikasi_slot_masih_kosong(slot["nama_sheet"], slot["nomor_baris"]):
                    break
                logger.warning(f"Slot baris {slot['nomor_baris']} sudah terisi, retry {attempt+1}")
                slot = None

            if slot is None:
                sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"
                await query.edit_message_text(
                    f"😔 *Maaf, stok akun di sheet {sheet_info} sedang habis.*\n\n"
                    "Semua slot sudah terisi. Hubungi admin.",
                    parse_mode="Markdown"
                )
                return ConversationHandler.END

            tanggal_logout = hitung_tanggal_logout(durasi)

            # Tulis logout & nomor pelanggan dulu (paling penting!)
            tulis_logout_ke_sheet(
                nama_sheet=slot["nama_sheet"],
                nomor_baris=slot["nomor_baris"],
                tanggal_logout=tanggal_logout,
                nomor_pelanggan=nomor_pelanggan
            )

            # Tulis rekapan (kalau gagal, tetap log warning tapi jangan rollback)
            try:
                tulis_rekapan(
                    nomor_pelanggan=nomor_pelanggan,
                    durasi=durasi,
                    email_akun=slot["email"]
                )
            except Exception as e:
                logger.warning(f"Gagal tulis rekapan: {e}")

        # Template tetap utuh, tombol Order Lagi di pesan terpisah
        template = format_template(slot, tanggal_logout, nomor_pelanggan, durasi, device)
        await query.edit_message_text(template, parse_mode="Markdown")

        keyboard = [[InlineKeyboardButton("🔄 Order Lagi", callback_data="order_lagi")]]
        await query.message.reply_text(
            "✅ Selesai!",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        logger.info(
            f"[OK] Sheet: {slot['nama_sheet']} | Baris: {slot['nomor_baris']} | "
            f"Pelanggan: {nomor_pelanggan} | Device: {device} | Logout: {tanggal_logout}"
        )

        # Notifikasi admin
        sheet_info = "HARIAN" if durasi in [1, 2, 3] else "MINGGUAN"
        await kirim_notif_admin(context, {
            "produk": f"Netflix {sheet_info} {durasi} Hari",
            "harga": HARGA.get(durasi, "?"),
            "pelanggan": nomor_pelanggan,
            "email": slot["email"],
            "device": device,
            "logout": tanggal_logout,
        })

    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        await query.edit_message_text(
            "⚠️ Terjadi kesalahan. Coba beberapa saat lagi atau hubungi admin."
        )

    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════
#  ALUR BULANAN
# ═══════════════════════════════════════════════════════════

async def callback_paket_bulanan(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima pilihan paket bulanan via button."""
    query = update.callback_query
    await query.answer()

    paket = PAKET_BULANAN_MAP[query.data]
    context.user_data["paket_bulanan"] = paket

    await query.edit_message_text(
        f"✅ Paket: *{paket['label']}*\n\n"
        f"Masukkan *nomor / nama pelanggan*:",
        parse_mode="Markdown"
    )
    return TANYA_NOMOR_BULANAN


async def terima_nomor_bulanan(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Terima nomor/nama pelanggan bulanan, tanya device."""
    nomor_pelanggan = update.message.text.strip()
    context.user_data["nomor_pelanggan"] = nomor_pelanggan

    keyboard = [
        [InlineKeyboardButton("📺 TV", callback_data="dev_tv")],
        [InlineKeyboardButton("📱 HP / TAB", callback_data="dev_hp")],
        [InlineKeyboardButton("💻 PC / LAPTOP", callback_data="dev_pc")],
        [InlineKeyboardButton("⬅️ Kembali", callback_data="back_paket")],
    ]
    await update.message.reply_text(
        f"✅ Pelanggan: *{nomor_pelanggan}*\n\n"
        f"Login device apa?",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_DEVICE_BULANAN


async def callback_device_bulanan(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Proses bulanan setelah pilih device."""
    query = update.callback_query
    await query.answer()

    device_key = query.data.replace("dev_", "")
    device = DEVICE_MAP[device_key]
    nomor_pelanggan = context.user_data.get("nomor_pelanggan", "")
    paket = context.user_data.get("paket_bulanan", {})
    jumlah_bulan = paket.get("bulan", 1)
    tipe = paket.get("tipe", "1p1u")
    is_sempriv = tipe == "sempriv"

    await query.edit_message_text("🔍 Sedang mencari slot kosong...")

    try:
        # Lock global: cegah race condition
        async with _order_lock:
            slot = None
            for attempt in range(3):
                slot = cari_slot_kosong_bulanan(device)
                if slot is None:
                    break
                if verifikasi_slot_masih_kosong(slot["nama_sheet"], slot["nomor_baris"]):
                    break
                logger.warning(f"Slot bulanan baris {slot['nomor_baris']} sudah terisi, retry {attempt+1}")
                slot = None

            if slot is None:
                await query.edit_message_text(
                    "😔 *Maaf, stok akun BULANAN sedang habis.*\n\n"
                    "Hubungi admin untuk info lebih lanjut.",
                    parse_mode="Markdown"
                )
                return ConversationHandler.END

            tanggal_logout = hitung_tanggal_logout_bulanan(jumlah_bulan, is_sempriv)

            tulis_logout_ke_sheet(
                nama_sheet=slot["nama_sheet"],
                nomor_baris=slot["nomor_baris"],
                tanggal_logout=tanggal_logout,
                nomor_pelanggan=nomor_pelanggan
            )

            try:
                tulis_rekapan_bulanan(
                    nomor_pelanggan=nomor_pelanggan,
                    jumlah_bulan=jumlah_bulan,
                    tipe=tipe,
                    email_akun=slot["email"]
                )
            except Exception as e:
                logger.warning(f"Gagal tulis rekapan bulanan: {e}")

        # Template tetap utuh, tombol Order Lagi di pesan terpisah
        template = format_template_bulanan(slot, tanggal_logout, tipe)
        await query.edit_message_text(template, parse_mode="Markdown")

        keyboard = [[InlineKeyboardButton("🔄 Order Lagi", callback_data="order_lagi")]]
        await query.message.reply_text(
            "✅ Selesai!",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

        logger.info(
            f"[OK] BULANAN | Baris: {slot['nomor_baris']} | "
            f"Pelanggan: {nomor_pelanggan} | Paket: {jumlah_bulan}bln {tipe} | "
            f"Device: {device} | Logout: {tanggal_logout}"
        )

        # Kirim notifikasi ke admin
        key = f"{jumlah_bulan}_{tipe}"
        harga = HARGA_BULANAN.get(key, "?")
        tipe_label = "Semi Private" if tipe == "sempriv" else "1P1U"
        await kirim_notif_admin(context, {
            "produk": f"Netflix BULANAN {jumlah_bulan} Bulan {tipe_label}",
            "harga": harga,
            "pelanggan": nomor_pelanggan,
            "email": slot["email"],
            "device": device,
            "logout": tanggal_logout,
        })

    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        await query.edit_message_text(
            "⚠️ Terjadi kesalahan. Coba beberapa saat lagi atau hubungi admin."
        )

    return ConversationHandler.END


# ─── Order Lagi ────────────────────────────────────────────

async def callback_order_lagi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Restart alur dari awal ketika tombol Order Lagi diklik.
    Edit pesan '✅ Selesai!' jadi pilihan mode — template tidak disentuh.
    """
    query = update.callback_query
    await query.answer()

    keyboard = [
        [InlineKeyboardButton("⚡ Quick Order", callback_data="tipe_quick")],
        [InlineKeyboardButton("📅 Harian / Mingguan", callback_data="tipe_harian")],
        [InlineKeyboardButton("📆 Bulanan", callback_data="tipe_bulanan")],
    ]
    await query.edit_message_text(
        "🍿 *Bot Netflix Otomatis*\n\nPilih mode order:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_TIPE
