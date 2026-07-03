# DoraHacks BUIDL — Stellar Hacks: Real-World ZK

Copy-paste source for the submission page. Edit freely up to the deadline —
this file just keeps a versioned draft in the repo.

## Vision (≤256 chars, for DoraHacks' Vision field)

> Every AI agent will need a reputation it can prove but never expose. KARMA builds that primitive on Stellar today — zero-knowledge, pay-per-call, no trusted server — so trust between autonomous agents becomes math, not a middleman.

(231 characters.)

## Tagline (one line)

> Trustless skill invocation for AI agents: prove reputation ≥ threshold without revealing it, pay per call in USDC — proof + payment settle together in ONE HTTP request, live on Stellar Testnet, no trusted server.

## Details field (paste directly into DoraHacks' Markdown editor)

```markdown
### Prove your reputation. Reveal nothing. Pay per call.

**KARMA lets an AI agent prove "my reputation clears this skill's bar" —
without ever exposing its actual score, its job history, or its identity.**
A Groth16 proof, checked on-chain by Stellar's native BN254 host functions.
A per-skill nullifier that makes replay mathematically impossible. A USDC
payment that settles in the *same* HTTP request as the proof. Live on
Stellar Testnet right now — not a mockup, not a simulation.

---

#### The problem

Agent economies need skills to gate access by reputation — "only invoke me
if you've cleared 80+ across 10 jobs." But publishing an agent's raw score
on-chain leaks competitively sensitive data, and a server-side check just
relocates the trust problem onto whoever runs that server.

#### What we built

Two Circom circuits (Groth16 / BN254) let an agent prove a reputation claim
in zero-knowledge:

- **`AgentCredentialProof`** — "I hold a credential committing to a score ≥
  X for skill Y, and it's a real leaf under the issuer's published
  job-history Merkle root" — without revealing the score or which leaf.
- **`ReputationAggregationProof`** — the portfolio version: "my average
  score across ≥ K distinct categories over ≥ N jobs is ≥ X."

Both are verified by Soroban contracts using **Stellar's native BN254 host
functions** (`env.crypto().bn254()`, CAP‑0074, Protocol 25) — no Arkworks,
no in-contract elliptic-curve arithmetic. A nullifier makes every replay
attempt revert on-chain, and the same fast lane is wired to a per-call USDC
x402 payment.

#### We audited our own circuit. We found 2 real bugs. We fixed them.

The credential commitment didn't bind the committed score, and the contract
never pinned the proof's Merkle root against any published state. Both
gaps are closed in the live deployment — disclosed, not concealed. Full
writeup: `DEMO_STELLAR.md` in the repo.

#### The whole thing, live — one HTTP request

This is the part we're proudest of: the agent signs a **real USDC payment**
and attaches its **zero-knowledge proof**, and sends both in a single POST.
The provider verifies and settles the payment on-chain, then verifies the
Groth16 proof on-chain, before it ever runs the skill — no trusted server
deciding anything the chain doesn't independently check.

Two real Stellar transactions from that one request:

| | |
|---|---|
| 💵 USDC payment settled on-chain | [`9880020b…`](https://stellar.expert/explorer/testnet/tx/9880020bb5354a167572c335c808c7cb4e5af65309ff6185ced3a4fd25d6c0ae) |
| 🔐 ZK proof verified on-chain | [`28d4917b…`](https://stellar.expert/explorer/testnet/tx/28d4917ba2192d8bf8a5a6004d392593df7e9e4639f9e2b23c0cf3503c4e153c) |

#### Live contracts (Stellar Testnet)

| Contract | Address |
|---|---|
| `agent_credential_verifier` | [`CDBIDMG2…SATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| `reputation_aggregation_verifier` | [`CDR55NDI…54UA7SRMO`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |

#### Why this matters for Stellar

This sits at the intersection of Stellar's two big 2026 pushes — **ZK
privacy** and **agentic payments (x402)** — in one sentence: *a
privacy-preserving credit score for AI agents, settled in USDC on Stellar.*
Selective disclosure + on-chain nullifier + Merkle-root pinning is
privacy *with* auditability, not privacy at the cost of it — the posture
real money movement actually needs.

#### Known limitations (we'd rather tell you than have you find them)

- The live demo's nullifier is one-shot by design (that's the replay guard
  working) — reproducing it needs a fresh proof for a new skill id,
  documented in the repo.
- Trusted setup for both circuits is single-contributor (hackathon scope);
  mainnet would need a multi-party ceremony.
- The provider stub currently runs its own x402 facilitator rather than
  routing through an independent third party — a legitimate x402 topology,
  but worth naming plainly.
