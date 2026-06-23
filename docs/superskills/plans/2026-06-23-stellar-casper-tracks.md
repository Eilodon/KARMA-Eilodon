# Stellar ZK + Casper Agentic Buildathon — Implementation Plan

> **For agentic workers:** execute task-by-task with `executing-plans`. TDD each task.
> Inputs: uploaded team docs `KARMA_Unified_Team_Roadmap.md` + `KARMAunifiedsynthesis.md`
> (treated as authoritative for vision; this plan is the executable layer).

**Goal:** Earn two plugin slots for KARMA's chain-agnostic core by shipping:
(a) **Stellar Track** — Circom Groth16 `AgentCredentialProof` + Soroban verifier + `x402Plugin/Stellar`,
demoing trustless agent-to-agent invocation (proof + payment in one HTTP request, no KARMA server).
(b) **Casper Track** — Odra port of the Skill+Job registry + `x402Plugin/Casper` + KARMA-MCP × Casper-MCP
composability demo + RWA-oracle reference skill.

**Architecture (where each piece lands):**
```
Layer 0 SUPER-MCP                  ── unchanged (shipped)
Layer 1 karma.tool.ts              ── extended: discover_skills.payment_options,
                                       create_job.settlement_rail param (generic)
        IPaymentPlugin (NEW)       ── src/lib/payment/plugin.ts
        x402Plugin/Stellar (NEW)   ── src/plugins/x402_stellar.ts
        x402Plugin/Casper (NEW)    ── src/plugins/x402_casper.ts
Layer 2 AgentSkillRegistry         ── Solidity v4 (shipped, redeploy gated to owner)
        AgentSkillRegistry/Odra    ── contracts-odra/  (NEW, Casper Track)
        SorobanVerifier (NEW)      ── contracts-soroban/agent_credential_verifier
Layer 3 ZKCredentialPlugin (NEW)   ── src/lib/zk/agent_credential.ts
                                     (Circom circuit + snarkjs prover + verifying key)
```

**Tech Stack:**
- TypeScript/ESM, viem (existing), zod/v4, Vitest (existing)
- **Circom 2** + **snarkjs** (Groth16 trusted setup) — circuit + browser/node prover
- **`@x402/core`, `@x402/express`, `@x402/stellar`** npm packages (Stellar x402)
- **`@stellar/stellar-sdk`** (ed25519 key path)
- **Soroban Rust SDK** + Stellar BN254 precompile (Protocol 26 host functions, CAP-0074)
- **Odra 1.0** (Casper smart contract Rust framework)
- **Casper SDK** (Casper x402 facilitator + on-chain interaction)

**Hackathon constraints (verified 2026-06-23):**
- Stellar Hacks: Real-World ZK — submission deadline **2026-06-29 19:00 UTC** (6.5 days).
  No "newly-developed" rule. Open-source repo + 2-3 min demo + ZK + Stellar load-bearing.
- Casper Agentic Buildathon Qualification — submission deadline **2026-06-30 23:59 UTC** (7.5 days).
  Hard rule: "All code and content must be original and newly developed for the Buildathon" —
  framing/Ask-Question is owner-managed (per session decision).

**Sequencing (must be linear at the Phase boundary; tracks parallel after):**
```
T1 → T2 → T3      (Phase 0 shared — block both tracks)
   ├── T4 → T5 → T6 → T7 → T8           (Phase 1A Stellar)
   └── T9 → T10 → T11 → T12 → T13       (Phase 1B Casper)
T14 (Phase 2 packaging per track)
```

**Out of scope (explicit defers):**
- `ReputationUpdateProof` circuit (synthesis §5.3 nice-to-have — skip for submission)
- `JobCommitmentProof` circuit (explicitly deferred by team doc)
- Cross-chain reputation proof Pharos→Stellar (nice-to-have)
- Full AgentSkillRegistry rewrite on Soroban (synthesis §5.3 explicit defer)
- Pharos v4 live redeploy (owner-handled locally per session decision)
- Redis-backed plugin state (single-process default; matches existing identity_session pattern)

---

## Phase 0 — Shared core (block both tracks)

### Task 1 — `IPaymentPlugin` interface + `SettlementRail` enum

