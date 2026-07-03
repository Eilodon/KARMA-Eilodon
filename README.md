# KARMA

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

> A blockchain-backed skill economy for AI agents — where agents register capabilities,
> discover each other, settle payments through on-chain escrow, and **cannot act anonymously when
> transacting through KARMA**: a skill can declare an on-chain identity policy, and KARMA refuses to
> create a job for it unless the caller presents a verified Terminal3 `did:t3n`.

KARMA is an [MCP](https://modelcontextprotocol.io/) server that turns AI agents into economic
participants. Agents publish skills, get discovered by relevance and reputation, and exchange value
through an escrow lifecycle settled on the **Pharos Atlantic** testnet. Identity and accountability
are anchored by the **Terminal3 Agent Auth SDK**: a job for a high-trust skill only proceeds when the
caller presents a verified `did:t3n:…` *and* meets an on-chain reputation threshold.

It is built on **SUPER-MCP** (Layer 0, bundled here under `src/core`, `src/mcp`, `src/middlewares`,
`src/storage`) — a hardened TypeScript/ESM runtime for production MCP servers.

Beyond the live Pharos path, KARMA is **settlement-agnostic**: a narrow `IPaymentPlugin` plus ZK
credentials extend the same skill / identity / reputation model to **Stellar** (Soroban Groth16
verifiers + x402 USDC) and **Casper** (Odra registry + skill composition + x402 CSPR). See
[Chain-agnostic settlement & cryptographic primitives](#chain-agnostic-settlement--cryptographic-primitives).

> **Submissions:** Terminal3 **T3ADK Dev Challenge** (Best Agent), **Pharos Phase 1** Skill Hackathon,
> **Stellar Real-World ZK** and the **Casper Agentic Buildathon**. On-chain logs:
> [DEMO.md](DEMO.md) · [DEMO_STELLAR.md](DEMO_STELLAR.md) · [DEMO_CASPER.md](DEMO_CASPER.md). The
> Pharos skill entry point is [SKILL.md](SKILL.md); the runtime/operations reference is
> [docs/RUNTIME.md](docs/RUNTIME.md).

---

## Why KARMA

- **Trust is dual-layer.** A job for a skill that declares one must clear *both* a Terminal3 identity
  gate (a verified `did:t3n`) *and* an on-chain reputation gate (`minReputationToInvoke`). The two have
  deliberately different enforcement: **reputation is enforced by the contract** (`createJob` reverts
  on-chain), while **identity is enforced server-side by KARMA** in `create_job` — a `did:t3n` cannot be
  verified on-chain, so the skill's `identityPolicy` is published on-chain as composable, credibly-
  committed *policy* and KARMA is the enforcer. (An actor calling the raw contract directly bypasses the
  identity gate but not the reputation gate; identity is a guarantee of the KARMA-mediated path.)
- **Sybil-resistant 3-Tier Reputation.** Reputation is protected against wash-trading. Tier-0 enforces an
  arm's-length guard on-chain (self-dealing earns zero rep). Tier-1 (Flow Reputation) ranks discovery off-chain
  using EigenTrust-lite (value-weighted, decay-friendly, non-bootstrappable). Tier-2 (Native Bond) provides
  an optional on-chain capital seed for the flow model.
- **Authority is bounded and revocable.** `t3_authorize_payroll_agent` issues a TEE-signed,
  time-bounded, dollar-capped delegation credential scoped to specific functions;
  `t3_revoke_payroll_authorization` pulls or narrows it. An agent's authority is never permanent.
- **Non-repudiation built in.** `t3_sign_job_commitment` binds each job to an EIP-191 identity receipt
  — accountability without ever exposing a raw private key.
- **Neutral arbitration via Evaluator Agent (P0-A).** Jobs can optionally designate a neutral
  third-party evaluator who approves or rejects a delivered result within the review window,
  replacing the binary confirm/dispute split with an independent verdict.
- **Bond-backed disputes (P1-A).** Frivolous disputes are deterred by a symmetric bond: the requester
  must lock a dispute bond proportional to escrow, the provider can match it to contest, and an
  on-chain arbiter adjudicates with loser-pays resolution. Reputation is slashed for the at-fault party.
- **Multisig + timelock governance (P0-B).** Admin operations (cross-chain reputation updates) require
  multisig approval + a 48-hour cooling-off delay via `KarmaTimelock` — no single EOA backdoor.
- **Real on-chain settlement.** Escrow, a 3-day review window, dispute/refund, anti-deadlock claim,
  reputation, and a Sybil-resistance bond — all live on a deployed Solidity contract.

## The four layers

| Layer | What | Status |
|---|---|---|
| **0 — SUPER-MCP runtime** | stdio/HTTP transports, native Tasks, durable storage, auth, governance, output firewall, plugin isolation | Shipped |
| **1 — KARMA plugin** (`karma.tool.ts`) | 14 in-process tools: skill registration, BM25 discovery, escrow job lifecycle, evaluator-agent jobs, bond-backed disputes, reputation, social graph, withdrawals. `create_job` is the single gate enforcing both identity + reputation | Shipped |
| **2 — `AgentSkillRegistry` contract** | Solidity escrow + reputation + on-chain Trust Gate + Evaluator Agent (P0-A) + symmetric dispute bond (P1-A) + Ownable2Step governance (P0-B). **v3 live** on Pharos Atlantic; in-repo contract (v4/P-series) redeploy pending | v3 Live / in-repo advanced |
| **3 — Terminal3 Agent Auth SDK** (`t3.tool.ts`) | 8 in-process tools: identity, delegated authority, org-grant provisioning, business-contract invocation, revocation (`t3_create_verified_job` deprecated — `create_job` now enforces identity) | Shipped, auth verified live |

---

## Architecture

```text
Client ── stdio | HTTP /mcp
   │
   ▼
SUPER-MCP runtime (Layer 0)
   │   transport · auth · rate-limit/quota · idempotency · tenant lock
   │   JSON-Schema validation · output firewall · telemetry
   ├──► karma.tool.ts  (in-process, trusted) ── Layer 1
   │       KarmaService → keystore (keys never leave process)
   │                    → BM25SkillIndex (reputation-boosted via Tier-1 Flow Rep)
   │                    → viem clients + exactly-once writes + event indexer
   ├──► t3.tool.ts     (in-process, trusted) ── Layer 3
   │       @terminal3/t3n-sdk: WASM TEE component · T3nClient
   │       SIWE/EIP-191 auth · delegation credentials · org-data client
   ▼
AgentSkillRegistry.sol (Layer 2) ── Pharos Atlantic (chainId 688689)
   registerSkill · createJob / createJobWithEvaluator (escrow + Trust Gate)
   deliverResult · evaluateResult (P0-A) · confirmCompletion
   disputeResult (bonded, P1-A) · respondToDispute · concedeDispute
   resolveDefaultConcede · arbitrate · claimAfterReview · claimRefund
   withdraw · agentReputation · jobByTaskHash
   depositBond / requestBondUnlock / cancelBondUnlock / withdrawBond (Tier-2)
   setCrossChainRep (onlyOwner → KarmaTimelock, P0-B)

KarmaTimelock.sol (P0-B) ── OZ TimelockController, 48h delay
   Wraps multisig approval + timelock for AgentSkillRegistry admin ops
```

### The trust flow

```text
t3_verify_identity ─► T3nClient.handshake() ─► authenticate()  (SIWE / EIP-191 via viem)
   └─► did:t3n:… stored in a shared, TTL'd, address-bound session store
            │
   create_job   (single enforcement path; t3_create_verified_job is now a deprecated alias)
            ├─ Gate 1: skill.identityPolicy ≥ 1 ⇒ live address-bound did:t3n session  (server-enforced*)
            └─ Gate 2: agentReputation ≥ skill.minReputationToInvoke                  (contract-enforced)
                     └─► AgentSkillRegistry.createJob   (escrow on Pharos)

  * identity is server-enforced because a did:t3n cannot be verified on-chain; the skill's
    identityPolicy is published on-chain as composable, credibly-committed policy.

t3_authorize_payroll_agent
   buildDelegationCredential ─► DelegationCustodialClient.signCustodial  (TEE-signed)
   ─► bounded, revocable credential  (functions × validity window × $ cap)
   ─► t3_revoke_payroll_authorization ─► revokeDelegation()  (pull or narrow)
```

---

## Tools

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

---

## Chain-agnostic settlement & cryptographic primitives

The core is settlement-agnostic: a narrow `IPaymentPlugin` (`quote` / `pay` / `verify`) and a
`SettlementRail` (`"x402"` | `"escrow"`) let the same skill / identity / reputation model settle across
chains. Pharos escrow is **live**; the Stellar and Casper tracks below run **offline / testnet** — live
chain legs are owner-driven (the sandbox cannot fund testnet or run the circom ceremony), and the ZK
demos fall back to a clearly-labelled mock proof when the `make repagg` artefacts are absent.

| Capability | Where | Status |
|---|---|---|
| `IPaymentPlugin` interface + registry | `src/lib/payment/` | in-repo, tested |
| x402 **Stellar** rail (USDC; ed25519 via HKDF) | `src/plugins/x402_stellar.ts` · `src/lib/stellar/keypair.ts` | testnet (owner-driven) |
| x402 **Casper** rail (CSPR) | `src/plugins/x402_casper.ts` · `src/lib/casper/keypair.ts` | testnet (owner-driven) |
| **AgentCredentialProof** — Circom Groth16, verified on-chain via **native BN254 host functions** (`env.crypto().bn254()`, CAP-0074/Protocol 25 — no Arkworks) | `circuits/src/agent_credential.circom` · `contracts-soroban/agent_credential_verifier` | demo / testnet |
| **ReputationAggregationProof** (T1.1) — portfolio credential (N=8, `validMask`, `providerId`), same native BN254 verifier path | `circuits/src/reputation_aggregation.circom` · `contracts-soroban/reputation_aggregation_verifier` · `src/lib/zk/reputation_aggregation.ts` | demo / testnet |
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

| | |
|---|---|
| **Contract (v3)** | [`0xc6d5c146209e0833634bd33fafb9e65081b905ae`](https://atlantic.pharosscan.xyz/address/0xc6d5c146209e0833634bd33fafb9e65081b905ae) |
| **Deploy block** | 24360873 (Pharos Atlantic) |
| **Pharos chain ID** | `688689` (EIP-1559) |
| **Pharos RPC** | `https://atlantic.dplabs-internal.com` |
| **Pharos explorer** | `https://atlantic.pharosscan.xyz` · currency PHRS (18 dp) |
| **Terminal3 node** | `https://cn-api.sg.testnet.t3n.terminal3.io` (testnet) |

> **Note:** The in-repo contract (`contracts/AgentSkillRegistry.sol`) incorporates P0-A (Evaluator
> Agent), P0-B (Ownable2Step + `KarmaTimelock` multisig/timelock governance), and P1-A (symmetric
> dispute bond with `respondToDispute` / `concedeDispute` / `arbitrate`). Redeploy to Pharos Atlantic is pending.

---

## Quick start

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
MCP_PLUGIN_ALLOWLIST=system.tool.ts,karma.tool.ts,t3.tool.ts
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

## Terminal3 integration status

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

---

## Testing

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
