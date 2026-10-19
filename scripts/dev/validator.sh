#!/bin/bash
# Локальный валидатор Solana для тестов MIORY (нужен WSL2: валидатор Solana
# на Windows не работает — падает на распаковке genesis-архива).
#
#   wsl -d Ubuntu -- bash /mnt/f/MIORY/scripts/dev/validator.sh
#
# Программу сюда НЕ грузим: её деплоит `anchor test` / `deploy-local.sh`,
# иначе program-аккаунт нельзя будет обновить.
set -uo pipefail
export PATH="$HOME/.local/solana/solana-release/bin:$PATH"

# Устанавливает Solana CLI, если его ещё нет.
if [ ! -x "$HOME/.local/solana/solana-release/bin/solana" ]; then
  mkdir -p "$HOME/.local/solana"
  cd "$HOME/.local/solana" || exit 1
  curl -sSL -o solana.tar.bz2 \
    https://github.com/anza-xyz/agave/releases/download/v4.3.2/solana-release-x86_64-unknown-linux-gnu.tar.bz2
  python3 - <<'PY'
import bz2, tarfile
with bz2.open('solana.tar.bz2', 'rb') as f:
    with tarfile.open(fileobj=f, mode='r|') as t:
        t.extractall('.')
PY
  rm -f solana.tar.bz2
fi

# Старый валидатор должен умереть, иначе он продолжит отдавать старое состояние.
pkill -9 -f solana-test-validator || true
for _ in $(seq 1 20); do
  pgrep -f solana-test-validator >/dev/null || break
  sleep 1
done

LEDGER="$HOME/miory-ledger"
rm -rf "$LEDGER"
mkdir -p "$LEDGER"
exec solana-test-validator --reset --log --ledger "$LEDGER" >> "$LEDGER/validator.log" 2>&1
