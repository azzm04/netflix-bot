# ============================================================
#  sheets_handler.py — Logika baca/tulis Google Sheets (Optimized)
# ============================================================

import random
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime, timedelta
from config import (
    CREDENTIALS_FILE, SPREADSHEET_NAME,
    SHEET_HARIAN, SHEET_MINGGUAN,
    COL_EMAIL, COL_PASSWORD, COL_PROFILE, COL_PIN,
    COL_LOGOUT, COL_PHONE, DATA_START_ROW, JAM_LOGOUT,
    HARGA
)

# Scope yang dibutuhkan untuk akses Google Sheets
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

BULAN_ID = {
    1: "Januari", 2: "Februari", 3: "Maret",
    4: "April",   5: "Mei",      6: "Juni",
    7: "Juli",    8: "Agustus",  9: "September",
    10: "Oktober", 11: "November", 12: "Desember"
}

BULAN_EN = {
    1: "January", 2: "February", 3: "March",
    4: "April", 5: "May", 6: "June",
    7: "July", 8: "August", 9: "September",
    10: "October", 11: "November", 12: "December"
}

BULAN_REKAP = {
    1: "JANUARI", 2: "FEBRUARI", 3: "MARET",
    4: "APRIL", 5: "MEI", 6: "JUNI",
    7: "JULI", 8: "AGUSTUS", 9: "SEPTEMBER",
    10: "OKTOBER", 11: "NOVEMBER", 12: "DESEMBER"
}


# ─── Cache koneksi agar tidak buat ulang tiap request ──────

_client_cache = None


def get_client():
    """Buat koneksi ke Google Sheets (dengan simple cache)."""
    global _client_cache
    try:
        if _client_cache is not None:
            # Test apakah masih valid
            _client_cache.list_spreadsheet_files(title=SPREADSHEET_NAME)
            return _client_cache
    except Exception:
        pass

    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    _client_cache = gspread.authorize(creds)
    return _client_cache


def get_spreadsheet():
    """Buka spreadsheet sekali, reuse untuk semua operasi."""
    client = get_client()
    return client.open(SPREADSHEET_NAME)


# ─── Helper ────────────────────────────────────────────────

def pilih_sheet(durasi: int):
    """Pilih sheet: 1/2/3 → HARIAN, 7 → MINGGUAN."""
    if durasi in [1, 2, 3]:
        return SHEET_HARIAN
    elif durasi == 7:
        return SHEET_MINGGUAN
    return SHEET_HARIAN


def is_baris_data(baris):
    """Baris valid = kolom A ada '@' (email), bukan header."""
    if len(baris) <= COL_EMAIL:
        return False
    return "@" in baris[COL_EMAIL].strip()


# ─── Cari slot kosong (RANDOM) ─────────────────────────────

def cari_slot_kosong(durasi: int, device: str = ""):
    """
    Kumpulkan SEMUA slot kosong, lalu pilih RANDOM.
    - Slot kosong = baris data valid + kolom E kosong
    - Device TV = skip akun "PAKE KODE"
    """
    spreadsheet = get_spreadsheet()
    nama_sheet = pilih_sheet(durasi)
    sheet = spreadsheet.worksheet(nama_sheet)
    semua_data = sheet.get_all_values()

    slot_tersedia = []

    for i, baris in enumerate(semua_data):
        nomor_baris = i + 1
        if nomor_baris < DATA_START_ROW:
            continue

        if not is_baris_data(baris):
            continue

        email = baris[COL_EMAIL].strip()
        password = baris[COL_PASSWORD].strip() if len(baris) > COL_PASSWORD else ""
        profil = baris[COL_PROFILE].strip() if len(baris) > COL_PROFILE else ""
        pin = baris[COL_PIN].strip() if len(baris) > COL_PIN else ""
        logout = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""

        # Kolom E kosong = slot tersedia
        if logout != "":
            continue

        # Device TV: skip akun "PAKE KODE"
        if device == "TV" and password.upper() == "PAKE KODE":
            continue

        slot_tersedia.append({
            "nomor_baris": nomor_baris,
            "email": email,
            "password": password,
            "profil": profil,
            "pin": pin,
            "nama_sheet": nama_sheet,
        })

    if not slot_tersedia:
        return None

    # Pilih random dari semua slot yang tersedia
    return random.choice(slot_tersedia)


