# KARMA — Casper Agentic Buildathon demo (RWA-oracle + x402)

> Casper Agentic Buildathon submission, T13 deliverable of the internal
> stellar-casper-tracks build plan.

This document is the reproduction guide a judge can follow to see KARMA's
RWA-oracle invocation work end-to-end on Casper Testnet: an Odra-backed
`AgentSkillRegistry`, an x402 fast-lane payment via Casper's live x402
Facilitator, and a signed price feed settled by the standard escrow review window.

**Short on time?** [90-second visual walkthrough](docs/media/casper-judges.html) — the same
story below, with a real captured terminal transcript instead of a wall of markdown.

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
| Odra `AgentSkillRegistry` port | [`contracts-odra/`](contracts-odra/) (T9) | `cargo +nightly test` 120/120 |
| Casper secp256k1 keystore adapter | [`src/lib/casper/keypair.ts`](src/lib/casper/keypair.ts) (T10) | 12/12 tests |
| x402Plugin/Casper | [`src/plugins/x402_casper.ts`](src/plugins/x402_casper.ts) (T11) | 28/28 tests — `verifyCasperExactPayload` is real ECDSA/SHA-256, not structural |
| KARMA × Casper composability demo | [`src/scripts/demo_casper_composability.ts`](src/scripts/demo_casper_composability.ts) (T12) | runs end-to-end |
| RWA-oracle registration script | [`src/scripts/register_rwa_oracle_skill.ts`](src/scripts/register_rwa_oracle_skill.ts) (T13) | dry-run by default; `--live` builds + signs + submits a real `casper-js-sdk` transaction |
| RWA-oracle e2e demo | [`src/scripts/demo_casper_e2e.ts`](src/scripts/demo_casper_e2e.ts) (T13) | runs end-to-end (offline state machine) |
| Live x402 HTTP loop | [`src/scripts/demo_casper_x402_live.ts`](src/scripts/demo_casper_x402_live.ts) (T13-live) | real local HTTP 402 → sign → verify round trip; `--live` adds the on-chain `create_job` leg |
| Real RPC client (register/deposit/create_job/deliver/confirm/withdraw + 3 live reads) | [`src/lib/casper/live_client.ts`](src/lib/casper/live_client.ts) (T13-live) | 14/14 tests — builds, signs, and submits real `casper-js-sdk` transactions; reads query the on-chain "state" dictionary directly |
| **MCP tool surface** — the RWA-oracle flow as 8 real MCP tools, not just scripts | [`src/plugins/casper.tool.ts`](src/plugins/casper.tool.ts) (T13-live) | 12/12 tests — any MCP client can call `casper_register_skill`, `casper_create_job`, `casper_get_account_state`, etc. directly |

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

> ⚠️ This step is owner-driven only because it needs funded Casper Testnet credentials — a
> private key, which nobody should paste into an AI session or a CI log. **A real install deploy
> has been done and verified end-to-end (2026-07-07)** from `agent-alpha`'s keystore identity:
> package hash `hash-a4e8ab23fe6bd87c97239bbc1292a2224cb34efc4f81a6c94edf06a7794f404f`, confirmed
> live via the account's on-chain `named_keys` (`AgentSkillRegistry` + `_access_token`), not just
> "the deploy tool exited 0." Three real gaps surfaced and got fixed along the way (see notes
> below Step 1) — the recipe here is the corrected one, not the original guess.

### Step 0 — Toolchain

```bash
rustup toolchain install nightly --profile minimal   # odra-macros 2.x needs nightly
rustup component add rust-src --toolchain nightly    # needed for -Z build-std, see Step 1
rustup target add wasm32-unknown-unknown --toolchain nightly
# Casper client (used for put-deploy + query-balance) — or use casper-js-sdk's SessionBuilder
# directly (see src/lib/casper/live_client.ts), which is what was actually used for the verified
# deploy, since casper-client can't set the Authorization header cspr.cloud now requires.
cargo install casper-client
```

### Step 1 — Deploy the Odra `AgentSkillRegistry`

