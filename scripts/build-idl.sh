#!/bin/bash
# Генерирует target/idl/miory.json без Anchor CLI.
#
# Anchor CLI делает это через `cargo test __anchor_private_print_idl
# --features idl-build`, парся вывод теста. Скрипт повторяет эту логику.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_ID="${ANCHOR_PROGRAM_ID:-FmoRzYQcTNoFsWFXYwaqNCjsmN4gHjufp4kGTJXJrAx5}"

cd "$ROOT/programs/miory"
cargo test __anchor_private_print_idl --features idl-build -- --show-output --quiet > "$ROOT/target/idl-build.log" 2>&1 || {
  echo "idl build failed, see target/idl-build.log" >&2
  exit 1
}

node "$ROOT/scripts/extract-idl.js" \
  "$ROOT/target/idl-build.log" \
  "$ROOT/target/idl/miory.json" \
  "$PROGRAM_ID"
