# ============================================================
#  sheets_handler.py — Logika baca/tulis Google Sheets (Optimized)
# ============================================================

import random
import asyncio
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime, timedelta
from config import (
    CREDENTIALS_FILE, SPREADSHEET_NAME,
    SHEET_HARIAN, SHEET_MINGGUAN, SHEET_BULANAN,
    COL_EMAIL, COL_PASSWORD, COL_PROFILE, COL_PIN,
    COL_LOGOUT, COL_PHONE, DATA_START_ROW, JAM_LOGOUT,
    HARGA, HARGA_BULANAN, DURASI_BULANAN_HARI,
    SPREADSHEET_MODAL_ID, SHEET_GESTUN, PAJAK_MERCHANT,
    COL_MODAL_TGL, COL_MODAL_KOMPONEN, COL_MODAL_BIAYA, COL_MODAL_KET,
    SPREADSHEET_INVEST_ID, INVEST_EMAIL_SHEET_MAP,
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

# Nama bulan untuk sheet modal netflix (kapital awal)
BULAN_MODAL = {
    1: "Januari", 2: "Februari", 3: "Maret",
    4: "April", 5: "Mei", 6: "Juni",
    7: "Juli", 8: "Agustus", 9: "September",
    10: "Oktober", 11: "November", 12: "Desember"
}


def get_sheet_modal_name(dt: datetime = None) -> str:
    """
    Return nama sheet modal netflix berdasarkan bulan.
    Format: "omset netflix_Juni", "omset netflix_Juli", dst.
    Jika dt tidak diisi, pakai waktu sekarang.
    """
    if dt is None:
        dt = datetime.now()
    return f"omset netflix_{BULAN_MODAL[dt.month]}"


# ─── Cache koneksi & lock untuk async safety ──────────────

_client_cache = None
_spreadsheet_cache = None
# Lock global async: hanya 1 order yang boleh akses sheet bersamaan
# Mencegah 2 order ambil slot yang sama (race condition)
_order_lock = asyncio.Lock()


def get_client():
    """Buat koneksi ke Google Sheets (dengan cache)."""
    global _client_cache
    if _client_cache is None:
        creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
        _client_cache = gspread.authorize(creds)
    return _client_cache


def get_spreadsheet():
    """Buka spreadsheet sekali, reuse untuk semua operasi."""
    global _spreadsheet_cache
    if _spreadsheet_cache is None:
        client = get_client()
        _spreadsheet_cache = client.open(SPREADSHEET_NAME)
    return _spreadsheet_cache


def reset_cache():
    """Reset cache jika koneksi error."""
    global _client_cache, _spreadsheet_cache
    _client_cache = None
    _spreadsheet_cache = None


def cari_worksheet_bulanan(spreadsheet):
    """Cari worksheet yang namanya mengandung 'BULANAN'."""
    for ws in spreadsheet.worksheets():
        if "BULANAN" in ws.title.upper():
            return ws
    return spreadsheet.worksheet(SHEET_BULANAN)


def cek_stok():
    """
    Hitung jumlah slot kosong di tiap sheet (HARIAN, MINGGUAN, BULANAN).
    Return: dict {nama_sheet: jumlah_slot_kosong}
    """
    spreadsheet = get_spreadsheet()
    hasil = {}

    for nama_sheet in [SHEET_HARIAN, SHEET_MINGGUAN]:
        try:
            sheet = spreadsheet.worksheet(nama_sheet)
            hasil[nama_sheet] = _hitung_slot_kosong(sheet.get_all_values())
        except Exception:
            hasil[nama_sheet] = "?"

    try:
        sheet_bulanan = cari_worksheet_bulanan(spreadsheet)
        hasil["BULANAN"] = _hitung_slot_kosong(sheet_bulanan.get_all_values())
    except Exception:
        hasil["BULANAN"] = "?"

    return hasil


def _hitung_slot_kosong(semua_data):
    """Helper: hitung jumlah slot kosong dari data sheet."""
    kosong = 0
    for i, baris in enumerate(semua_data):
        if (i + 1) < DATA_START_ROW:
            continue
        if not is_baris_data(baris):
            continue
        logout = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""
        if logout == "":
            kosong += 1
    return kosong


# ─── Mapping bulan Indonesia → angka (untuk parse tanggal) ─

BULAN_ID_REVERSE = {v.lower(): k for k, v in BULAN_ID.items()}
# Tambah alias singkat
BULAN_ID_REVERSE["mei"] = 5


def _parse_tanggal_logout(teks: str):
    """
    Parse teks logout ke datetime.
    Format yang didukung:
    - "28 Mei 12:30"
    - "27 Mei 21.40" (pakai titik)
    - "30 Mei 22:10"
    - "23 Juni ( Sempriv )" → jam default 19:00
    Return: datetime atau None jika gagal parse.
    """
    teks = teks.strip()
    if not teks or teks.upper() == "EXPIRED":
        return None

    try:
        parts = teks.split()
        if len(parts) < 2:
            return None

        hari = int(parts[0])
        bulan_str = parts[1].lower().rstrip(",")
        bulan = BULAN_ID_REVERSE.get(bulan_str)
        if bulan is None:
            return None

        # Cari jam — support ":" dan "."
        jam = 19
        menit = 0
        found_time = False
        for part in parts[2:]:
            if ":" in part:
                time_parts = part.split(":")
                jam = int(time_parts[0])
                menit = int(time_parts[1]) if len(time_parts) > 1 else 0
                found_time = True
                break
            elif "." in part:
                # Cek apakah ini format jam (misal "21.40")
                time_parts = part.split(".")
                if time_parts[0].isdigit() and time_parts[1].isdigit():
                    j = int(time_parts[0])
                    m = int(time_parts[1])
                    if 0 <= j <= 23 and 0 <= m <= 59:
                        jam = j
                        menit = m
                        found_time = True
                        break

        # Tentukan tahun
        now = datetime.now()
        tahun = now.year

        return datetime(tahun, bulan, hari, jam, menit)
    except (ValueError, IndexError):
        return None


def cek_logout():
    """
    Scan semua sheet (HARIAN, MINGGUAN, BULANAN).
    Cari akun yang waktu logout-nya sudah lewat dari sekarang.
    Return: list of dict {sheet, baris, email, profil, logout_text, pelanggan}
    """
    spreadsheet = get_spreadsheet()
    now = datetime.now()
    expired_list = []

    sheets_to_check = []

    # HARIAN & MINGGUAN
    for nama_sheet in [SHEET_HARIAN, SHEET_MINGGUAN]:
        try:
            sheets_to_check.append((nama_sheet, spreadsheet.worksheet(nama_sheet)))
        except Exception:
            pass

    # BULANAN
    try:
        sheet_bulanan = cari_worksheet_bulanan(spreadsheet)
        sheets_to_check.append(("BULANAN", sheet_bulanan))
    except Exception:
        pass

    # CRACK sheets
    for nama_sheet in ["CRACK_1-160_PREMIUM", "CRACK_161-320_PREMIUM", "CRACK_1-250"]:
        try:
            sheets_to_check.append((nama_sheet, spreadsheet.worksheet(nama_sheet)))
        except Exception:
            pass

    CRACK_SHEETS = ["CRACK_1-160_PREMIUM", "CRACK_161-320_PREMIUM", "CRACK_1-250"]

    for nama_sheet, sheet in sheets_to_check:
        semua_data = sheet.get_all_values()
        is_crack = nama_sheet in CRACK_SHEETS

        for i, baris in enumerate(semua_data):
            nomor_baris = i + 1
            if nomor_baris < DATA_START_ROW:
                continue

            # Untuk CRACK: cek @ di kolom A atau B (struktur berbeda)
            # Untuk sheet lain: cek @ di kolom A saja
            if is_crack:
                has_email = (
                    (len(baris) > 0 and "@" in baris[0]) or
                    (len(baris) > 1 and "@" in baris[1])
                )
                if not has_email:
                    continue
            else:
                if not is_baris_data(baris):
                    continue

            logout_text = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""

            # Skip kosong, MATI, atau EXPIRED
            if not logout_text or logout_text.upper() in ("EXPIRED", "MATI"):
                continue

            # Parse tanggal logout
            tgl_logout = _parse_tanggal_logout(logout_text)
            if tgl_logout is None:
                continue

            # Cek apakah sudah lewat
            if tgl_logout <= now:
                # Untuk CRACK: email bisa di kolom A atau B, profil di kolom D
                if is_crack:
                    email = baris[1].strip() if len(baris) > 1 and "@" in baris[1] else baris[0].strip()
                    profil = baris[3].strip() if len(baris) > 3 else ""  # Kolom D = profil di CRACK
                else:
                    email = baris[COL_EMAIL].strip()
                    profil = baris[COL_PROFILE].strip() if len(baris) > COL_PROFILE else ""
                pelanggan = baris[COL_PHONE].strip() if len(baris) > COL_PHONE else ""

                expired_list.append({
                    "sheet": nama_sheet,
                    "baris": nomor_baris,
                    "email": email,
                    "profil": profil,
                    "logout_text": logout_text,
                    "pelanggan": pelanggan,
                })

    return expired_list


# ─── Ganti Hari ────────────────────────────────────────────

def _cek_masih_ada_hari_ini(sheet, tanggal_str: str, is_crack: bool = False):
    """
    Cek apakah masih ada akun dengan tanggal hari ini di kolom E yang belum expired.
    tanggal_str: misal "5 Juni" atau "27 Mei"
    is_crack: True jika sheet CRACK (email di kolom B, bukan A)
    Return: list of dict akun yang masih aktif hari ini.
    """
    semua_data = sheet.get_all_values()
    masih_aktif = []

    parts_target = tanggal_str.strip().split()
    if len(parts_target) < 2:
        return masih_aktif
    hari_target  = parts_target[0]
    bulan_target = parts_target[1].lower()

    for i, baris in enumerate(semua_data):
        nomor_baris = i + 1
        if nomor_baris < DATA_START_ROW:
            continue

        # Validasi baris: CRACK cek @ di kolom A atau B, lainnya kolom A saja
        if is_crack:
            has_email = (
                (len(baris) > 0 and "@" in baris[0]) or
                (len(baris) > 1 and "@" in baris[1])
            )
            if not has_email:
                continue
        else:
            if not is_baris_data(baris):
                continue

        logout_text = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""
        if not logout_text or logout_text.upper() == "EXPIRED":
            continue

        # Exact match: split logout_text, cek hari == hari_target DAN bulan == bulan_target
        # "5 Juni 10:00" → parts[0]="5", parts[1]="Juni"
        # "15 Juni 10:00" → parts[0]="15" → TIDAK cocok dengan hari_target="5"
        parts_logout = logout_text.split()
        if len(parts_logout) >= 2:
            if parts_logout[0] == hari_target and parts_logout[1].lower() == bulan_target:
                # Cek apakah jam-nya sudah lewat
                tgl_logout = _parse_tanggal_logout(logout_text)
                if tgl_logout and tgl_logout > datetime.now():
                    email = baris[COL_EMAIL].strip()
                    profil = baris[COL_PROFILE].strip() if len(baris) > COL_PROFILE else ""
                    pelanggan = baris[COL_PHONE].strip() if len(baris) > COL_PHONE else ""
                    masih_aktif.append({
                        "baris": nomor_baris,
                        "email": email,
                        "profil": profil,
                        "logout_text": logout_text,
                        "pelanggan": pelanggan,
                    })

    return masih_aktif


def _ubah_warna_biru_besok(sheet, tanggal_besok_str: str, is_crack: bool = False):
    """
    Cari semua cell di kolom E yang mengandung tanggal besok,
    lalu ubah format: font Netflix Sans, size 12, bold, warna biru.
    Pakai batch format (1 API call) untuk hindari rate limit.
    is_crack: True jika sheet CRACK (email di kolom A atau B)
    """
    semua_data = sheet.get_all_values()
    ranges_to_format = []

    parts = tanggal_besok_str.split()
    if len(parts) < 2:
        return 0
    hari_besok = parts[0]
    bulan_besok = parts[1]

    for i, baris in enumerate(semua_data):
        nomor_baris = i + 1
        if nomor_baris < DATA_START_ROW:
            continue

        # Validasi baris sesuai tipe sheet
        if is_crack:
            has_email = (
                (len(baris) > 0 and "@" in baris[0]) or
                (len(baris) > 1 and "@" in baris[1])
            )
            if not has_email:
                continue
        else:
            if not is_baris_data(baris):
                continue

        logout_text = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""
        if not logout_text or logout_text.upper() == "EXPIRED":
            continue

        # Strict match: split teks logout, cek hari dan bulan exact
        logout_parts = logout_text.split()
        if len(logout_parts) >= 2:
            if logout_parts[0] == hari_besok and logout_parts[1].lower() == bulan_besok.lower():
                cell_ref = gspread.utils.rowcol_to_a1(nomor_baris, COL_LOGOUT + 1)
                ranges_to_format.append(cell_ref)

    # Batch format: semua cell dalam 1 API call
    if ranges_to_format:
        format_config = {
            "textFormat": {
                "fontFamily": "Netflix Sans",
                "fontSize": 11,
                "bold": True,
                "foregroundColorStyle": {
                    "rgbColor": {"red": 0, "green": 0, "blue": 1}
                }
            }
        }
        # Gabung semua range jadi 1 batch call
        batch_formats = [{"range": r, "format": format_config} for r in ranges_to_format]
        sheet.batch_format(batch_formats)

    return len(ranges_to_format)


def gantihari():
    """
    Proses ganti hari:
    1. Cek apakah masih ada akun hari ini yang belum lewat jam-nya
    2. Jika masih ada → return daftar akun yang belum logout
    3. Jika sudah semua → ubah warna font biru untuk tanggal besok

    Return: (status, data)
    - ("belum_selesai", list_akun_masih_aktif) → masih ada yang belum logout
    - ("berhasil", jumlah_cell_diubah) → sudah semua, warna diubah
    """
    spreadsheet = get_spreadsheet()
    now = datetime.now()

    # Format tanggal hari ini dan besok
    tanggal_hari_ini = f"{now.day} {BULAN_ID[now.month]}"
    besok = now + timedelta(days=1)
    tanggal_besok = f"{besok.day} {BULAN_ID[besok.month]}"

    # Kumpulkan semua sheet
    sheets_to_check = []
    for nama_sheet in [SHEET_HARIAN, SHEET_MINGGUAN]:
        try:
            sheets_to_check.append((nama_sheet, spreadsheet.worksheet(nama_sheet)))
        except Exception:
            pass
    try:
        sheet_bulanan = cari_worksheet_bulanan(spreadsheet)
        sheets_to_check.append(("BULANAN", sheet_bulanan))
    except Exception:
        pass
    # CRACK sheets — ikut dicek dan diubah warna
    for nama_sheet in ["CRACK_1-160_PREMIUM", "CRACK_161-320_PREMIUM", "CRACK_1-250"]:
        try:
            sheets_to_check.append((nama_sheet, spreadsheet.worksheet(nama_sheet)))
        except Exception:
            pass

    CRACK_SHEETS = {"CRACK_1-160_PREMIUM", "CRACK_161-320_PREMIUM", "CRACK_1-250"}

    # Step 1: Cek apakah masih ada akun hari ini yang belum lewat
    semua_masih_aktif = []
    for nama_sheet, sheet in sheets_to_check:
        is_crack = nama_sheet in CRACK_SHEETS
        aktif = _cek_masih_ada_hari_ini(sheet, tanggal_hari_ini, is_crack)
        for item in aktif:
            item["sheet"] = nama_sheet
        semua_masih_aktif.extend(aktif)

    if semua_masih_aktif:
        return ("belum_selesai", semua_masih_aktif)

    # Step 2: Semua sudah logout, ubah warna biru untuk besok
    total_diubah = 0
    for nama_sheet, sheet in sheets_to_check:
        is_crack = nama_sheet in CRACK_SHEETS
        jumlah = _ubah_warna_biru_besok(sheet, tanggal_besok, is_crack)
        total_diubah += jumlah

    return ("berhasil", total_diubah)


# ─── Helper ────────────────────────────────────────────────

def pilih_sheet(durasi: int):
    """Pilih sheet: 1/2/3 → HARIAN, 7/14 → MINGGUAN."""
    if durasi in [1, 2, 3]:
        return SHEET_HARIAN
    elif durasi in [7, 14]:
        return SHEET_MINGGUAN
    return SHEET_HARIAN


def is_baris_data(baris):
    """Baris valid = kolom A ada '@' (email), bukan header."""
    if len(baris) <= COL_EMAIL:
        return False
    return "@" in baris[COL_EMAIL].strip()


# ─── Cari slot kosong (RANDOM) ─────────────────────────────

def _pilih_slot_terdistribusi(slot_tersedia: list) -> dict:
    """
    Pilih slot dari akun yang punya slot kosong TERBANYAK.
    Tujuan: distribusi merata — akun dengan banyak slot kosong diisi dulu
    sebelum akun yang sudah hampir penuh.

    Cara kerja:
    1. Hitung jumlah slot kosong per email
    2. Kelompokkan email berdasarkan jumlah slot kosong (descending)
    3. Dari kelompok terbanyak, pilih random salah satu slotnya
    """
    if not slot_tersedia:
        return None

    # Hitung slot kosong per email
    kosong_per_email = {}
    for slot in slot_tersedia:
        email = slot["email"]
        kosong_per_email[email] = kosong_per_email.get(email, 0) + 1

    # Cari jumlah slot kosong terbanyak
    maks_kosong = max(kosong_per_email.values())

    # Filter hanya email yang punya slot kosong terbanyak
    email_kandidat = [e for e, n in kosong_per_email.items() if n == maks_kosong]

    # Pilih random salah satu email kandidat (agar tidak selalu email yang sama)
    email_terpilih = random.choice(email_kandidat)

    # Dari email terpilih, ambil semua slotnya lalu pilih random satu
    slot_email = [s for s in slot_tersedia if s["email"] == email_terpilih]
    return random.choice(slot_email)


def _cari_slot_dari_sheet(sheet, device: str = ""):
    """
    Helper: kumpulkan semua slot kosong dari sheet, return list dict.
    """
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

        if logout != "":
            continue
        if device == "TV" and password.upper() == "PAKE KODE":
            continue

        slot_tersedia.append({
            "nomor_baris": nomor_baris,
            "email": email,
            "password": password,
            "profil": profil,
            "pin": pin,
            "nama_sheet": sheet.title,
        })

    return slot_tersedia


def cari_slot_kosong(durasi: int, device: str = ""):
    """Cari slot kosong di sheet HARIAN/MINGGUAN, pilih dari akun terdistribusi."""
    spreadsheet = get_spreadsheet()
    nama_sheet = pilih_sheet(durasi)
    sheet = spreadsheet.worksheet(nama_sheet)
    slot_tersedia = _cari_slot_dari_sheet(sheet, device)
    return _pilih_slot_terdistribusi(slot_tersedia)


def cari_slot_kosong_bulanan(device: str = ""):
    """Cari slot kosong di sheet BULANAN, pilih dari akun terdistribusi."""
    spreadsheet = get_spreadsheet()
    sheet = cari_worksheet_bulanan(spreadsheet)
    slot_tersedia = _cari_slot_dari_sheet(sheet, device)
    return _pilih_slot_terdistribusi(slot_tersedia)


def verifikasi_slot_masih_kosong(nama_sheet: str, nomor_baris: int) -> bool:
    """
    Cek ulang slot masih kosong sebelum tulis (anti race condition).
    Return True jika masih kosong, False jika sudah terisi.
    """
    spreadsheet = get_spreadsheet()
    sheet = spreadsheet.worksheet(nama_sheet)
    cell_value = sheet.cell(nomor_baris, COL_LOGOUT + 1).value
    return cell_value is None or cell_value.strip() == ""


def bulatkan_jam():
    """
    Bulatkan jam sekarang ke kelipatan 10 menit terdekat.
    Aturan: sisa menit 0-5 bulatkan ke bawah, 6-9 bulatkan ke atas.
    Contoh: 20:52 → 20:50, 20:57 → 21:00
    """
    now = datetime.now()
    menit = now.minute
    sisa = menit % 10

    if sisa <= 5:
        menit_bulat = menit - sisa
    else:
        menit_bulat = menit + (10 - sisa)

    # Handle overflow (60 menit = +1 jam)
    jam = now.hour
    if menit_bulat >= 60:
        menit_bulat = 0
        jam += 1
    if jam >= 24:
        jam = 0

    return f"{jam:02d}:{menit_bulat:02d}"


# ─── Hitung tanggal logout ─────────────────────────────────

def hitung_tanggal_logout(durasi_hari: int) -> str:
    """Hitung tanggal logout: sekarang + durasi, jam dibulatkan."""
    tgl_logout = datetime.now() + timedelta(days=durasi_hari)
    bulan = BULAN_ID[tgl_logout.month]
    jam = bulatkan_jam()
    return f"{tgl_logout.day} {bulan} {jam}"


# ─── Tulis ke sheet (batch = lebih cepat) ──────────────────

def tulis_logout_ke_sheet(nama_sheet: str, nomor_baris: int, tanggal_logout: str, nomor_pelanggan: str):
    """Tulis logout (E) dan nomor pelanggan (F) dalam 1 batch update, lalu ubah background E jadi putih."""
    spreadsheet = get_spreadsheet()
    sheet = spreadsheet.worksheet(nama_sheet)

    # Batch update: tulis 2 cell sekaligus (1 API call)
    col_e = gspread.utils.rowcol_to_a1(nomor_baris, COL_LOGOUT + 1)
    col_f = gspread.utils.rowcol_to_a1(nomor_baris, COL_PHONE + 1)
    sheet.batch_update([
        {"range": col_e, "values": [[tanggal_logout]]},
        {"range": col_f, "values": [[nomor_pelanggan]]},
    ])

    # Ubah background kolom E jadi putih (slot sudah terisi)
    sheet.format(col_e, {
        "backgroundColor": {"red": 1, "green": 1, "blue": 1}
    })


def tulis_rekapan(nomor_pelanggan: str, durasi: int, email_akun: str):
    """Tulis rekapan di baris setelah data terakhir (batch update)."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    # Format data
    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    durasi_text = f"{durasi} hari"
    harga = _parse_harga(HARGA.get(durasi, "Rp0"))

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


def tulis_rekapan_quick(nomor_pelanggan: str, durasi: int, email_akun: str, lokasi: str):
    """Tulis rekapan dengan lokasi. Kolom E = email + ', ' + lokasi."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    durasi_text = f"{durasi} hari"
    harga = _parse_harga(HARGA.get(durasi, "Rp0"))
    email_lokasi = f"{email_akun}, {lokasi}"

    kolom_a = sheet_rekap.col_values(1)
    baris_target = len(kolom_a) + 1
    for i in range(len(kolom_a) - 1, -1, -1):
        if kolom_a[i].strip() != "":
            baris_target = i + 2
            break

    row = baris_target
    sheet_rekap.batch_update([
        {"range": gspread.utils.rowcol_to_a1(row, 1), "values": [[nomor_pelanggan]]},
        {"range": gspread.utils.rowcol_to_a1(row, 2), "values": [[tanggal]]},
        {"range": gspread.utils.rowcol_to_a1(row, 3), "values": [[durasi_text]]},
        {"range": gspread.utils.rowcol_to_a1(row, 4), "values": [[harga]]},
        {"range": gspread.utils.rowcol_to_a1(row, 5), "values": [[email_lokasi]]},
    ])


def tulis_rekapan_bulanan_quick(nomor_pelanggan: str, jumlah_bulan: int, tipe: str, email_akun: str, lokasi: str):
    """Tulis rekapan bulanan dengan lokasi. Kolom E = email + ', ' + lokasi."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    if tipe == "sempriv":
        durasi_text = f"{jumlah_bulan} b sempriv"
    else:
        durasi_text = f"{jumlah_bulan} b 1 u"
    key = f"{jumlah_bulan}_{tipe}"
    harga = _parse_harga(HARGA_BULANAN.get(key, "Rp0"))
    email_lokasi = f"{email_akun}, {lokasi}"

    kolom_a = sheet_rekap.col_values(1)
    baris_target = len(kolom_a) + 1
    for i in range(len(kolom_a) - 1, -1, -1):
        if kolom_a[i].strip() != "":
            baris_target = i + 2
            break

    row = baris_target
    sheet_rekap.batch_update([
        {"range": gspread.utils.rowcol_to_a1(row, 1), "values": [[nomor_pelanggan]]},
        {"range": gspread.utils.rowcol_to_a1(row, 2), "values": [[tanggal]]},
        {"range": gspread.utils.rowcol_to_a1(row, 3), "values": [[durasi_text]]},
        {"range": gspread.utils.rowcol_to_a1(row, 4), "values": [[harga]]},
        {"range": gspread.utils.rowcol_to_a1(row, 5), "values": [[email_lokasi]]},
    ])


# ─── Fungsi khusus BULANAN ──────────────────────────────────


def hitung_tanggal_logout_bulanan(jumlah_bulan: int, is_sempriv: bool) -> str:
    """
    Hitung tanggal logout bulanan.
    1 bulan = 27 hari, 2 bulan = 54 hari.
    Format:
    - 1P1U: '25 Juni (1U)'
    - Sempriv: '25 Juni (Sempriv)'
    """
    hari = DURASI_BULANAN_HARI.get(jumlah_bulan, 27)
    tgl_logout = datetime.now() + timedelta(days=hari)
    bulan = BULAN_ID[tgl_logout.month]

    if is_sempriv:
        return f"{tgl_logout.day} {bulan} (Sempriv)"
    else:
        return f"{tgl_logout.day} {bulan} (1U)"


def tulis_rekapan_bulanan(nomor_pelanggan: str, jumlah_bulan: int, tipe: str, email_akun: str):
    """Tulis rekapan bulanan. tipe = '1p1u' atau 'sempriv'."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"

    # Durasi text
    if tipe == "sempriv":
        durasi_text = f"{jumlah_bulan} b sempriv"
    else:
        durasi_text = f"{jumlah_bulan} b 1 u"

    # Harga
    key = f"{jumlah_bulan}_{tipe}"
    harga = _parse_harga(HARGA_BULANAN.get(key, "Rp0"))

    # Cari baris terakhir
    kolom_a = sheet_rekap.col_values(1)
    baris_target = len(kolom_a) + 1
    for i in range(len(kolom_a) - 1, -1, -1):
        if kolom_a[i].strip() != "":
            baris_target = i + 2
            break

    row = baris_target
    sheet_rekap.batch_update([
        {"range": gspread.utils.rowcol_to_a1(row, 1), "values": [[nomor_pelanggan]]},
        {"range": gspread.utils.rowcol_to_a1(row, 2), "values": [[tanggal]]},
        {"range": gspread.utils.rowcol_to_a1(row, 3), "values": [[durasi_text]]},
        {"range": gspread.utils.rowcol_to_a1(row, 4), "values": [[harga]]},
        {"range": gspread.utils.rowcol_to_a1(row, 5), "values": [[email_akun]]},
    ])


# ─── Rekap & Closing ────────────────────────────────────────

def _parse_harga(harga_str: str) -> int:
    """
    Parse nilai harga ke integer.
    Handle berbagai format:
    - 'Rp8,000' → 8000
    - 'Rp8.000' → 8000
    - '8000'    → 8000  (angka murni)
    - 8000      → 8000  (sudah integer)
    """
    if isinstance(harga_str, int):
        return harga_str
    if isinstance(harga_str, float):
        return int(harga_str)
    digits = "".join(c for c in str(harga_str) if c.isdigit())
    return int(digits) if digits else 0


def rekap_pendapatan(periode: str) -> dict:
    """
    Hitung rekap pendapatan dari sheet REKAPAN.
    periode: 'hari_ini', 'minggu_ini', 'bulan_ini'
    
    Return: {
        'total_order': int,
        'total_pendapatan': int,
        'detail': {durasi_text: {'count': int, 'total': int}},
        'tanggal_range': str
    }
    """
    now = datetime.now()
    spreadsheet = get_spreadsheet()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    try:
        sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)
    except Exception:
        return None

    semua_data = sheet_rekap.get_all_values()

    # Tentukan range tanggal
    if periode == "hari_ini":
        tanggal_target = f"{now.day} {BULAN_EN[now.month]} {now.year}"
        tanggal_range = tanggal_target
    elif periode == "minggu_ini":
        # 7 hari terakhir
        tanggal_list = []
        for i in range(7):
            d = now - timedelta(days=i)
            tanggal_list.append(f"{d.day} {BULAN_EN[d.month]} {d.year}")
        tanggal_range = f"{tanggal_list[-1]} - {tanggal_list[0]}"
    elif periode == "bulan_ini":
        # Semua tanggal bulan ini
        tanggal_list = []
        for day in range(1, now.day + 1):
            d = now.replace(day=day)
            tanggal_list.append(f"{d.day} {BULAN_EN[d.month]} {d.year}")
        tanggal_range = f"1 - {now.day} {BULAN_EN[now.month]} {now.year}"
    else:
        return None

    total_order = 0
    total_pendapatan = 0
    detail = {}

    for i, baris in enumerate(semua_data):
        if i == 0:  # Skip header
            continue
        if len(baris) < 4:
            continue

        tanggal_baris = baris[1].strip() if len(baris) > 1 else ""
        durasi_text   = baris[2].strip() if len(baris) > 2 else ""
        harga_text    = baris[3].strip() if len(baris) > 3 else ""

        # Skip baris yang tidak ada harganya sama sekali
        if not harga_text:
            continue

        # Cek apakah tanggal masuk range
        match = False
        if periode == "hari_ini":
            match = tanggal_baris == tanggal_target
        elif periode in ("minggu_ini", "bulan_ini"):
            match = tanggal_baris in tanggal_list

        if not match:
            continue

        harga = _parse_harga(harga_text)
        if harga <= 0:
            continue

        total_order += 1
        total_pendapatan += harga

        # Gunakan label "lainnya" jika kolom C kosong
        label = durasi_text if durasi_text else "lainnya"
        if label not in detail:
            detail[label] = {"count": 0, "total": 0}
        detail[label]["count"] += 1
        detail[label]["total"] += harga

    return {
        "total_order": total_order,
        "total_pendapatan": total_pendapatan,
        "detail": detail,
        "tanggal_range": tanggal_range,
    }


