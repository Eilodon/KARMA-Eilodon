# DoraHacks BUIDL — Stellar Hacks: Real-World ZK

Copy-paste source for the submission page. Edit freely up to the deadline —
this file just keeps a versioned draft in the repo.

## Tagline (one line)

> Trustless skill invocation for AI agents: prove reputation ≥ threshold without revealing it (Groth16 on Stellar's native BN254 host functions) — no trusted server, no leaked business data.

## Short description (2-3 sentences, for the summary card)

KARMA lets an AI agent prove "my reputation is high enough to call this paid
skill" without ever revealing its actual score, its job history, or its
identity — a Groth16 proof verified on-chain by Stellar's native BN254
pairing check (CAP-0074), with a per-skill nullifier that makes replay
mathematically impossible. Two independent verifier contracts are live on
Testnet right now, not a simulation: a single-skill credential gate and a
cross-category portfolio-credential gate, both real Groth16 proofs, both with
a confirmed on-chain replay rejection.

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
- Video: `docs/media/stellar-zk-demo.mp4` (~45s — upload to YouTube unlisted
  or DoraHacks' native uploader, then paste the link here)
- Live-evidence GIF (same content, silent/looping):
  `docs/media/stellar-live-evidence.gif`

## Tags / categories to select on the form

`Zero-Knowledge`, `Real-World ZK`, `Payments`, `Agentic Payments / x402`,
`Infrastructure`

## Known limitations (disclose proactively, matches DEMO_STELLAR.md)

- The full "proof + payment in one HTTP request" flow needs a provider-stub
  HTTP server that hasn't been built yet — the ZK leg is live on-chain, the
  x402 payment leg is demonstrated offline (with a real registered payee,
  not a placeholder). See `demo_stellar_zk.ts`.
- Trusted setup for both circuits is single-contributor (hackathon scope);
  mainnet would need a multi-party ceremony (e.g. Hermez).