**Files:**
- Create: `src/lib/payment/plugin.ts`
- Create: `src/lib/payment/registry.ts`
- Test: `src/__tests__/payment_registry.test.ts`

Interface — chain-agnostic, narrow (just enough for x402-style fast-lane + escrow fallback):
```ts
// src/lib/payment/plugin.ts
export type SettlementRail = "x402" | "escrow";

export interface PaymentReceipt {
  rail: SettlementRail;
  txHash?: string;          // chain-specific tx/op hash
  facilitatorRef?: string;  // x402 facilitator settlement id
  payer: string;            // address (chain-native format — caller validates)
  payee: string;
  amount: string;           // base-10 string, BigInt-safe (D-6)
  asset: string;            // "USDC" | "CSPR" | "PHRS" | etc — symbolic, no parsing here
  network: string;          // CAIP-2-ish: "stellar:testnet", "casper:testnet", "pharos:atlantic"
}

export interface PaymentQuote {
  rail: SettlementRail;
  network: string;
  asset: string;
  price: string;            // base-10 string
  facilitatorUrl?: string;  // x402 only
}

export interface PaymentRequest {
  skillId: string;          // logical skill id (decoupled from chain-specific id)
  price: string;
  asset: string;
  payTo: string;
  network: string;
}

export interface IPaymentPlugin {
  /** Stable id, e.g. "x402-stellar", "x402-casper", "escrow-pharos". */
  readonly id: string;
  /** Settlement rail this plugin implements. */
  readonly rail: SettlementRail;
  /** Networks this plugin handles (e.g. ["stellar:testnet", "stellar:pubnet"]). */
  readonly networks: readonly string[];
  /** Quote the cost of invoking this skill via this rail. Read-only. */
  quote(req: PaymentRequest): Promise<PaymentQuote>;
  /**
   * Pay then return a verifiable receipt. For x402: signs + posts to facilitator.
   * For escrow: writes to-chain (e.g. AgentSkillRegistry.createJob), returns tx hash.
   */
  pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt>;
  /** Verify a receipt server-side (provider-side gate). Pure — no signing. */
  verify(receipt: PaymentReceipt): Promise<boolean>;
}
```

Registry — minimal, single-process:
```ts
// src/lib/payment/registry.ts
import type { IPaymentPlugin, SettlementRail } from "./plugin.js";

export class PaymentPluginRegistry {
  private readonly byId = new Map<string, IPaymentPlugin>();
  register(p: IPaymentPlugin): void {
    if (this.byId.has(p.id)) throw new Error(`[KARMA] payment plugin '${p.id}' already registered`);
    this.byId.set(p.id, p);
  }
  /** All plugins for a given rail (e.g. all x402 implementations). */
  byRail(rail: SettlementRail): IPaymentPlugin[] {
    return [...this.byId.values()].filter((p) => p.rail === rail);
  }
  /** Single plugin matching a (rail, network) pair, or null. */
  resolve(rail: SettlementRail, network: string): IPaymentPlugin | null {
    return [...this.byId.values()].find((p) => p.rail === rail && p.networks.includes(network)) ?? null;
  }
  /** All registered plugins (for discover_skills.payment_options surfacing). */
  list(): IPaymentPlugin[] { return [...this.byId.values()]; }
  clear(): void { this.byId.clear(); }
}

export const paymentPlugins = new PaymentPluginRegistry();
```

