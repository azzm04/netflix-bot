# ============================================================
#  bot.py — Main bot Telegram Netflix (Inline Buttons)
# ============================================================

import logging
import json
import os
from datetime import datetime
from telegram import Update, BotCommand, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ConversationHandler,
    ContextTypes,
    filters,
)
from config import BOT_TOKEN, ADMIN_CHAT_ID, ADMIN_ID, USERS_FILE, HARGA, HARGA_BULANAN
import gspread
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
    cek_stok,
    cek_logout,
    gantihari,
    verifikasi_slot_masih_kosong,
    get_spreadsheet,
    rekap_pendapatan,
    closing_hari,
    _order_lock,
)

# Setup logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Sembunyikan token dari log httpx (mencegah token terekspos di log)
logging.getLogger("httpx").setLevel(logging.WARNING)


# ─── User management (cached) ─────────────────────────────

_allowed_users_cache = None
_allowed_users_mtime = 0


def _init_users_file():
    """Buat file allowed_users.json jika belum ada."""
    if not os.path.exists(USERS_FILE):
        with open(USERS_FILE, "w") as f:
            json.dump([ADMIN_ID], f)


# Inisialisasi saat module di-load
_init_users_file()


def load_allowed_users() -> list:
    """Load daftar user dari file JSON (dengan cache berdasarkan mtime)."""
    global _allowed_users_cache, _allowed_users_mtime
    try:
        mtime = os.path.getmtime(USERS_FILE)
        if _allowed_users_cache is not None and mtime == _allowed_users_mtime:
            return _allowed_users_cache
        with open(USERS_FILE, "r") as f:
            _allowed_users_cache = json.load(f)
            _allowed_users_mtime = mtime
            return _allowed_users_cache
    except (FileNotFoundError, json.JSONDecodeError):
        return [ADMIN_ID]


def save_allowed_users(users: list):
    """Simpan daftar user ke file JSON dan update cache."""
    global _allowed_users_cache, _allowed_users_mtime
    with open(USERS_FILE, "w") as f:
        json.dump(users, f)
    _allowed_users_cache = users
    _allowed_users_mtime = os.path.getmtime(USERS_FILE)


def is_allowed(user_id: int) -> bool:
    """Cek apakah user boleh pakai bot."""
    return user_id in load_allowed_users()


async def kirim_notif_admin(context: ContextTypes.DEFAULT_TYPE, data: dict):
    """Kirim notifikasi order berhasil ke admin."""
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

    try:
        await context.bot.send_message(
            chat_id=ADMIN_CHAT_ID,
            text=teks,
            parse_mode="Markdown"
        )
    except Exception as e:
        logger.error(f"Gagal kirim notif admin: {e}")

# State untuk ConversationHandler
(TANYA_TIPE, TANYA_DURASI, TANYA_NOMOR, TANYA_DEVICE,
 TANYA_PAKET_BULANAN, TANYA_NOMOR_BULANAN, TANYA_DEVICE_BULANAN,
 TANYA_QUICK_ORDER) = range(8)

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


