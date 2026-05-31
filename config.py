# ============================================================
#  config.py — Konfigurasi bot Netflix
# ============================================================

import os

# Token dari @BotFather Telegram
BOT_TOKEN = os.getenv("BOT_TOKEN", "8976693990:AAF4tkZE5p2W-tRqd3bgyfPCN02X7tBKdc8")

# Nama file credentials Google Service Account
CREDENTIALS_FILE = "credentials.json"

# Nama spreadsheet Google Sheets (harus sama persis)
SPREADSHEET_NAME = "netflix account jaeminies's"

# Spreadsheet REKAPAN MODAL (untuk /closing)
SPREADSHEET_MODAL_ID = "1-o6jOoE3rH2SOlH9975HODC7MpzDBg8zD8Z1RLnRK7g"
SHEET_MODAL = "modal netflix"

# Pajak merchant (0.7%)
PAJAK_MERCHANT = 0.007

# ---- Nama sheet berdasarkan durasi ----
SHEET_HARIAN = "HARIAN"       # Untuk durasi 1, 2, 3 hari
SHEET_MINGGUAN = "MINGGUAN"   # Untuk durasi 7 hari
SHEET_BULANAN = "BULANAN"     # Untuk durasi 1 bulan, 2 bulan

# ---- Mapping kolom (0 = kolom A, 1 = B, dst) ----
COL_EMAIL      = 0   # A - email akun Netflix
COL_PASSWORD   = 1   # B - password
COL_PROFILE    = 2   # C - nama profil
COL_PIN        = 3   # D - PIN / kode
COL_LOGOUT     = 4   # E - tanggal logout (kosong = slot tersedia, hijau)
COL_PHONE      = 5   # F - nomor telepon pelanggan

# Baris awal data (lewati header)
DATA_START_ROW = 2

# Jam logout default
JAM_LOGOUT = "10:00"

# ---- ID yang menerima notifikasi setiap order berhasil ----
NOTIF_ORDER_IDS = [-1005278264601]

# ---- User yang boleh pakai bot (whitelist) ----
# Admin utama yang tidak bisa dihapus
ADMIN_ID = 5728717900

# File untuk simpan daftar user yang diizinkan
USERS_FILE = "allowed_users.json"

# ---- Harga berdasarkan durasi (Harian/Mingguan) ----
HARGA = {
    1: "Rp6,000",
    2: "Rp8,000",
    3: "Rp12,000",
    7: "Rp20,000",
    14: "Rp30,000",
}

# ---- Harga Bulanan ----
HARGA_BULANAN = {
    "1_1p1u": "Rp50,000",
    "1_sempriv": "Rp60,000",
    "2_1p1u": "Rp80,000",
    "2_sempriv": "Rp95,000",
}

# ---- Durasi bulanan dalam hari ----
DURASI_BULANAN_HARI = {
    1: 27,   # 1 bulan = 27 hari
    2: 54,   # 2 bulan = 54 hari
}
