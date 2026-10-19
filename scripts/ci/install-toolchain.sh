#!/usr/bin/env bash
# Installs the Solana and the Anchor toolchains in a GitHub runner.
#
# The Anchor repository ships a CLI, not a GitHub Action, so the toolchains
# are installed here: the Solana CLI with the official installer and the
# Anchor CLI with the prebuilt binary of the release.
set -euo pipefail

SOLANA_VERSION="${SOLANA_VERSION:-v4.3.2}"
ANCHOR_VERSION="${ANCHOR_VERSION:-v0.32.2}"
ANCHOR_ASSET="anchor-${ANCHOR_VERSION#v}-x86_64-unknown-linux-gnu"

if ! command -v solana >/dev/null 2>&1; then
  echo "installing the Solana CLI ${SOLANA_VERSION}"
  sh -c "$(curl -sSfL https://release.anza.xyz/${SOLANA_VERSION}/install)"
fi

if ! command -v anchor >/dev/null 2>&1; then
  echo "installing the Anchor CLI ${ANCHOR_VERSION}"
  mkdir -p "$HOME/.local/bin"
  curl -sSfL \
    "https://github.com/coral-xyz/anchor/releases/download/${ANCHOR_VERSION}/${ANCHOR_ASSET}" \
    -o "$HOME/.local/bin/anchor"
  chmod +x "$HOME/.local/bin/anchor"
fi

# The runner only picks up the PATH changes of the following steps.
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
echo "$HOME/.local/share/solana/install/active_release/bin" >> "$GITHUB_PATH"

export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
anchor --version