def tulis_fee_admin(tanggal_str: str, nominal: int) -> dict:
    """
    Tulis fee admin ke kolom C di sheet REKAPAN MODAL.
    tanggal_str: format DD/MM/YYYY (misal '05/06/2026')
    nominal: integer (misal 50000)

    Return:
    - {'ok': True, 'baris': int}  → berhasil
    - {'ok': False, 'reason': str} → gagal
    """
    client = get_client()
    spreadsheet_modal = client.open_by_key(SPREADSHEET_MODAL_ID)
    sheet_modal = spreadsheet_modal.worksheet(get_sheet_modal_name())

    semua_data = sheet_modal.get_all_values()

    baris_target = None
    for i, baris in enumerate(semua_data):
        if len(baris) > 0 and baris[0].strip() == tanggal_str:
            baris_target = i + 1  # gspread 1-indexed
            break

    if baris_target is None:
        return {"ok": False, "reason": f"Tanggal `{tanggal_str}` tidak ditemukan di sheet REKAPAN MODAL."}

    col_c = gspread.utils.rowcol_to_a1(baris_target, 3)
    sheet_modal.update_acell(col_c, nominal)

    return {"ok": True, "baris": baris_target}


def tulis_gestun(tanggal_str: str, nominal: int, persen: float = None) -> dict:
    """
    Tulis data gestun sebagai baris baru di sheet "rekapan" di spreadsheet REKAPAN MODAL.
    Struktur kolom:
      A: Tanggal (DD/MM/YYYY)
      B: Nominal
      C: Keuntungan % (opsional, format desimal misal 0.05 untuk 5%)
      D: Hasil Bersih (formula di sheet, tidak perlu ditulis)

    tanggal_str : format DD/MM/YYYY
    nominal     : integer (misal 2000000)
    persen      : float persen keuntungan (misal 5.0 untuk 5%), None jika tidak diisi

    Return:
    - {'ok': True, 'baris': int}
    - {'ok': False, 'reason': str}
    """
    client = get_client()
    spreadsheet_modal = client.open_by_key(SPREADSHEET_MODAL_ID)
    sheet_gestun = spreadsheet_modal.worksheet(SHEET_GESTUN)

    # Cari baris kosong pertama di KOLOM A mulai dari baris 3 (baris 1-2 = header)
    # Hanya baca kolom A agar tidak terpengaruh kolom lain (misal kolom F-G PENGELUARAN)
    kolom_a = sheet_gestun.col_values(1)  # list nilai kolom A, index 0 = baris 1
    baris_tulis = 3  # default: mulai dari baris 3 jika kolom A kosong semua

    for i in range(2, len(kolom_a)):  # index 2 = baris 3 (0-indexed)
        if kolom_a[i].strip() == "":
            baris_tulis = i + 1  # gspread 1-indexed
            break
    else:
        # Semua baris kolom A terisi, append setelah baris terakhir
        baris_tulis = len(kolom_a) + 1

    col_a = gspread.utils.rowcol_to_a1(baris_tulis, 1)
    col_b = gspread.utils.rowcol_to_a1(baris_tulis, 2)

    batch = [
        {"range": col_a, "values": [[tanggal_str]]},
        {"range": col_b, "values": [[nominal]]},
    ]

    # Kolom C: tulis persentase jika diisi (misal 5% → 0.05 agar formula sheet bisa hitung)
    if persen is not None:
        col_c = gspread.utils.rowcol_to_a1(baris_tulis, 3)
        batch.append({"range": col_c, "values": [[persen / 100]]})

    sheet_gestun.batch_update(batch)

    return {"ok": True, "baris": baris_tulis}