# ─── Hitung tanggal logout ─────────────────────────────────

def hitung_tanggal_logout(durasi_hari: int) -> str:
    """Hitung tanggal logout: sekarang + durasi, jam 19:00."""
    tgl_logout = datetime.now() + timedelta(days=durasi_hari)
    bulan = BULAN_ID[tgl_logout.month]
    return f"{tgl_logout.day} {bulan} {JAM_LOGOUT}"


# ─── Tulis ke sheet (batch = lebih cepat) ──────────────────

def tulis_logout_ke_sheet(nama_sheet: str, nomor_baris: int, tanggal_logout: str, nomor_pelanggan: str):
    """Tulis logout (E) dan nomor pelanggan (F) dalam 1 batch update."""
    spreadsheet = get_spreadsheet()
    sheet = spreadsheet.worksheet(nama_sheet)

    # Batch update: tulis 2 cell sekaligus (1 API call)
    col_e = gspread.utils.rowcol_to_a1(nomor_baris, COL_LOGOUT + 1)
    col_f = gspread.utils.rowcol_to_a1(nomor_baris, COL_PHONE + 1)
    sheet.batch_update([
        {"range": col_e, "values": [[tanggal_logout]]},
        {"range": col_f, "values": [[nomor_pelanggan]]},
    ])


