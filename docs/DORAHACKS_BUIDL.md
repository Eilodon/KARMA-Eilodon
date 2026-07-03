# DoraHacks BUIDL — Stellar Hacks: Real-World ZK

Copy-paste source for the submission page. Edit freely up to the deadline —
this file just keeps a versioned draft in the repo.

## Vision (≤256 chars, for DoraHacks' Vision field)

> KARMA is a protocol for agent economies, not an app — settlement, identity, and reputation, specified once and already conformant on two chains. The chain that implements it deepest first becomes the one every later adopter interoperates with.

(243 characters.)

## Tagline (one line)

> Trustless skill invocation for AI agents: prove reputation ≥ threshold without revealing it, pay per call in USDC — proof + payment settle together in ONE HTTP request, live on Stellar Testnet, no trusted server.

## Details field (paste directly into DoraHacks' Markdown editor)

```markdown
### A protocol for agent economies — proven deepest on Stellar

**KARMA lets an AI agent prove "my reputation clears this skill's bar" —
without ever exposing its actual score, its job history, or its identity.**
A Groth16 proof, checked on-chain by Stellar's native BN254 host functions.
A USDC payment that settles in the *same* HTTP request as the proof. Live
on Stellar Testnet right now — not a mockup, not a simulation.

But KARMA isn't a Stellar app with a multi-chain label. It's a **spec**
(`docs/standards/`) — `IPaymentPlugin v1`, a 3-method settlement interface,
plus a public, PR-governed `IdentityPolicy` registry — with independent,
tested reference implementations. **Stellar and Casper are both already
v1.0 ✓ conformant**; Pharos is the chain the spec was extracted from. Landing
a new chain adapter follows a documented recipe estimated at **1–2
sessions**. The bet: whichever chain implements deepest first doesn't just
win a demo — it becomes the reference every later adopter interoperates
with. Stellar's implementation is the deepest one we've shipped.

---

#### The problem

Agent economies need skills to gate access by reputation — "only invoke me
if you've cleared 80+ across 10 jobs." But publishing an agent's raw score
on-chain leaks competitively sensitive data, and a server-side check just
relocates the trust problem onto whoever runs that server.

#### What we built, on Stellar

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

#### Not a hackathon-only claim — the same spec runs elsewhere, tested

| Chain | Role | Proof |
|---|---|---|
| **Stellar** | ZK privacy + native settlement — the deepest implementation | 2 verifiers live on Testnet, 12/12 + 19/19 tests, one-HTTP-request flow live |
| **Casper** | `IPaymentPlugin` v1.0 ✓ conformant, Odra port | 120 Rust tests |
| **Pharos** | Original chain the spec was extracted from | Live contract, 96 Foundry tests |
| **Terminal3** | Reference `IdentityPolicy` implementation | Verified live against testnet |

Partnering with KARMA isn't hosting one hackathon submission — it's early,
deep alignment with a protocol two other chains already implement, with a
documented path for whoever wants to go deeper next.

#### Why this matters for Stellar specifically

This sits at the intersection of Stellar's two big 2026 pushes — **ZK
privacy** and **agentic payments (x402)** — in one sentence: *a
privacy-preserving credit score for AI agents, settled in USDC on Stellar.*
Selective disclosure + on-chain nullifier + Merkle-root pinning is
privacy *with* auditability, not privacy at the cost of it — the posture
real money movement actually needs, and Stellar is the reference chain for
it today.

#### Known limitations (we'd rather tell you than have you find them)

- The live demo's nullifier is one-shot by design (that's the replay guard
  working) — reproducing it needs a fresh proof for a new skill id,
  documented in the repo.
- Trusted setup for both circuits is single-contributor (hackathon scope);
  mainnet would need a multi-party ceremony.
- The provider stub currently runs its own x402 facilitator rather than
  routing through an independent third party — a legitimate x402 topology,
  but worth naming plainly.
- Pharos's `IPaymentPlugin` wrapper is pending (v2) — the escrow rail
  predates the spec and isn't yet a formally conformant implementation,
  even though the underlying contract is live and tested.
```

*(Embed the video and the live-evidence GIF using the editor's 🖼️/🎬 toolbar
buttons at the top of the "one HTTP request" section — that's the visual
payoff moment.)*

## Links

- Repo: (fill in GitHub URL)
- Judge walkthrough: [`DEMO_STELLAR.md`](../DEMO_STELLAR.md)
- Protocol spec: [`docs/standards/IPaymentPlugin-v1.md`](../docs/standards/IPaymentPlugin-v1.md) ·
  [`docs/standards/reference-implementations.md`](../docs/standards/reference-implementations.md)
- Video: `docs/media/stellar-zk-demo.mp4` (~78s, narrated — the idea, the 2
  soundness fixes, then the live one-HTTP-request x402+ZK flow running for
  real. Upload to YouTube unlisted or DoraHacks' native uploader, then paste
  the link here)
- Live-evidence GIF (same content, silent/looping):
  `docs/media/stellar-live-evidence.gif`

## Tags / categories to select on the form

`Zero-Knowledge`, `Real-World ZK`, `Payments`, `Agentic Payments / x402`,
`Infrastructure`
