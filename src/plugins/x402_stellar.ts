import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  STELLAR_PUBNET_CAIP2,
  USDC_TESTNET_ADDRESS,
  USDC_PUBNET_ADDRESS,
  convertToTokenAmount,
} from "@x402/stellar";
import type { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { keystoreManager } from "../lib/keystore.js";
import type {
  IPaymentPlugin,
  PaymentOption,
  PaymentQuote,
  PaymentReceipt,
  PaymentRequest,
} from "../lib/payment/plugin.js";

/** Signer-lookup seam — defaults to the real keystore, overridden in tests. */
export type StellarKeypairLookup = (agentId: string) => StellarKeypair;

/**
 * x402Plugin/Stellar (T7) — IPaymentPlugin implementation for the Stellar/USDC fast lane.
 *
 * Wraps `@x402/stellar` packages so KARMA's `create_job` can route an x402-tagged invocation
 * through Stellar's HTTP-native micropayment rail (synthesis §5.5).
 *
 * Plugin shape per IPaymentPlugin:
 *   • quote(req)  — synchronous, no network. Just shapes the agreed USDC price.
 *   • pay(req)    — uses the agent's HKDF-derived Stellar Keypair (T6) to build an
 *                   `Ed25519Signer` and returns a "pending receipt" carrying the agent's
 *                   Stellar address + the network + the asset. The signed payment payload
 *                   itself is produced by the demo flow (T8) at the moment of HTTP request
 *                   (because x402 binds a payment to a specific `paymentRequired` quote that
 *                   only the resource server emits in its 402 response). pay() therefore
 *                   verifies the signer can be constructed and the inputs are well-formed,
 *                   returning a receipt that callers attach to a request envelope.
 *   • verify(rec) — server-side sanity (network/asset/payee shape). Full settlement
 *                   verification belongs to the facilitator response in T8.
 */

/** Stellar networks this plugin handles — exact-match per IPaymentPlugin.resolve(). */
const STELLAR_NETWORKS: readonly string[] = [STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2];

/** USDC stays the default asset; the plugin still allows overrides on PaymentRequest.asset. */
function defaultAssetForNetwork(network: string): string {
  if (network === STELLAR_TESTNET_CAIP2) return USDC_TESTNET_ADDRESS;
  if (network === STELLAR_PUBNET_CAIP2) return USDC_PUBNET_ADDRESS;
  return "";
}

export class StellarX402Plugin implements IPaymentPlugin {
  readonly id = "x402-stellar";
  readonly rail = "x402" as const;
  readonly networks = STELLAR_NETWORKS;
  private readonly lookup: StellarKeypairLookup;

  constructor(
    private readonly facilitatorUrl: string,
    lookup: StellarKeypairLookup = (agentId) => keystoreManager.getStellarKeypair(agentId),
  ) {
    this.lookup = lookup;
  }

  async quote(req: PaymentRequest): Promise<PaymentQuote> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-stellar] unsupported network ${req.network}`);
    }
    return {
      rail: this.rail,
      network: req.network,
      asset: req.asset || defaultAssetForNetwork(req.network),
      // x402 Stellar tokens are 7-decimal smallest units (USDC). Convert here so caller passes
      // human-readable "$0.01" but receives "100000" smallest-unit amount in the quote (or
      // honours an already-smallest-units string if no decimal point present).
      price: req.price.includes(".") ? convertToTokenAmount(req.price) : req.price,
      facilitatorUrl: this.facilitatorUrl,
    };
  }

  async pay(req: PaymentRequest, opts: { agentId: string }): Promise<PaymentReceipt> {
    if (!this.networks.includes(req.network)) {
      throw new Error(`[x402-stellar] unsupported network ${req.network}`);
    }
    const keypair = this.lookup(opts.agentId);
    // Build the SEP-43 signer so the demo flow can attach it to an x402Client when it has the
    // server-emitted PaymentRequired quote. The signer is held in plugin-local scope — its
    // construction proves the agent's Stellar key is available and well-formed.
    // req.network has been checked against this.networks (CAIP-2 strings); the cast just satisfies
    // x402-stellar's `${string}:${string}` Network template literal type.
    const signer = createEd25519Signer(keypair.secret(), req.network as `${string}:${string}`);
    if (signer.address !== keypair.publicKey()) {
      throw new Error("[x402-stellar] signer address mismatch — keypair/signer disagree");
    }
    return {
      rail: this.rail,
      payer: keypair.publicKey(),
      payee: req.payTo,
      amount: req.price.includes(".") ? convertToTokenAmount(req.price) : req.price,
      asset: req.asset || defaultAssetForNetwork(req.network),
      network: req.network,
      facilitatorRef: this.facilitatorUrl,
    };
  }

  async verify(receipt: PaymentReceipt): Promise<boolean> {
    // Structural sanity — the heavyweight on-chain settlement check is the facilitator's job
    // (T8 demo asserts the `PAYMENT-RESPONSE` header from the resource server, which carries the
    // facilitator's signed verdict). Reject obvious shape mismatches that callers must not
    // act on.
    if (receipt.rail !== this.rail) return false;
    if (!this.networks.includes(receipt.network)) return false;
    if (!receipt.payer.startsWith("G") || receipt.payer.length !== 56) return false;
    if (!receipt.payee || !receipt.amount) return false;
    return true;
  }
}

/** Recommended payment option entry to advertise from a Stellar-friendly skill's
 *  `register_skill` payload (matches the SkillDocument.payment_options shape). */
export function stellarX402PaymentOption(network: string = STELLAR_TESTNET_CAIP2): PaymentOption {
  return {
    rail: "x402",
    network,
    asset: defaultAssetForNetwork(network),
  };
}
