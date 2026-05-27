# ============================================================
#  config.py — Konfigurasi bot Netflix
# ============================================================

# Token dari @BotFather Telegram
BOT_TOKEN = "8976693990:AAF4tkZE5p2W-tRqd3bgyfPCN02X7tBKdc8"

# Nama file credentials Google Service Account
CREDENTIALS_FILE = "credentials.json"

# Nama spreadsheet Google Sheets (harus sama persis)
SPREADSHEET_NAME = "netflix account jaeminies's"

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
JAM_LOGOUT = "19:00"

# ---- Admin Chat ID (untuk notifikasi order) ----
ADMIN_CHAT_ID = 5728717900

# ---- User yang boleh pakai bot (whitelist) ----
# Admin utama yang tidak bisa dihapus
ADMIN_ID = 5728717900

# File untuk simpan daftar user yang diizinkan
USERS_FILE = "allowed_users.json"

# ---- Harga berdasarkan durasi (Harian/Mingguan) ----
HARGA = {
    1: "Rp5,000",
    2: "Rp7,000",
    3: "Rp10,000",
    7: "Rp17,000",
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
