# RFC — x402 Casper: EIP-712 / CEP-18 interop with the official reference

## 1. Problem

`src/plugins/x402_casper.ts` is a self-contained "exact" payment-scheme implementation, written
before this research and before the Casper AI Toolkit's own x402 reference was known. Casper's own
site (`casper.network/ai`) names [`make-software/casper-x402`](https://github.com/make-software/casper-x402)
**"the official reference implementation for the x402 protocol on Casper"** — production-ready,
backed by [`casper-ecosystem/casper-eip-712`](https://github.com/casper-ecosystem/casper-eip-712)
(published April 2026) for the typed-data layer. The Buildathon's prize pool earmarks
**$100,000 of $150,000 as "x402 Ecosystem Credits"** — the organizers structurally reward genuine
interop with this specific reference, not merely "an x402-shaped payment flow."

Today, KARMA's rail cannot talk to the official facilitator, client, or CEP-18 settlement path.
Every layer diverges: signing scheme, message schema, numeric units, signature encoding, HTTP
header name, and the underlying asset model. This is not a field-rename; it is two different
protocols that happen to share a scheme name (`"exact"`).

## 2. Goals / non-goals

**Goals:** pin every divergence to its exact source (cited, not assumed); size the real blocking
sub-problem (§4) honestly; produce an ordered, scoped migration plan a future session can execute
without re-deriving this research.

**Non-goals:** this RFC does not change `x402_casper.ts`'s runtime behavior. It is the decision
document the judge-fit playbook's "Phương án A vs B" branch asked for — implementation is a
separate, explicit go/no-go (§9).

## 3. Divergence, field by field

Sources: `js/packages/mechanisms/casper/src/{types,constants,signer}.ts` and
`exact/client/scheme.ts` in `make-software/casper-x402`; `go/docs/api-reference.md` in the same
repo; `js/README.md` in `casper-ecosystem/casper-eip-712`. KARMA side: `src/plugins/x402_casper.ts`
as of this commit.

| Aspect | KARMA today | Official reference |
|---|---|---|
| `x402Version` | `1` | `2` |
| Network id | `"casper:testnet"` / `"casper:mainnet"` — code comment admits "symbolic, not strict CAIP-2" | `"casper:casper-test"` / `"casper:casper"` / `"casper:casper-net-1"` — real CAIP-2 |
| Signing scheme | `canonicalize(payload)` (sorted-key JSON) → SHA-256 → secp256k1 sign → DER-encode | EIP-712 typed-data digest (`casper-eip-712`'s `hashTypedData(domain, types, "TransferWithAuthorization", message)`) → `keypair.signAndAddAlgorithmBytes(digest)` |
| Signature encoding | ASN.1 DER, variable length (`compactToDER`) | Casper-native: `[1 algorithm byte \| 64 raw bytes]`, fixed 65 bytes / 130 hex chars |
| Signed message fields | **Everything** — `scheme, network, payer, payee, amount, asset, validAfter, validBefore, nonce` all go into the hashed canonical JSON | Only `{from, to, value, validAfter, validBefore, nonce}` are in the signed struct (`ExactCasperAuthorization`). `scheme`/`network`/`asset`(as `verifyingContract`) live in the **EIP-712 domain**, not the message |
| `validAfter`/`validBefore` units | milliseconds (`Date.now()`) | **seconds** |
| Payer/payee field names | `payer` / `payee` / `amount` | `from` / `to` / `value` |
| `asset` | free string, `"CSPR"` (the native token symbol) | **must be a CEP-18 contract package hash** (64 hex chars) — the official scheme has no concept of paying in the native asset directly |
| Settlement | **none.** `pay()`/`payWithEnvelope()` never call a facilitator or submit a transaction; the receipt's `txHash` is literally the signature hex, per the code's own comment ("until a settlement tx is realised by the facilitator") | Facilitator submits a real `transfer_with_authorization` deploy against the CEP-18 contract (`from, to, amount: CLUInt256, valid_after: CLUInt64, valid_before: CLUInt64, nonce: 32B, public_key, signature: 65B`) — actual on-chain settlement |
| HTTP header | `X-PAYMENT` (per code comments, `DEMO_CASPER.md`) | `PAYMENT-SIGNATURE` |
| Public key format | secp256k1 hex via `casper-js-sdk`'s `PublicKey` | Algorithm-prefixed hex, curve-agnostic (signer defaults to `KeyAlgorithm.ED25519` but takes a configurable `KeyAlgorithmType` — **secp256k1 keys are not the blocker**, the envelope format is) |

Every row above is independently fixable except one, which sets the actual scope of this RFC.

## 4. The real blocking sub-problem: CEP-18, not cryptography

The signing-scheme and encoding rows in §3 are mechanical — swap SHA-256/DER for
`casper-eip-712`'s typed-data pipeline, rename fields, switch ms→s. The genuine blocker is
architectural: **the official `"exact"` scheme has no native-asset path.** `PaymentRequirements.asset`
is required to be a CEP-18 fungible-token contract package hash; settlement is a CEP-18
`transfer_with_authorization` call. KARMA's `AgentSkillRegistry` escrow, by contrast, is built
entirely on native CSPR motes (`#[odra(payable)]` entry points, `attached_value()`) — there is no
CEP-18 token anywhere in `contracts-odra/`.

This is not a KARMA gap to close by "trying harder" — it is Casper's x402 layer and Casper's
native-asset escrow layer genuinely not sharing an asset model yet. Two ways to scope around it,
not mutually exclusive:

- **(a) Wrap CSPR in a CEP-18 token.** Deploy or adopt a CSPR-backed CEP-18 wrapper so x402
  payments settle in a real fungible token 1:1 redeemable for CSPR. Correct long-term answer,
  real scope: a new contract, a mint/redemption story, liquidity assumptions — not a 5-day item.
- **(b) Keep x402 as the discovery fast-lane it already is, on a neutral test token.** KARMA's own
  architecture already treats x402 as a pre-escrow "fast lane" (per `DEMO_CASPER.md`'s framing),
  separate from the CSPR escrow that actually settles the job. Point the payload's `asset` at any
  existing CEP-18 test token on Testnet (or a trivial throwaway one) and get the **client-side wire
  format** — EIP-712 signing, correct schema, correct header — genuinely interoperable with the
  official facilitator's *verification* path, without touching `AgentSkillRegistry` or pretending
  x402 replaces CSPR escrow. Smaller blast radius; matches the architecture that already exists.

## 5. Concrete migration mechanism (scoped to §4(b))

### 5.1 New dependencies
- `@casper-ecosystem/casper-eip-712` (npm) — typed-data domain separator + `hashTypedData`.
- A CEP-18 token package hash on Testnet for the `asset` field. Needs a source — see §9.
- Either point at a real `make-software/casper-x402` facilitator instance, or implement
  settlement against the same `transfer_with_authorization` entry point using the
  `submit`/`submitPayable` pattern `live_client.ts` already has for every other Odra call.

### 5.2 Payload shape (replaces `CasperExactPaymentPayload`)

```ts
interface ExactCasperAuthorization {
  from: string;          // payer account-hash, "00" prefix
  to: string;             // payee account-hash, "00" prefix
  value: string;          // atomic token amount, decimal string
  validAfter: string;     // unix SECONDS
  validBefore: string;    // unix SECONDS
  nonce: string;           // 32-byte hex
}
interface ExactCasperPayload {
  signature: string;       // 65-byte algo-prefixed hex (130 hex chars) — NOT DER
  publicKey: string;
  authorization: ExactCasperAuthorization;
}
```

`scheme`/`network`/`asset` move out of the signed struct and into the EIP-712 domain
(`{name, version, chain_name, contract_package_hash}` — the Casper-specific domain field set per
`casper-eip-712`'s README, chosen over the Ethereum-shaped `chainId`/`verifyingContract` pair).

### 5.3 Signing pipeline (replaces `canonicalize` → SHA-256 → `compactToDER`)

```
domain   = { name, version, chain_name: network, contract_package_hash: asset }
digest   = hashTypedData(domain, transferWithAuthorizationTypes, "TransferWithAuthorization", message)
signature = keypair.signAndAddAlgorithmBytes(digest)   // [1 algo byte | 64 raw bytes]
```

`compactToDER` and `canonicalize`'s role in signing both go away; `canonicalize` may still be
useful internally but is no longer the thing that gets hashed.

### 5.4 Settlement (currently absent entirely)

`verify()`/`verifyCasperExactPayload` today only re-check the signature and expiry — never touch
chain. A real settlement path means building and submitting an actual
`transfer_with_authorization` deploy (args per §3's table) the same way `live_client.ts`'s
`submitPayable` already builds every other signed Odra call, then waiting for finalization like
the rest of the demo scripts do.

### 5.5 Wire-level renames
`X-PAYMENT` → `PAYMENT-SIGNATURE` header; `x402Version: 1` → `2`; network id
`"casper:testnet"` → `"casper:casper-test"`.

## 6. Test impact

`src/__tests__/x402_casper.test.ts` and `casper_live_client.test.ts`'s x402-adjacent cases assert
today's scheme (DER length, `X-PAYMENT` framing, ms-based timestamps). A cutover to §5 is a
rewrite of that suite, not an extension — every fixture's expected bytes change shape.

## 7. Effort & risk estimate

| Task | Effort | Risk |
|---|---|---|
| Add `casper-eip-712`, port domain/typed-data signing | Small–medium | Low — mechanical once the type strings are confirmed against a real test vector |
| Field/unit renames (§5.2, §5.5) | Small | Low |
| Source a CEP-18 test token for `asset` (§4(b)) | Small–medium | **Unknown — depends on whether a public Testnet CEP-18 test token already exists to point at, or a throwaway one must be deployed first** |
| Real settlement call (§5.4) | Medium | Medium — new code path, needs its own tests, first real interaction with a facilitator (self-hosted or real) |
| Rewrite `x402_casper.test.ts` | Medium | Low — mechanical given §5 is nailed down |
| End-to-end proof against the *real* `make-software/casper-x402` facilitator (not just self-consistent) | Medium–large | **Medium-high — depends on that facilitator's live availability/config, outside this repo's control** |

## 8. Recommendation for the Buildathon window

Full interop (§5 in full, verified against the *real* official facilitator) is not a safe bet
inside the ~5 days remaining before the 2026-07-26 deadline — the last row of §7 depends on an
external service this team doesn't control. Recommended path:

1. Ship this RFC now — it is itself Buildathon-relevant evidence for **Long-Term Launch Plans**
   and **Potential for Long-Term Impact** (a real, scoped, honestly-risk-rated roadmap item, not a
   vague "we'll look into it").
2. Disclose the gap plainly in `DEMO_CASPER.md`/README (already partly done — the "Composability"
   framing can extend to "wire-compatible interop: not yet, see RFC").
3. If time allows after higher-priority items (see the judge-fit playbook's action docket), take
   the §4(b)/§5.2–5.3 slice only — EIP-712 signing + correct schema against a throwaway test
   token, proven self-consistently (KARMA's own `verifyCasperExactPayload` updated to the new
   scheme) — without the real-facilitator dependency in §7's last row. That alone converts "we use
   a bespoke scheme" into "we speak the real wire format, settlement integration is the next
   step," which is a materially stronger and still honest claim.
4. Full production interop (§5.4's real settlement call, end-to-end against the live facilitator)
   is a post-Buildathon milestone, not a submission-window one.

## 9. Decision request

- Confirm: pursue the §8.3 narrow slice (EIP-712 wire format only, self-verified, no live
  facilitator dependency) before the deadline, or hold everything here as research-only and ship
  the RFC alone?
- If pursuing §8.3: is there a known existing CEP-18 test token on Casper Testnet to point `asset`
  at, or does one need to be deployed first? (Blocks §5.2 either way — needs an answer before code
  starts.)
