import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import casperSdk from "casper-js-sdk";
import { hashTypedData, CASPER_DOMAIN_TYPES } from "@casper-ecosystem/casper-eip-712";
import {
  CasperX402Plugin,
  SETTLEMENT_TOKEN_NAME,
  DOMAIN_VERSION,
  DEFAULT_DOMAIN_CHAIN_NAME,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  CASPER_TESTNET_CAIP2,
} from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey } from "../lib/casper/keypair.js";

const { PublicKey } = casperSdk;

const SECP_SEED = new Uint8Array(32).fill(0x77);
const TEST_KEYPAIR = deriveCasperPrivateKey(SECP_SEED);
const FAKE_TOKEN_HASH = "hash-" + "33".repeat(32);

/** Same "00" + bare-hex shape `docs/media/casper_human_payer.html`'s CSPR.click flow builds
 *  (`toEip712AddressField` in src/web/casper_human_payer_entry.ts) — the official
 *  make-software/casper-x402 `csprclick-x402` reference example's own convention for an
 *  EIP-712 "address"-typed Casper account field. */
function toEip712AddressField(accountHashPrefixed: string): string {
  return "00" + accountHashPrefixed.replace(/^account-hash-/, "");
}

describe("P3 — CSPR.click typed-data compatibility with CasperX402Plugin's own signing", () => {
  it("schema-driven hashTypedData (what CSPR.click's signTypedData / casper-eip-712 uses) accepts the SAME signature CasperX402Plugin's manual-concat digest produces", async () => {
    // Sign exactly the way CasperX402Plugin.payWithEnvelope does today (proven correct on-chain
    // in demo_casper_x402_settlement_live.ts). This is standing in for "a human signed via
    // CSPR.click" — both ultimately go through the same secp256k1 key + casper-js-sdk signing
    // primitive, so if a schema-driven digest verifies against this signature, it will equally
    // verify against a CSPR.click-produced one for the same inputs.
    const plugin = new CasperX402Plugin("https://x402-facilitator.casper.network", () => TEST_KEYPAIR, {
      settlementTokenPackageHash: FAKE_TOKEN_HASH,
    });
    const { envelope } = await plugin.payWithEnvelope(
      {
        skillId: "cspr-click-test",
        price: "1000000",
        asset: "KX402",
        payTo: "account-hash-" + "44".repeat(32),
        network: CASPER_TESTNET_CAIP2,
      },
      { agentId: "irrelevant-agent-id" },
    );

    // Independently rebuild the digest via the GENERIC, schema-driven `hashTypedData` — the same
    // {domain, types, primaryType, message} shape docs/media/casper_human_payer.html hands to
    // `window.csprclick.signTypedData`. This is deliberately NOT
    // `buildTransferAuthorizationDigest`'s manual-concat approach (that's the thing being
    // cross-checked against, not reused).
    const domain = {
      name: SETTLEMENT_TOKEN_NAME,
      version: DOMAIN_VERSION,
      chain_name: DEFAULT_DOMAIN_CHAIN_NAME,
      contract_package_hash: FAKE_TOKEN_HASH.replace(/^hash-/, ""),
    };
    const message = {
      from: toEip712AddressField(envelope.payload.from),
      to: toEip712AddressField(envelope.payload.to),
      value: Number(envelope.payload.value),
      validAfter: envelope.payload.validAfter,
      validBefore: envelope.payload.validBefore,
      nonce: envelope.payload.nonce,
    };
    const digest = hashTypedData(
      domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      "TransferWithAuthorization",
      message,
      { domainTypes: CASPER_DOMAIN_TYPES },
    );

    // The real proof: KARMA's own signature (from the manual-concat signing path) verifies
    // against THIS independently, schema-driven-reconstructed digest. If the two encodings ever
    // diverged (e.g. a domain field order/casing mismatch — exactly the class of bug RFC
    // 2026-07-21 found the hard way against the deployed contract), this assertion would fail
    // BEFORE any human ever clicks "sign" in a real browser.
    const pubKey = PublicKey.fromHex(envelope.publicKeyHex);
    const signatureBytes = Uint8Array.from(Buffer.from(envelope.signature, "hex"));
    expect(pubKey.verifySignature(digest, signatureBytes)).toBe(true);
  });
});

describe("P3 — human-as-x402-payer flow never touches governance-signer-gated methods", () => {
  // Exact method names gated by `require_governance_signer()` in
  // contracts-odra/src/agent_skill_registry.rs (7 call sites, confirmed by direct source read).
  const GOVERNANCE_GATED_METHODS = [
    "propose_set_dispute_bond_bps",
    "propose_set_arbiter",
    "propose_set_arbiter_panel",
    "propose_set_panel_arbiter_fee",
    "propose_set_cross_chain_rep",
    "approve_proposal",
    "cancel_proposal",
  ];

  const SURFACES = [
    "src/web/casper_human_payer_entry.ts",
    "src/scripts/relay_casper_x402_envelope.ts",
    "docs/media/casper_human_payer.html",
  ];

  it.each(SURFACES)("%s references none of the 7 governance-gated methods", (relPath) => {
    const text = readFileSync(new URL(`../../${relPath}`, import.meta.url), "utf8");
    for (const method of GOVERNANCE_GATED_METHODS) {
      expect(text.includes(method)).toBe(false);
    }
  });
});

describe("P3 — casper_human_payer.bundle.js is up to date with its entry source", () => {
  it("the committed bundle was built from the current casper_human_payer_entry.ts (no stale build)", () => {
    // Cheap drift guard: the bundle must at least contain the domain name / typehash struct name
    // that the current source declares — if someone edits the entry file and forgets to re-run
    // `pnpm run build:human-payer-page`, the bundle silently goes stale (this test would still
    // pass on unrelated edits, but catches the common case: a domain/type-string change never
        // re-bundled).
    const bundle = readFileSync(new URL("../../docs/media/casper_human_payer.bundle.js", import.meta.url), "utf8");
    expect(bundle).toContain(SETTLEMENT_TOKEN_NAME);
    expect(bundle).toContain("TransferWithAuthorization");
  });
});