```bash
cd contracts-odra
./build-wasm.sh
# Writes wasm/karma_odra.wasm — see contracts-odra/README.md § "wasm32 build — how this
# actually works" for why this script, not `cargo odra build`, is the reliable path today.
# As of 2026-07 this ALSO needs target-cpu=mvp + -Z build-std=core,alloc (see the script's
# comments) — plain target-feature=-bulk-memory alone is not enough; recent rustc/LLVM still
# emits memory.copy/memory.fill for large copies even with that flag, and Casper's on-chain
# wasm engine rejects any bulk-memory instruction at preprocessing.

casper-client put-deploy \
  --node-address https://node.testnet.cspr.cloud \
  --chain-name casper-test \
  --secret-key $DEPLOYER_KEY \
  --payment-amount 800000000000 \
  --session-path ./wasm/karma_odra.wasm \
  --session-args-json '[
    {"name": "odra_cfg_package_hash_key_name", "type": "String", "value": "AgentSkillRegistry"},
    {"name": "odra_cfg_allow_key_override", "type": "Bool", "value": false},
    {"name": "odra_cfg_is_upgradable", "type": "Bool", "value": true},
    {"name": "odra_cfg_is_upgrade", "type": "Bool", "value": false},
    {"name": "odra_cfg_constructor", "type": "String", "value": "init"},
    {"name": "review_window_ms", "type": "U64", "value": "259200000"},
    {"name": "governance_signers", "type": {"List": "Key"}, "value": ["account-hash-<deployer-account-hash>"]},
    {"name": "governance_threshold", "type": "U32", "value": 1},
    {"name": "timelock_delay_ms", "type": "U64", "value": "0"}
  ]'

# Record the printed `contract_package_hash` as KARMA_ODRA_REGISTRY in .env
```

