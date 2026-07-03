#!/usr/bin/env bash
# Records docs/media/stellar-zk-demo.mp4 — the narrated pitch: the idea, the 2 soundness
# fixes, then the live x402 + ZK "one HTTP request" flow (src/scripts/demo_stellar_x402_live.ts)
# running for real, with a synced English voiceover (Edge TTS, no API key needed).
#
# IMPORTANT — needs a FRESH, not-yet-spent skill/proof fixture (same one-shot-nullifier
# constraint as demo_stellar_x402_live.ts — see that file's docstring for how to generate one).
# Pass it via SKILL_ID / PACKED_PATH below; do not reuse a fixture already spent by a prior
# recording or DEMO_STELLAR.md's live-evidence runs.
#
# Requires: stellar CLI (`t3n` identity), demo-video/.venv (asciinema + edge-tts), agg, ffmpeg.
#
#   KEYSTORE_PASSWORD=<password> SKILL_ID=<fresh id> PACKED_PATH=<fresh fixture path> \
#     docs/media/record-stellar-demo-video.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DV="$ROOT/demo-video"
SKILL_ID="${SKILL_ID:?set SKILL_ID to a freshly registered, not-yet-spent skill id}"
PACKED_PATH="${PACKED_PATH:?set PACKED_PATH to that skill's packed proof fixture}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:?}"
TMP="$(mktemp -d)"
MARKERS="$TMP/markers"
mkdir -p "$MARKERS" "$TMP/audio"
trap 'rm -rf "$TMP"' EXIT

# ── 1. Narration audio (per-segment, Edge TTS + loudnorm) ──────────────────────────────
SCRIPT_JSON="$HERE/stellar-narration.json" \
AUDIO_DIR="$TMP/audio" \
NARRATION_OUT="$TMP/narration.json" \
"$DV/.venv/bin/python" "$DV/narration/tts.py"

# ── 2. Record the real terminal session, marking each beat's start time silently
#        (to a file, not to the terminal — keeps the recording free of debug text) ──────
cat > "$TMP/session.sh" <<SESSION
#!/usr/bin/env bash
export TERM=xterm-256color
set -uo pipefail
cd "$ROOT"
mark() { date +%s.%N > "$MARKERS/\$1.ts"; }

mark start
clear
echo "======================================================================"
echo "  KARMA — Stellar Hacks: Real-World ZK"
echo "  Prove reputation. Reveal nothing. Pay per call in USDC."
echo "======================================================================"
mark hook
sleep 6.2

echo
echo "THE IDEA:"
echo "  A Groth16 proof, verified on-chain by Stellar's native BN254 host"
echo "  functions (env.crypto().bn254(), CAP-0074, Protocol 25)."
echo "  No Arkworks. No trusted server. No leaked business data."
mark idea
sleep 11.1

echo
echo "======================================================================"
echo "  WE AUDITED OUR OWN CIRCUIT. WE FOUND 2 REAL BUGS. WE FIXED THEM."
echo "======================================================================"
echo "  1. Score wasn't bound to the commitment       -> now it is."
echo "  2. Merkle root wasn't pinned on-chain          -> now it is."
mark bugs
sleep 12.6

echo
echo "======================================================================"
echo "  NOW: ONE HTTP REQUEST. PROOF + PAYMENT. LIVE. WATCH."
echo "======================================================================"
mark hero_intro
sleep 4.8

echo
mark hero_flow
KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" SKILL_ID="$SKILL_ID" PACKED_PATH="$PACKED_PATH" \
  pnpm exec tsx src/scripts/demo_stellar_x402_live.ts
mark hero_flow_done
sleep 0.5

echo
echo "======================================================================"
echo "  ^ ONE POST REQUEST. TWO REAL STELLAR TRANSACTIONS."
echo "    Payment settled on-chain. Proof verified on-chain."
echo "======================================================================"
mark reveal
sleep 11.8

echo
echo "  Trustless skill invocation for AI agents."
echo "  Live on Stellar Testnet, today. -> DEMO_STELLAR.md"
mark closing
sleep 6.8
mark end
SESSION
chmod +x "$TMP/session.sh"

export REC_COLS=100 REC_ROWS=32
python3 "$DV/lib/ptyrec.py" "$DV/.venv/bin/asciinema" rec -q --overwrite \
  -c "bash $TMP/session.sh" "$TMP/take.cast"

# ── 3. Build a fully time-aligned audio track from the real marker offsets ─────────────
python3 - "$MARKERS" "$TMP/offsets.env" <<'PY'
import sys
markers = ["start","hook","idea","bugs","hero_intro","hero_flow","reveal","closing"]
mdir, out = sys.argv[1], sys.argv[2]
ts = {m: float(open(f"{mdir}/{m}.ts").read().strip()) for m in markers}
t0 = ts["start"]
with open(out, "w") as f:
    for m in markers[1:]:
        f.write(f"{m}={int(round((ts[m]-t0)*1000))}\n")
PY
source "$TMP/offsets.env"

ffmpeg -y \
  -i "$TMP/audio/hook.mp3" -i "$TMP/audio/idea.mp3" -i "$TMP/audio/bugs.mp3" \
  -i "$TMP/audio/hero_intro.mp3" -i "$TMP/audio/hero_flow.mp3" \
  -i "$TMP/audio/reveal.mp3" -i "$TMP/audio/closing.mp3" \
  -filter_complex "
[0]adelay=${hook}|${hook}[a0];
[1]adelay=${idea}|${idea}[a1];
[2]adelay=${bugs}|${bugs}[a2];
[3]adelay=${hero_intro}|${hero_intro}[a3];
[4]adelay=${hero_flow}|${hero_flow}[a4];
[5]adelay=${reveal}|${reveal}[a5];
[6]adelay=${closing}|${closing}[a6];
[a0][a1][a2][a3][a4][a5][a6]amix=inputs=7:duration=longest:normalize=0[aout]
" -map "[aout]" -ar 48000 "$TMP/narration_mixed.mp3"

# ── 4. Render the recording to video, pad the end, mux with narration ──────────────────
"$DV/bin/agg" --speed 1.0 --idle-time-limit 8 --font-size 18 --theme monokai \
  "$TMP/take.cast" "$TMP/take.gif"

ffmpeg -y -i "$TMP/take.gif" \
  -vf "fps=15,scale=1104:832:flags=lanczos,format=yuv420p,tpad=stop_mode=clone:stop_duration=25" \
  -c:v libx264 -crf 20 -movflags +faststart \
  "$TMP/video_only.mp4"

ffmpeg -y -i "$TMP/video_only.mp4" -i "$TMP/narration_mixed.mp3" \
  -c:v copy -c:a aac -b:a 128k -shortest \
  "$HERE/stellar-zk-demo.mp4"

echo "-> $HERE/stellar-zk-demo.mp4"