def tulis_rekapan(nomor_pelanggan: str, durasi: int, email_akun: str):
    """Tulis rekapan di baris setelah data terakhir (batch update)."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    # Format data
    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    durasi_text = f"{durasi} hari"
    harga = HARGA.get(durasi, "Rp0")

    # Cari baris terakhir yang kolom A terisi
    kolom_a = sheet_rekap.col_values(1)
    baris_target = len(kolom_a) + 1

    for i in range(len(kolom_a) - 1, -1, -1):
        if kolom_a[i].strip() != "":
            baris_target = i + 2
            break

    # Batch update: tulis 5 cell sekaligus (1 API call)
    row = baris_target
    sheet_rekap.batch_update([
        {"range": gspread.utils.rowcol_to_a1(row, 1), "values": [[nomor_pelanggan]]},
        {"range": gspread.utils.rowcol_to_a1(row, 2), "values": [[tanggal]]},
        {"range": gspread.utils.rowcol_to_a1(row, 3), "values": [[durasi_text]]},
        {"range": gspread.utils.rowcol_to_a1(row, 4), "values": [[harga]]},
        {"range": gspread.utils.rowcol_to_a1(row, 5), "values": [[email_akun]]},
    ])


# ─── Template formatting ───────────────────────────────────

def format_template(data: dict, tanggal_logout: str, nomor_pelanggan: str, durasi: int, device: str) -> str:
    """
    Template dengan Markdown formatting.
    1. Device TV → template-harian-tv
    2. Kolom B = "PAKE KODE" → template menggunakan kode
    3. Selain itu → template normal
    """
    password = data.get("password", "")
    is_pake_kode = password.upper() == "PAKE KODE"

    if device == "TV":
        pesan = (
            f"‼️*WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN*‼️\n"
            f"\n"
            f"🍿NETFLIX 1 PROFILE 1 USER🍿\n"
            f"💌 Email : `{data['email']}`\n"
            f"🔖 Profil : `{data['profil']}`\n"
            f"🔒 Pin Profil : `{data['pin']}`\n"
            f"⏰ Logout : `{tanggal_logout}`\n"
            f" `WAJIB LOGOUT TEPAT WAKTU!`\n"
            f"\n"
            f"⚠️ PENTING - WAJIB BACA!\n"
            f"MEMBELI = SETUJU PATUHI SNK\n"
            f"📌 SNK :\n"
            f"𖥻 Login 1 device SAJA\n"
            f"𖥻 NO VPN\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 TIDAK BISA PINDAH DEVICE\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"𖥻 *WAJIB LOGOUT MANDIRI JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!!!*\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"CARA LOGOUT NETFLIX DI TV\n"
            f"1. Klik bagian \"Profile\" di kiri atas\n"
            f"2. Klik \"Dapatkan Bantuan\" / \"Get Help\"\n"
            f"3. Klik \"Keluar\"\n"
            f"*ATAU*\n"
            f"๑ buka aplikasi netflix di TV\n"
            f"๑ pencet tombol berikut di remote TV :\n"
            f"⬆️⬆️ - ⬇️⬇️ - ⬅️➡️ - \n"
            f"⬅️➡️ - ⬆️⬆️ - ⬆️⬆️ \n"
            f"๑ scroll pilihan sampai bertemu opsi sign out / keluar\n"
            f"\n"
            f"𝙏𝙝𝙖𝙣𝙠𝙨 & 𝙝𝙖𝙥𝙥𝙮 𝙬𝙖𝙩𝙘𝙝𝙞𝙣𝙜 💖"
        )

    elif is_pake_kode:
        pesan = (
            f"‼️WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN‼️\n"
            f"\n"
            f"🍿 *DATA AKUN NETPLIKS 1P1U* 🍿\n"
            f"💌 ⦂ `{data['email']}`\n"
            f"🗝️ ⦂ (GUNAKAN KODE MASUK - TIDAK ADA PW)\n"
            f"🔖 ⦂ `{data['profil']}`\n"
            f"🔒 ⦂ `{data['pin']}`\n"
            f"⏰ Logout ⦂ `{tanggal_logout}`\n"
            f" `WAJIB LOGOUT TEPAT WAKTU!`\n"
            f"\n"
            f"ⓘ syarat dan ketentuan ⦂\n"
            f"𖥻 *LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA*\n"
            f"𖥻 Login 1 device SAJA (terpantau)\n"
            f"𖥻 NO VPN\n"
            f"𖥻 *LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA! INGAT TUHAN GA PERNAH TIDUR 👀!*\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 *TIDAK BISA PINDAH DEVICE!*\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Lebih dari 1 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Aku sangat respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )

    else:
        pesan = (
            f"‼️WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN‼️\n"
            f"\n"
            f"🍿 *DATA AKUN NETPLIKS 1P1U* 🍿\n"
            f"💌 ⦂ `{data['email']}`\n"
            f"🗝️ ⦂ `{data['password']}`\n"
            f"🔖 ⦂ `{data['profil']}`\n"
            f"🔒 ⦂ `{data['pin']}`\n"
            f"⏰ Logout ⦂ `{tanggal_logout}`\n"
            f" `WAJIB LOGOUT TEPAT WAKTU!`\n"
            f"\n"
            f"ⓘ syarat dan ketentuan ⦂\n"
            f"𖥻 *LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA*\n"
            f"𖥻 Login 1 device SAJA (terpantau)\n"
            f"𖥻 NO VPN\n"
            f"𖥻 *LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA! INGAT TUHAN GA PERNAH TIDUR 👀!*\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 *TIDAK BISA PINDAH DEVICE!*\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Lebih dari 1 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Aku sangat respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )

    return pesan


def format_template_plain(data: dict, tanggal_logout: str, nomor_pelanggan: str, durasi: int, device: str) -> str:
    """Versi plain text (tanpa markdown) untuk di-copy user."""
    password = data.get("password", "")
    is_pake_kode = password.upper() == "PAKE KODE"

    if device == "TV":
        pesan = (
            f"‼️WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN‼️\n"
            f"\n"
            f"🍿NETFLIX 1 PROFILE 1 USER🍿\n"
            f"💌 Email : {data['email']}\n"
            f"🔖 Profil : {data['profil']}\n"
            f"🔒 Pin Profil : {data['pin']}\n"
            f"⏰ Logout : {tanggal_logout}\n"
            f" WAJIB LOGOUT TEPAT WAKTU!\n"
            f"\n"
            f"⚠️ PENTING - WAJIB BACA!\n"
            f"MEMBELI = SETUJU PATUHI SNK\n"
            f"📌 SNK :\n"
            f"𖥻 Login 1 device SAJA\n"
            f"𖥻 NO VPN\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 TIDAK BISA PINDAH DEVICE\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"𖥻 WAJIB LOGOUT MANDIRI JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!!!\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"CARA LOGOUT NETFLIX DI TV\n"
            f"1. Klik bagian \"Profile\" di kiri atas\n"
            f"2. Klik \"Dapatkan Bantuan\" / \"Get Help\"\n"
            f"3. Klik \"Keluar\"\n"
            f"ATAU\n"
            f"๑ buka aplikasi netflix di TV\n"
            f"๑ pencet tombol berikut di remote TV :\n"
            f"⬆️⬆️ - ⬇️⬇️ - ⬅️➡️ - \n"
            f"⬅️➡️ - ⬆️⬆️ - ⬆️⬆️ \n"
            f"๑ scroll pilihan sampai bertemu opsi sign out / keluar\n"
            f"\n"
            f"𝙏𝙝𝙖𝙣𝙠𝙨 & 𝙝𝙖𝙥𝙥𝙮 𝙬𝙖𝙩𝙘𝙝𝙞𝙣𝙜 💖"
        )

    elif is_pake_kode:
        pesan = (
            f"‼️WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN‼️\n"
            f"\n"
            f"🍿 DATA AKUN NETPLIKS 1P1U 🍿\n"
            f"💌 ⦂ {data['email']}\n"
            f"🗝️ ⦂ (GUNAKAN KODE MASUK - TIDAK ADA PW)\n"
            f"🔖 ⦂ {data['profil']}\n"
            f"🔒 ⦂ {data['pin']}\n"
            f"⏰ Logout ⦂ {tanggal_logout}\n"
            f" WAJIB LOGOUT TEPAT WAKTU!\n"
            f"\n"
            f"ⓘ syarat dan ketentuan ⦂\n"
            f"𖥻 LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA\n"
            f"𖥻 Login 1 device SAJA (terpantau)\n"
            f"𖥻 NO VPN\n"
            f"𖥻 LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA! INGAT TUHAN GA PERNAH TIDUR 👀!\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 TIDAK BISA PINDAH DEVICE!\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Lebih dari 1 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Aku sangat respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )

    else:
        pesan = (
            f"‼️WAJIB KIRIM SS LOGIN MAKS 1x24 JAM! NO SS = NO GARANSI = NO KOMPLAIN‼️\n"
            f"\n"
            f"🍿 DATA AKUN NETPLIKS 1P1U 🍿\n"
            f"💌 ⦂ {data['email']}\n"
            f"🗝️ ⦂ {data['password']}\n"
            f"🔖 ⦂ {data['profil']}\n"
            f"🔒 ⦂ {data['pin']}\n"
            f"⏰ Logout ⦂ {tanggal_logout}\n"
            f" WAJIB LOGOUT TEPAT WAKTU!\n"
            f"\n"
            f"ⓘ syarat dan ketentuan ⦂\n"
            f"𖥻 LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA\n"
            f"𖥻 Login 1 device SAJA (terpantau)\n"
            f"𖥻 NO VPN\n"
            f"𖥻 LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA! INGAT TUHAN GA PERNAH TIDUR 👀!\n"
            f"𖥻 1 bulan = 28 hari\n"
            f"𖥻 Dilarang login-logout berulang\n"
            f"𖥻 TIDAK BISA PINDAH DEVICE!\n"
            f"𖥻 DILARANG UBAH APAPUN!!!\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Lebih dari 1 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Aku sangat respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )

    return pesan