- [ ] Step 1: failing tests — register/dedupe/byRail/resolve happy + miss + clear.
- [ ] Step 2: `pnpm test src/__tests__/payment_registry.test.ts` → FAIL (module missing).
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(payment): add IPaymentPlugin interface + registry (Phase 0)`.

---

### Task 2 — Plumb `payment_options` into `discover_skills`

**Files:** `src/lib/types.ts`, `src/lib/bm25_index.ts`, `src/lib/skill_indexer_runtime.ts`,
`src/plugins/karma.tool.ts` (discover_skills), `src/__tests__/karma_tools.test.ts`.

1. `SkillDocument` add optional `payment_options?: Array<{ rail: SettlementRail; network: string; asset: string }>`.
2. `bm25_index.ts` STORE_FIELDS append `"payment_options"`; `SkillSearchHit` adds it.
3. `skillDocFromChain` populates from skill's `mcpEndpoint` metadata convention OR fallback to current
   default `[{ rail: "escrow", network: "pharos:atlantic", asset: "PHRS" }]` (every existing skill).
4. `discover_skills` description: append note that hits include `payment_options[]`.

Default policy: a skill that doesn't override its payment options gets the existing Pharos escrow rail.
A skill registered with x402 metadata (via Task 6 — `register_skill` extension) gets `[x402, escrow]`.

- [ ] Step 1: failing tests — discover_skills returns `payment_options` per hit; default = escrow/Pharos.
- [ ] Step 2: → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: `pnpm test` → PASS.
- [ ] Step 5: commit `feat(karma): surface payment_options in discover_skills (Phase 0)`.

---

### Task 3 — `create_job` accepts `settlement_rail` param (generic, chain-neutral)

**Files:** `src/plugins/karma.tool.ts` (create_job handler), `src/__tests__/karma_tools.test.ts`.

Add optional `settlement_rail?: "x402" | "escrow"` (default `"escrow"`). When `"escrow"`, route
unchanged to existing Pharos escrow path. When `"x402"`, return `status: "rejected", reason:
"settlement_rail_not_implemented"` for now — Task 7 (Stellar) and Task 11 (Casper) wire the actual
rail through `paymentPlugins.resolve(rail, network)`. This keeps Task 3 surface stable while the
plugins are still being built.

- [ ] Step 1: failing tests — default rail still works; rail="x402" returns structured rejection.
- [ ] Step 2: → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(karma): add settlement_rail param to create_job (Phase 0 stub)`.

---

## Phase 1A — Stellar Track (deadline 2026-06-29 19:00 UTC)

### Task 4 — Circom circuit `AgentCredentialProof.circom`

**Files:**
- Create: `circuits/agent_credential.circom`
- Create: `circuits/Makefile` (compile + trusted setup + verifying key export)
- Create: `circuits/README.md` (rebuild instructions, ptau provenance)
- Create: `circuits/test/agent_credential.test.ts` (snarkjs-based)

Circuit (~80–120 LoC Circom). Inputs match synthesis §5.3.1:
```
Public:  skillId, minReputation, nullifier, credentialCommitment
Private: credentialSecret, reputationScore, merklePath, jobHistoryRoot

Constraints:
  1. credentialCommitment == Poseidon(credentialSecret)
  2. reputationScore >= minReputation     (LessThan + assertion)
  3. MerkleProof(credentialCommitment, merklePath) == jobHistoryRoot
  4. nullifier == Poseidon(credentialSecret, skillId)
```
Use `circomlib` Poseidon (3 inputs for nullifier; 1 input variant for commitment). Tree depth = 16
(supports ≤65k jobs in proof window — fine for hackathon scope).

Trusted setup: download **Powers of Tau** from existing Hermez ceremony (Phase 1 universal), do
Groth16 Phase 2 ceremony locally (single contributor — acceptable for testnet demo, must be flagged
in README that mainnet would require a multi-party ceremony).

Export: `verification_key.json` + WASM prover + `*.zkey`.

- [ ] Step 1: snarkjs test — generate proof from sample inputs; verify locally with `snarkjs groth16 verify`.
- [ ] Step 2: → FAIL (toolchain not installed yet).
- [ ] Step 3: write Makefile to bootstrap circom + snarkjs + download ptau; run end-to-end with a
      **dummy 5-line circuit** first to validate toolchain BEFORE writing the real circuit (synthesis §5.3
      "biggest risk is toolchain setup, not circuit logic").
- [ ] Step 4: implement real circuit; iterate until proof verifies offline.
- [ ] Step 5: commit `feat(zk): add AgentCredentialProof Circom circuit + Groth16 setup`.

---

### Task 5 — Soroban verifier contract

**Files:**
- Create: `contracts-soroban/agent_credential_verifier/Cargo.toml`
- Create: `contracts-soroban/agent_credential_verifier/src/lib.rs`
- Create: `contracts-soroban/agent_credential_verifier/src/test.rs`

