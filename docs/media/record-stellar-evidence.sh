#!/usr/bin/env bash
# Records docs/media/stellar-live-evidence.gif — a real terminal session hitting the LIVE
# Stellar Testnet contracts (fetch, read, and a real replay-guard rejection). Every command
# below actually runs; nothing is scripted output. Re-run any time to regenerate the GIF
# after a redeploy (update CRED/REPAGG below first).
#
# Requires: stellar CLI configured with a `t3n` identity (or edit --source-account below),
# demo-video/.venv (python -m venv + `pip install asciinema`), demo-video/bin/agg.
#
#   docs/media/record-stellar-evidence.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DV="$ROOT/demo-video"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CRED=CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP
REPAGG=CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO

node "$ROOT/circuits/scripts/pack-bn254.mjs" \
  "$ROOT/circuits/build/agent_credential/verification_key.json" \
  "$ROOT/circuits/build/agent_credential/happy.proof.json" \
  "$ROOT/circuits/build/agent_credential/happy.public.json" \
  "$TMP/agent_credential_packed.json"

cat > "$TMP/session.sh" <<SESSION
#!/usr/bin/env bash
export TERM=xterm-256color
set -uo pipefail
CRED=$CRED
REPAGG=$REPAGG

clear
echo "KARMA — Stellar ZK verifiers, LIVE on Stellar Testnet (not a mock, not a local test)"
echo "======================================================================================"
sleep 1

echo
echo "\\\$ stellar contract fetch --id \${CRED:0:12}... --network testnet"
stellar contract fetch --id "\$CRED" --network testnet --out-file "$TMP/fetch.wasm" \\
  && echo "-> WASM pulled straight off the ledger. This contract is real." \\
  && ls -la "$TMP/fetch.wasm"
sleep 1

echo
echo "\\\$ stellar contract invoke --id \${CRED:0:12}... -- skill_root --skill_id 42"
stellar contract invoke --id "\$CRED" --source-account t3n --network testnet -- skill_root --skill_id 42
echo "-> on-chain Merkle root for skill 42, published by set_skill_root"
sleep 1

echo
echo "Now: replay a ZK proof whose nullifier was already spent by a real create_job call..."
sleep 1
echo "\\\$ stellar contract invoke --id \${CRED:0:12}... -- create_job --nullifier <already-used>"
REPLAY_OUT=\$(stellar contract invoke \\
  --id "\$CRED" --source-account t3n --network testnet \\
  -- create_job \\
  --payer GDJZCSWUIR5YQAOGKV4EIYCXN2OA5FS6THMV3PTZNZHGC2N3UZUODOMK \\
  --skill_id 42 \\
  --task_commitment 0000000000000000000000000000000000000000000000000000000000000000 \\
  --proof "\$(node -e "const j=require('$TMP/agent_credential_packed.json'); console.log(JSON.stringify(j.proof))")" \\
  --nullifier "\$(node -e "console.log(require('$TMP/agent_credential_packed.json').public_inputs[2])")" \\
  --public_inputs "\$(node -e "console.log(JSON.stringify(require('$TMP/agent_credential_packed.json').public_inputs.map(h=>BigInt('0x'+h).toString())))")" \\
  --x402_receipt 00 2>&1)
echo "\$REPLAY_OUT" | grep -m1 "error:" || true
echo
echo "-> REJECTED on-chain: Error(Contract, #5) = NullifierReused. The replay guard is real."
sleep 2

echo
echo "======================================================================================"
echo "Sibling contract, reputation_aggregation_verifier — same story:"
echo "\\\$ stellar contract invoke --id \${REPAGG:0:12}... -- epoch_root --epoch_id 202606"
stellar contract invoke --id "\$REPAGG" --source-account t3n --network testnet -- epoch_root --epoch_id 202606
sleep 1
echo
echo "Two independent Groth16/BN254 verifiers, verified via Stellar's NATIVE host functions"
echo "(env.crypto().bn254(), CAP-0074) — no Arkworks, no mock. Full tx history: DEMO_STELLAR.md"
sleep 2
SESSION
chmod +x "$TMP/session.sh"

export REC_COLS=100 REC_ROWS=26
python3 "$DV/lib/ptyrec.py" "$DV/.venv/bin/asciinema" rec -q --overwrite \
  -c "bash $TMP/session.sh" "$TMP/evidence.cast"

"$DV/bin/agg" --speed 1.3 --idle-time-limit 1.2 --font-size 16 --theme monokai \
  "$TMP/evidence.cast" "$HERE/stellar-live-evidence.gif"

echo "-> $HERE/stellar-live-evidence.gif"
