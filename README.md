# KARMA

> 🤖 **Casper Agentic Buildathon — judges start here:** [DEMO_CASPER.md](DEMO_CASPER.md) ·
> [90-second visual walkthrough](docs/media/casper-judges.html) · an RWA price-oracle agent that
> discovers a skill, pays for it over a real signed x402 envelope, and settles the job on an Odra
> `AgentSkillRegistry` — trust from escrow + cryptography, not a server anyone has to take on faith.
>
> [![KARMA on Casper — judge walkthrough: real x402 payment verification, 120/120 Odra contract tests, RWA-oracle archetype](docs/media/casper-judges-hero.png)](docs/media/casper-judges.html)
>
> ☝️ **The terminal panels in that page are a real captured run**, not typed-out copy — reproduce
> them yourself with `pnpm exec tsx src/scripts/demo_casper_x402_live.ts` (real local HTTP 402 →
> pay → verify loop), `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` (120/120),
> and `contracts-odra/build-wasm.sh` (a real, `WebAssembly.validate()`-clean 534KB
> `karma_odra.wasm`, all 24 entry points exported). Submitting that wasm to Testnet is the one
> remaining step, gated on a funded key nobody should paste into an AI session — see
> [DEMO_CASPER.md](DEMO_CASPER.md) for exactly where that stands and how to finish it.