def tulis_modal_netflix(tanggal_str: str, nominal: int, keterangan: str) -> dict:
    """
    Tambah baris baru di tabel kanan sheet "modal netflix" (REKAPAN MODAL).
    Kolom H: Tanggal, I: Komponen ("modal"), J: Biaya, K: Keterangan

    tanggal_str : format DD/MM/YYYY
    nominal     : integer
    keterangan  : string, contoh "10 ACC EXTEND MEET"

    Return: {'ok': True, 'baris': int} atau {'ok': False, 'reason': str}
    """
    client = get_client()
    spreadsheet_modal = client.open_by_key(SPREADSHEET_MODAL_ID)
    sheet = spreadsheet_modal.worksheet(get_sheet_modal_name())

    semua_data = sheet.get_all_values()

    # Cari baris kosong pertama di kolom H (tabel kanan)
    # Header tabel kanan ada di baris 1 (index 0), data mulai baris 2
    baris_tulis = 2  # default jika tabel masih kosong
    for i in range(len(semua_data) - 1, 0, -1):  # mundur dari bawah, skip baris 0 (header)
        baris = semua_data[i]
        # Kolom H = index 7 (0-indexed)
        val_h = baris[7].strip() if len(baris) > 7 else ""
        if val_h:  # baris terakhir yang kolom H-nya ada isinya
            baris_tulis = i + 2  # baris berikutnya (gspread 1-indexed)
            break

    col_h = gspread.utils.rowcol_to_a1(baris_tulis, COL_MODAL_TGL)
    col_i = gspread.utils.rowcol_to_a1(baris_tulis, COL_MODAL_KOMPONEN)
    col_j = gspread.utils.rowcol_to_a1(baris_tulis, COL_MODAL_BIAYA)
    col_k = gspread.utils.rowcol_to_a1(baris_tulis, COL_MODAL_KET)

    sheet.batch_update([
        {"range": col_h, "values": [[tanggal_str]]},
        {"range": col_i, "values": [["modal"]]},
        {"range": col_j, "values": [[nominal]]},
        {"range": col_k, "values": [[keterangan]]},
    ])

    return {"ok": True, "baris": baris_tulis}