```

*(Embed the video and the live-evidence GIF using the editor's 🖼️/🎬 toolbar
buttons at the top of the "one HTTP request" section — that's the visual
payoff moment.)*

## Short description (2-3 sentences, for the summary card)

KARMA lets an AI agent prove "my reputation is high enough to call this paid
skill" without ever revealing its actual score, its job history, or its
identity — a Groth16 proof verified on-chain by Stellar's native BN254
pairing check (CAP-0074, no Arkworks), with a per-skill nullifier that makes
replay mathematically impossible. A single client HTTP request carries both
the proof and a real x402 USDC payment; the provider stub settles the
payment and verifies the proof on-chain, live on Testnet — not a mockup, not
a simulation.

## Full description

**The problem.** An AI agent economy needs skills to gate access by
reputation ("only invoke me if you've completed ≥10 jobs at 80+ score") —
but publishing an agent's raw score on-chain leaks competitively sensitive
business data, and a server-side reputation check just moves the trust
problem onto whoever runs that server.

**What KARMA does about it.** Two Circom circuits (Groth16 over BN254) let
an agent prove a reputation claim in zero-knowledge:

- `AgentCredentialProof` — "I hold a credential committing to a score ≥ X
  for skill Y, and it's a real leaf under the issuer's published
  job-history Merkle root" — without revealing the score or which leaf.
- `ReputationAggregationProof` — the portfolio version: "my average score
  across ≥ K distinct categories over ≥ N jobs in epoch E is ≥ X."

Both proofs are verified on **Stellar Soroban contracts using the network's
native BN254 host functions** (`env.crypto().bn254()`, CAP-0074, shipped in
Protocol 25 "X-Ray") — not a software Arkworks fallback, no in-contract
elliptic-curve arithmetic. A per-skill / per-epoch nullifier makes replay
attacks revert on-chain, and the same fast lane is wired to a per-call USDC
x402 payment so a skill can be metered per invocation with no KARMA server
sitting in the trust path.

**We audited our own circuit and found 2 real soundness gaps** — the
credential commitment didn't bind the committed score, and the contract
didn't pin the proof's Merkle root against any published state. Both are
fixed in the live deployment: see the "Soundness fixes" section of
[DEMO_STELLAR.md](../DEMO_STELLAR.md). Disclosed, not concealed.

**Live evidence, not a mockup.** Both verifiers are deployed on Stellar
Testnet with real transactions: contract deploy, `register_skill` /
`set_epoch_root`, a real Groth16 proof verified via `create_job` /
`submit_proof`, and a confirmed nullifier-replay rejection
(`Error(Contract, #5)`). Full tx hashes + stellar.expert links in
[DEMO_STELLAR.md](../DEMO_STELLAR.md).

**The full "one HTTP request" flow is live, end to end.**
`src/scripts/demo_stellar_x402_live.ts` runs a real provider-stub HTTP
server and a real x402 client: agent-alpha signs a genuine x402 payment
(a Soroban authorization entry) and POSTs it to `/invoke` in the same
request as the ZK proof headers. The provider stub verifies + **settles the
USDC payment on-chain**
([tx](https://stellar.expert/explorer/testnet/tx/9880020bb5354a167572c335c808c7cb4e5af65309ff6185ced3a4fd25d6c0ae))
and **verifies the Groth16 proof on-chain**
([tx](https://stellar.expert/explorer/testnet/tx/28d4917ba2192d8bf8a5a6004d392593df7e9e4639f9e2b23c0cf3503c4e153c)),
both from one client-side HTTP POST — no trusted server deciding anything
the chain doesn't independently verify.

## Why this matters for Stellar (judge-facing pitch)

This sits at the intersection of Stellar's two 2026 strategic pushes —
**ZK privacy** and **agentic payments (x402)** — with one line: *a
privacy-preserving credit score for AI agents, settled in USDC on Stellar.*
Selective disclosure (score hidden, threshold public) + on-chain nullifier +
job-history root pinning is "privacy-with-auditability," not privacy at the
cost of accountability — the same posture regulators and enterprises
actually want from agentic payments infrastructure.

## Live contracts (Testnet)

| Contract | Address |
|---|---|
| `agent_credential_verifier` | [`CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP`](https://stellar.expert/explorer/testnet/contract/CDBIDMG22BBIQPSWBNPMUOXXH7XJMHUHASEQYS3TDH766WSATCJT4GTP) |
| `reputation_aggregation_verifier` | [`CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO`](https://stellar.expert/explorer/testnet/contract/CDR55NDIGKCWJXKQ334TNVHUAS37Q2ZBBGZZAV25OR6IC5O54UA7SRMO) |

## Links

- Repo: (fill in GitHub URL)
- Judge walkthrough: [`DEMO_STELLAR.md`](../DEMO_STELLAR.md)
- Video: `docs/media/stellar-zk-demo.mp4` (~78s, narrated — the idea, the 2
  soundness fixes, then the live one-HTTP-request x402+ZK flow running for
  real. Upload to YouTube unlisted or DoraHacks' native uploader, then paste
  the link here)
- Live-evidence GIF (same content, silent/looping):
  `docs/media/stellar-live-evidence.gif`

## Tags / categories to select on the form

`Zero-Knowledge`, `Real-World ZK`, `Payments`, `Agentic Payments / x402`,
`Infrastructure`

## Known limitations (disclose proactively, matches DEMO_STELLAR.md)

- The live x402 + ZK flow uses a fixed demo skill/proof pair per run (the
  nullifier is one-shot by design — that's the replay guard, not a bug);
  reproducing it live again needs a freshly generated proof for a new
  `skill_id`, documented in DEMO_STELLAR.md.
- Trusted setup for both circuits is single-contributor (hackathon scope);
  mainnet would need a multi-party ceremony (e.g. Hermez).
- The provider stub currently acts as its own x402 facilitator (KARMA's own
  signer settles the payment it receives) rather than routing through an
  independent third-party facilitator — a legitimate x402 topology, but
  worth naming: the trust-minimization is "no server decides anything the
  chain doesn't verify," not "a neutral third party settles."
