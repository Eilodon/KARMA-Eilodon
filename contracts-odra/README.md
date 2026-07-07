# `karma-odra` — AgentSkillRegistry on Casper

Odra 2.x port of `contracts/AgentSkillRegistry.sol` (v4) for the **Casper Agentic Buildathon**
(T9 of the internal stellar-casper-tracks build plan).

The port mirrors the Solidity surface 1-to-1: skill lifecycle, escrow + pull-payment jobs, the
on-chain `identityPolicy` (P0), the trust-gate `minReputationToInvoke`, and the Tier-2
Sybil-resistance bond (PD-007). All three audited invariants — CEI, pull-payment, self-deal
nullification — are preserved.

## Layout

```
contracts-odra/
├── Cargo.toml                          # odra 2.2 (resolves to 2.8 transitive); odra-test dev-dep
├── Odra.toml                           # `cargo odra build` contract registration
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

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-odra
cargo odra build  # writes wasm/karma_odra.wasm
```

### wasm32 build — known blocker

Actually running the above (not just documenting it) surfaced two real, now-fixed gaps and one
still-open one:

- **Fixed** — cargo-odra 0.1.7 looks for `Odra.toml` (capital O); the repo shipped `odra.toml`.
  Renamed.
- **Fixed** — the wasm32 target has no std runtime, so linking `std` alongside
  `odra-casper-wasm-env`'s own panic handler collided on the `panic_impl` lang item
  (`error[E0152]`). `src/lib.rs` now carries `#![cfg_attr(target_arch = "wasm32", no_std)]` —
  native `cargo test` is unaffected (still 120/120 green), only the wasm32 artifact goes `no_std`.
  `odra::prelude` already re-exports the `alloc`-backed `String`/`Vec` the contract uses, so no
  further `no_std` porting was needed.
- **Still open** — `cargo-odra 0.1.7`'s build step shells out to `cargo build --bin
  <crate>_build_contract --target wasm32-unknown-unknown`, i.e. it expects `bin/build_contract.rs`
  to be a real `[[bin]]` target. But `odra-build 2.8.1`'s actual public API is `odra_build::build()`
  (singular, no `_contract` suffix) and is designed to run as a **build script** (`build.rs`,
  native host arch, emits `cargo:rustc-cfg=odra_module=...` consumed by the `#[odra::module]` macro
  while compiling the crate itself as a `cdylib`) — not as a compiled-to-wasm binary. `bin/`'s two
  files predate this and don't match either cargo-odra 0.1.7's invocation or odra-build 2.8.1's
  real API; declaring them as `[[bin]]` targets just moves the failure from "no bin target found"
  to "no function `build_contract` in crate `odra_build`" without producing a working wasm.
  Likely root cause: cargo-odra's CLI version isn't pinned anywhere (unlike `odra`/`odra-test`,
  which are pinned to `=2.8.1`), so `cargo install cargo-odra` grabs whatever is currently latest,
  which doesn't line up with the pinned library version's build protocol.
  **Concrete next step**: replace `bin/build_contract.rs` with a crate-root `build.rs` calling
  `odra_build::build()`, add `cdylib` to `[lib] crate-type`, and set `ODRA_MODULE` /
  `ODRA_BACKEND` per cargo-odra's actual (version-matched) expectations — or pin a cargo-odra
  release known to match `odra 2.8.1`.
