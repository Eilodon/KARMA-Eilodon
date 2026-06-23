# KARMA — Casper Agentic Buildathon demo (RWA-oracle + x402)

> Casper Agentic Buildathon submission, T13 deliverable of plan
> [`docs/superskills/plans/2026-06-23-stellar-casper-tracks.md`](docs/superskills/plans/2026-06-23-stellar-casper-tracks.md).

This document is the reproduction guide a judge can follow to see KARMA's
RWA-oracle invocation work end-to-end on Casper Testnet: an Odra-backed
`AgentSkillRegistry`, an x402 fast-lane payment via Casper's live x402
Facilitator, and a signed price feed settled by the standard escrow review window.

## What this submission does (architecture)

```
Requester agent                        Provider agent + Odra registry on Casper
─────────────                          ─────────────────────────────────────────
1. discover_skills (via KARMA-MCP)     1. Skill registered on `AgentSkillRegistry`
   → rwa_price_oracle hit                 (Odra port — T9, contracts-odra/)
                                       2. Sybil-resistance bond locked (PD-007)

2. create_job(settlement_rail=x402)    3. Provider receives invocation, fetches
   → CasperX402Plugin (T11) builds        BTC/USD price, signs JSON with the
     signed payment envelope              same secp256k1 keystore key (T10)

3. POST /invoke with X-PAYMENT         4. Provider records the result hash on
   header (DER signature + payer +        Odra via `deliver_result(jobId, hash)`
   payee + amount + nonce + TTL)

4. Verify provider's signed feed +     5. CSPR escrow credited to the provider's
   call `confirm_completion`              pull-payment ledger (CEI)

5. Provider calls `withdraw` to        6. Skill reputation +5; agent reputation
   pull the CSPR escrow                   +5 (arm's-length, self-deal-safe)
```

Closes one open architectural gap in KARMA's production trust model: Pharos
was the single chain for paid jobs. Casper adds a second escrow rail AND a
live x402 fast-lane (announced with the Casper AI Toolkit) so AI agents can
settle micropayments per HTTP request, no human in the loop.

## Building blocks (everything in this repo)

| Layer | Path | Status |
|---|---|---|
| Odra `AgentSkillRegistry` port | [`contracts-odra/`](contracts-odra/) (T9) | `cargo +nightly test` 32/32 |
| Casper secp256k1 keystore adapter | [`src/lib/casper/keypair.ts`](src/lib/casper/keypair.ts) (T10) | 12/12 tests |
| x402Plugin/Casper | [`src/plugins/x402_casper.ts`](src/plugins/x402_casper.ts) (T11) | 22/22 tests |
| KARMA × Casper composability demo | [`src/scripts/demo_casper_composability.ts`](src/scripts/demo_casper_composability.ts) (T12) | runs end-to-end |
| RWA-oracle registration script | [`src/scripts/register_rwa_oracle_skill.ts`](src/scripts/register_rwa_oracle_skill.ts) (T13) | dry-run prints the deploy |
| RWA-oracle e2e demo | [`src/scripts/demo_casper_e2e.ts`](src/scripts/demo_casper_e2e.ts) (T13) | runs end-to-end |

## Quick start — offline orchestration (no Casper credentials needed)

This shows the FULL DATA FLOW end-to-end without touching the live network.
A judge can run it in any clean clone of the repo:

```bash
# 1. Install JS deps
pnpm install --frozen-lockfile

# 2. Compile + run the Odra contract tests (proves the port mirrors Solidity v4)
rustup toolchain install nightly --profile minimal
cargo +nightly test --manifest-path contracts-odra/Cargo.toml
# Expected: 32 passed; 0 failed.

# 3. Run the composability demo — shows the KARMA-MCP × Casper-MCP cross-server flow
pnpm exec tsx src/scripts/demo_casper_composability.ts

# 4. Run the RWA-oracle end-to-end demo — full job lifecycle (8 boxed steps)
pnpm exec tsx src/scripts/demo_casper_e2e.ts

# 5. Print the live `register_skill` recipe the deployer would run on Casper Testnet
pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts
```

Expected output: the e2e demo prints 8 numbered boxes covering register →
deposit_bond → discover → create_job (x402) → fetch+sign feed → deliver_result →
confirm_completion → withdraw. The Step 4 x402 envelope and the Step 7 feed
verification are produced by REAL T10/T11 code, not stubbed.

## Live run — Casper Testnet (owner-driven, requires funded keystore)

> ⚠️ This step is owner-driven because it needs funded Casper Testnet credentials,
> the `cargo-odra` CLI, and a deployed Odra contract package. Steps below are the
> reproduction plan.

### Step 0 — Toolchain

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-odra
# Casper client (used for put-deploy + query-balance)
cargo install casper-client
```

### Step 1 — Deploy the Odra `AgentSkillRegistry`

```bash
cd contracts-odra
cargo odra build
# Produces wasm/karma_odra.wasm