def closing_hari() -> dict:
    """
    Closing hari:
    1. Hitung total pendapatan hari ini dari REKAPAN
    2. Kalikan (1 - 0.7%) = pendapatan setelah pajak merchant
    3. Tulis ke spreadsheet REKAPAN MODAL, kolom B pada baris tanggal hari ini
    
    Return: {'total': int, 'setelah_pajak': int, 'pajak': int} atau None jika gagal
    """
    now = datetime.now()

    # 1. Hitung total pendapatan hari ini
    rekap = rekap_pendapatan("hari_ini")
    if rekap is None or rekap["total_pendapatan"] == 0:
        return {"total": 0, "setelah_pajak": 0, "pajak": 0}

    total = rekap["total_pendapatan"]
    pajak = int(total * PAJAK_MERCHANT)
    setelah_pajak = total - pajak

    # 2. Buka spreadsheet REKAPAN MODAL (pakai ID), sheet dinamis per bulan
    client = get_client()
    spreadsheet_modal = client.open_by_key(SPREADSHEET_MODAL_ID)
    sheet_modal = spreadsheet_modal.worksheet(get_sheet_modal_name(now))

    # 3. Cari baris dengan tanggal hari ini (format DD/MM/YYYY)
    tanggal_hari_ini = now.strftime("%d/%m/%Y")
    semua_data = sheet_modal.get_all_values()

    baris_target = None
    for i, baris in enumerate(semua_data):
        if len(baris) > 0 and baris[0].strip() == tanggal_hari_ini:
            baris_target = i + 1  # gspread index dari 1
            break

    if baris_target is None:
        return None  # Tanggal tidak ditemukan di REKAPAN MODAL

    # 4. Tulis setelah_pajak ke kolom B
    col_b = gspread.utils.rowcol_to_a1(baris_target, 2)
    sheet_modal.update_acell(col_b, f"{setelah_pajak:,}".replace(",", ","))

    return {
        "total": total,
        "setelah_pajak": setelah_pajak,
        "pajak": pajak,
        "detail": rekap["detail"],
        "total_order": rekap["total_order"],
    }