> 🏆 **Stellar Hacks: Real-World ZK — judges start here:** [DEMO_STELLAR.md](DEMO_STELLAR.md) ·
> live Soroban verifier [`CDBIDMG2…SATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP)
> on Testnet · a Groth16/BN254 credential proof verified on-chain via native host functions
> (CAP-0074), with a score-bound commitment, an on-chain-pinned job-history root, a
> replay-guarded nullifier, and a per-call USDC x402 fast-lane.
>
> ![Live Stellar Testnet terminal: real WASM fetch, real on-chain reads, a real replay attack rejected by two independently deployed Groth16/BN254 verifiers](docs/media/stellar-live-evidence.gif)
>
> ☝️ **Not a recording of a script — every command above hit Stellar Testnet live** (regenerate
> it yourself: `docs/media/record-stellar-evidence.sh`).
>
> 🎬 **[Watch the ~78s narrated video](docs/media/stellar-zk-demo.mp4)** — the idea, the 2
> soundness bugs we found in our own circuit and how we fixed them, then the live
> "proof + payment in one HTTP request" flow running for real, voiceover included.

> A protocol for agent economies — not a single-chain app. Agents publish skills, get discovered
> by relevance and reputation, and invoke each other under enforceable trust gates: identity,
> reputation, and settlement, specified once and implemented per chain. Built on **SUPER-MCP**
> (Layer 0, bundled here under `src/core`, `src/mcp`, `src/middlewares`, `src/storage`) — a
> hardened TypeScript/ESM MCP server.

**KARMA is a spec with reference implementations, not a spec with one implementation.**
[`docs/standards/`](docs/standards/) defines `IPaymentPlugin v1` (a 3-method settlement
interface — `quote` / `pay` / `verify`) and a public, PR-governed `IdentityPolicy` registry.
**Stellar and Casper are both already v1.0 ✓ conformant** implementations of that same interface
(see [reference-implementations.md](docs/standards/reference-implementations.md)); Pharos is the
original chain the spec was extracted from. The documented playbook for landing a new chain
adapter is estimated at **1–2 sessions** — not months. That's the actual bet here: this isn't
"KARMA also runs on your chain," it's "your chain becomes a conformant node in a protocol that
already runs on two others" — and the deepest, earliest implementation is the one every later
adopter has to interoperate with.

**On Stellar specifically, that implementation is the deepest one we've shipped.** Trust is
enforced by math, not a server: an agent proves "my reputation is above this skill's threshold"
via a Groth16 proof, verified on-chain by Stellar's native BN254 host functions (CAP-0074) — the
actual score, job history, and identity never leave the agent — and settles per-call in USDC over
x402, live, in one HTTP request. Full story + live evidence: [DEMO_STELLAR.md](DEMO_STELLAR.md).

The same skill / identity / reputation model is also proven end-to-end on **Pharos** (Solidity
escrow + reputation, live contract, 96 Foundry tests) and **Casper** (Odra port, 120 Rust tests),
gating identity via the **Terminal3 Agent Auth SDK** where a chain supports server-mediated
identity — real, tested, independently-judged proof that the spec holds up outside Stellar too,
not just a claim. Details in [DEMO.md](DEMO.md) · [DEMO_CASPER.md](DEMO_CASPER.md) ·
[docs/RUNTIME.md](docs/RUNTIME.md).

---

## Why KARMA

- **A protocol, not a port.** `IPaymentPlugin v1` and the `IdentityPolicy` registry are versioned,
  documented specs (`docs/standards/`) — Stellar and Casper are independent, v1.0-conformant
  implementations of the same interface, not copy-pasted integrations. Adding a fourth chain follows
  a documented recipe estimated at 1–2 sessions.
- **Zero-knowledge reputation gating (Stellar track).** An agent proves "reputation ≥ threshold for
  skill Y" via Groth16, verified on-chain by Stellar's native BN254 host functions (CAP-0074) — the
  score, job history, and credential secret never leave the agent. Two independent verifier contracts
  (single-skill gate + portfolio credential) are live on Testnet. See [DEMO_STELLAR.md](DEMO_STELLAR.md).
- **Sybil-resistant reputation.** Protected against wash-trading: an arm's-length guard (self-dealing
  earns zero rep), EigenTrust-lite flow ranking off-chain (value-weighted, decay-friendly), and an
  optional on-chain capital bond — the same reputation kernel every chain adapter reads from.
- **Real on-chain settlement, proven on multiple chains.** Escrow + dispute + refund on Pharos
  (Solidity, live), ZK credential verification on Stellar (Soroban, live), skill composition on
  Casper (Odra, 120 tests) — same trust model, chain-appropriate enforcement each time, not three
  unrelated demos.
- **Non-repudiation & bounded authority (Terminal3-gated chains).** Every job binds to a signed
  identity receipt, and delegated authority is always TEE-signed, time-bounded, and revocable — never
  a permanent grant.

## Architecture (Stellar ZK track)

```text
Agent (client-side, off-chain)             Soroban verifier (on-chain, Stellar Testnet)
───────────────────────────────            ─────────────────────────────────────────────
1. Generate AgentCredentialProof           1. Groth16 pairing check via native BN254 host
   (Circom, Groth16 over BN254,               functions — env.crypto().bn254(), CAP-0074,
   score bound into the commitment)            no Arkworks, no software EC arithmetic
2. Build x402 payment payload              2. Check the proof's Merkle root against the
   (USDC on Stellar Testnet)                   admin-published job-history root (set_skill_root)
3. POST /invoke with proof + receipt       3. Check the nullifier hasn't been used — replay
   headers, no KARMA server in the path        guard, reverts Error(Contract, #5) on reuse
                                            4. If all pass: execute skill, return result
```

This diagram isn't aspirational — `src/scripts/demo_stellar_x402_live.ts` runs it for real: a
signed x402 payment (Soroban auth entry) and the ZK proof travel in one client HTTP POST, and the
provider stub settles the USDC on-chain and verifies the proof on-chain before responding. Full
architecture, the two soundness gaps we found in our own circuit + how we fixed them, and the live
transaction table (including this flow's settlement + proof-verification tx hashes):
[DEMO_STELLAR.md](DEMO_STELLAR.md).

**The same spec, proven on other chains too** (separate, already-judged submissions — condensed
here so this README stays legible for the Stellar track, but this is the evidence behind the
"protocol, not a port" claim above, not filler):

| Chain | What's live | Spec conformance | Tests |
|---|---|---|---|
| **Pharos** (`contracts/AgentSkillRegistry.sol`) | Escrow, 3-day review window, dispute/refund, Sybil-resistance bond, evaluator-agent arbitration, multisig+timelock governance. Contract deployed, see [Live deployment](#live-deployment). | original chain the spec was extracted from; `IPaymentPlugin` wrapper pending (v2) | 96 Foundry tests |
| **Terminal3** (`t3.tool.ts`, `@terminal3/t3n-sdk`) | SIWE/EIP-191 identity gate (`did:t3n:…`), TEE-signed bounded delegation credentials. Verified live against the Terminal3 testnet. | reference `IdentityPolicy` implementation (value `1`/`2` in the [open registry](docs/standards/IdentityPolicy-registry.md)) | — |
| **Casper** (`contracts-odra/`) | Odra port of the registry + skill composition with weighted revenue split. | `IPaymentPlugin` **v1.0 ✓** | 120 Rust tests |

Deep dives if useful: [DEMO.md](DEMO.md) (Pharos), [DEMO_CASPER.md](DEMO_CASPER.md) (Casper),
[docs/standards/reference-implementations.md](docs/standards/reference-implementations.md) (spec
conformance matrix, all chains), [docs/RUNTIME.md](docs/RUNTIME.md) (full operations reference).

---

## Tools

This is a real, full MCP server — 13 skill-economy tools + 8 Terminal3 identity tools + 8 Casper
Odra registry tools, all in-process, all backed by live testnet chains (Pharos escrow, Terminal3
SIWE identity, Casper AgentSkillRegistry). Expand for the full surface:

<details>
<summary><strong>Full tool tables</strong></summary>

### KARMA skill economy (Layer 1)

| Tool | Kind | Purpose |
|---|---|---|
| `karma_health` | read | Runtime canary; RPC/contract env presence + skill-indexer health. |
| `register_skill` | write | Register a skill on-chain (name, price, endpoint, optional reputation Trust-Gate + `identityPolicy`) + BM25 upsert. |
| `discover_skills` | read | BM25 search (prefix + fuzzy), reputation-boosted, `maxPriceWei` / `minReputation` filters. |
| `create_job` | write | Idempotent escrow via `taskHash`; enforces the skill's identity + reputation gates (single path); `exists` on replay. Supports optional `evaluator` + `evaluatorFeeWei` (P0-A). |
| `deliver_result` | write | Provider submits `resultHash`; opens the 3-day review window. |
| `complete_job` | write | Requester confirms; releases escrow + bumps reputation (arm's-length only, Tier-0). |
| `dispute_result` | write | **P1-A (bond-backed):** Requester rejects within the window by locking a dispute bond (proportional to escrow). |
| `claim_after_review` | write | Provider claims after the window if the requester ghosted (anti-deadlock). |
| `evaluate_result` | write | **P0-A:** Neutral evaluator approves (escrow → provider) or rejects (refund → requester). |
| `read_job` | read | Read one job's on-chain state by id; exposes `evaluator` and `evaluatorFee` fields. |
| `get_agent_reputation` | read | Agent's skills + scores + on-chain `agentReputation`. |
| `query_social_graph` | read | Job edges for an agent (as provider / requester). |
| `get_pending_balance` | read | Withdrawable balance in wei + formatted PHRS. |
| `withdraw_balance` | write | Pull released escrow to the agent's wallet. |

### Terminal3 identity & delegation (Layer 3)

| Tool | Purpose |
|---|---|
| `t3_health` | Validate `T3N_NODE_URL` and load the WASM TEE component. |
| `t3_verify_identity` | Authenticate an agent (SIWE/EIP-191) → cache its `did:t3n:…`. |
| `t3_create_verified_job` | Dual-gate job: verified DID **and** on-chain reputation. |
| `t3_get_usage` | Read TEE token balance / consumption (`getUsage`). |
| `t3_get_audit_events` | Fetch the immutable TEE audit trail (`getAuditEvents`). |
| `t3_sign_job_commitment` | EIP-191 non-repudiation receipt for a job (`eip191Digest` + `compactDidFromBytes`). |
| `t3_authorize_payroll_agent` | Issue a TEE-signed, bounded, revocable delegation credential; attempt org-grant + payroll invocation. |
| `t3_revoke_payroll_authorization` | Revoke the credential entirely or narrow its function set. |

The SDK is exercised across ~23 distinct surfaces (WASM loader, `T3nClient` lifecycle, EIP-191
`GuestToHostHandler`, delegation-credential builders + custodial signer, org-data client, usage/audit
reads, standalone crypto primitives). Raw private keys never leave `KeystoreManager` — all signing
goes through viem `Account.signMessage` or the TEE-side custodial signer.

### Casper skill registry (Layer 1, Odra) — `casper.tool.ts`

The RWA-oracle flow ([DEMO_CASPER.md](DEMO_CASPER.md)) as MCP tools, not just standalone scripts —
any MCP client can drive Casper's Odra `AgentSkillRegistry` directly. Each write builds, signs,
and submits a real `casper-js-sdk` transaction (`src/lib/casper/live_client.ts`); reads query the
contract's on-chain "state" dictionary directly (`src/lib/casper/odra_storage_key.ts`). Requires
`CASPER_RPC_URL` + `KARMA_ODRA_REGISTRY` — `casper_health` reports whether they're set.

| Tool | Kind | Purpose |
|---|---|---|
| `casper_health` | read | Whether `CASPER_RPC_URL` + `KARMA_ODRA_REGISTRY` are configured. |
| `casper_register_skill` | write | Register a skill (name, price, `identityPolicy`) — real signed transaction. |
| `casper_deposit_bond` | write | Lock a Tier-2 Sybil-resistance bond (PD-007). |
| `casper_create_job` | write | Create + escrow a job against a skill (payable, `amount` = price). |
| `casper_deliver_result` | write | Provider records a result hash, opens the review window. |
| `casper_confirm_completion` | write | Requester releases escrow + bumps reputation (arm's-length). |
| `casper_withdraw` | write | Pull the caller's released-escrow balance (CEI pull-payment). |
| `casper_get_account_state` | read | Pending balance + reputation + bonded amount, read live from chain. |

</details>

---

## Chain-agnostic settlement & cryptographic primitives

The core is settlement-agnostic: a narrow `IPaymentPlugin` (`quote` / `pay` / `verify`) and a
`SettlementRail` (`"x402"` | `"escrow"`) let the same skill / identity / reputation model settle across
chains. Pharos escrow and both Stellar ZK verifiers are **live on-chain**; Casper's contract
compiles to a real, verified wasm today (`contracts-odra/build-wasm.sh`) and is reachable through
8 MCP tools (`casper.tool.ts`) — the chain leg remains owner-driven testnet (funding + signing the
deploy needs a real key, which stays with its owner, not in this session).

| Capability | Where | Status |
|---|---|---|
| `IPaymentPlugin` interface + registry | `src/lib/payment/` | in-repo, tested |
| x402 **Stellar** rail (USDC; ed25519 via HKDF) | `src/plugins/x402_stellar.ts` · `src/lib/stellar/keypair.ts` | testnet, real funded accounts |
| x402 **Casper** rail (CSPR) | `src/plugins/x402_casper.ts` · `src/lib/casper/keypair.ts` · `src/lib/casper/live_client.ts` | real HTTP + ECDSA verify loop today ([demo](src/scripts/demo_casper_x402_live.ts)); on-chain settlement testnet (owner-driven) |
| **AgentCredentialProof** — Circom Groth16, verified on-chain via **native BN254 host functions** (`env.crypto().bn254()`, CAP-0074/Protocol 25 — no Arkworks) | `circuits/src/agent_credential.circom` · `contracts-soroban/agent_credential_verifier` | **live on Testnet** |
| **ReputationAggregationProof** (T1.1) — portfolio credential (N=8, `validMask`, `providerId`), same native BN254 verifier path | `circuits/src/reputation_aggregation.circom` · `contracts-soroban/reputation_aggregation_verifier` · `src/lib/zk/reputation_aggregation.ts` | **live on Testnet** |
| **Cross-chain reputation oracle** (T1.3) — folds indexed Pharos rep into a provable credential | `src/lib/zk/rep_oracle.ts` | in-repo, tested |
| **Signed-TLS attestation** (T1.4 fallback) — verifiable RWA price feed | `src/lib/zk/signed_tls_attestation.ts` | in-repo, tested |
| **Skill composition** (T2.1) — weighted revenue split + reputation propagation | `contracts-odra/src/agent_skill_registry.rs` · `src/lib/casper/{odra_registry,composition_tools}.ts` | Odra + in-process, tested |
| **Autonomous economic loop** (T5.1) — budget-capped goal loop + dashboard | `src/lib/autonomous_loop/` · `src/scripts/run_autonomous_loop.ts` | dry-run tested; `--live` owner-driven |
| **Trust-kernel hardening** (T0.1/T0.2) — dispute-rate + anti-wash into flow reputation | `src/lib/flow_reputation.ts` | in-repo (Sybil Tier-1) |

Public specs live in [`docs/standards/`](docs/standards/) (IPaymentPlugin v1, IdentityPolicy registry,
reference implementations); open design in [`docs/rfc/`](docs/rfc/) (symmetric dispute bond, P3-hard).

```bash
pnpm demo:cross-chain     # Pharos rep → ZK proof → Casper RWA (signed-TLS) → settle  (offline)
pnpm demo:self-hosting    # KARMA registers its own oracle as a paid skill on itself  (offline)
pnpm exec tsx src/scripts/demo_casper_composability.ts    # KARMA-MCP × Casper-MCP composability
pnpm exec tsx src/scripts/run_autonomous_loop.ts --ticks 20   # autonomous loop (dry-run)
```

---

## Live deployment

**Stellar Testnet** (Soroban, native BN254) — full tx table + reproduction steps in
[DEMO_STELLAR.md](DEMO_STELLAR.md):

| | |
|---|---|
| **`agent_credential_verifier`** | [`CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| **`reputation_aggregation_verifier`** | [`CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |

<details>
<summary><strong>Pharos + Terminal3 (separate, already-judged submission)</strong></summary>

| | |
|---|---|
| **Contract (v3)** | [`0xc6d5c146209e0833634bd33fafb9e65081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae) |
| **Deploy block** | 24360873 (Pharos Atlantic) |
| **Pharos chain ID** | `688689` (EIP-1559) |
| **Pharos RPC** | `https://atlantic.dplabs-internal.com` |
| **Pharos explorer** | `https://atlantic.pharosscan.xyz` · currency PHRS (18 dp) |
| **Terminal3 node** | `https://cn-api.sg.testnet.t3n.terminal3.io` (testnet) |

The in-repo contract (`contracts/AgentSkillRegistry.sol`) incorporates evaluator-agent arbitration,
multisig+timelock governance, and a symmetric dispute bond beyond what's deployed above; redeploy is
pending. Full details: [DEMO.md](DEMO.md).

</details>

---

## Quick start

> For the Stellar ZK track specifically, [DEMO_STELLAR.md](DEMO_STELLAR.md) has its own
> self-contained quickstart (circuit + Soroban contract, no Pharos wallet needed). The steps below
> are for running the general MCP server / test suite / Pharos demo.

### Requirements

- Node.js 20+, pnpm 9.15.9 (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- [Foundry](https://book.getfoundry.sh/) (`foundryup`) for the Solidity tests
- A funded Pharos Atlantic wallet for deploy / on-chain demo
- Redis 8.2.2+ only if `STORAGE_DRIVER=redis` (production)

### Install & validate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test          # 636 passed, 1 skipped
pnpm build
```

### Create a keystore

```bash
KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=<min-8-chars> \
  pnpm setup:keystore agent-alpha agent-beta
```

Generates fresh keypairs (Web3 Secret Storage v3, scrypt + aes-128-ctr), writes `keystore.json`
(`0o600`), and prints each address to fund from a
[Pharos faucet](https://stakely.io/faucet/pharos-atlantic-testnet-phrs).

### Run (stdio) with the KARMA economy enabled

```env
# .env
TRANSPORT_DRIVER=stdio
STORAGE_DRIVER=fs
MCP_SAFE_MODE=false
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts,t3.tool.ts,casper.tool.ts
MCP_PLUGIN_ISOLATION_MODE=policy
PHAROS_RPC_URL=https://atlantic.dplabs-internal.com
PHAROS_CONTRACT_ADDRESS=0xc6d5c146209e0833634bd33fafb9e65081b905ae
KEYSTORE_PATH=./keystore.json
KEYSTORE_PASSWORD=<password>
# T3N_NODE_URL is optional — the code targets the Terminal3 testnet by default.
```

```bash
pnpm build && pnpm start
```

`karma.tool.ts` and `t3.tool.ts` **must** run in-process (`MCP_PLUGIN_ISOLATION_MODE=policy`); they
hold the in-process keystore and fail closed (`assertInProcess()`) if dispatched to the external
plugin runner. Example MCP client config:

```json
{
  "mcpServers": {
    "karma": {
      "command": "node",
      "args": ["/absolute/path/to/KARMA/dist/index.js"],
      "env": { "TRANSPORT_DRIVER": "stdio", "STORAGE_DRIVER": "fs", "MCP_SAFE_MODE": "false" }
    }
  }
}
```

HTTP transport, production auth (JWT/OIDC), Docker, and the full configuration reference are in
[docs/RUNTIME.md](docs/RUNTIME.md).

---

## Demo

*(Pharos track — for the Stellar ZK demo, see [DEMO_STELLAR.md](DEMO_STELLAR.md).)*

```bash
pnpm demo:discover     # offline: BM25 ranking + injection sanitization, no chain/keystore
```

Full on-chain loop (needs a funded keystore + deployed contract):

```bash
# Deploy (or reuse the live address above), then:
KEYSTORE_PASSWORD=<password> pnpm demo          # register → escrow (+replay) → deliver → confirm → withdraw
KEYSTORE_PASSWORD=<password> pnpm demo:verify
KEYSTORE_PASSWORD=<password> pnpm demo:trust-gate
```

Each step calls the real tool handler → `KarmaService` → Pharos Atlantic. The completed 5-transaction
loop is recorded in [DEMO.md](DEMO.md).

---

<details>
<summary><strong>Terminal3 integration status</strong> (separate, already-judged submission)</summary>

Verified **live against the Terminal3 testnet** (not just mocks):

- ✅ **Authentication** — an agent's Ethereum keystore wallet authenticates via SIWE/EIP-191 and
  receives its own `did:t3n:…`. No external account linkage required.
- ✅ **Delegation lifecycle** — `t3_authorize_payroll_agent` issues a real TEE-signed delegation
  credential (`signCustodial`), and `t3_revoke_payroll_authorization` revokes it. Issue → revoke is
  proven end-to-end.
- ⚠️ **Org-grant provisioning & payroll invocation** — depend on a pre-provisioned organisation and a
  deployed `tee:payroll` contract, which are **not available on the public testnet**
  (`OrganisationNotFound` / `404`). These steps degrade gracefully and return structured evidence;
  the credential itself remains the verifiable artifact.

Notes for integrators:

- The SDK defaults to the `production` environment, whose node is unreachable for development; KARMA
  calls `setEnvironment("testnet")` so `getNodeUrl()` targets the public testnet. `T3N_NODE_URL`
  overrides it.
- Terminal3's EthSign challenge is **SIWE (EIP-4361)**: the handler signs a SIWE message (challenge
  embedded as the hex `Nonce`) and returns `{ host_to_guest, message, signature }` with the signature
  base64-encoded. Signing raw challenge bytes, omitting `message`, or hex-encoding the signature pass
  SDK-mocked unit tests but fail the live WASM — always confirm new call sequences with a live smoke
  run (`src/scripts/t3_payroll_smoke.ts`), not just mocks.
- Paid TEE operations (e.g. custodial credential signing) require a funded Terminal3 account; identity
  verification and usage reads are free.

Residual gaps tracked as `PATTERN-DEBT-T3N-00x` in [docs/RUNTIME.md](docs/RUNTIME.md) and the
app-layer pattern-debt registry: the DID session store is now shared + TTL'd + address-bound (closes the
ad-hoc cache), but still in-memory ⇒ single-process/restart-volatile until a redis-backed parity is added
for multi-replica.

</details>

---

## Testing

**Stellar ZK track:**

```bash
cd contracts-soroban/agent_credential_verifier && cargo test --features testutils       # 12/12
cd contracts-soroban/reputation_aggregation_verifier && cargo test --features testutils # 19/19
cd circuits && make credential && make repagg    # circuit compile + real Groth16 prove/verify
```

Both Soroban test suites include a real, non-mocked Groth16 proof verified via the native
`bn254_multi_pairing_check` host function (no Arkworks fallback) — see [DEMO_STELLAR.md](DEMO_STELLAR.md).

<details>
<summary><strong>Other chains</strong> (separate, already-judged submissions)</summary>

```bash
pnpm test            # full Vitest suite (641 passed, 1 skipped)
pnpm typecheck       # tsc --noEmit
pnpm test:contract   # Foundry tests for AgentSkillRegistry.sol (96 tests, requires forge)
pnpm test:enterprise # Layer-0 runtime hardening suites
pnpm ci              # typecheck + lint + test
```

Contract test coverage (Foundry): **96 Solidity tests** including P1-A symmetric dispute bond
scenarios, P0-A evaluator agent scenarios, and P0-B governance/timelock scenarios.

Odra/Casper: **120 Rust tests** (`contracts-odra/src/agent_skill_registry/tests.rs`) covering the
full parallel feature set including P0-A/P1-A mechanics ported for ms-based time and U512 arithmetic.

</details>

The ABI drift guard (`src/__tests__/karma_contract.test.ts`) fails if the Solidity surface diverges
from `src/lib/abi.ts`. Live T3N call sequences are covered by `src/scripts/t3_payroll_smoke.ts`.

---

## Project layout

```text
src/
  core/          SUPER-MCP runtime core (tasks, request context, pattern debt)
  mcp/           protocol adapters, tool registry, transports
  middlewares/   auth, rate limit, quota, idempotency, output firewall
  storage/       fs / redis / memory drivers + encryption (v3 hkdf, v4 kms)
  plugins/
    karma.tool.ts   Layer 1 — 14 skill economy tools (in-process)
    t3.tool.ts      Layer 3 — Terminal3 identity & delegation tools (in-process)
    x402_stellar.ts / x402_casper.ts   IPaymentPlugin settlement rails
  lib/           KarmaService, keystore, viem clients, BM25 index, ABI, flow_reputation
    payment/         IPaymentPlugin interface + registry
    zk/              RepAgg proof wrapper, cross-chain rep oracle, signed-TLS attestation
    stellar/ casper/ HKDF-derived keypairs; in-process Odra registry + composition tools
    autonomous_loop/ T5.1 loop core + dashboard + live/dry-run runner
  scripts/       setup_keystore, deploy_contract, demos (cross-chain, self-hosting,
                 stellar/casper), run_autonomous_loop, t3_payroll_smoke
  __tests__/     Vitest suites (runtime + app layer) — 71 files
circuits/        Circom circuits: agent_credential, reputation_aggregation (+ snarkjs harness)
contracts/       AgentSkillRegistry.sol + KarmaTimelock.sol (Foundry, Pharos)
contracts-soroban/   Stellar verifiers: agent_credential, reputation_aggregation (Rust)
contracts-odra/      Casper AgentSkillRegistry + skill composition (Odra / Rust)
docs/            RUNTIME.md, standards/, rfc/, ADRs, plans, session handoffs
```

---

## Security notes

- The external child-process plugin runner is **best-effort hardening, not** an OS/container/microVM
  sandbox; untrusted third-party plugins are not yet supported in production (DEBT-001).
- `karma.tool.ts` / `t3.tool.ts` use an in-process keystore and must run in-process; they throw at
  startup in the external worker.
- The keystore is testnet-only. Rotate `KEYSTORE_PASSWORD` (re-encrypt) if it is ever exposed;
  `keystore.json*` and `.env*` are gitignored.
- Raw private keys never leave `KeystoreManager` — signing is done by viem `Account` or the TEE.

For auth modes, KMS-backed crypto-erasure, the output firewall, and the complete configuration
reference, see [docs/RUNTIME.md](docs/RUNTIME.md).

---

## License

See [LICENSE](LICENSE).
