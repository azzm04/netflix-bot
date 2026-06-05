# ============================================================
#  handlers/group.py — Group-only commands:
#                       /feeadmin, /gestun, /modal_netflix
#
#  Pola edit-in-place:
#  - Bot kirim 1 pesan saat command dipanggil, simpan message_id
#  - Setiap step EDIT pesan itu (bukan kirim baru)
#  - Pesan teks user dihapus agar chat tetap bersih
# ============================================================

import logging
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, ConversationHandler
from config import ADMIN_ID
from sheets_handler import tulis_fee_admin, tulis_gestun, tulis_modal_netflix
from handlers.states import (
    FEE_TANYA_TANGGAL, FEE_TANYA_NOMINAL, FEE_KONFIRMASI,
    GESTUN_PILIH_MODE,
    GESTUN_TANYA_TANGGAL, GESTUN_TANYA_NOMINAL, GESTUN_TANYA_PERSEN, GESTUN_KONFIRMASI,
    GESTUN_QUICK,
    MODAL_PILIH_MODE,
    MODAL_TANYA_TANGGAL, MODAL_TANYA_NOMINAL, MODAL_TANYA_KET, MODAL_KONFIRMASI,
    MODAL_QUICK,
)

logger = logging.getLogger(__name__)


# ─── Helper edit-in-place ───────────────────────────────────

async def _edit(context, key_prefix: str, teks: str, keyboard=None):
    """Edit pesan bot yang tersimpan di user_data."""
    chat_id = context.user_data.get(f"{key_prefix}_chat_id")
    msg_id  = context.user_data.get(f"{key_prefix}_msg_id")
    if not chat_id or not msg_id:
        return
    markup = InlineKeyboardMarkup(keyboard) if keyboard else None
    try:
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=msg_id,
            text=teks,
            parse_mode="Markdown",
            reply_markup=markup,
        )
    except Exception:
        pass  # Pesan mungkin tidak berubah (konten sama) — abaikan


async def _hapus_pesan_user(update):
    """Hapus pesan teks user agar chat tetap bersih."""
    try:
        await update.message.delete()
    except Exception:
        pass  # Tidak punya permission delete — skip


# ═══════════════════════════════════════════════════════════
#  /feeadmin
# ═══════════════════════════════════════════════════════════