def format_template_bulanan(data: dict, tanggal_logout: str, tipe: str) -> str:
    """
    Template bulanan:
    - tipe 'sempriv' → template semiprivate (2 device)
    - tipe '1p1u' → template 1p1u (1 device)
    """
    if tipe == "sempriv":
        pesan = (
            f"  ꔘ  NETFLIX 1 Profile 1 User  ꔘ \n"
            f" ﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉\n"
            f"*WAJIB KIRIM SS LOGIN MAX 1x24 JAM.*\n"
            f"*NO SS = GARANSI HANGUS = NO KOMPLAIN.*\n"
            f"\n"
            f"*ⓘ SNK ⦂*\n"
            f"𖹭 𓋰 LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA\n"
            f"𖹭 𓋰 Login 2 device SAJA (terpantau)\n"
            f"𖹭 𓋰 NO VPN\n"
            f"𖹭 𓋰 1 bulan = 27 hari\n"
            f"𖹭 𓋰 Dilarang login-logout berulang\n"
            f"𖹭 𓋰 *TIDAK BISA PINDAH DEVICE!!*\n"
            f"𖹭 𓋰 *DILARANG UBAH APAPUN!!*\n"
            f"𖹭 𓋰 *Berani otak-atik isi akun? DENDA 500k + SPILL + BLACKLIST!!*\n"
            f"𖹭 𓋰 LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!!\n"
            f"𖹭 𓋰 This is BLACKMARKET, so don't expect stability 100%. Ini akun sharing, patuhi segala aturan, satu kesalahan berdampak pada semua pengguna akun\n"
            f"𖹭 𓋰 ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR\n"
            f"\n"
            f"*ⓘ SANKSI ⦂*\n"
            f"⚠️ Ketauan login lebih dari 2 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI\n"
            f"\n"
            f"🍿 *DATA AKUN* 🍿\n"
            f"💌 ⦂ `{data['email']}`\n"
            f"🗝️ ⦂ `{data['password']}`\n"
            f"🔖 ⦂ `{data['profil']}`\n"
            f"🔒 ⦂ `{data['pin']}`\n"
            f"⏰ Logout ⦂ `{tanggal_logout}`\n"
            f" `WAJIB LOGOUT TEPAT WAKTU!!`\n"
            f"\n"
            f"Aku respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )
    else:
        pesan = (
            f" ꔘ  NETFLIX 1 Profile 1 User  ꔘ \n"
            f" ﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉﹉\n"
            f"*WAJIB KIRIM SS LOGIN MAX 1x24 JAM.*\n"
            f"*NO SS = GARANSI HANGUS = NO KOMPLAIN.*\n"
            f"\n"
            f"*ⓘ SNK ⦂*\n"
            f"𖹭 𓋰 LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA\n"
            f"𖹭 𓋰 Login 1 device SAJA (terpantau)\n"
            f"𖹭 𓋰 NO VPN\n"
            f"𖹭 𓋰 1 bulan = 27 hari\n"
            f"𖹭 𓋰 Dilarang login-logout berulang\n"
            f"𖹭 𓋰 *TIDAK BISA PINDAH DEVICE!!*\n"
            f"𖹭 𓋰 *DILARANG UBAH APAPUN!!*\n"
            f"𖹭 𓋰 *Berani otak-atik isi akun? DENDA 500k + SPILL + BLACKLIST!!*\n"
            f"𖹭 𓋰 LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!!\n"
            f"𖹭 𓋰 This is BLACKMARKET, so don't expect stability 100%. Ini akun sharing, patuhi segala aturan, satu kesalahan berdampak pada semua pengguna akun\n"
            f"𖹭 𓋰 ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR\n"
            f"\n"
            f"*ⓘ SANKSI ⦂*\n"
            f"⚠️ Ketauan login lebih dari 1 device = KICK\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI\n"
            f"\n"
            f"🍿 *DATA AKUN* 🍿\n"
            f"💌 ⦂ `{data['email']}`\n"
            f"🗝️ ⦂ `{data['password']}`\n"
            f"🔖 ⦂ `{data['profil']}`\n"
            f"🔒 ⦂ `{data['pin']}`\n"
            f"⏰ Logout ⦂ `{tanggal_logout}`\n"
            f" `WAJIB LOGOUT TEPAT WAKTU!!`\n"
            f"\n"
            f"Aku respect kepada siapapun yang menaati rules dan menggunakan akun dengan bijak. Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 💖 💖"
        )

    return pesan


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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Ketauan login >1 device = KICK + DENDA.\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI.\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 🍀"
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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Ketauan login >1 device = KICK + DENDA.\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI.\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 🍀"
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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Ketauan login >1 device = KICK + DENDA.\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI.\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 🍀"
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
            f"ⓘ SNK  ⦂\n"
            f"𖦹  ꒱  WAJIB LOGIN PAKE JARINGAN DATA INTERNET / HOTSPOT DATA. JANGAN MAKSA PAKE WIFI!\n"
            f"𖦹  ꒱   login 1 device SAJA (terpantau).\n"
            f"𖦹  ꒱   NO VPN.\n"
            f"𖦹  ꒱   durasi 1 bulan = 25 - 30 hari. \n"
            f"𖦹  ꒱  dilarang login-logout berulang. TIDAK BISA PINDAH device walaupun sudah logout di device awal!\n"
            f"𖦹  ꒱  dilarang otak-atik settingan account. dilarang ganti email dan password. dilarang mengubah billing. mohon untuk menjadi pengguna yang bijak dan jujur agar tidak merugikan/dirugikan pengguna lain.\n"
            f"𖦹  ꒱  LOGOUT JIKA DURASI SEWA SUDAH HABIS. MOHON KESADARANNYA!\n"
            f"𖦹  ꒱  SYARAT KLAIM GARANSI -> KIRIM BUKTI SS LOGIN. TIDAK KIRIM = GARANSI HANGUS!\n"
            f"𖦹  ꒱  ERROR? ESTIMASI GARANSI PROSES MAX 0 - 3 HARI JADI SABAR.\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"ⓘ SANKSI ⦂\n"
            f"⚠️ Ketauan login >1 device = KICK + DENDA.\n"
            f"⚠️ Melanggar = DENDA 500K = NO GARANSI.\n"
            f"⚠️ Complain limit = NO REFUND\n"
            f"\n"
            f"Terima kasih banyak kak! Selamat menonton yaaa~♡ Have a nice day 🍀"
        )

    return pesan