casper-client put-deploy \
  --node-address https://node.testnet.cspr.cloud \
  --chain-name casper-test \
  --secret-key $DEPLOYER_KEY \
  --payment-amount 200000000000 \
  --session-path ./wasm/karma_odra.wasm \
  --session-arg "review_window_ms:U64:'259200000'"   # 3 days

# Record the printed `contract_package_hash` as KARMA_ODRA_REGISTRY in .env
```

### Step 2 — Register the `rwa_price_oracle` skill

```bash
export CASPER_RPC_URL=https://node.testnet.cspr.cloud
export KARMA_ODRA_REGISTRY=hash-...                  # from Step 1
export KEYSTORE_PATH=./keystore.json
export KEYSTORE_PASSWORD=...
export KARMA_AGENT_ID=agent-alpha

pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts --live
# Prints the agent's Casper account-hash + RPC + contract package,
# then drops into casper-client to submit the deploy.
```

### Step 3 — Provider deposits a Tier-2 Sybil bond (PD-007)

```bash
casper-client put-deploy \
  --node-address $CASPER_RPC_URL \
  --chain-name casper-test \
  --secret-key $PROVIDER_KEY \
  --payment-amount 1500000000 \
  --session-package-hash $KARMA_ODRA_REGISTRY \
  --session-entry-point deposit_bond \
  --payment-amount-from-purse 1000000000
```

### Step 4 — Run the live e2e (x402 fast-lane invocation)

```bash
# Pre-req: provider's mcp endpoint accepts X-PAYMENT headers (see DEMO_STELLAR.md §Step 3
# for the matching Express + @x402/express middleware setup; Casper-side substitutes
# the facilitator URL for Casper's live one):
export CASPER_X402_FACILITATOR_URL=https://x402-facilitator.casper.network

# Then the live runner posts against the provider stub with the x402 envelope from T11.
# The facilitator settles CSPR atomically with the request, and the provider stub
# fetches the signed RWA feed, calls `deliver_result` on Odra, and the requester
# confirms completion + the provider withdraws.
```

### Expected live transactions

| Step | Tool | What you'll see |
|---|---|---|
| Odra contract deploy | `casper-client put-deploy --session-path …` | contract_package_hash `hash-…` |
| register_skill | `register_rwa_oracle_skill.ts --live` | tx hash + assigned `skill_id` |
| deposit_bond | `casper-client put-deploy --entry-point deposit_bond` | tx hash + `BondUpdated` event |
| create_job (x402) | x402 facilitator settle | settle response with deploy hash |
| deliver_result | `casper-client put-deploy --entry-point deliver_result` | tx hash + `ResultDelivered` event |
| confirm_completion | `casper-client put-deploy --entry-point confirm_completion` | tx hash + `JobCompleted` event |
| withdraw | `casper-client put-deploy --entry-point withdraw` | tx hash + transfer to provider |

The offline e2e demo (`pnpm exec tsx src/scripts/demo_casper_e2e.ts`) already
prints each of these in narrated form — the live mode just lets the chain
confirm them and produce the on-chain tx hashes.

## What's verified by the on-chain side

A judge running the live mode should observe, on **Casper Testnet** alone
(no Pharos / no KARMA server):

1. The Odra registry accepts `register_skill` and assigns a `skill_id`.
2. The Sybil bond is locked and the seed-eligible amount surfaces in
   `seed_eligible_bond(agent)`.
3. The Casper x402 facilitator settles CSPR in the same HTTP round-trip as
   the `create_job` invocation.
4. The provider's signed RWA feed verifies under their public key off-chain;
   the `result_hash` recorded on Odra binds the feed to the job.
5. The escrow ALWAYS settles to the provider's pull-payment ledger after
   `confirm_completion`; reputation bumps only happen at arm's-length
   (self-deal nullification — mirrored from Solidity's audit Abductive-2).

These together are the "trust mechanism" — math + payment + escrow, no
trusted intermediary. That's the closing argument of synthesis §5 + plan §1B.

## Submission notes

- **Composability claim is structural.** Tested independently in
  `src/scripts/demo_casper_composability.ts` — the orchestrator code holds
  KARMA-MCP and Casper-MCP tool sets side by side and reasons across them
  with zero chain-specific glue. The wire format IS the integration.
- **Odra port mirrors audited Solidity invariants.** CEI before
  `transfer_tokens`, pull-payment ledger, self-deal nullification on both
  completion paths. 32 tests pin the boundary cases — happy path, ghost
  requester, dispute window, double-complete, identity policy, duplicate
  task-hash exactly-once, all 7 Tier-2 bond cases.
- **No `@x402/casper` npm package yet.** T11's plugin builds the "exact"
  payment payload natively (canonical-JSON + SHA-256 + secp256k1 + DER) —
  exactly the pipeline Casper's live x402 Facilitator (announced with the
  Casper AI Toolkit) verifies. Aligning the precise wire-field names to
  Casper Foundation's facilitator spec is the final owner-driven step.
- **Nightly Rust required.** `odra-macros 2.x` uses `#![feature(box_patterns)]`.
  Documented in `contracts-odra/README.md` and the plan's done-state notes.
