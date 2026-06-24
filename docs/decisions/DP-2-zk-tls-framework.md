# DP-2 — zk-TLS for the Casper RWA-oracle: signed-TLS-proxy fallback (NOT live tlsnotary)

**Status:** Decided · 2026-06-24
**Scope:** Casper RWA-oracle (T1.4 / T13). Stellar tracks are unaffected.
**Reverses:** Roadmap §B.T1.4's "tlsnotary first, fallback if it doesn't work."

## Decision

Ship the **KARMA-signed-TLS-proxy** as the production attestation path for the Casper
RWA-oracle hackathon submission. **Do not run live tlsnotary in this window.** Document
zk-TLS as the post-hackathon upgrade path.

The proxy is a single trust component: it fetches the upstream HTTPS resource using a
standard verified TLS client, then signs `(url, cert_sha256, body_sha256, fetched_at)`
with a well-known KARMA public key. Casper-side consumers verify the signature against
the published key. Trust assumption: the KARMA-operated proxy is honest (it does not
fabricate or modify the upstream payload).

## Why tlsnotary does not fit this window

Verified via Context7 against `/tlsnotary/tlsn-js` (the canonical NPM surface) and the
TLSNotary v0.1.0-alpha.12 docs. Three specific failures, not a vague "too hard":

1. **Browser-only prover surface.** `tlsn-js` README states "NPM modules for proving and
   verifying TLSNotary attestations in browser environments." The Node.js path
   ("prover-ts" demo) still drives a browser; there is no pure Node prover module that
   would slot into a `tsx` script the same way `@stellar/stellar-sdk` does.

2. **External notary + WebSocket-proxy infrastructure.** A live prove path requires:
   - A notary server (Rust binary, `cargo run --release` in `tlsn/crates/notary/server/`)
     — either self-hosted ops overhead or trust in PSE's hosted alpha at
     `notary.pse.dev/v0.1.0-alpha.11`.
   - A WebSocket→TCP proxy (`wstcp`, installed via `cargo install`) because browsers
     cannot speak raw TCP. Adds a fragile second hop with its own failure modes.
   Both of these are "infrastructure dependencies that judges have to take on faith
   during the demo" — exactly the opposite of "falsifiable proof."

3. **Alpha software.** Current published version is `v0.1.0-alpha.12`. The protocol is
   still being iterated; depending on it for a public submission means signing up for
   protocol-shift risk inside the hackathon window. Also: alpha proving times remain
   tens of seconds even on capable hardware — UX-acceptable for a one-shot demo, but
   the integration cost dwarfs the marginal authenticity gain over a clearly-disclosed
   signed-proxy.

## What the fallback gives up — and how to be honest about it

The KARMA-signed-TLS-proxy is **strictly weaker** than tlsnotary on one dimension:
trust in KARMA. tlsnotary's attestation is verifiable without trusting the notary's
honesty (the cryptographic protocol forces commit-then-reveal); the signed-proxy
attestation is verifiable only against a known KARMA pubkey, so a compromised KARMA
key would let the operator forge attestations.

Mitigations we accept for the hackathon:

- The KARMA pubkey is published at a well-known location (repository docs + on-chain
  registry per T4.2). Key rotation is a public, multi-sig event.
- The proxy is open-source; anyone can re-fetch the upstream URL and compare against
  the attested body within the freshness window. Detection of forgery is publicly
  reproducible.
- The RWA-oracle skill explicitly documents this trust assumption in its
  `description` field so a discovering agent can refuse the skill if it does not want
  to trust KARMA.

Post-hackathon: swap the signing call for a tlsnotary attestation against a real
notary. The verification side has the same shape (verify a public signature against a
well-known pubkey vs. verify a tlsnotary attestation against its public verification
key), so the migration is a single component swap, not a re-architecture.

## What the fallback gives back

- **Real upstream fetch.** Binance/Coinbase price feed is genuinely fetched over a
  verified TLS connection. No mock JSON.
- **Real cryptographic chain.** Cert SHA256 + body SHA256 + timestamp → ed25519
  signature → on-chain verifiable signature.
- **Live demo path.** Runs in `tsx` in 1 second flat — no notary server, no proxy, no
  alpha dependencies.
- **Falsifiable.** Anyone can re-fetch the URL and check the body hash; anyone can
  verify the signature with the published KARMA pubkey.

## Implementation outline

Two files:

- `src/lib/zk/signed_tls_attestation.ts` — pure module:
  - `fetchAndAttest(url, signer)` → `{ url, certSha256, bodySha256, body, fetchedAt, sig }`
  - `verifyAttestation(envelope, pubkey)` → boolean
  - Captures the TLS cert chain via Node `tls.TLSSocket.getPeerCertificate({ raw: true })`.
  - Signs ed25519 — same primitive Stellar/Casper signing already uses.
- `src/scripts/demo_casper_rwa_oracle_signed.ts` — drives a live Binance fetch through
  `fetchAndAttest`, hands the envelope to the existing RWA-oracle demo flow.

Unit tests in `src/__tests__/signed_tls_attestation.test.ts` cover:
- Round-trip: sign → verify returns true.
- Tampered body → verify returns false.
- Wrong pubkey → verify returns false.
- Cert mismatch (mocked) → verify returns false.

## When to revisit (the post-hackathon upgrade gate)

Revisit zk-TLS when ANY of:

1. tlsnotary ships a pure Node.js prover (no browser, no WebSocket proxy) at a stable
   (non-alpha) version.
2. zkPass ships a Node.js SDK with proving-time under 5 seconds.
3. The hosted notary at `notary.pse.dev` graduates to non-alpha with documented SLAs.

Track via a docs/decisions follow-up doc; revisit cadence is "whenever T1.4 is
re-prioritized," not on a fixed schedule.