# ─── Rekap Invest Netflix ───────────────────────────────────

def _cocokkan_email_invest(email_kolom_e: str) -> str | None:
    """
    Cocokkan email dari kolom E REKAPAN ke INVEST_EMAIL_SHEET_MAP.
    Kolom E bisa berisi 'email@domain.com' atau 'email@domain.com, Jakarta'.
    Return: nama sheet ('rekapan_ena' / 'rekapan_umi') atau None jika tidak cocok.
    """
    # Ambil bagian email saja (sebelum koma), lalu lowercase untuk case-insensitive
    email_bersih = email_kolom_e.split(",")[0].strip().lower()
    return INVEST_EMAIL_SHEET_MAP.get(email_bersih)


def _ambil_data_rekap_hari_ini() -> dict:
    """
    Ambil semua baris dari REKAPAN JUNI/JULI/dst hari ini.
    Return: dict {nama_sheet: [list baris]} — sudah dipisah per sheet invest.
    Setiap baris adalah dict: {nomor, tanggal, durasi, harga, email_raw}
    """
    now = datetime.now()
    tanggal_target = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    try:
        sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)
    except Exception as e:
        raise RuntimeError(f"Sheet '{nama_sheet_rekap}' tidak ditemukan: {e}")

    semua_data = sheet_rekap.get_all_values()
    hasil: dict[str, list] = {}

    for i, baris in enumerate(semua_data):
        if i == 0:  # skip header
            continue
        if len(baris) < 5:
            continue

        tanggal_baris = baris[1].strip() if len(baris) > 1 else ""
        if tanggal_baris != tanggal_target:
            continue

        nomor   = baris[0].strip() if len(baris) > 0 else ""
        durasi  = baris[2].strip() if len(baris) > 2 else ""
        harga   = _parse_harga(baris[3]) if len(baris) > 3 else 0
        email_e = baris[4].strip() if len(baris) > 4 else ""

        if not email_e or harga <= 0:
            continue

        nama_sheet_invest = _cocokkan_email_invest(email_e)
        if nama_sheet_invest is None:
            continue  # email ini bukan milik ena/umi, skip

        entry = {
            "nomor":     nomor,
            "tanggal":   tanggal_baris,
            "durasi":    durasi,
            "harga":     harga,
            "email_raw": email_e,
        }
        hasil.setdefault(nama_sheet_invest, []).append(entry)

    return hasil