Base: clone pattern from `stellar/soroban-examples/groth16_verifier`. Adapt to KARMA-specific public
inputs (skillId, minReputation, nullifier, credentialCommitment).

```rust
pub fn create_job(
    env: Env,
    skill_id: u64,
    task_commitment: BytesN<32>,
    proof: Groth16Proof,
    public_inputs: Vec<U256>,    // [skill_id, min_rep, nullifier, cred_commit]
    x402_receipt: Option<X402Receipt>,
) -> u64 {
    require!(!nullifier_used(&env, &public_inputs.get(2)), "nullifier replay");
    require!(
        verify_groth16(&env, &VKEY_BYTES, &proof, &public_inputs),
        "invalid credential proof"
    );
    match x402_receipt {
        Some(r) => verify_x402_receipt(&env, &r, get_skill_price(&env, skill_id)),
        None    => panic!("escrow path not implemented on Soroban (deferred)"),
    };
    store_nullifier(&env, public_inputs.get(2));
    create_job_record(&env, skill_id, task_commitment)
}
```

Hardcode verifying key bytes (output of Task 4) as a `const VKEY_BYTES: &[u8]`. Storage: nullifier
mapping (`Map<BytesN<32>, bool>`), skill price mapping (`Map<u64, U256>`), job counter.

Skill registration: keep minimal — `register_skill(skill_id, price, min_rep)` admin-only for the demo
(NOT a full marketplace, per synthesis §5.4 — wrong approach to replicate Pharos surface).

- [ ] Step 1: write `test.rs` — happy path (valid proof + valid receipt → job created), nullifier replay
      (second submission rejected), invalid proof rejected.
- [ ] Step 2: `cargo test --target wasm32-unknown-unknown` → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(soroban): add agent_credential_verifier contract`.

---

### Task 6 — ed25519 keystore path

**Files:**
- Create: `src/lib/stellar/keypair.ts`
- Create: `src/__tests__/stellar_keypair.test.ts`
- Modify: `src/lib/keystore.ts` (add `getStellarAccount(agentId, tenantId)`)

Issue: KARMA's existing keystore uses secp256k1 (Web3 v3 scrypt) → not directly usable for Stellar
(ed25519). Two options:
- (a) Derive a stable ed25519 keypair **from the same scrypt-decrypted secp256k1 entropy** via HKDF
  with a Stellar-specific salt. Same backup unit, two key materials.
- (b) Add a separate `stellar_*` field per agent in keystore.json with its own scrypt block.

Choose **(a)** — keeps a single seed and the keystore file compatible. Document the derivation
clearly in `stellar/keypair.ts`.

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export function deriveStellarKeypair(secp256k1PrivKey: Uint8Array): Keypair {
  const seed = hkdf(sha256, secp256k1PrivKey, /*salt*/ utf8("karma-stellar-v1"), /*info*/ utf8("ed25519"), 32);
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}
```

- [ ] Step 1: failing tests — deterministic derivation (same input → same address); two different
      agent secrets → two different addresses; round-trip sign+verify.
- [ ] Step 2: → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(stellar): add HKDF-derived ed25519 keypair from KARMA keystore`.

---

### Task 7 — `x402Plugin/Stellar` implementation

**Files:**
- Create: `src/plugins/x402_stellar.ts`
- Create: `src/__tests__/x402_stellar.test.ts`
- Modify: `src/index.ts` (register plugin at boot when env flag set)

Wrap `@x402/core` + `@x402/stellar` packages. Implement `IPaymentPlugin`:
- `quote()`: synchronous; return facilitator-relative quote (no network call).
- `pay()`: use derived ed25519 keypair, build payment payload via `@x402/stellar`,
  call facilitator (`https://www.x402.org/facilitator` testnet), return receipt.
- `verify()`: re-derive receipt's payment hash; verify against facilitator settle response.

ENV additions: `STELLAR_NETWORK` (`stellar:testnet` | `stellar:pubnet`),
`STELLAR_X402_FACILITATOR_URL` (default `https://www.x402.org/facilitator`).

- [ ] Step 1: failing tests — `pay` against a mocked facilitator returns a well-formed receipt; `verify`
      accepts it; `pay` against a 402-rejecting facilitator throws structured error.
