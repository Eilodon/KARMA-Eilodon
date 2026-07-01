# KARMA — Stellar ZK + x402 fast-lane demo

> Stellar Hacks: Real-World ZK hackathon submission, T8 deliverable of plan
> [`docs/superskills/plans/2026-06-23-stellar-casper-tracks.md`](docs/superskills/plans/2026-06-23-stellar-casper-tracks.md).

This document is what a judge or reproducer should follow to see KARMA's
"trustless fast-lane" working end-to-end on Stellar Testnet: a ZK credential
proof + a USDC x402 payment, delivered in **one HTTP request**, with no
KARMA server in the invocation path.

## What this submission does (architecture)

```
Agent (client-side, off-chain)             Provider / Soroban verifier (on-chain)
───────────────────────────────            ────────────────────────────────────────
1. Generate AgentCredentialProof           1. Decode X-Reputation-Proof
   (Circom, Groth16 over BN254)               and call agent_credential_verifier
                                              (Soroban): Groth16 pairing check
                                              via native BN254 host functions
                                              (env.crypto().bn254(), CAP-0074)
2. Build x402 payment payload              2. Verify X-Payment-Receipt with the
   (USDC on Stellar Testnet, $0.01)           Coinbase x402 facilitator on Stellar
                                              → USDC moved at the same instant
3. Build HTTP request:                     3. Check X-Nullifier not yet used
     X-Reputation-Proof  (~2 KB)              (per-skill replay guard, on-chain)
     X-Payment-Receipt   (signed)
     X-Nullifier         (per-skill)
                                           4. If all pass: execute skill,
4. POST /invoke ────────────────────────►     return result. No KARMA server.
```

Closes two open architectural problems in KARMA's production trust model
(documented in [`README.md`](README.md) before we knew about this hackathon):

1. **Identity gate was server-enforced** because `did:t3n` cannot be verified
   on-chain. The ZK proof + Soroban verifier eliminate that centralization
   point — trust is now pure math.
2. **Payment was multi-step escrow only.** x402-on-Stellar adds a one-shot
   fast-lane that's still trustless (proof + payment together).

## Building blocks (everything in this repo)

| Layer | Path | Status |
|---|---|---|
| Circuit + Groth16 setup | [`circuits/`](circuits/) (T4) | `make credential` passes |
| Soroban verifier contract | [`contracts-soroban/agent_credential_verifier/`](contracts-soroban/agent_credential_verifier/) (T5) | `cargo test --features testutils` 8/8 — native BN254 host functions, no Arkworks |
| Stellar ed25519 keypair derivation | [`src/lib/stellar/keypair.ts`](src/lib/stellar/keypair.ts) (T6) | 10/10 |
| x402Plugin/Stellar | [`src/plugins/x402_stellar.ts`](src/plugins/x402_stellar.ts) (T7) | 15/15 |
| Offline orchestration demo | [`src/scripts/demo_stellar_zk.ts`](src/scripts/demo_stellar_zk.ts) (T8) | runs end-to-end |

## Quick start — offline orchestration (no Stellar credentials needed)

This shows the FULL DATA FLOW end-to-end without touching the live network.
A judge can run it in any clean clone of the repo:

```bash
# 1. Install JS deps
pnpm install --frozen-lockfile

# 2. Build the circuit + generate happy-path proof + verifying key (~2 min)
cd circuits && make credential && cd ..

# 3. Build the Soroban verifier WASM (cargo + wasm32v1-none target)
cd contracts-soroban/agent_credential_verifier
rustup target add wasm32v1-none
cargo build --target wasm32v1-none --release
cd ../..

# 4. Run the orchestration demo — prints public signals, x402 receipt, HTTP envelope
pnpm exec tsx src/scripts/demo_stellar_zk.ts
```

Expected output: public signals + an x402 PaymentReceipt + the HTTP request
envelope a provider would receive. The script's last line shows the agent's
derived Stellar G-address (deterministic from a fixture secp256k1 seed).

## Live run — Stellar Testnet (owner-driven, requires funded keystore)

> ⚠️ This step is owner-driven because it needs funded Stellar testnet
> credentials + a wallet with a USDC trustline. Steps below are the
> reproduction plan.

### Step 1 — Deploy the Soroban verifier

```bash
# Pre-req: stellar CLI installed (curl -fsSL https://soroban.stellar.org/install.sh | bash)
cd contracts-soroban/agent_credential_verifier
cargo build --target wasm32v1-none --release

stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_credential_verifier.wasm \
  --network testnet \
  --source-account $DEPLOYER_KEY

# Record the printed contract address as STELLAR_VERIFIER_CONTRACT in .env
```

### Step 2 — Register the skill with the verifying key

