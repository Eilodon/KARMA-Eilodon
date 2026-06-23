# `karma-odra` — AgentSkillRegistry on Casper

Odra 2.x port of `contracts/AgentSkillRegistry.sol` (v4) for the **Casper Agentic Buildathon**
(plan: [`docs/superskills/plans/2026-06-23-stellar-casper-tracks.md`](../docs/superskills/plans/2026-06-23-stellar-casper-tracks.md) — T9).

The port mirrors the Solidity surface 1-to-1: skill lifecycle, escrow + pull-payment jobs, the
on-chain `identityPolicy` (P0), the trust-gate `minReputationToInvoke`, and the Tier-2
Sybil-resistance bond (PD-007). All three audited invariants — CEI, pull-payment, self-deal
nullification — are preserved.

## Layout

```
contracts-odra/
├── Cargo.toml                          # odra 2.2 (resolves to 2.8 transitive); odra-test dev-dep
├── odra.toml                           # `cargo odra build` contract registration
├── bin/
│   ├── build_contract.rs               # cargo-odra WASM entry (deploy path only)
│   └── build_schema.rs
└── src/
    ├── lib.rs                          # crate root + invariant overview
    ├── agent_skill_registry.rs         # contract (~620 LoC)
    └── agent_skill_registry/
        └── tests.rs                    # 32 tests, mirror of test/AgentSkillRegistry.t.sol
```

## Test loop

`odra-macros` 2.x needs the nightly compiler (`#![feature(box_patterns)]`):

```bash
rustup toolchain install nightly --profile minimal
cargo +nightly test --manifest-path contracts-odra/Cargo.toml
```

Expected: **32 passed; 0 failed** (happy path, refund window, ghost-requester / dispute /
claim-after-review, double-complete guard, trust gate, identity policy, self-deal nullification,
duplicate task-hash exactly-once, constructor bounds, and the seven Tier-2 bond cases).

## Casper-specific deltas vs Solidity

- `U512` (CSPR motes) replaces `uint256` (wei).
- Block time is in **milliseconds**, so every duration constant is ms:
  - `MIN_REVIEW_WINDOW` = `1h`
  - `MAX_REVIEW_WINDOW` = `30d`
  - `DEFAULT_REVIEW_WINDOW` = `3d`
  - `BOND_UNLOCK_COOLDOWN` = `7d`
- `bytes32 taskHash` / `bytes32 resultHash` → `odra::casper_types::bytesrepr::Bytes` (the Casper
  bytes wrapper — `Vec<u8>` triggers a runtime efficiency assertion in bytesrepr).
- Reentrancy-guard is dropped: Casper's deploy-isolated execution model removes the Solidity
  cross-call vector. CEI ordering is preserved (`pending_withdrawals` is zeroed *before*
  `transfer_tokens`), so any future cross-contract extension stays safe by construction.
- `JobStatus` is a flat enum (no variant data). Rust's exhaustive `match` on every state-transition
  guard still gives the compile-time state-machine claim. Pattern-data-carrying variants are a
  cheap follow-on if we want to inline `result_hash` / `completed_at`.

## Deploy path (T13)

WASM compilation + Casper Testnet deployment is wired up in T13 (RWA-oracle e2e). The entry points
in `bin/` are stubs ready for `cargo odra build` once `wasm32-unknown-unknown` + the `cargo-odra`
CLI are installed:

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-odra
cargo odra build  # writes wasm/karma_odra.wasm
```