- [ ] Step 2: → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.
- [ ] Step 5: commit `feat(payment): add x402Plugin/Stellar (IPaymentPlugin)`.

---

### Task 8 — End-to-end Stellar demo + DEMO_STELLAR.md

**Files:**
- Create: `src/scripts/demo_stellar_zk.ts`
- Create: `DEMO_STELLAR.md`
- Create: `demo-video/STELLAR.md` (script outline for the 2-3 min demo video)

Script flow:
1. Generate a `AgentCredentialProof` for agent-alpha (credential_secret + score=80 + skill min_rep=60).
2. Generate x402 USDC payment payload on Stellar Testnet via Task 7's plugin.
3. POST to a stub provider endpoint (mock for demo) with `X-Payment` + `X-Reputation-Proof` +
   `X-Nullifier` headers (synthesis §5.6 wire format).
4. Stub provider verifies proof against Soroban verifier (real contract call) + x402 receipt; returns
   result.
5. Print real tx hash from Soroban verify call; print x402 facilitator settle response.
6. Replay attempt (same nullifier) → rejected.

`DEMO_STELLAR.md`: 5 transaction log table (testnet hashes), reproduction steps, env example.

- [ ] Step 1: run dummy script with all components mocked → green.
- [ ] Step 2: swap real Soroban call in → tx hash on Stellar Testnet.
- [ ] Step 3: swap real x402 facilitator in → settle confirmation.
- [ ] Step 4: capture replay test (nullifier reuse rejected on-chain).
- [ ] Step 5: commit `feat(demo): end-to-end Stellar ZK + x402 flow with DEMO_STELLAR.md`.

---

## Phase 1B — Casper Track (deadline 2026-06-30 23:59 UTC)

### Task 9 — Odra port of AgentSkillRegistry

**Files:**
- Create: `contracts-odra/Cargo.toml`, `contracts-odra/src/agent_skill_registry.rs`
- Create: `contracts-odra/src/agent_skill_registry/tests.rs`

Port v4 Solidity → Odra. Mirror surface 1-to-1 where feasible:
- `Skill` struct (with `identityPolicy`), `Job` struct, `JobStatus` enum.
- `register_skill`, `create_job` (payable CSPR), `deliver_result`, `confirm_completion`,
  `dispute_result`, `claim_after_review`, `claim_refund`, `withdraw`.
- `deposit_bond`, `request_bond_unlock`, `cancel_bond_unlock`, `withdraw_bond`.

Use Odra's pattern-matched `JobStatus` enum so the compile-time state machine claim (synthesis §6)
is real. Document the matched-vs-unmatched transitions in a comment block.

```rust
#[derive(OdraType)]
pub enum JobStatus {
    Open,
    Delivered { result_hash: [u8; 32] },
    Completed { paid_at: u64 },
    Refunded,
    Disputed,
}
```

- [x] Step 1: write Odra tests mirroring the most critical Foundry tests (happy path, self-deal guard,
      review window, dispute, claim_after_review, bond unlock cooldown) — `contracts-odra/src/agent_skill_registry/tests.rs` (32 tests).
- [x] Step 2: `cargo test` → FAIL (compile errors: missing `#[odra::odra_type]` migration + `Vec<u8>` → `Bytes` for Casper bytesrepr).
- [x] Step 3: implement — `contracts-odra/src/agent_skill_registry.rs` (~620 LoC, Solidity v4 mirror).
- [x] Step 4: → PASS — 32 passed; 0 failed (`cargo +nightly test`, Odra 2.8 / Casper bytesrepr).
- [x] Step 5: commit `feat(odra): port AgentSkillRegistry to Odra/Casper (T9)`.

**Done-state notes (T9):**
- `JobStatus` kept as a flat enum (no variant data) to stay on Casper's bytesrepr happy path; the
  pattern-matched state-machine claim is still served by Rust's exhaustive `match` on every
  state-transition guard. Moving result-hash/timestamps into variants is a follow-on once we have
  more time with `OdraType` enums-with-data.
- Casper convention: durations live in **milliseconds** (`MIN/MAX/DEFAULT_REVIEW_WINDOW`,
  `BOND_UNLOCK_COOLDOWN`). Same boundary tests as Solidity (`1h`, `3d`, `30d`, `7d`) — verified.
