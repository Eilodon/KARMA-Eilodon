/**
 * Pure, Node-free EIP-712 constants/types shared between `x402_casper.ts` (Node — KARMA's own
 * agent-keystore signing path) and `src/web/casper_human_payer_entry.ts` (browser — the CSPR.click
 * human-as-x402-payer flow, P3). Split out specifically so the browser bundle doesn't drag in
 * `x402_casper.ts`'s Node-only imports (`node:buffer`, `node:crypto`, `../lib/keystore.js`'s
 * `node:fs/promises`) — confirmed the hard way: an esbuild browser-target bundle of
 * `x402_casper.ts` directly failed on exactly those unresolvable `node:*` specifiers. Both files
 * re-export these so existing imports of the constants from `x402_casper.ts` keep working
 * unchanged.
 */

/** Real CAIP-2 network ids — matches `make-software/casper-x402`'s own `constants.ts`. */
export const CASPER_TESTNET_CAIP2 = "casper:casper-test";
export const CASPER_MAINNET_CAIP2 = "casper:casper";

/** Must match `contracts-odra/src/x402_settlement_token.rs`'s `TOKEN_NAME` exactly — it's part of
 *  the EIP-712 domain, so a mismatch here silently produces a digest the contract never signed. */
export const SETTLEMENT_TOKEN_NAME = "KARMA x402 Settlement Token";
/** `CEP3009`'s hardcoded `DOMAIN_VERSION` — not configurable on the contract side, don't change. */
export const DOMAIN_VERSION = "1";

/** The EIP-712 domain's `chain_name` field — Casper's own bare protocol chain name (what
 *  `X402SettlementToken::init` was actually called with), e.g. `"casper-test"`. Deliberately NOT
 *  `CASPER_TESTNET_CAIP2` (`"casper:casper-test"`) — that CAIP-2 string is the x402 wire
 *  `network` field, a different value from a different namespace. Confirmed the hard way while
 *  building this file's own CSPR.click cross-check test: a first draft of
 *  `casper_human_payer_entry.ts` used `CASPER_TESTNET_CAIP2` here, which produced a domain
 *  separator the deployed contract never signed (see `src/__tests__/x402_casper_human_payer.test.ts`,
 *  which caught it before any human would have hit it in a real browser). Overridable via
 *  `CASPER_CHAIN_NAME` — matches `x402_casper.ts`'s own `domainChainName` default exactly. */
export const DEFAULT_DOMAIN_CHAIN_NAME = "casper-test";

/** `CEP3009`'s own hardcoded EIP-712 typehash source string for `transfer_with_authorization` —
 *  see `x402_casper.ts`'s fuller doc comment on this same string for the byte-for-byte provenance. */
export const TRANSFER_WITH_AUTHORIZATION_TYPE_STRING =
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

/** The same struct, as a `{name,type}[]` field list — the shape `casper-eip-712`'s schema-driven
 *  `hashTypedData`/`hashStruct` (and CSPR.click's `signTypedData`, which wraps the same package)
 *  take. Field order/casing here IS the typehash — one source of truth, not a second hand-typed
 *  copy that could silently drift. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Wire-format "exact" payment authorization — matches `make-software/casper-x402`'s
 *  `ExactCasperAuthorization` field names/units exactly. */
export interface CasperExactAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
}

/** Signed payload — what travels in the `PAYMENT-SIGNATURE` header / gets relayed on-chain. */
export interface CasperX402SignedPayload {
  x402Version: 2;
  scheme: "exact";
  network: string;
  payload: CasperExactAuthorization;
  publicKeyHex: string;
  signature: string;
}
