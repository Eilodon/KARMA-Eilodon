#!/usr/bin/env bash
# Install circom binary + snarkjs into circuits/bin and circuits/node_modules.
# Idempotent — re-running is safe. Pin to a known version so the proof + verifier
# bytes are reproducible (Stellar ZK track requires verifier-key on Soroban to
# match the verifying key produced by this exact setup).

set -euo pipefail

CIRCOM_VERSION="${CIRCOM_VERSION:-v2.2.3}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HERE/bin"
mkdir -p "$BIN_DIR"

if [[ ! -x "$BIN_DIR/circom" ]]; then
  echo "[toolchain] downloading circom $CIRCOM_VERSION..."
  curl -fsSL -o "$BIN_DIR/circom" \
    "https://github.com/iden3/circom/releases/download/$CIRCOM_VERSION/circom-linux-amd64"
  chmod +x "$BIN_DIR/circom"
fi
"$BIN_DIR/circom" --version

if [[ ! -d "$HERE/node_modules/snarkjs" ]]; then
  echo "[toolchain] installing snarkjs + circomlibjs locally..."
  (cd "$HERE" && pnpm install --ignore-workspace)
fi

echo "[toolchain] OK — circom=$BIN_DIR/circom snarkjs=$HERE/node_modules/.bin/snarkjs"
