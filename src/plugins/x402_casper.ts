import { Buffer } from "node:buffer";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperKeypair } from "casper-js-sdk";
import { keystoreManager } from "../lib/keystore.js";
import {
  casperAccountHash,
  casperPublicKeyHex,
} from "../lib/casper/keypair.js";
import type {
  IPaymentPlugin,
  PaymentOption,
  PaymentQuote,
  PaymentReceipt,
  PaymentRequest,
} from "../lib/payment/plugin.js";
const { PublicKey } = casperSdk;

/**
 * x402Plugin/Casper (T11) — IPaymentPlugin implementation for Casper's live x402 fast lane.
 *
 * Mirrors `x402Plugin/Stellar` (T7) on every public surface. The only chain-specific deltas live
 * inside `pay()`:
 *   1. secp256k1 (not ed25519) — uses the Casper keypair already derived at keystore load (T10),
 *      so callers never touch private bytes.
 *   2. Native asset is CSPR (motes, 9 decimals). A price string with a decimal point is converted;
 *      a pre-formatted smallest-unit string passes through unchanged — same rule as T7's
 *      `convertToTokenAmount` flow.
 *   3. There is no `@x402/casper` package published on npm yet, so this plugin builds the "exact"
 *      payment payload directly: a canonical-JSON object (sorted keys), SHA-256-hashed, signed
 *      with the agent's Casper key. The wire format matches what the live Casper x402 Facilitator
 *      (announced with the Casper AI Toolkit) verifies — secp256k1 over SHA-256 + DER signature,
 *      surface fields aligned with Coinbase's "exact" scheme (payer/payee/amount/asset/network +
 *      `validAfter`/`validBefore`/`nonce`).
 *
 * `pay()` does NOT call the facilitator. It builds + signs the payload and returns a receipt the
 * caller stamps onto the HTTP request (`X-PAYMENT` header). The HTTP exchange + the facilitator
 * settle response are wired in T13's end-to-end demo, mirroring T8's Stellar pattern.
 */

/** CAIP-2-ish identifiers per the roadmap plan §Phase 1B (symbolic, not strict CAIP-2). */
export const CASPER_TESTNET_CAIP2 = "casper:testnet";
export const CASPER_MAINNET_CAIP2 = "casper:mainnet";

const CASPER_NETWORKS: readonly string[] = [CASPER_TESTNET_CAIP2, CASPER_MAINNET_CAIP2];

const CSPR_DECIMALS = 9;
const DEFAULT_ASSET = "CSPR";

/** Signer-lookup seam — defaults to the real keystore, overridden in tests (same shape as T7). */
export type CasperKeypairLookup = (agentId: string) => CasperKeypair;

/** Convert a CSPR decimal string ("0.01") into motes ("10000000"). Pure — exported for tests +
 *  the e2e demo so callers can stamp `amount` consistently. Pre-formatted smallest-unit strings
 *  (no decimal point) pass through unchanged. */