> `init()`'s real signature (`contracts-odra/src/agent_skill_registry.rs`) takes the last four
> args above — `governance_signers` seeds the P0-B multisig (at least one signer; use the
> deployer's own account-hash for a single-signer setup) and becomes the initial arbiter.
> `--session-args-json` (a file or inline JSON, per `casper-client put-deploy --help`) handles
> the `List<Key>` arg cleanly; the single-arg `--session-arg` form used in earlier drafts of this
> doc only covered `review_window_ms` and would have reverted with `InvalidGovernanceConfig`.
>
> **Three more gaps, found by actually running this (not just reading Odra's docs):**
> 1. The `odra_cfg_*` args (first five above) are mandatory for *every* Odra install deploy
>    (https://odra.dev/docs/backends/casper/#wasm-arguments) — omitting them fails with
>    `ExecutionError::MissingArg` (`"User error: 64658"` — Odra's own error space starts at
>    `65536 - 1000` for framework errors, `64536 + 122 = 64658`; this repo's own `Error` enum
>    only occupies codes 1-53, so a code in the 64500s is never this contract's own logic).
> 2. `--payment-amount 200000000000` (200 CSPR) is **not enough** — the real install consumed
>    ~579 CSPR once the args above were fixed, most likely because disabling bulk-memory (Step 1's
>    wasm note) forces slower byte-loop copies instead of the single fast instruction. Use
>    `800000000000` (800 CSPR): comfortably above the real cost, safely under this testnet's
>    `block_gas_limit` (812.5 CSPR per `chain_get_...`/`info_get_chainspec` — a single transaction
>    cannot request more than this network-wide cap; check it fresh, it's a chainspec value, not
>    a constant). Unused payment is **not refunded on this network** (`refund` was `0` even on a
>    request that used a tiny fraction of its limit), so don't set this arbitrarily high either.
> 3. `https://rpc.testnet.casper.network/rpc` (this doc's old RPC example) doesn't resolve in
>    DNS — use `https://node.testnet.cspr.cloud/rpc` instead, but as of 2026-07 it requires a
>    free API key (sign up at cspr.cloud), sent as a raw `Authorization: <key>` header (no
>    `Bearer` prefix). `casper-client` has no flag for custom headers, so the verified deploy
>    used `casper-js-sdk`'s `SessionBuilder` directly against `HttpHandler.setCustomHeaders`
>    (see `CasperLiveClientOpts.rpcHeaders` in `src/lib/casper/live_client.ts`, and
>    `CASPER_RPC_API_KEY` in `.env.example`) rather than the `casper-client` CLI shown above.

### Step 2 — Register the `rwa_price_oracle` skill

```bash
export CASPER_RPC_URL=https://node.testnet.cspr.cloud
export KARMA_ODRA_REGISTRY=hash-...                  # from Step 1
export KEYSTORE_PATH=./keystore.json
export KEYSTORE_PASSWORD=...
export KARMA_AGENT_ID=agent-alpha

pnpm exec tsx src/scripts/register_rwa_oracle_skill.ts --live
# Builds a real ContractCallBuilder transaction (register_skill, matching the Rust signature
# 1-to-1), signs it with the agent's Casper key, submits it via RpcClient.putTransaction, and
# prints the real transaction hash — no casper-client shell-out, no stub.
```

### Step 3 — Provider deposits a Tier-2 Sybil bond (PD-007)

```ts
// pnpm exec tsx (see CasperLiveClient.depositBond in src/lib/casper/live_client.ts)
const { txHash } = await client.depositBond(signer, 1_000_000_000n); // 1 CSPR bond
```

> **`deposit_bond()` takes no named args** — it reads `self.env().attached_value()`, Odra's
> "payable" convention (https://odra.dev/docs/basics/native-token). Casper has no native
> account→contract token transfer, so a plain `ContractCallBuilder` call with a `U512` arg named
> `amount` does nothing — `attached_value()` stays zero and the call reverts with
> `ExecutionError::NoBond` (verified: this is exactly what the earlier draft of this doc's
> `--payment-amount-from-purse` flag would have hit too, since `casper-client put-deploy` has no
> such flag — that recipe was never actually run). The real mechanism is Odra's **"Cargo Purse"**
> idiom: a one-time-use purse, funded by the caller, whose URef is passed as a `cargo_purse` arg;
> the wasm-side glue transfers 100% of that purse's balance into the contract and reads it back
> as `attached_value()`. Building that purse manually means either a two-transaction dance
> (create purse via the mint system contract, then call `deposit_bond` referencing it) or Odra's
> own answer to this: a generic, contract-agnostic **`proxy_caller` session** that does both in
> one deploy. `CasperLiveClient.depositBond`/`createJob` (payable) route through
> `submitPayable()`, which uses exactly that session — bundled at
> `src/lib/casper/resources/proxy_caller_with_return.wasm` (copied from `odra-casper-test-vm`'s
> `resources/`; Odra ships no separate npm/crates.io package for it, and it doesn't need building
> from source — it's generic, not project-specific like `karma_odra.wasm`). Verified end-to-end
> on testnet: `depositBond(1 CSPR)` succeeded, and `bondedOf(account)` read back `"1000000000"`.

### Step 4 — Run the live e2e (x402 fast-lane invocation)

```bash
pnpm exec tsx src/scripts/demo_casper_x402_live.ts --live
# Runs the real local HTTP 402 -> sign -> verify loop (no funded key needed for this part —
# see it work today by running it WITHOUT --live), then, with --live and Step 1-3's env vars
# set, submits a real create_job deploy via CasperLiveClient to settle the escrow on-chain.
```

> `create_job` is **also** payable (no `amount` arg exists on the real entry point — the escrow
> is `attached_value()`, checked to equal exactly the skill's `price_per_call`), so
> `CasperLiveClient.createJob` routes through the same proxy-caller session as `depositBond`
> (§Step 3). `task_hash`/`deliver_result`'s `result_hash` are Rust `Bytes` params — wire type
> `List(U8)`, not the fixed-size `ByteArray` earlier drafts of this client used (confirmed
> against the deployed contract's own entry-point signatures via `query_global_state`, not
> guessed). Verified end-to-end on testnet: `createJob` → `getJob` read back the exact
> `task_hash` + `escrowAmountMotes` + `status: "Open"`; `deliverResult` → `getJob` showed
> `status: "Delivered"` and the exact `result_hash`.

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
  completion paths. 120 tests pin the boundary cases — happy path, ghost
  requester, dispute window, double-complete, identity policy, duplicate
  task-hash exactly-once, all 7 Tier-2 bond cases, plus the P0-A evaluator
  and P0-B governance/timelock mechanics.
- **No `@x402/casper` npm package yet, so KARMA runs its own verification** —
  same topology DEMO_STELLAR.md uses for the Stellar rail. T11's plugin builds
  the "exact" payment payload natively (canonical-JSON + SHA-256 + secp256k1 +
  DER); `verifyCasperExactPayload` (T13-live) independently re-verifies that
  signature, the expiry window, and the payee — real cryptography, not a
  shape check. `demo_casper_x402_live.ts` runs the whole HTTP 402 → sign →
  verify loop against a real local server today. Aligning the wire-field
  names to Casper Foundation's official facilitator (once published) is a
  drop-in swap, not a rewrite.
- **Nightly Rust required.** `odra-macros 2.x` uses `#![feature(box_patterns)]`.
  Documented in `contracts-odra/README.md` and the plan's done-state notes.
