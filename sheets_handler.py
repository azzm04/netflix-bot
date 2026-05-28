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
    HARGA, HARGA_BULANAN, DURASI_BULANAN_HARI
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

def _cek_masih_ada_hari_ini(sheet, tanggal_str: str):
    """
    Cek apakah masih ada akun dengan tanggal hari ini di kolom E yang belum expired.
    tanggal_str: misal "27 Mei"
    Return: list of dict akun yang masih aktif hari ini.
    """
    semua_data = sheet.get_all_values()
    masih_aktif = []

    for i, baris in enumerate(semua_data):
        nomor_baris = i + 1
        if nomor_baris < DATA_START_ROW:
            continue
        if not is_baris_data(baris):
            continue

        logout_text = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""
        if not logout_text or logout_text.upper() == "EXPIRED":
            continue

        # Cek apakah tanggal di kolom E mengandung tanggal hari ini
        if tanggal_str.lower() in logout_text.lower():
            # Cek apakah jam-nya sudah lewat
            tgl_logout = _parse_tanggal_logout(logout_text)
            if tgl_logout and tgl_logout > datetime.now():
                # Masih aktif (belum lewat jam-nya)
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


def _ubah_warna_biru_besok(sheet, tanggal_besok_str: str):
    """
    Cari semua cell di kolom E yang mengandung tanggal besok,
    lalu ubah format: font Netflix Sans, size 12, bold, warna biru.
    tanggal_besok_str: misal "28 Mei"
    """
    semua_data = sheet.get_all_values()
    ranges_to_format = []

    for i, baris in enumerate(semua_data):
        nomor_baris = i + 1
        if nomor_baris < DATA_START_ROW:
            continue
        if not is_baris_data(baris):
            continue

        logout_text = baris[COL_LOGOUT].strip() if len(baris) > COL_LOGOUT else ""
        if not logout_text or logout_text.upper() == "EXPIRED":
            continue

        # Cek apakah mengandung tanggal besok
        if tanggal_besok_str.lower() in logout_text.lower():
            cell_ref = gspread.utils.rowcol_to_a1(nomor_baris, COL_LOGOUT + 1)
            ranges_to_format.append(cell_ref)

    # Ubah format: Netflix Sans, size 12, bold, warna biru
    if ranges_to_format:
        format_config = {
            "textFormat": {
                "fontFamily": "Netflix Sans",
                "fontSize": 12,
                "bold": True,
                "foregroundColorStyle": {
                    "rgbColor": {"red": 0, "green": 0, "blue": 1}
                }
            }
        }
        for cell_ref in ranges_to_format:
            sheet.format(cell_ref, format_config)

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

    # Step 1: Cek apakah masih ada akun hari ini yang belum lewat
    semua_masih_aktif = []
    for nama_sheet, sheet in sheets_to_check:
        aktif = _cek_masih_ada_hari_ini(sheet, tanggal_hari_ini)
        for item in aktif:
            item["sheet"] = nama_sheet
        semua_masih_aktif.extend(aktif)

    if semua_masih_aktif:
        return ("belum_selesai", semua_masih_aktif)

    # Step 2: Semua sudah logout, ubah warna biru untuk besok
    total_diubah = 0
    for nama_sheet, sheet in sheets_to_check:
        jumlah = _ubah_warna_biru_besok(sheet, tanggal_besok)
        total_diubah += jumlah

    return ("berhasil", total_diubah)


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
    """Cari slot kosong di sheet HARIAN/MINGGUAN, pilih random."""
    spreadsheet = get_spreadsheet()
    nama_sheet = pilih_sheet(durasi)
    sheet = spreadsheet.worksheet(nama_sheet)
    slot_tersedia = _cari_slot_dari_sheet(sheet, device)
    return random.choice(slot_tersedia) if slot_tersedia else None


def cari_slot_kosong_bulanan(device: str = ""):
    """Cari slot kosong di sheet BULANAN, pilih random."""
    spreadsheet = get_spreadsheet()
    sheet = cari_worksheet_bulanan(spreadsheet)
    slot_tersedia = _cari_slot_dari_sheet(sheet, device)
    return random.choice(slot_tersedia) if slot_tersedia else None


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


def tulis_rekapan_quick(nomor_pelanggan: str, durasi: int, email_akun: str, lokasi: str):
    """Tulis rekapan dengan lokasi. Kolom E = email + ', ' + lokasi."""
    now = datetime.now()
    nama_sheet_rekap = f"REKAPAN {BULAN_REKAP[now.month]} {now.year}"

    spreadsheet = get_spreadsheet()
    sheet_rekap = spreadsheet.worksheet(nama_sheet_rekap)

    tanggal = f"{now.day} {BULAN_EN[now.month]} {now.year}"
    durasi_text = f"{durasi} hari"
    harga = HARGA.get(durasi, "Rp0")
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
    harga = HARGA_BULANAN.get(key, "Rp0")
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
    Format: '23 Juni 20:50' atau '23 Juni ( Sempriv )' jika sempriv.
    """
    hari = DURASI_BULANAN_HARI.get(jumlah_bulan, 27)
    tgl_logout = datetime.now() + timedelta(days=hari)
    bulan = BULAN_ID[tgl_logout.month]
    jam = bulatkan_jam()

    if is_sempriv:
        return f"{tgl_logout.day} {bulan} ( Sempriv )"
    else:
        return f"{tgl_logout.day} {bulan} {jam}"


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
    harga = HARGA_BULANAN.get(key, "Rp0")

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