```bash
# Pack circuits/build/agent_credential/verification_key.json (snarkjs decimal-string
# coordinates) into the contract's native VerifyingKey shape — alpha/beta/gamma/delta as
# Bn254G1Affine/Bn254G2Affine (64/128-byte big-endian hex), ic as an array of hex strings.
# Fixed-width byte packing only, no EC-point re-serialization library needed (unlike the
# Arkworks-canonical format the verifier used before the CAP-0074 native-host-function
# migration — see contracts-soroban/agent_credential_verifier/README.md).
node circuits/scripts/pack-bn254.mjs \
  circuits/build/agent_credential/verification_key.json \
  circuits/build/agent_credential/happy.proof.json \
  circuits/build/agent_credential/happy.public.json \
  /tmp/agent_credential_packed.json
# -> { "vkey": {alpha, beta, gamma, delta, ic: [...]}, "proof": {a,b,c}, "public_inputs": [...] }

stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- register_skill \
  --skill_id 42 \
  --vkey "$(jq -c .vkey /tmp/agent_credential_packed.json)" \
  --min_reputation 60 \
  --price_per_call 100000 \
  --owner $PROVIDER_ADDRESS
```

### Step 3 — Run the live demo (proof → x402 settle → Soroban verify)

```bash
# Fund agent-alpha's derived Stellar address (printed by step 0 of the offline demo)
# from the Stellar Lab faucet + establish a USDC trustline.

# Minimal direct call (skips the x402/provider-stub HTTP hop — proves the ZK leg alone):
# nullifier = public_inputs[2] from the same packed JSON; task_commitment is any 32-byte
# tag the caller picks to identify this job off-chain.
stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $PAYER_KEY \
  --network testnet \
  -- create_job \
  --payer $PAYER_ADDRESS \
  --skill_id 42 \
  --task_commitment 0000000000000000000000000000000000000000000000000000000000000000 \
  --proof "$(jq -c .proof /tmp/agent_credential_packed.json)" \
  --nullifier "$(jq -r '.public_inputs[2]' /tmp/agent_credential_packed.json)" \
  --public_inputs "$(jq -c .public_inputs /tmp/agent_credential_packed.json)" \
  --x402_receipt ""
# -> tx hash + emitted `job_created` event; re-running the same command reverts with
#    Error(Contract, #5) (NullifierReused) — the replay guard.

# Full flow (proof + x402 payment in one HTTP request, no direct contract call from the
# client) additionally needs a provider stub that:
# 1. Accepts a POST with the three x402 + ZK headers (X-Payment-Receipt, X-Reputation-Proof,
#    X-Nullifier — see demo_stellar_zk.ts for the exact envelope)
# 2. Forwards the x402 receipt to the facilitator for settlement
# 3. Packs the decoded proof via pack-bn254.mjs and calls create_job() as above
# Recommended stub provider endpoint (Express + @x402/express middleware):
# see https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
```

### Expected live transactions

| Step | Tool | What you'll see |
|---|---|---|
| Soroban contract deploy | `stellar contract deploy` | contract address `C…` on testnet |
| register_skill | `stellar contract invoke` | tx hash `0x…` confirming the skill+vkey |
| x402 USDC payment | x402 facilitator settle | `~5s` settle response with operation hash |
| create_job (verify proof) | Soroban contract call | tx hash + emitted `job_created` event |
| Replay attempt (same nullifier) | Soroban contract call | contract reverts with `Error(Contract, #5)` (NullifierReused) |

`pnpm exec tsx src/scripts/demo_stellar_zk.ts` already prints what each of these
HTTP+chain interactions looks like in raw form — the live mode just lets the
chain confirm them and produce the on-chain tx hashes.

## What's verified by the on-chain side

A judge running the live mode should observe, on **Stellar Testnet** alone
(no Pharos / no T3N / no KARMA server):

1. The Soroban verifier accepts a valid AgentCredentialProof and creates a job.
2. The same nullifier on a second invocation is rejected on-chain.
3. The x402 facilitator settles USDC in the same HTTP round-trip.

These three together are the "trust mechanism" — math + payment, no trusted
server. That's the closing argument of synthesis §5 + plan §1A.

## Submission notes

- **Public-signal order is contract-asserted.** The circuit emits
  `[skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot]`
  and the Soroban verifier's `create_job` checks `pi_skill == skill_id`,
  `pi_min_rep == skill.min_reputation`, `pi_nullifier == nullifier` before
  the Groth16 pairing call (see `contracts-soroban/.../src/lib.rs`).
- **Trusted setup ceremony** for the demo is single-contributor (locally
  generated `pot13_final.ptau`). Mainnet would require Hermez. Documented in
  `circuits/README.md` — not concealed.
- **Stellar BN254 host functions.** The pairing check is *not* a software
  Arkworks fallback — it calls `env.crypto().bn254().pairing_check(...)`
  directly, backed by the host's `bn254_multi_pairing_check`
  ([CAP-0074](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md),
  shipped in Protocol 25 "X-Ray", confirmed live well ahead of this hackathon).
  `contracts-soroban/.../src/lib.rs:crypto::verify_groth16` has no `ark-*`
  dependency at all — see `contracts-soroban/agent_credential_verifier/README.md`
  for the exact host-function call sequence and point encoding.
