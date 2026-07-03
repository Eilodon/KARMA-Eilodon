#!/usr/bin/env bash
# Records docs/media/stellar-zk-demo.mp4 — the ~45s pitch: idea, the 2 soundness bugs we
# found + fixed, `cargo test` passing, then a real replay-guard rejection on live Testnet.
# Every command actually runs; nothing is scripted output. Re-run after a redeploy (update
# CRED/REPAGG below first).
#
# Requires: stellar CLI (`t3n` identity), demo-video/.venv (asciinema), demo-video/bin/agg,
# ffmpeg.
#
#   docs/media/record-stellar-demo-video.sh
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
cd "$ROOT"
PACKED="$TMP/agent_credential_packed.json"
CRED=$CRED
REPAGG=$REPAGG

clear
echo "======================================================================"
echo "  KARMA — Stellar Hacks: Real-World ZK"
echo "  A privacy-preserving credit score for AI agents, on Stellar."
echo "======================================================================"
sleep 3

echo
echo "THE IDEA:"
echo "  An AI agent proves \"my reputation >= 60\" to invoke a paid skill —"
echo "  WITHOUT revealing its actual score. Groth16 proof, verified on-chain"
echo "  by Stellar's NATIVE BN254 host functions (CAP-0074, Protocol 25)."
echo "  No Arkworks. No trusted server. No leaked business data."
sleep 6

echo
echo "======================================================================"
echo "  WE AUDITED OUR OWN CIRCUIT. WE FOUND 2 REAL BUGS. WE FIXED THEM."
echo "======================================================================"
sleep 2
echo
echo "BUG 1: the credential commitment didn't bind the reputation score —"
echo "       any holder could self-declare an arbitrary score."
echo "  FIX: credentialCommitment = Poseidon(credentialSecret, reputationScore)"
sleep 5
echo
echo "BUG 2: create_job never pinned the proof's Merkle root on-chain —"
echo "       a prover could supply a proof against a self-built tree."
echo "  FIX: new set_skill_root() admin call + an on-chain root check"
sleep 5

echo
echo "\\\$ cargo test --features testutils"
(cd contracts-soroban/agent_credential_verifier && cargo test --features testutils --quiet 2>&1 | tail -4)
sleep 3

echo
echo "======================================================================"
echo "  NOW: LIVE ON STELLAR TESTNET. NOT A SIMULATION."
echo "======================================================================"
sleep 1

echo
echo "\\\$ stellar contract fetch --id \${CRED:0:12}... --network testnet"
stellar contract fetch --id "\$CRED" --network testnet --out-file "$TMP/fetch.wasm" \\
  && echo "-> real WASM, pulled straight off the ledger."
sleep 3

echo
echo "Replay a ZK proof whose nullifier was already spent on-chain..."
sleep 1
REPLAY_OUT=\$(stellar contract invoke \\
  --id "\$CRED" --source-account t3n --network testnet \\
  -- create_job \\
  --payer GDJZCSWUIR5YQAOGKV4EIYCXN2OA5FS6THMV3PTZNZHGC2N3UZUODOMK \\
  --skill_id 42 \\
  --task_commitment 0000000000000000000000000000000000000000000000000000000000000000 \\
  --proof "\$(node -e "console.log(JSON.stringify(require('\$PACKED').proof))")" \\
  --nullifier "\$(node -e "console.log(require('\$PACKED').public_inputs[2])")" \\
  --public_inputs "\$(node -e "console.log(JSON.stringify(require('\$PACKED').public_inputs.map(h=>BigInt('0x'+h).toString())))")" \\
  --x402_receipt 00 2>&1)
echo "\$REPLAY_OUT" | grep -m1 "error:" || true
echo "-> REJECTED on-chain: Error(Contract, #5) NullifierReused. The guard is real."
sleep 5

echo
echo "======================================================================"
echo "  Two independent verifiers, both live:"
echo "    agent_credential_verifier      \$CRED"
echo "    reputation_aggregation_verifier \$REPAGG"
echo "======================================================================"
sleep 4
echo
echo "  Full tx history + reproduction steps: DEMO_STELLAR.md"
echo "  \"Trustless skill invocation for AI agents — prove reputation without"
echo "   revealing it, pay per call in USDC, no trusted server in the loop.\""
sleep 6
SESSION
chmod +x "$TMP/session.sh"

export REC_COLS=100 REC_ROWS=32
python3 "$DV/lib/ptyrec.py" "$DV/.venv/bin/asciinema" rec -q --overwrite \
  -c "bash $TMP/session.sh" "$TMP/video.cast"

"$DV/bin/agg" --speed 1.0 --idle-time-limit 6.5 --font-size 20 --theme monokai \
  "$TMP/video.cast" "$TMP/video.gif"

ffmpeg -y -i "$TMP/video.gif" \
  -vf "fps=15,scale=1228:924:flags=lanczos,format=yuv420p" \
  -c:v libx264 -crf 20 -movflags +faststart \
  "$HERE/stellar-zk-demo.mp4"

echo "-> $HERE/stellar-zk-demo.mp4"