# ─── /start ────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Mulai percakapan, tanya tipe langganan."""
    # Cek whitelist
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
        await query.edit_message_text(
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

    # Angka besar (>7) tanpa kata "bulan" → tetap dianggap bulanan (backward compat)
    if durasi_int > 7:
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
            from sheets_handler import get_spreadsheet
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

        # Kirim template
        if durasi_info["mode"] == "bulanan":
            template = format_template_bulanan(slot, tanggal_logout, tipe)
        else:
            template = format_template(slot, tanggal_logout, nomor_pelanggan, durasi, device_type)
        await pesan_loading.edit_text(template, parse_mode="Markdown")

        # Tombol Order Lagi
        keyboard = [[InlineKeyboardButton("🔄 Order Lagi", callback_data="order_lagi")]]
        await update.message.reply_text("✅ Selesai!", reply_markup=InlineKeyboardMarkup(keyboard))

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

        # Kirim template (di luar lock biar lock cepat dilepas)
        template = format_template(slot, tanggal_logout, nomor_pelanggan, durasi, device)
        await query.edit_message_text(template, parse_mode="Markdown")

        # Tombol Order Lagi
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

        template = format_template_bulanan(slot, tanggal_logout, tipe)
        await query.edit_message_text(template, parse_mode="Markdown")

        # Tombol Order Lagi
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


# ─── /adduser, /removeuser, /listuser ──────────────────────

async def adduser(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Tambah user ke whitelist. Hanya admin utama."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama yang bisa menambah user.")
        return

    if not context.args:
        await update.message.reply_text(
            "Cara pakai: `/adduser 123456789`\n"
            "_(masukkan Telegram User ID)_",
            parse_mode="Markdown"
        )
        return

    try:
        new_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ ID harus berupa angka.")
        return

    users = load_allowed_users()
    if new_id in users:
        await update.message.reply_text(f"ℹ️ User `{new_id}` sudah terdaftar.", parse_mode="Markdown")
        return

    users.append(new_id)
    save_allowed_users(users)
    await update.message.reply_text(f"✅ User `{new_id}` berhasil ditambahkan.", parse_mode="Markdown")


async def removeuser(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Hapus user dari whitelist. Hanya admin utama."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama yang bisa menghapus user.")
        return

    if not context.args:
        await update.message.reply_text(
            "Cara pakai: `/removeuser 123456789`",
            parse_mode="Markdown"
        )
        return

    try:
        remove_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ ID harus berupa angka.")
        return

    if remove_id == ADMIN_ID:
        await update.message.reply_text("❌ Tidak bisa menghapus admin utama.")
        return

    users = load_allowed_users()
    if remove_id not in users:
        await update.message.reply_text(f"ℹ️ User `{remove_id}` tidak ditemukan.", parse_mode="Markdown")
        return

    users.remove(remove_id)
    save_allowed_users(users)
    await update.message.reply_text(f"✅ User `{remove_id}` berhasil dihapus.", parse_mode="Markdown")


async def listuser(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Lihat daftar user yang diizinkan. Hanya admin utama."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return

    users = load_allowed_users()
    teks = "👥 *Daftar User Terdaftar:*\n\n"
    for uid in users:
        label = " (admin)" if uid == ADMIN_ID else ""
        teks += f"• `{uid}`{label}\n"
    teks += f"\nTotal: {len(users)} user"
    await update.message.reply_text(teks, parse_mode="Markdown")


# ─── /stok ─────────────────────────────────────────────────

async def stok(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cek stok slot kosong di tiap sheet."""
    # Cek whitelist
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

    except Exception as e:
        logger.error(f"Error closing: {e}", exc_info=True)
        await pesan.edit_text("⚠️ Gagal proses closing.")


# ─── /cancel ───────────────────────────────────────────────

async def callback_order_lagi(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Restart alur dari awal ketika tombol Order Lagi diklik."""
    query = update.callback_query
    await query.answer()

    # Hapus tombol
    await query.edit_message_text("🔄 Memulai order baru...")

    # Tampilkan pilihan tipe lagi (termasuk Quick Order)
    keyboard = [
        [InlineKeyboardButton("⚡ Quick Order", callback_data="tipe_quick")],
        [InlineKeyboardButton("📅 Harian / Mingguan", callback_data="tipe_harian")],
        [InlineKeyboardButton("📆 Bulanan", callback_data="tipe_bulanan")],
    ]
    await query.message.reply_text(
        "🍿 *Bot Netflix Otomatis*\n\n"
        "Pilih mode order:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return TANYA_TIPE


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


# ─── Pesan tidak dikenal ────────────────────────────────────

async def pesan_tidak_dikenal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Balas pesan di luar alur percakapan."""
    if not is_allowed(update.effective_user.id):
        return  # Abaikan user yang tidak terdaftar
    await update.message.reply_text("Ketik /start untuk memulai.")


# ─── Main ──────────────────────────────────────────────────

async def post_init(application):
    """Set menu commands berbeda untuk admin dan user biasa."""
    from telegram import BotCommandScopeChat

    # Menu untuk semua user (default)
    await application.bot.set_my_commands([
        BotCommand("start", "Mulai cari akun Netflix"),
        BotCommand("stok", "Cek stok slot kosong"),
        BotCommand("cancel", "Batalkan proses"),
        BotCommand("ceklogout", "Cek akun yang perlu di-logout"),
        BotCommand("gantihari", "Ganti hari & ubah warna besok"),
    ])

    # Menu khusus admin (lebih lengkap)
    try:
        await application.bot.set_my_commands(
            [
                BotCommand("start", "Mulai cari akun Netflix"),
                BotCommand("stok", "Cek stok slot kosong"),
                BotCommand("ceklogout", "Cek akun yang perlu di-logout"),
                BotCommand("gantihari", "Ganti hari & ubah warna besok"),
                BotCommand("rekap", "Lihat rekap pendapatan"),
                BotCommand("closing", "Closing hari & tulis ke REKAPAN MODAL"),
                BotCommand("adduser", "Tambah user"),
                BotCommand("removeuser", "Hapus user"),
                BotCommand("listuser", "Lihat daftar user"),
                BotCommand("cancel", "Batalkan proses"),
            ],
            scope=BotCommandScopeChat(chat_id=ADMIN_ID)
        )
    except Exception:
        pass  # Gagal set scope admin tidak fatal


def main():
    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()

    conv_handler = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
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
        conversation_timeout=300,  # 5 menit timeout
        allow_reentry=True,        # /start bisa restart conversation
    )

    app.add_handler(conv_handler)
    app.add_handler(CommandHandler("stok", stok))
    app.add_handler(CommandHandler("ceklogout", ceklogout))
    app.add_handler(CommandHandler("gantihari", cmd_gantihari))
    app.add_handler(CommandHandler("rekap", cmd_rekap))
    app.add_handler(CommandHandler("closing", cmd_closing))
    app.add_handler(CallbackQueryHandler(callback_rekap, pattern="^rekap_"))
    app.add_handler(CommandHandler("adduser", adduser))
    app.add_handler(CommandHandler("removeuser", removeuser))
    app.add_handler(CommandHandler("listuser", listuser))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, pesan_tidak_dikenal))

    print("✅ Bot berjalan... Tekan Ctrl+C untuk berhenti.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
