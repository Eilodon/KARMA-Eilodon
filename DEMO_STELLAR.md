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
| Soroban verifier contract | [`contracts-soroban/agent_credential_verifier/`](contracts-soroban/agent_credential_verifier/) (T5) | `cargo test --features testutils` 12/12 — native BN254 host functions, no Arkworks, job-history-root pinning |
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

## Live run — Stellar Testnet ✅ confirmed live (2026-07-03, soundness-patched build)

`agent_credential_verifier` is deployed and has processed a real proof on
Stellar Testnet — not a simulation, not a local test. Verify independently:
`stellar contract fetch --id CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP --network testnet`
succeeds and returns the deployed WASM.

This is the **patched** build: the credential commitment binds the
reputation score (`Poseidon(credentialSecret, reputationScore)`) and
`create_job` pins `jobHistoryRoot` against an admin-published `set_skill_root`
call — see "Soundness fixes" below for what changed and why. An earlier,
unpatched deploy (`CBXH5QUD…MMIHUYOM`, 2026-07-02) exists on Testnet but is
superseded; don't cite it as current evidence.

| Step | Tx hash | stellar.expert |
|---|---|---|
| Upload WASM | `a38d27d9b7cbcc3ff14637f6d4bf76cf24264c0e9656312055fe3655e8aba0e7` | [tx](https://stellar.expert/explorer/testnet/tx/a38d27d9b7cbcc3ff14637f6d4bf76cf24264c0e9656312055fe3655e8aba0e7) |
| Create contract | `06c031eb6f7ba4552fdc45bd2b53191eaacefb35bf38b8d9d6860bed2964429e` | [contract](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| `register_skill(skill_id=42, min_reputation=60)` | `3ca0c83b424eb99604e9d63a960ef89461cdf321d6536d167b7435f2004e66e0` | [tx](https://stellar.expert/explorer/testnet/tx/3ca0c83b424eb99604e9d63a960ef89461cdf321d6536d167b7435f2004e66e0) |
| `set_skill_root(skill_id=42, root=…)` — publishes the issuer's job-history root | `286d222d712e325ed9a22c2b75f97a4ae7f85517edce808e2669037037f0bad7` | [tx](https://stellar.expert/explorer/testnet/tx/286d222d712e325ed9a22c2b75f97a4ae7f85517edce808e2669037037f0bad7) |
| `create_job` — verifies a real Groth16 proof via `env.crypto().bn254().pairing_check`, checks the proof's `jobHistoryRoot` against the published root | `25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1` — `job_created`, `job_id=1` | [tx](https://stellar.expert/explorer/testnet/tx/25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1) |
| Replay same nullifier | reverts `Error(Contract, #5)` (`NullifierReused`) | *(no tx hash — the CLI simulates first and never submits a fee-bearing tx when simulation reverts; the revert is CLI-observable, not a mined transaction. Screenshot/terminal capture is the evidence here.)* |

Deployer/admin: `GDJZCSWUIR5YQAOGKV4EIYCXN2OA5FS6THMV3PTZNZHGC2N3UZUODOMK`.

Steps below are the reproduction recipe if you want to redeploy or extend this
(e.g. deploying `reputation_aggregation_verifier` too, which is not yet live).

> ⚠️ Needs funded Stellar testnet credentials + a wallet with a USDC
> trustline to reproduce from scratch.

A few gotchas hit during the real run that the recipe below has been updated
to reflect: the contract's constructor requires `--admin` (used the deployer
identity as admin); `set_skill_root` must be called before `create_job` for a
skill or it reverts `SkillRootNotSet`; `--x402_receipt` rejects an empty
string from the CLI (pass `00`, since this branch only stores the field and
doesn't validate its contents); `--public_inputs` must be decimal strings
(not the hex `pack-bn254.mjs` emits — convert via `BigInt(...)` first).

### Step 1 — Deploy the Soroban verifier

```bash
# Pre-req: stellar CLI installed (curl -fsSL https://soroban.stellar.org/install.sh | bash)
cd contracts-soroban/agent_credential_verifier
cargo build --target wasm32v1-none --release

stellar contract deploy \
  --wasm target/wasm32v1-none/release/agent_credential_verifier.wasm \
  --network testnet \
  --source-account $DEPLOYER_KEY \
  -- --admin $DEPLOYER_ADDRESS
# --admin is required by the constructor (not optional, despite older docs).

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

# Publish the job-history root the proof's Merkle path was built against — create_job
# reverts SkillRootNotSet / JobHistoryRootMismatch without this.
stellar contract invoke \
  --id $STELLAR_VERIFIER_CONTRACT \
  --source $DEPLOYER_KEY \
  --network testnet \
  -- set_skill_root \
  --skill_id 42 \
  --root "$(jq -r '.public_inputs[4]' /tmp/agent_credential_packed.json)"
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
  --public_inputs "$(jq -c '.public_inputs | map(. | if startswith("0x") then (. as $h | ($h[2:] | ascii_upcase)) else . end)' /tmp/agent_credential_packed.json)" \
  --x402_receipt "00"
# public_inputs must be decimal strings — pack-bn254.mjs emits hex, so convert
# each element with BigInt(x).toString() before passing (jq alone can't do
# arbitrary-precision hex->decimal; a one-line node/jq helper is simplest).
# --x402_receipt rejects an empty string from the CLI; "00" is accepted since
# this branch only stores the field and doesn't validate its contents.
# -> tx hash + emitted `job_created` event; re-running the same command reverts
#    with Error(Contract, #5) (NullifierReused) — the CLI simulates first and
#    will NOT submit a tx for a reverting call, so the replay guard shows up
#    as a CLI error, not a second tx hash.

# Full flow (proof + x402 payment in one HTTP request, no direct contract call from the
# client) additionally needs a provider stub that:
# 1. Accepts a POST with the three x402 + ZK headers (X-Payment-Receipt, X-Reputation-Proof,
#    X-Nullifier — see demo_stellar_zk.ts for the exact envelope)
# 2. Forwards the x402 receipt to the facilitator for settlement
# 3. Packs the decoded proof via pack-bn254.mjs and calls create_job() as above
# Recommended stub provider endpoint (Express + @x402/express middleware):
# see https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
```

`pnpm exec tsx src/scripts/demo_stellar_zk.ts` already prints what each of these
HTTP+chain interactions looks like in raw form — the live mode just lets the
chain confirm them and produce the on-chain tx hashes (see the confirmed
table above).

## What's verified by the on-chain side

Confirmed on **Stellar Testnet** alone (no Pharos / no T3N / no KARMA server
in the path) — see the tx table above:

1. ✅ The Soroban verifier accepts a valid AgentCredentialProof — with its
   committed reputation score and its Merkle membership under an
   admin-published root both checked — and creates a job (`create_job`, tx
   `25dd392b7a8a9adfc804dfeb576309e2d1876103fd6645949310e7ea6db597a1`).
2. ✅ Replaying the same nullifier is rejected (`Error(Contract, #5)`,
   CLI-observed — no second tx, see note above).
3. ⏳ **Not yet confirmed on-chain**: an x402 USDC payment settling in the
   same HTTP round-trip as the proof verification. The proof-verification leg
   above was invoked directly via `stellar contract invoke`, not via the
   `X-Payment-Receipt` + provider-stub HTTP path described in the
   architecture diagram — that full one-HTTP-request flow still needs the
   provider stub (see Step 3 note) implemented and run. Until then, the
   accurate claim is: **the ZK leg is live on-chain; the payment leg is
   demonstrated offline** (`demo_stellar_zk.ts`) and not yet wired to the
   live proof verification in a single request.

That's the closing argument of synthesis §5 + plan §1A, scoped to what's
actually been shown rather than the full architecture goal.

## Submission notes

- **Soundness fixes shipped before the final deploy.** An earlier internal
  audit of this circuit/contract pair found two gaps, both closed in the
  live build above (contract `CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP`):
  1. The credential's Merkle leaf now binds the reputation score —
     `credentialCommitment = Poseidon(credentialSecret, reputationScore)`
     (`circuits/src/agent_credential.circom`) — instead of the score being an
     unconstrained private witness a holder could self-declare.
  2. `create_job` now requires the proof's `jobHistoryRoot` public signal to
     match an admin-published root (`set_skill_root`, mirroring the sibling
     contract `reputation_aggregation_verifier`'s `set_epoch_root`), instead
     of accepting any self-consistent tree the caller supplies.
  Both fixes are covered by dedicated tests
  (`create_job_rejects_when_skill_root_not_set`,
  `create_job_rejects_wrong_job_history_root` in
  `contracts-soroban/agent_credential_verifier/src/test.rs`) — 12/12 passing.
  An earlier, unpatched contract (`CBXH5QUD…MMIHUYOM`) was briefly live on
  Testnet on 2026-07-02 before this fix; it is superseded and should not be
  cited as current evidence.

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
