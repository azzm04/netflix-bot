#!/bin/bash
# setup-server.sh — Setup device-kicker di Ubuntu 24.04
# Jalankan sekali setelah git pull: bash device-kicker/setup-server.sh

set -e

echo "=== [1/4] Install Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version

echo ""
echo "=== [2/4] Install Chromium dependencies ==="
sudo apt install -y \
  ca-certificates fonts-liberation libappindicator3-1 \
  libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 \
  libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 wget xdg-utils

echo ""
echo "=== [3/4] Install npm packages ==="
cd "$(dirname "$0")"
npm install --production

echo ""
echo "=== [4/4] Buat file .env ==="
if [ ! -f ".env" ]; then
  cat > .env << 'EOF'
GOOGLE_CREDENTIALS_PATH=../credentials.json
SPREADSHEET_NAME=netflix account jaeminies
SHEETS_TO_CHECK=HARIAN_DURASI-1,HARIAN_DURASI-2&3,MINGGUAN,BULANAN
COL_EMAIL=0
COL_PASSWORD=1
COL_PROFILE=2
COL_LOGOUT=4
DATA_START_ROW=2
CRON_SCHEDULE=*/15 * * * *
HEADLESS=true
CODE_INPUT_MODE=telegram
TELEGRAM_CODE_TIMEOUT=300000
BRIDGE_DIR=/tmp
EOF
  echo ".env dibuat. Edit jika perlu."
else
  echo ".env sudah ada, skip."
fi

echo ""
echo "=== Setup selesai! ==="
echo "Langkah selanjutnya:"
echo "  1. Edit device-kicker/.env jika perlu"
echo "  2. Jalankan: node device-kicker/test-sheets.js"
echo "  3. Setup systemd: sudo cp device-kicker/netflix-kicker.service /etc/systemd/system/"
echo "  4. sudo systemctl enable netflix-kicker && sudo systemctl start netflix-kicker"