export function convertCsprToMotes(price: string): string {
  if (!price.includes(".")) return price;
  const [intPart, fracRaw = ""] = price.split(".");
  if (fracRaw.length > CSPR_DECIMALS) {
    throw new Error(`[x402-casper] CSPR has ${CSPR_DECIMALS} decimals; got ${fracRaw.length} (${price})`);
  }
  const frac = fracRaw.padEnd(CSPR_DECIMALS, "0");
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** Canonical JSON: sorted keys, no whitespace. Matches what the facilitator hashes server-side. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Convert a 64-byte compact secp256k1 signature into the DER form the facilitator parses. */
export function compactToDER(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error(`[x402-casper] expected 64-byte compact sig, got ${sig.length}`);
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  const asAsn1Int = (n: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < n.length - 1 && n[i] === 0) i += 1;
    const t = n.slice(i);
    return t[0] & 0x80 ? Uint8Array.from([0x00, ...t]) : t;
  };
  const rE = asAsn1Int(r);
  const sE = asAsn1Int(s);
  const body = Uint8Array.from([0x02, rE.length, ...rE, 0x02, sE.length, ...sE]);
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** Wire-format "exact" payment payload. Pre-sign canonical-JSON shape; `validAfter` / `validBefore`
 *  / `nonce` exist for replay protection on the facilitator side. */
export interface CasperExactPaymentPayload {
  scheme: "exact";
  network: string;
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  /** Unix ms — payload not yet valid before this instant. */
  validAfter: number;
  /** Unix ms — payload expires at this instant. */
  validBefore: number;
  /** 32-byte hex nonce (random per `pay()` call). */
  nonce: string;
}

/** Signed payload — what travels in the `X-PAYMENT` header to the resource server / facilitator. */
export interface CasperX402SignedPayload {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: CasperExactPaymentPayload;
  publicKeyHex: string;
  /** DER-encoded secp256k1/SHA-256 signature over `canonicalize(payload)`. Hex string. */
  signature: string;
}

/** Random hex nonce. Exposed for tests / determinism overrides. */
export function makeNonce(rng: () => Uint8Array = () => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}): string {
  return Buffer.from(rng()).toString("hex");
}

export interface CasperX402PluginOptions {
  /** TTL for a built payment payload, in ms. Defaults to 5 min, the de-facto x402 ceiling. */
  ttlMs?: number;
  /** Nonce generator — override in tests for determinism. */
  nonce?: () => string;
  /** Clock — override in tests. */
  now?: () => number;
}

export class CasperX402Plugin implements IPaymentPlugin {
  readonly id = "x402-casper";
  readonly rail = "x402" as const;
  readonly networks = CASPER_NETWORKS;
  private readonly lookup: CasperKeypairLookup;
  private readonly ttlMs: number;
  private readonly nonce: () => string;
  private readonly now: () => number;

  constructor(
    private readonly facilitatorUrl: string,
    lookup: CasperKeypairLookup = (agentId) => keystoreManager.getCasperKeypair(agentId),
    opts: CasperX402PluginOptions = {},
  ) {
    this.lookup = lookup;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1_000;
    this.nonce = opts.nonce ?? makeNonce;
    this.now = opts.now ?? Date.now;
  }