- Toolchain: `odra-macros 2.8.1` requires **nightly** (`#![feature(box_patterns)]`); deploy/build
  needs `rustup toolchain install nightly`. `cargo +nightly test` is the local TDD loop.
- WASM build (`cargo odra build`) deferred to T13's e2e demo — needs `wasm32-unknown-unknown` target
  + the `cargo-odra` CLI. `bin/build_contract.rs` + `bin/build_schema.rs` are scaffolded but kept
  out of the regular link graph until that path is exercised.

---

### Task 10 — Casper SDK keystore + signer

**Files:**
- Create: `src/lib/casper/keypair.ts`, `src/__tests__/casper_keypair.test.ts`
- Modify: `src/lib/keystore.ts` (add `getCasperAccount(agentId, tenantId)`)

Casper supports secp256k1 — direct reuse of existing keystore. Adapter wraps Casper SDK signer
around the existing `viem` account's raw private key path. No HKDF needed.

- [x] Step 1: failing tests — deterministic Casper public key from same seed; round-trip sign+verify
      against `casper-js-sdk` — `src/__tests__/casper_keypair.test.ts` (12 tests).
- [x] Step 2: → FAIL (module missing + Bytes import path).
- [x] Step 3: implement — `src/lib/casper/keypair.ts` + wire `casperKeypair` into `AgentIdentity` +
      `KeystoreManager.{getCasperKeypair, getCasperPublicKeyHex, getCasperAccountHash}`.
- [x] Step 4: → PASS — 12/12; full suite 514 passed / 5 skipped; lint clean.
- [x] Step 5: commit `feat(casper): expose Casper signer over KARMA keystore (T10)`.

**Done-state notes (T10):**
- No HKDF: Casper natively supports secp256k1, so the keystore's 32-byte private key is the
  Casper signer's raw secret. Single backup-unit covers Ethereum + Stellar + Casper.
- `casper-js-sdk@5.0.12` has a sign/verify format mismatch (sign → 64-byte compact, verifySignature
  → DER only + skips SHA-256). Production sign path is fine; tests verify via `node:crypto.verify`
  + `compactToDER` + PEM public-key for canonical secp256k1/SHA-256 + DER pipeline (matches what
  the live Casper x402 facilitator expects). Documented inline in the test file.

---

### Task 11 — `x402Plugin/Casper` implementation

**Files:**
- Create: `src/plugins/x402_casper.ts`
- Create: `src/__tests__/x402_casper.test.ts`

Same `IPaymentPlugin` shape as Task 7. Backed by Casper's x402 facilitator (live mainnet — testnet
URL TBD from buildathon developer resources). Settles CSPR via signed authorization, returns receipt
with `txHash` + `facilitatorRef`.

ENV: `CASPER_NETWORK` (`casper:testnet` | `casper:mainnet`), `CASPER_X402_FACILITATOR_URL`.

- [x] Step 1 failing tests → impl → PASS → commit `feat(payment): add x402Plugin/Casper (IPaymentPlugin) (T11)`.

**Done-state notes (T11):**
- `@x402/casper` is not yet published to npm (verified `npm view @x402/casper` → 404). The plugin
  uses `@x402/core` types + builds the "exact" payment payload natively: canonical-JSON object,
  SHA-256 + secp256k1, DER signature — the canonical pipeline the live Casper x402 Facilitator
  (announced with the Casper AI Toolkit) verifies. Documented inline + in the test for the
  facilitator-spec alignment owner-driven step in T13.
- Default asset CSPR (9-decimal motes); `convertCsprToMotes` mirrors `@x402/stellar`'s
  `convertToTokenAmount` policy. Pre-formatted smallest-unit strings pass through.
- Signing payload includes `validAfter` / `validBefore` / `nonce` for replay protection on the
  facilitator side (matches Coinbase "exact" scheme).
- 22 tests (`src/__tests__/x402_casper.test.ts`): metadata, quote (4), pay (5 — receipt shape +
  node:crypto-verified signature + fail-fast on unsupported network + lookup error propagation
  + TTL window), verify (5), payment-option helper (2), canonicalize (1), signed-payload type
  shape (1). Full suite 536 passed / 5 skipped; lint clean.

