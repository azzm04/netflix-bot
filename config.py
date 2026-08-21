# ============================================================
#  config.py — Konfigurasi bot Netflix
# ============================================================

import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID"))

SPREADSHEET_MODAL_ID = os.getenv("SPREADSHEET_MODAL_ID")
SPREADSHEET_INVEST_ID = os.getenv("SPREADSHEET_INVEST_ID")

if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN belum di-set di .env!")

# Nama file credentials Google Service Account
CREDENTIALS_FILE = "credentials.json"
SPREADSHEET_NAME = "netflix account jaeminies"
INVEST_EMAIL_SHEET_MAP = {
    "humbinfoe@stayhome.li":          "rekapan_UMI_rose_2",
    "kittab982@tapi.re":          "rekapan_UMI_rose_2",
    
    "us3101tp7@ramaco.tech": "rekapan_ena_std_plan",
    "us3001appletp4@ramaco.tech": "rekapan_ena_std_plan",
    "splashwater_albercas.mx@mrthala.com": "rekapan_ena_std_plan",
    "michel5@ramaco.tech": "rekapan_ena_std_plan",
    "tjbzqu@mahesh.co": "rekapan_ena_std_plan",

    "chapman.brooke.11@gmail.com" : "rekapan_ena_rose_21",
    "wagmug733@fuwari.be" : "rekapan_ena_rose_21",
    "lagion777@fanclub.pm" : "rekapan_ena_rose_21",
    "ivot.u.nask.a@gmail.com" : "rekapan_ena_rose_21",
}
# SHEET_MODAL dibuat dinamis per bulan di sheets_handler: "modal netflix_Juni", dst.
SHEET_GESTUN = "rekapan"   # Sheet PENDAPATAN GESTUN di spreadsheet REKAPAN MODAL

# Kolom tabel MODAL NETFLIX (tabel kanan di sheet "modal netflix")
# H=8, I=9, J=10, K=11 (1-indexed untuk gspread)
COL_MODAL_TGL      = 8   # H - Tanggal
COL_MODAL_KOMPONEN = 9   # I - Komponen (selalu "modal")
COL_MODAL_BIAYA    = 10  # J - Biaya/Nominal
COL_MODAL_KET      = 11  # K - Keterangan (Total Akun & Maker)

# Pajak merchant (0.7%)
PAJAK_MERCHANT = 0.007

# ---- Nama sheet berdasarkan durasi ----
SHEET_HARIAN_1  = "HARIAN_DURASI-1"     # Untuk durasi 1 hari
SHEET_HARIAN_23 = "HARIAN_DURASI-2&3"   # Untuk durasi 2, 3 hari
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
_notif_ids_raw = os.getenv("NOTIF_ORDER_IDS", "")
NOTIF_ORDER_IDS = [int(x.strip()) for x in _notif_ids_raw.split(",") if x.strip()]

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