def _cari_baris_terakhir_invest(sheet) -> int:
    """
    Cari baris kosong pertama setelah data terakhir di sheet invest_netflix.
    Cek kolom A DAN kolom D (karena subtotal ada di kolom D, kolom A-nya kosong).
    Tambah 1 baris jarak (spacer) agar tidak mepet dengan blok sebelumnya.
    Return: nomor baris target (1-indexed).
    """
    # Ambil semua nilai kolom A dan D sekaligus
    semua = sheet.get_all_values()
    baris_terakhir_berisi = 0

    for i, baris in enumerate(semua):
        col_a = baris[0].strip() if len(baris) > 0 else ""
        col_d = baris[3].strip() if len(baris) > 3 else ""
        if col_a or col_d:
            baris_terakhir_berisi = i + 1  # 1-indexed

    if baris_terakhir_berisi == 0:
        return 2  # sheet kosong, mulai baris 2

    # +2: 1 untuk baris setelah data terakhir, 1 lagi untuk baris jarak (spacer)
    return baris_terakhir_berisi + 2


def _sudah_ada_di_invest(sheet, tanggal_str: str, nomor: str, email_raw: str) -> bool:
    """
    Anti-duplikat: cek apakah kombinasi tanggal+nomor+email sudah ada di sheet.
    Cek kolom B (tanggal), A (nomor), E (email).
    """
    semua_data = sheet.get_all_values()
    for baris in semua_data:
        if len(baris) < 5:
            continue
        tgl_ada   = baris[1].strip()
        nomor_ada = baris[0].strip()
        email_ada = baris[4].strip()
        if tgl_ada == tanggal_str and nomor_ada == nomor and email_ada == email_raw:
            return True
    return False