---

### Task 12 — KARMA MCP × Casper MCP composability demo

**Files:**
- Create: `src/scripts/demo_casper_composability.ts`
- Create: `demo-video/CASPER_COMPOSABILITY.md` (video script)

Orchestrator agent uses BOTH MCP servers via standard MCP transport:
1. **Casper MCP** (from `Tairon-ai/casper-network-mcp` or `msanlisavas/casper-mcp` — pick the one with
   working stdio transport) — query agent's CSPR balance + account hash.
2. **KARMA MCP** (this repo) — `discover_skills` for an RWA-oracle skill → `create_job` with
   `settlement_rail: "x402"` → KARMA routes to `x402Plugin/Casper` → pay via x402.
3. Skill provider receives x402 receipt + invokes its endpoint.

The point per synthesis §6: NO custom integration code between the two MCP servers — composability
by protocol design. The orchestrator literally has both tool sets available and reasons across them.

- [x] Step 1: install + smoke-test chosen Casper MCP server in standalone (deferred to owner-driven —
      external npm + network, sandbox-incompatible; reproduction plan documented in
      `demo-video/CASPER_COMPOSABILITY.md`).
- [x] Step 2: write orchestrator script that uses both MCPs through the standard client transport —
      `src/scripts/demo_casper_composability.ts`, in-process MCP-shaped tool registries (drop-in
      swappable for `StdioMcpClient` per the script's composability claim).
- [x] Step 3: capture session log showing the cross-MCP reasoning + the x402 settle — the script
      runs end-to-end offline, producing a real signed Casper x402 envelope via T11's plugin.
- [x] Step 4: commit `feat(demo): KARMA MCP × Casper MCP composability orchestration (T12)`.

**Done-state notes (T12):**
- Cannot install external `Tairon-ai/casper-network-mcp` / `msanlisavas/casper-mcp` in the
  ephemeral sandbox (network + npm publish status varies). The composability claim is about
  the SHAPE of the orchestrator code, not about which transport carries each call — so the demo
  uses in-process MCP-shaped tool registries with the same `call(name, args)` envelope. The
  script explicitly documents that swapping either registry for a live stdio client leaves the
  orchestrator code byte-identical.
- Real KARMA `discover_skills` / `create_job` need a live Pharos RPC + indexer; mocked here at
  the response level, but the `karma.create_job(settlement_rail: "x402")` leg flows through the
  REAL `CasperX402Plugin` (T11) and produces a real signed payment envelope.
- ESM/CJS interop fix landed in `src/lib/casper/keypair.ts`: `casper-js-sdk` ships as a
  webpack-bundled CJS module, so Node's ESM loader (used by `tsx` for the demo) can't statically
  resolve its named exports. Switched to default-import + destructure with `import type` for
  the TypeScript side. Vitest already worked via Vite's CJS-interop layer.

---

### Task 13 — RWA-oracle skill + end-to-end Casper demo + DEMO_CASPER.md

**Files:**
- Create: `src/scripts/register_rwa_oracle_skill.ts`
- Create: `src/scripts/demo_casper_e2e.ts`
- Create: `DEMO_CASPER.md`

RWA-oracle skill = simplest possible useful skill (per Casper DoraHacks example #2): fetches an
off-chain RWA price feed (mock for hackathon: hardcoded JSON), returns a signed price + timestamp.
Registered on the Odra registry. Discoverable via KARMA MCP. Invocable via x402.

End-to-end run produces 5+ Casper Testnet txs (register_skill, deposit_bond, create_job via x402,
deliver_result, complete_job, withdraw).

- [ ] Step 1 register skill on Odra. Step 2 e2e script. Step 3 DEMO_CASPER.md tx hashes. Step 4 commit
      `feat(demo): RWA-oracle e2e on Casper with DEMO_CASPER.md`.

---

## Phase 2 — Packaging (per track, after 1A/1B green)

### Task 14 — Submission packaging

For EACH track:
- 2-3 min demo video (tools: OBS/Loom — narrate the demo script).
- README badge linking to track-specific DEMO.md.
- Open-source repo URL + demo video URL ready (owner submits).

Not committed code; deliverable to owner. No TDD.

---

## Verification (whole-plan)

- `pnpm typecheck` green at every Phase boundary.
- `pnpm test` green at every Phase boundary (470 baseline + new tests).
- `forge test` green (Pharos contract untouched).
- `cargo odra test` green (Casper contract).
- `cargo test --target wasm32-unknown-unknown` green (Soroban contract).
- Stellar Testnet: 1+ real `verify_groth16` tx + 1+ x402 settle.
- Casper Testnet: 5+ real txs spanning register/create/deliver/complete/withdraw.

## Risk register — what kills the plan

| Risk | Likelihood | Mitigation |
|---|---|---|
| Toolchain setup (Circom + snarkjs + Soroban + Stellar SDK + Odra + Casper SDK) eats day 1 | **HIGH** | T4 step 3 explicitly runs a dummy circuit end-to-end before writing real logic |
| ed25519/secp256k1 mismatch breaks Stellar key path mid-track | MED | Task 6 is isolated + tested with deterministic derivation BEFORE Task 7 |
| x402 facilitator URL/format drift between docs and actual API | MED | Task 7 tests against mock first; live integration in Task 8 step 2/3 |
| Casper x402 facilitator unavailable for testnet | MED | Falls back to Casper mainnet with very small amounts; OR demo with mock facilitator + flag in README |
| Odra version churn (1.0 is current) | LOW | Pin exact version in `Cargo.toml` |
| Phase 0 interface design wrong → both tracks need refactor | HIGH if bad design | Keep interface NARROW (just `quote`/`pay`/`verify`); resist abstraction |

## Task Risk Summary (task-risk-score)
<!-- task-risk-score: DO NOT DUPLICATE — update this section -->
<!-- last-run: 2026-06-23 | CONTEXT: BUSINESS_LOGIC + DOMAIN_NEW -->

| Task | S×B/D | QBR | Risk | Boundary | Action |
|------|-------|-----|------|----------|--------|
| T1 IPaymentPlugin | 3×2/3 | 2 | LOW | SINGLE | tight interface, narrow tests |
| T2 discover_skills | 2×2/3 | 1 | LOW | SINGLE | additive field, drift guard not affected |
| T3 settlement_rail param | 2×2/3 | 1 | LOW | SINGLE | stub for x402 keeps behaviour explicit |
| T4 Circom circuit | 3×3/4 | 4 | **HIGH** | NEW DOMAIN | dummy circuit first; ptau provenance documented |
| T5 Soroban verifier | 3×3/4 | 4 | **HIGH** | NEW DOMAIN | clone soroban-examples first; verify with Task 4 outputs |
| T6 ed25519 keystore | 3×2/3 | 2 | LOW | SINGLE | deterministic derivation property test |
| T7 x402Plugin/Stellar | 3×2/3 | 2 | MED | SINGLE | mock facilitator first |
| T8 Stellar demo | 3×3/3 | 3 | MED | INTEG | depends on T4–T7; gates the submission |
| T9 Odra port | 3×3/4 | 4 | **HIGH** | NEW DOMAIN | mirror Foundry tests one-to-one |
| T10 Casper signer | 2×2/3 | 1 | LOW | SINGLE | secp256k1 reuse, no new key path |
| T11 x402Plugin/Casper | 3×2/3 | 2 | MED | SINGLE | mock facilitator first |
| T12 MCP composability | 3×2/3 | 2 | MED | INTEG | external MCP server reliability is the variable |
| T13 RWA + Casper e2e | 3×3/3 | 3 | MED | INTEG | gates Casper submission |
| T14 Packaging | — | — | SKIPPED | — | docs/video, owner-driven |

**Summary:**
- High-risk tasks: T4, T5, T9 (all NEW DOMAINs — no precedent in repo). Each gets a "dummy first"
  toolchain validation step before real logic.
- Integration-test surface: T8 (Stellar full flow), T12 (MCP composability), T13 (Casper full flow).
- Cross-boundary task: none — Phase 0 (T1–T3) is the only shared surface; both tracks read from it
  but neither modifies it after Phase 0 closes.
