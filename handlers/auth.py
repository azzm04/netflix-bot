# ============================================================
#  handlers/auth.py — User management & whitelist handlers
# ============================================================

import os
import json
import logging
from telegram import Update
from telegram.ext import ContextTypes
from config import ADMIN_ID, USERS_FILE

logger = logging.getLogger(__name__)

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
