# Netflix Device Kicker

Auto-kick device customer Netflix yang sudah melewati deadline sewa per profil.

## Cara Kerja

```
Google Sheets (email/password + kolom E = tanggal logout)
        ↓
  Baca akun expired (tanggal E sudah lewat dari sekarang)
        ↓
  Puppeteer login ke netflix.com
        ↓
  Buka /manageaccountaccess
        ↓
  Expand device, cari yang pakai profil target
        ↓
  Klik "Keluar" untuk semua device profil tersebut
        ↓
  Update kolom E di sheet jadi "EXPIRED"
```

## Setup

### 1. Install dependencies

```bash
cd device-kicker
npm install
```

> Puppeteer akan otomatis download Chromium (~170MB). Tunggu sampai selesai.

### 2. Konfigurasi `.env`

Edit file `.env`:

```env
SPREADSHEET_NAME=netflix account jaeminies's  # nama spreadsheet kamu
SHEETS_TO_CHECK=HARIAN,MINGGUAN,BULANAN        # sheet mana yang dicek
CRON_SCHEDULE=*/15 * * * *                     # cek setiap 15 menit
HEADLESS=true                                  # false = lihat browser untuk debug
```

### 3. Jalankan

**Mode scheduler** (cek otomatis tiap X menit):
```bash
npm start
```

**Mode run sekali** (untuk testing):
```bash
npm run kick-now
```

**Mode debug** (lihat browser):
```env
# di .env
HEADLESS=false
```
```bash
npm run kick-now
```

## Struktur Kolom Spreadsheet

| Kolom | Index | Isi |
|-------|-------|-----|
| A | 0 | Email Netflix |
| B | 1 | Password |
| C | 2 | Nama Profil |
| D | 3 | PIN |
| E | 4 | Tanggal Logout |
| F | 5 | No. HP Pelanggan |

## Catatan

- Proses per akun berjalan sequential (satu per satu) untuk menghindari block dari Netflix.
- Jika kolom E sudah bertuliskan `EXPIRED`, baris tersebut dilewati.
- Gunakan `HEADLESS=false` jika Netflix menampilkan CAPTCHA atau verifikasi tambahan.
