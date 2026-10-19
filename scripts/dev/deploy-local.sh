#!/bin/bash
# Деплоит программу MIORY на локальный валидатор из WSL.
#
# Windows-CLI через WSL-мост не тянет деплой 400+ КБ программы
# ("Data writes to account failed: Max retries exceeded"), поэтому деплоим
# из WSL, где сам solana CLI.
#
#   wsl -d Ubuntu -- bash /mnt/f/MIORY/scripts/dev/deploy-local.sh
set -uo pipefail
export PATH="$HOME/.local/solana/solana-release/bin:$PATH"
URL="http://127.0.0.1:8899"
PROGRAM_ID="$(solana-keygen pubkey /mnt/f/MIORY/target/deploy/miory-keypair.json)"

echo "program id: $PROGRAM_ID"
echo "--- program account ---"
solana --url "$URL" account "$PROGRAM_ID" | head -8

# Если предыдущий деплой оборвался, program-аккаунт остаётся в битом
# состоянии и повторный деплой падает с "insufficient funds".
if solana --url "$URL" account "$PROGRAM_ID" >/dev/null 2>&1; then
  echo "--- close the broken program account ---"
  solana --url "$URL" program close "$PROGRAM_ID" || true
fi

echo "--- deploy ---"
solana program deploy /mnt/f/MIORY/target/deploy/miory.so \
  --keypair /mnt/f/MIORY/target/deploy/miory-keypair.json \
  --url "$URL"