def rekap_invest_harian() -> dict:
    """
    Tulis rekapan hari ini ke spreadsheet invest_netflix.
    Dijalankan otomatis jam 23:59 (sama seperti auto_closing).

    Format visual (mengikuti sheet manual):
    - Header tanggal : merge A:E, bg ungu (0.835,0.651,0.741), bold, center
    - Baris data     : kolom A  = bg ungu (sama header)
                       kolom B,D,E = bg pink muda (0.957,0.8,0.8), center
                       kolom C  = putih (no fill), center
    - Baris subtotal : hanya kolom D, bg hijau (0.416,0.659,0.310), bold, center

    Return: {
        'rekapan_ena': {'ditulis': int, 'total': int, 'skip_duplikat': int},
        'rekapan_umi': {'ditulis': int, 'total': int, 'skip_duplikat': int},
    }
    """
    now = datetime.now()

    # 1. Ambil data hari ini yang relevan
    data_per_sheet = _ambil_data_rekap_hari_ini()

    if not data_per_sheet:
        return {}

    client = get_client()
    spreadsheet_invest = client.open_by_key(SPREADSHEET_INVEST_ID)

    # Warna (dari pembacaan sheet asli)
    BG_UNGU      = {"red": 0.835, "green": 0.651, "blue": 0.741}   # header & kolom A data
    BG_PINK      = {"red": 0.957, "green": 0.800, "blue": 0.800}   # kolom B,D,E data
    BG_PUTIH     = {"red": 1.0,   "green": 1.0,   "blue": 1.0}     # kolom C data
    BG_HIJAU     = {"red": 0.416, "green": 0.659, "blue": 0.310}   # subtotal

    hasil = {}

    for nama_sheet, baris_list in data_per_sheet.items():
        try:
            sheet = spreadsheet_invest.worksheet(nama_sheet)
        except Exception as e:
            hasil[nama_sheet] = {"error": str(e)}
            continue

        ditulis = 0
        skip_duplikat = 0
        total_harga = 0

        # Anti-duplikat
        baris_baru = []
        for entry in baris_list:
            if _sudah_ada_di_invest(sheet, entry["tanggal"], entry["nomor"], entry["email_raw"]):
                skip_duplikat += 1
                continue
            baris_baru.append(entry)

        if not baris_baru:
            hasil[nama_sheet] = {"ditulis": 0, "total": 0, "skip_duplikat": skip_duplikat}
            continue

        sheet_id = sheet._properties["sheetId"]
        baris_tulis = _cari_baris_terakhir_invest(sheet)  # 1-indexed

        # ── 1. Header tanggal (merge A:E, bg ungu, bold, center) ──────────
        header_row = baris_tulis  # 1-indexed
        header_row_idx = header_row - 1  # 0-indexed untuk Sheets API

        tanggal_str = baris_baru[0]["tanggal"]

        # Tulis teks header di kolom A (anchor merge)
        sheet.batch_update([{
            "range": gspread.utils.rowcol_to_a1(header_row, 1),
            "values": [[tanggal_str]],
        }])

        # Merge A:E pada baris header
        sheet.spreadsheet.batch_update({
            "requests": [{
                "mergeCells": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": header_row_idx,
                        "endRowIndex":   header_row_idx + 1,
                        "startColumnIndex": 0,
                        "endColumnIndex":   5,
                    },
                    "mergeType": "MERGE_ALL",
                }
            }]
        })

        # Format header: bg ungu, bold, center
        sheet.batch_format([{
            "range": f"A{header_row}:E{header_row}",
            "format": {
                "backgroundColor": BG_UNGU,
                "textFormat": {"bold": True},
                "horizontalAlignment": "CENTER",
            }
        }])

        baris_tulis += 1

        # ── 2. Baris data ──────────────────────────────────────────────────
        batch_values = []
        batch_formats = []

        for entry in baris_baru:
            r = baris_tulis  # 1-indexed

            # Tulis nilai
            batch_values.extend([
                {"range": gspread.utils.rowcol_to_a1(r, 1), "values": [[entry["nomor"]]]},
                {"range": gspread.utils.rowcol_to_a1(r, 2), "values": [[entry["tanggal"]]]},
                {"range": gspread.utils.rowcol_to_a1(r, 3), "values": [[entry["durasi"]]]},
                {"range": gspread.utils.rowcol_to_a1(r, 4), "values": [[entry["harga"]]]},
                {"range": gspread.utils.rowcol_to_a1(r, 5), "values": [[entry["email_raw"]]]},
            ])

            # Format per kolom: A=ungu, B=pink, C=putih, D=pink, E=pink
            for col_idx, bg in [(1, BG_UNGU), (2, BG_PINK), (3, BG_PUTIH), (4, BG_PINK), (5, BG_PINK)]:
                batch_formats.append({
                    "range": gspread.utils.rowcol_to_a1(r, col_idx),
                    "format": {
                        "backgroundColor": bg,
                        "horizontalAlignment": "CENTER",
                    }
                })

            total_harga += entry["harga"]
            ditulis += 1
            baris_tulis += 1

        sheet.batch_update(batch_values)
        sheet.batch_format(batch_formats)

        # ── 3. Baris subtotal (hanya kolom D, bg hijau, bold, center) ──────
        subtotal_row = baris_tulis
        sheet.batch_update([{
            "range": gspread.utils.rowcol_to_a1(subtotal_row, 4),
            "values": [[total_harga]],
        }])
        sheet.batch_format([{
            "range": gspread.utils.rowcol_to_a1(subtotal_row, 4),
            "format": {
                "backgroundColor": BG_HIJAU,
                "textFormat": {"bold": True},
                "horizontalAlignment": "CENTER",
            }
        }])

        hasil[nama_sheet] = {
            "ditulis": ditulis,
            "total": total_harga,
            "skip_duplikat": skip_duplikat,
        }

    return hasil