  async quote(req: PaymentRequest): Promise<PaymentQuote> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-casper] unsupported network ${req.network}`);
    }
    return {
      rail: this.rail,
      network: req.network,
      asset: req.asset || DEFAULT_ASSET,
      price: convertCsprToMotes(req.price),
      facilitatorUrl: this.facilitatorUrl,
    };
  }

  async pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt> {
    return (await this.payWithEnvelope(req, opts)).receipt;
  }

  /**
   * Same as `pay()`, but also returns the full signed envelope — `PaymentReceipt` (the shared
   * `IPaymentPlugin` shape) only carries `signature` through `txHash`, dropping `validAfter` /
   * `validBefore` / `nonce`, so a resource server can't reconstruct the canonical payload from a
   * receipt alone. Callers that need to actually verify the payment (not just self-check its
   * shape) — e.g. the `X-PAYMENT` header a provider receives — want this method instead.
   */
  async payWithEnvelope(
    req: PaymentRequest,
    opts: { agentId: string },
  ): Promise<{ receipt: PaymentReceipt; envelope: CasperX402SignedPayload }> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-casper] unsupported network ${req.network}`);
    }
    const keypair = this.lookup(opts.agentId);
    const payer = casperAccountHash(keypair);
    const pubHex = casperPublicKeyHex(keypair);
    const amount = convertCsprToMotes(req.price);
    const asset = req.asset || DEFAULT_ASSET;

    const validAfter = this.now();
    const validBefore = validAfter + this.ttlMs;
    const payload: CasperExactPaymentPayload = {
      scheme: "exact",
      network: req.network,
      payer,
      payee: req.payTo,
      amount,
      asset,
      validAfter,
      validBefore,
      nonce: this.nonce(),
    };
    // Canonical JSON → SHA-256 digest → secp256k1 sign → DER. The facilitator runs the same
    // pipeline server-side (the SDK's `PrivateKey.sign()` applies SHA-256 internally, so we
    // hand it the raw canonical-JSON bytes, not a pre-digest).
    const canonical = canonicalize(payload);
    const sigCompact = keypair.sign(new TextEncoder().encode(canonical));
    const sigDER = compactToDER(sigCompact);

    const signedEnvelope: CasperX402SignedPayload = {
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload,
      publicKeyHex: pubHex,
      signature: Buffer.from(sigDER).toString("hex"),
    };
    const receipt: PaymentReceipt = {
      rail: this.rail,
      payer,
      payee: req.payTo,
      amount,
      asset,
      network: req.network,
      facilitatorRef: this.facilitatorUrl,
      // Forward the signature through `txHash` until a settlement tx is realised by the
      // facilitator (T13). Distinct from a real chain hash — callers should not treat it as one;
      // `payWithEnvelope` carries the full envelope for callers that need to verify or transmit it.
      txHash: signedEnvelope.signature,
    };
    return { receipt, envelope: signedEnvelope };
  }

  /** Structural self-check only (shared `IPaymentPlugin` contract — receipts from every chain
   *  round-trip through this). Does NOT verify the cryptographic signature: `PaymentReceipt`
   *  doesn't carry `validAfter`/`validBefore`/`nonce`, so there's nothing to re-derive the
   *  canonical payload from. A resource server verifying a real `X-PAYMENT` header should use
   *  `verifyCasperExactPayload` against the full envelope instead. */
  async verify(receipt: PaymentReceipt): Promise<boolean> {
    if (receipt.rail !== this.rail) return false;
    if (!this.networks.includes(receipt.network)) return false;
    if (!receipt.payer.startsWith("account-hash-")) return false;
    if (!receipt.payee || !receipt.amount) return false;
    return true;
  }
}

export type CasperExactPayloadVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The real, cryptographic check a resource server (or a self-hosted facilitator, same pattern
 * DEMO_STELLAR.md's provider stub uses for the Stellar rail) runs against a received `X-PAYMENT`
 * envelope: signature validity, expiry window, and (optionally) the expected payee. Pure —
 * no network calls.
 */
export function verifyCasperExactPayload(
  envelope: CasperX402SignedPayload,
  opts: { expectedPayee?: string; expectedNetwork?: string; now?: number } = {},
): CasperExactPayloadVerdict {
  const now = opts.now ?? Date.now();
  if (envelope.scheme !== "exact") return { ok: false, reason: "unsupported scheme" };
  if (opts.expectedNetwork && envelope.network !== opts.expectedNetwork) {
    return { ok: false, reason: "network mismatch" };
  }
  if (opts.expectedPayee && envelope.payload.payee !== opts.expectedPayee) {
    return { ok: false, reason: "payee mismatch" };
  }
  if (now < envelope.payload.validAfter) return { ok: false, reason: "not yet valid" };
  if (now > envelope.payload.validBefore) return { ok: false, reason: "expired" };

  const canonical = canonicalize(envelope.payload);
  const pem = PublicKey.fromHex(envelope.publicKeyHex).toPem();
  const nodePubKey = createPublicKey({ key: pem, format: "pem" });
  const sigDER = Buffer.from(envelope.signature, "hex");
  const validSig = cryptoVerify("sha256", new TextEncoder().encode(canonical), nodePubKey, sigDER);
  if (!validSig) return { ok: false, reason: "invalid signature" };
  return { ok: true };
}

/** Recommended payment option entry for a Casper-friendly skill's `register_skill` payload. */
export function casperX402PaymentOption(network: string = CASPER_TESTNET_CAIP2): PaymentOption {
  return {
    rail: "x402",
    network,
    asset: DEFAULT_ASSET,
  };
}

/** Re-export for the e2e demo + facilitator parity: the canonical JSON helper a verifier needs. */
export { canonicalize as canonicalizeCasperPaymentPayload };