async def cmd_feeadmin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Mulai input fee admin. Hanya admin, hanya di group."""
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return ConversationHandler.END

    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("⛔ Command ini hanya bisa digunakan di dalam group.")
        return ConversationHandler.END

    now = datetime.now()
    keyboard = [
        [InlineKeyboardButton(f"📅 Hari ini ({now.strftime('%d/%m/%Y')})", callback_data="fee_tgl_hari_ini")],
        [InlineKeyboardButton("✏️ Masukkan tanggal lain", callback_data="fee_tgl_custom")],
        [InlineKeyboardButton("❌ Batal", callback_data="fee_batal")],
    ]
    msg = await update.message.reply_text(
        "💼 *INPUT FEE ADMIN*\n\nPilih tanggal:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    context.user_data["fee_chat_id"] = msg.chat_id
    context.user_data["fee_msg_id"]  = msg.message_id
    return FEE_TANYA_TANGGAL


async def callback_fee_pilih_tanggal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "fee_batal":
        await query.edit_message_text("❌ Input fee admin dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    if query.data == "fee_tgl_hari_ini":
        tanggal = datetime.now().strftime("%d/%m/%Y")
        context.user_data["fee_tanggal"] = tanggal
        await query.edit_message_text(
            f"💼 *INPUT FEE ADMIN*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"Ketik nominal fee admin (angka saja, contoh: `50000`):",
            parse_mode="Markdown",
        )
        return FEE_TANYA_NOMINAL

    elif query.data == "fee_tgl_custom":
        await query.edit_message_text(
            "💼 *INPUT FEE ADMIN*\n\n"
            "Ketik tanggal format *DD/MM/YYYY*\n"
            "Contoh: `05/06/2026`",
            parse_mode="Markdown",
        )
        return FEE_TANYA_TANGGAL

    return FEE_TANYA_TANGGAL


async def terima_tanggal_fee(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)

    try:
        tgl = datetime.strptime(teks, "%d/%m/%Y")
        tanggal_fmt = tgl.strftime("%d/%m/%Y")
    except ValueError:
        await _edit(
            context, "fee",
            "💼 *INPUT FEE ADMIN*\n\n"
            "❌ Format tidak valid. Ketik *DD/MM/YYYY*, contoh: `05/06/2026`\n"
            "Atau /cancel untuk batal.",
        )
        return FEE_TANYA_TANGGAL

    context.user_data["fee_tanggal"] = tanggal_fmt
    await _edit(
        context, "fee",
        f"💼 *INPUT FEE ADMIN*\n\n"
        f"📅 Tanggal: `{tanggal_fmt}`\n\n"
        f"Ketik nominal fee admin (angka saja, contoh: `50000`):",
    )
    return FEE_TANYA_NOMINAL


async def terima_nominal_fee(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)

    bersih = "".join(c for c in teks if c.isdigit())
    if not bersih or int(bersih) <= 0:
        tanggal = context.user_data.get("fee_tanggal", "?")
        await _edit(
            context, "fee",
            f"💼 *INPUT FEE ADMIN*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"❌ Nominal tidak valid. Ketik angka saja, contoh: `50000`:",
        )
        return FEE_TANYA_NOMINAL

    nominal = int(bersih)
    tanggal = context.user_data.get("fee_tanggal", "?")
    context.user_data["fee_nominal"] = nominal

    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="fee_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="fee_konfirm_tidak"),
        ]
    ]
    await _edit(
        context, "fee",
        f"💼 *KONFIRMASI FEE ADMIN*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📅 Tanggal   : `{tanggal}`\n"
        f"💰 Fee Admin : *Rp{nominal:,}*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"Simpan ke sheet REKAPAN MODAL?",
        keyboard,
    )
    return FEE_KONFIRMASI


async def callback_konfirmasi_fee(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "fee_konfirm_tidak":
        await query.edit_message_text("❌ Input fee admin dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    tanggal = context.user_data.get("fee_tanggal")
    nominal = context.user_data.get("fee_nominal")
    await query.edit_message_text("🔄 Menyimpan fee admin ke sheet...")

    try:
        result = tulis_fee_admin(tanggal, nominal)
        if not result["ok"]:
            await query.edit_message_text(
                f"❌ *Gagal menyimpan fee admin*\n\n{result['reason']}",
                parse_mode="Markdown",
            )
            return ConversationHandler.END

        await query.edit_message_text(
            f"✅ *FEE ADMIN TERSIMPAN*\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"📅 Tanggal   : `{tanggal}`\n"
            f"💰 Fee Admin : *Rp{nominal:,}*\n"
            f"📊 Baris     : {result['baris']}\n"
            f"━━━━━━━━━━━━━━━━",
            parse_mode="Markdown",
        )
        logger.info(f"[FEE ADMIN] {tanggal} | {nominal} | Baris {result['baris']}")

    except Exception as e:
        logger.error(f"Error tulis fee admin: {e}", exc_info=True)
        await query.edit_message_text("⚠️ Terjadi kesalahan saat menyimpan fee admin.")

    context.user_data.clear()
    return ConversationHandler.END


async def cancel_fee(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await _hapus_pesan_user(update)
    await _edit(context, "fee", "❌ Input fee admin dibatalkan.")
    context.user_data.clear()
    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════
#  /gestun
# ═══════════════════════════════════════════════════════════

def _parse_quick_gestun(teks: str) -> dict:
    result = {"tanggal": None, "nominal": None, "persen": None}
    for line in teks.strip().split("\n"):
        line = line.strip()
        if ":" not in line:
            continue
        value = line.split(":", 1)[1].strip()
        lower = line.lower()
        if "tanggal" in lower:
            for fmt in ("%d/%m/%Y", "%d/%m/%y"):
                try:
                    result["tanggal"] = datetime.strptime(value.strip(), fmt).strftime("%d/%m/%Y")
                    break
                except ValueError:
                    continue
        elif "nominal" in lower:
            bersih = "".join(c for c in value if c.isdigit())
            if bersih:
                result["nominal"] = int(bersih)
        elif "keuntungan" in lower:
            if value.strip() in ("-", "", "0", "tidak ada", "none"):
                result["persen"] = None
            else:
                try:
                    p = float(value.replace("%", "").replace(",", ".").strip())
                    result["persen"] = p if 0 < p <= 100 else None
                except ValueError:
                    result["persen"] = None
    return result if result["tanggal"] and result["nominal"] else None


def _fmt_gestun_konfirm(tanggal, nominal, persen) -> str:
    persen_str = f"{persen}%" if persen is not None else "-"
    hasil_str  = f"Rp{int(nominal * persen / 100):,}" if persen is not None else "-"
    return (
        f"💳 *KONFIRMASI DATA GESTUN*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📅 Tanggal       : `{tanggal}`\n"
        f"💰 Nominal       : *Rp{nominal:,}*\n"
        f"📊 Keuntungan % : *{persen_str}*\n"
        f"✅ Hasil Bersih  : *{hasil_str}*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"Simpan ke sheet REKAPAN MODAL?"
    )


async def cmd_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return ConversationHandler.END
    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("⛔ Command ini hanya bisa digunakan di dalam group.")
        return ConversationHandler.END

    keyboard = [
        [InlineKeyboardButton("⚡ Quick (paste form)", callback_data="gestun_mode_quick")],
        [InlineKeyboardButton("📝 Step-by-step", callback_data="gestun_mode_step")],
        [InlineKeyboardButton("❌ Batal", callback_data="gestun_batal")],
    ]
    msg = await update.message.reply_text(
        "💳 *INPUT DATA GESTUN*\n\nPilih mode input:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    context.user_data["gestun_chat_id"] = msg.chat_id
    context.user_data["gestun_msg_id"]  = msg.message_id
    return GESTUN_PILIH_MODE


async def callback_gestun_pilih_mode(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "gestun_batal":
        await query.edit_message_text("❌ Input gestun dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    if query.data == "gestun_mode_quick":
        await query.edit_message_text(
            "💳 *QUICK GESTUN*\n\n"
            "Paste form berikut (isi nilainya):\n\n"
            "```\n"
            "𖥻 Tanggal (dd/mm/yy) : \n"
            "𖥻 Nominal : \n"
            "𖥻 Keuntungan (opsional) : \n"
            "```\n\n"
            "_Keuntungan bisa dikosongkan atau isi `-` jika tidak ada._",
            parse_mode="Markdown",
        )
        return GESTUN_QUICK

    elif query.data == "gestun_mode_step":
        keyboard = [
            [InlineKeyboardButton(f"📅 Hari ini ({datetime.now().strftime('%d/%m/%Y')})", callback_data="gestun_tgl_hari_ini")],
            [InlineKeyboardButton("✏️ Tanggal lain", callback_data="gestun_tgl_custom")],
            [InlineKeyboardButton("❌ Batal", callback_data="gestun_batal_step")],
        ]
        await query.edit_message_text(
            "💳 *INPUT DATA GESTUN*\n\nPilih tanggal transaksi:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return GESTUN_TANYA_TANGGAL

    return GESTUN_PILIH_MODE


# ── Quick mode ──────────────────────────────────────────────

async def terima_quick_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text
    await _hapus_pesan_user(update)

    data = _parse_quick_gestun(teks)
    if data is None:
        await _edit(
            context, "gestun",
            "💳 *QUICK GESTUN*\n\n"
            "❌ Format tidak valid. Pastikan tanggal dan nominal terisi.\n\n"
            "```\n"
            "𖥻 Tanggal (dd/mm/yy) : 05/06/26\n"
            "𖥻 Nominal : 2000000\n"
            "𖥻 Keuntungan (opsional) : 5\n"
            "```",
        )
        return GESTUN_QUICK

    context.user_data["gestun_tanggal"] = data["tanggal"]
    context.user_data["gestun_nominal"] = data["nominal"]
    context.user_data["gestun_persen"]  = data["persen"]

    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="gestun_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="gestun_konfirm_tidak"),
        ]
    ]
    await _edit(context, "gestun", _fmt_gestun_konfirm(data["tanggal"], data["nominal"], data["persen"]), keyboard)
    return GESTUN_KONFIRMASI


# ── Step-by-step mode ───────────────────────────────────────

async def callback_gestun_pilih_tanggal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data in ("gestun_batal", "gestun_batal_step"):
        await query.edit_message_text("❌ Input gestun dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    if query.data == "gestun_tgl_hari_ini":
        tanggal = datetime.now().strftime("%d/%m/%Y")
        context.user_data["gestun_tanggal"] = tanggal
        await query.edit_message_text(
            f"💳 *INPUT DATA GESTUN*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"Ketik *nominal* (angka saja, contoh: `2000000`):",
            parse_mode="Markdown",
        )
        return GESTUN_TANYA_NOMINAL

    elif query.data == "gestun_tgl_custom":
        await query.edit_message_text(
            "💳 *INPUT DATA GESTUN*\n\n"
            "Ketik tanggal format *DD/MM/YY*\n"
            "Contoh: `05/06/26`",
            parse_mode="Markdown",
        )
        return GESTUN_TANYA_TANGGAL

    return GESTUN_TANYA_TANGGAL


async def terima_tanggal_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)

    tanggal_fmt = None
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            tanggal_fmt = datetime.strptime(teks, fmt).strftime("%d/%m/%Y")
            break
        except ValueError:
            continue

    if tanggal_fmt is None:
        await _edit(
            context, "gestun",
            "💳 *INPUT DATA GESTUN*\n\n"
            "❌ Format tidak valid. Ketik *DD/MM/YY*, contoh: `05/06/26`\n"
            "Atau /cancel untuk batal.",
        )
        return GESTUN_TANYA_TANGGAL

    context.user_data["gestun_tanggal"] = tanggal_fmt
    await _edit(
        context, "gestun",
        f"💳 *INPUT DATA GESTUN*\n\n"
        f"📅 Tanggal: `{tanggal_fmt}`\n\n"
        f"Ketik *nominal* (angka saja, contoh: `2000000`):",
    )
    return GESTUN_TANYA_NOMINAL


async def terima_nominal_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)
    bersih = "".join(c for c in teks if c.isdigit())

    tanggal = context.user_data.get("gestun_tanggal", "?")
    if not bersih or int(bersih) <= 0:
        await _edit(
            context, "gestun",
            f"💳 *INPUT DATA GESTUN*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"❌ Nominal tidak valid. Ketik angka saja, contoh: `2000000`:",
        )
        return GESTUN_TANYA_NOMINAL

    context.user_data["gestun_nominal"] = int(bersih)
    keyboard = [
        [InlineKeyboardButton("⏭️ Lewati (tidak ada %)", callback_data="gestun_persen_skip")],
        [InlineKeyboardButton("❌ Batal", callback_data="gestun_persen_batal")],
    ]
    await _edit(
        context, "gestun",
        f"💳 *INPUT DATA GESTUN*\n\n"
        f"📅 Tanggal : `{tanggal}`\n"
        f"💰 Nominal : *Rp{int(bersih):,}*\n\n"
        f"Ketik *% keuntungan* (contoh: `5` untuk 5%)\n"
        f"Atau tekan *Lewati* jika tidak ada:",
        keyboard,
    )
    return GESTUN_TANYA_PERSEN


async def callback_gestun_persen(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "gestun_persen_batal":
        await query.edit_message_text("❌ Input gestun dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    context.user_data["gestun_persen"] = None
    tanggal = context.user_data.get("gestun_tanggal", "?")
    nominal = context.user_data.get("gestun_nominal", 0)
    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="gestun_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="gestun_konfirm_tidak"),
        ]
    ]
    await query.edit_message_text(
        _fmt_gestun_konfirm(tanggal, nominal, None),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return GESTUN_KONFIRMASI


async def terima_persen_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip().replace("%", "").replace(",", ".")
    await _hapus_pesan_user(update)

    tanggal = context.user_data.get("gestun_tanggal", "?")
    nominal = context.user_data.get("gestun_nominal", 0)

    try:
        persen = float(teks)
        if not (0 < persen <= 100):
            raise ValueError
    except ValueError:
        keyboard = [
            [InlineKeyboardButton("⏭️ Lewati (tidak ada %)", callback_data="gestun_persen_skip")],
            [InlineKeyboardButton("❌ Batal", callback_data="gestun_persen_batal")],
        ]
        await _edit(
            context, "gestun",
            f"💳 *INPUT DATA GESTUN*\n\n"
            f"📅 Tanggal : `{tanggal}`\n"
            f"💰 Nominal : *Rp{nominal:,}*\n\n"
            f"❌ Persentase tidak valid. Masukkan angka 0-100, contoh: `5`:",
            keyboard,
        )
        return GESTUN_TANYA_PERSEN

    context.user_data["gestun_persen"] = persen
    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="gestun_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="gestun_konfirm_tidak"),
        ]
    ]
    await _edit(context, "gestun", _fmt_gestun_konfirm(tanggal, nominal, persen), keyboard)
    return GESTUN_KONFIRMASI


# ── Shared: konfirmasi & simpan ─────────────────────────────

async def callback_konfirmasi_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "gestun_konfirm_tidak":
        await query.edit_message_text("❌ Input gestun dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    tanggal = context.user_data.get("gestun_tanggal")
    nominal = context.user_data.get("gestun_nominal")
    persen  = context.user_data.get("gestun_persen")
    await query.edit_message_text("🔄 Menyimpan data gestun ke sheet...")

    try:
        result = tulis_gestun(tanggal, nominal, persen)
        if not result["ok"]:
            await query.edit_message_text(
                f"❌ *Gagal menyimpan gestun*\n\n{result.get('reason', 'Unknown error')}",
                parse_mode="Markdown",
            )
            return ConversationHandler.END

        persen_str = f"{persen}%" if persen is not None else "-"
        hasil_str  = f"Rp{int(nominal * persen / 100):,}" if persen is not None else "-"
        await query.edit_message_text(
            f"✅ *DATA GESTUN TERSIMPAN*\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"📅 Tanggal       : `{tanggal}`\n"
            f"💰 Nominal       : *Rp{nominal:,}*\n"
            f"📊 Keuntungan % : *{persen_str}*\n"
            f"✅ Hasil Bersih  : *{hasil_str}*\n"
            f"📊 Baris         : {result['baris']}\n"
            f"━━━━━━━━━━━━━━━━",
            parse_mode="Markdown",
        )
        logger.info(f"[GESTUN] {tanggal} | {nominal} | {persen} | Baris {result['baris']}")

    except Exception as e:
        logger.error(f"Error tulis gestun: {e}", exc_info=True)
        await query.edit_message_text("⚠️ Terjadi kesalahan saat menyimpan data gestun.")

    context.user_data.clear()
    return ConversationHandler.END


async def cancel_gestun(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await _hapus_pesan_user(update)
    await _edit(context, "gestun", "❌ Input gestun dibatalkan.")
    context.user_data.clear()
    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════
#  /modal_netflix
# ═══════════════════════════════════════════════════════════

def _parse_quick_modal(teks: str) -> dict:
    result = {"tanggal": None, "nominal": None, "keterangan": None}
    for line in teks.strip().split("\n"):
        line = line.strip()
        if ":" not in line:
            continue
        value = line.split(":", 1)[1].strip()
        lower = line.lower()
        if "tanggal" in lower:
            for fmt in ("%d/%m/%Y", "%d/%m/%y"):
                try:
                    result["tanggal"] = datetime.strptime(value, fmt).strftime("%d/%m/%Y")
                    break
                except ValueError:
                    continue
        elif "nominal" in lower:
            bersih = "".join(c for c in value if c.isdigit())
            if bersih:
                result["nominal"] = int(bersih)
        elif any(k in lower for k in ("total", "akun", "maker", "keterangan")):
            result["keterangan"] = value if value not in ("-", "") else ""
    if not result["tanggal"] or not result["nominal"]:
        return None
    result["keterangan"] = result["keterangan"] or ""
    return result


def _fmt_modal_konfirm(tanggal, nominal, keterangan) -> str:
    ket_str = keterangan if keterangan else "-"
    return (
        f"🏦 *KONFIRMASI MODAL NETFLIX*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📅 Tanggal          : `{tanggal}`\n"
        f"💰 Nominal          : *Rp{nominal:,}*\n"
        f"📝 Total Akun/Maker : *{ket_str}*\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"Simpan ke sheet REKAPAN MODAL?"
    )


async def cmd_modal_netflix(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("⛔ Hanya admin utama.")
        return ConversationHandler.END
    if update.effective_chat.type not in ("group", "supergroup"):
        await update.message.reply_text("⛔ Command ini hanya bisa digunakan di dalam group.")
        return ConversationHandler.END

    keyboard = [
        [InlineKeyboardButton("⚡ Quick (paste form)", callback_data="modal_mode_quick")],
        [InlineKeyboardButton("📝 Step-by-step", callback_data="modal_mode_step")],
        [InlineKeyboardButton("❌ Batal", callback_data="modal_batal")],
    ]
    msg = await update.message.reply_text(
        "🏦 *INPUT MODAL NETFLIX*\n\nPilih mode input:",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    context.user_data["modal_chat_id"] = msg.chat_id
    context.user_data["modal_msg_id"]  = msg.message_id
    return MODAL_PILIH_MODE


async def callback_modal_pilih_mode(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "modal_batal":
        await query.edit_message_text("❌ Input modal dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    if query.data == "modal_mode_quick":
        await query.edit_message_text(
            "🏦 *QUICK MODAL NETFLIX*\n\n"
            "Paste form berikut (isi nilainya):\n\n"
            "```\n"
            "𖥻 Tanggal (dd/mm/yy) : \n"
            "𖥻 Nominal : \n"
            "𖥻 Total Akun & Maker : \n"
            "```",
            parse_mode="Markdown",
        )
        return MODAL_QUICK

    elif query.data == "modal_mode_step":
        keyboard = [
            [InlineKeyboardButton(f"📅 Hari ini ({datetime.now().strftime('%d/%m/%Y')})", callback_data="modal_tgl_hari_ini")],
            [InlineKeyboardButton("✏️ Tanggal lain", callback_data="modal_tgl_custom")],
            [InlineKeyboardButton("❌ Batal", callback_data="modal_batal_step")],
        ]
        await query.edit_message_text(
            "🏦 *INPUT MODAL NETFLIX*\n\nPilih tanggal:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        return MODAL_TANYA_TANGGAL

    return MODAL_PILIH_MODE


# ── Quick mode ──────────────────────────────────────────────

async def terima_quick_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text
    await _hapus_pesan_user(update)

    data = _parse_quick_modal(teks)
    if data is None:
        await _edit(
            context, "modal",
            "🏦 *QUICK MODAL NETFLIX*\n\n"
            "❌ Format tidak valid. Pastikan tanggal dan nominal terisi.\n\n"
            "```\n"
            "𖥻 Tanggal (dd/mm/yy) : 05/06/26\n"
            "𖥻 Nominal : 1827000\n"
            "𖥻 Total Akun & Maker : 10 ACC EXTEND MEET\n"
            "```",
        )
        return MODAL_QUICK

    context.user_data["modal_tanggal"]    = data["tanggal"]
    context.user_data["modal_nominal"]    = data["nominal"]
    context.user_data["modal_keterangan"] = data["keterangan"]

    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="modal_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="modal_konfirm_tidak"),
        ]
    ]
    await _edit(context, "modal", _fmt_modal_konfirm(data["tanggal"], data["nominal"], data["keterangan"]), keyboard)
    return MODAL_KONFIRMASI


# ── Step-by-step mode ───────────────────────────────────────

async def callback_modal_pilih_tanggal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data in ("modal_batal", "modal_batal_step"):
        await query.edit_message_text("❌ Input modal dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    if query.data == "modal_tgl_hari_ini":
        tanggal = datetime.now().strftime("%d/%m/%Y")
        context.user_data["modal_tanggal"] = tanggal
        await query.edit_message_text(
            f"🏦 *INPUT MODAL NETFLIX*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"Ketik *nominal* modal (angka saja, contoh: `1827000`):",
            parse_mode="Markdown",
        )
        return MODAL_TANYA_NOMINAL

    elif query.data == "modal_tgl_custom":
        await query.edit_message_text(
            "🏦 *INPUT MODAL NETFLIX*\n\n"
            "Ketik tanggal format *DD/MM/YY*\n"
            "Contoh: `05/06/26`",
            parse_mode="Markdown",
        )
        return MODAL_TANYA_TANGGAL

    return MODAL_TANYA_TANGGAL


async def terima_tanggal_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)

    tanggal_fmt = None
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            tanggal_fmt = datetime.strptime(teks, fmt).strftime("%d/%m/%Y")
            break
        except ValueError:
            continue

    if tanggal_fmt is None:
        await _edit(
            context, "modal",
            "🏦 *INPUT MODAL NETFLIX*\n\n"
            "❌ Format tidak valid. Ketik *DD/MM/YY*, contoh: `05/06/26`",
        )
        return MODAL_TANYA_TANGGAL

    context.user_data["modal_tanggal"] = tanggal_fmt
    await _edit(
        context, "modal",
        f"🏦 *INPUT MODAL NETFLIX*\n\n"
        f"📅 Tanggal: `{tanggal_fmt}`\n\n"
        f"Ketik *nominal* modal (angka saja, contoh: `1827000`):",
    )
    return MODAL_TANYA_NOMINAL


async def terima_nominal_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    teks = update.message.text.strip()
    await _hapus_pesan_user(update)
    bersih = "".join(c for c in teks if c.isdigit())

    tanggal = context.user_data.get("modal_tanggal", "?")
    if not bersih or int(bersih) <= 0:
        await _edit(
            context, "modal",
            f"🏦 *INPUT MODAL NETFLIX*\n\n"
            f"📅 Tanggal: `{tanggal}`\n\n"
            f"❌ Nominal tidak valid. Ketik angka saja, contoh: `1827000`:",
        )
        return MODAL_TANYA_NOMINAL

    context.user_data["modal_nominal"] = int(bersih)
    keyboard = [
        [InlineKeyboardButton("⏭️ Lewati (kosongkan keterangan)", callback_data="modal_ket_skip")],
        [InlineKeyboardButton("❌ Batal", callback_data="modal_ket_batal")],
    ]
    await _edit(
        context, "modal",
        f"🏦 *INPUT MODAL NETFLIX*\n\n"
        f"📅 Tanggal : `{tanggal}`\n"
        f"💰 Nominal : *Rp{int(bersih):,}*\n\n"
        f"Ketik *Total Akun & Maker*, contoh: `10 ACC EXTEND MEET`\n"
        f"Atau tekan *Lewati* jika tidak ada:",
        keyboard,
    )
    return MODAL_TANYA_KET


async def callback_modal_ket(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "modal_ket_batal":
        await query.edit_message_text("❌ Input modal dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    context.user_data["modal_keterangan"] = ""
    tanggal = context.user_data.get("modal_tanggal", "?")
    nominal = context.user_data.get("modal_nominal", 0)
    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="modal_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="modal_konfirm_tidak"),
        ]
    ]
    await query.edit_message_text(
        _fmt_modal_konfirm(tanggal, nominal, ""),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return MODAL_KONFIRMASI


async def terima_ket_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    keterangan = update.message.text.strip()
    await _hapus_pesan_user(update)
    context.user_data["modal_keterangan"] = keterangan

    tanggal = context.user_data.get("modal_tanggal", "?")
    nominal = context.user_data.get("modal_nominal", 0)
    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, simpan", callback_data="modal_konfirm_ya"),
            InlineKeyboardButton("❌ Batal", callback_data="modal_konfirm_tidak"),
        ]
    ]
    await _edit(context, "modal", _fmt_modal_konfirm(tanggal, nominal, keterangan), keyboard)
    return MODAL_KONFIRMASI


# ── Shared: konfirmasi & simpan ─────────────────────────────

async def callback_konfirmasi_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    if query.data == "modal_konfirm_tidak":
        await query.edit_message_text("❌ Input modal dibatalkan.")
        context.user_data.clear()
        return ConversationHandler.END

    tanggal    = context.user_data.get("modal_tanggal")
    nominal    = context.user_data.get("modal_nominal")
    keterangan = context.user_data.get("modal_keterangan", "")
    await query.edit_message_text("🔄 Menyimpan data modal ke sheet...")

    try:
        result = tulis_modal_netflix(tanggal, nominal, keterangan)
        if not result["ok"]:
            await query.edit_message_text(
                f"❌ *Gagal menyimpan modal*\n\n{result.get('reason', 'Unknown error')}",
                parse_mode="Markdown",
            )
            return ConversationHandler.END

        ket_str = keterangan if keterangan else "-"
        await query.edit_message_text(
            f"✅ *MODAL NETFLIX TERSIMPAN*\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"📅 Tanggal          : `{tanggal}`\n"
            f"💰 Nominal          : *Rp{nominal:,}*\n"
            f"📝 Total Akun/Maker : *{ket_str}*\n"
            f"📊 Baris            : {result['baris']}\n"
            f"━━━━━━━━━━━━━━━━",
            parse_mode="Markdown",
        )
        logger.info(f"[MODAL] {tanggal} | {nominal} | {keterangan} | Baris {result['baris']}")

    except Exception as e:
        logger.error(f"Error tulis modal: {e}", exc_info=True)
        await query.edit_message_text("⚠️ Terjadi kesalahan saat menyimpan modal.")

    context.user_data.clear()
    return ConversationHandler.END


async def cancel_modal(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await _hapus_pesan_user(update)
    await _edit(context, "modal", "❌ Input modal dibatalkan.")
    context.user_data.clear()
    return ConversationHandler.END
