/**
 * P3 — relays a human-signed x402 payment envelope on-chain.
 *
 * Companion to `docs/media/casper_human_payer.html`: that page runs entirely in a judge/human's
 * own browser, connects their wallet via CSPR.click, and produces a signed
 * `CasperExactAuthorization` envelope (JSON) — but a static page has no funded account to submit
 * a Casper transaction with, and shouldn't (the whole point of the CEP-3009/EIP-3009 pattern is
 * that the signer and the tx submitter can be different accounts — see
 * `settleTransferWithAuthorization`'s own doc comment: "any account may relay, the signature, not
 * the caller, authorizes the transfer"). This script is that relay: it takes the envelope the
 * human produced, cryptographically re-verifies it (never trusts a payload blindly before
 * spending gas on it), then submits `transfer_with_authorization` using KARMA's own funded key —
 * the human never needs testnet CSPR for gas, only an account capable of signing EIP-712 typed
 * data.
 *
 * This never touches `AgentSkillRegistry` or any of its 7 `require_governance_signer()`-gated
 * methods — x402 settlement is a direct CEP-18 transfer on `X402SettlementToken`, independent of
 * the job/escrow/dispute contract (see `CasperX402Plugin`'s own "fast-lane" doc comment).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/relay_casper_x402_envelope.ts --envelope-file <path.json>
 *     # verify only (default) — no network call, no funds needed.
 *   pnpm exec tsx src/scripts/relay_casper_x402_envelope.ts --envelope-file <path.json> --live
 *     # verify, then submit on-chain. Needs CASPER_RPC_URL (testnet only, same DP-3 guard as
 *     # every other live script here) + KARMA_X402_CASPER_SETTLEMENT_TOKEN, plus either
 *     # CASPER_RELAYER_SECRET_HEX (raw key) or KEYSTORE_PATH/KEYSTORE_PASSWORD + an agentId arg
 *     # (same dual-path convention as demo_casper_x402_settlement_live.ts).
 *   cat envelope.json | pnpm exec tsx src/scripts/relay_casper_x402_envelope.ts --live
 *     # envelope can also be piped via stdin instead of --envelope-file.
 *
 * Envelope shape expected (matches `docs/media/casper_human_payer.html`'s output exactly, and
 * `CasperX402SignedPayload` from src/plugins/x402_casper.ts):
 *   {
 *     "x402Version": 2, "scheme": "exact", "network": "casper:casper-test",
 *     "payload": { "from": "account-hash-...", "to": "account-hash-...", "value": "1000000",
 *                  "validAfter": 1234567890, "validBefore": 1234571490, "nonce": "<64 hex chars>" },
 *     "publicKeyHex": "02...", "signature": "<hex>"
 *   }
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import casperSdk from "casper-js-sdk";
import { keystoreManager } from "../lib/keystore.js";
import {
  settleTransferWithAuthorization,
  verifyCasperExactPayload,
  type CasperX402SignedPayload,
} from "../plugins/x402_casper.js";

const { RpcClient, HttpHandler, ContractCallBuilder, PrivateKey, KeyAlgorithm } = casperSdk;

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: Buffer | string) => (data += chunk.toString("utf8")));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parseEnvelope(raw: string): CasperX402SignedPayload {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("[relay] envelope JSON must be an object");
  }
  const env = parsed as Partial<CasperX402SignedPayload>;
  if (env.scheme !== "exact") throw new Error("[relay] envelope.scheme must be \"exact\"");
  if (typeof env.network !== "string") throw new Error("[relay] envelope.network missing");
  if (typeof env.publicKeyHex !== "string") throw new Error("[relay] envelope.publicKeyHex missing");
  if (typeof env.signature !== "string") throw new Error("[relay] envelope.signature missing");
  const p = env.payload;
  if (
    !p ||
    typeof p.from !== "string" ||
    typeof p.to !== "string" ||
    typeof p.value !== "string" ||
    typeof p.validAfter !== "number" ||
    typeof p.validBefore !== "number" ||
    typeof p.nonce !== "string"
  ) {
    throw new Error("[relay] envelope.payload is missing or malformed");
  }
  return { x402Version: 2, scheme: "exact", network: env.network, payload: p, publicKeyHex: env.publicKeyHex, signature: env.signature };
}

async function main(): Promise<void> {
  const envelopeFile = opt("--envelope-file");
  const raw = envelopeFile ? readFileSync(envelopeFile, "utf8") : await readStdin();
  if (!raw.trim()) {
    throw new Error("[relay] no envelope provided — pass --envelope-file <path> or pipe JSON via stdin");
  }
  const envelope = parseEnvelope(raw);
  const live = flag("--live");

  const settlementTokenPackageHash = process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN;
  console.log("[relay] envelope:", {
    from: envelope.payload.from,
    to: envelope.payload.to,
    value: envelope.payload.value,
    network: envelope.network,
    nonce: envelope.payload.nonce.slice(0, 16) + "...",
  });

  const verdict = verifyCasperExactPayload(envelope, { settlementTokenPackageHash });
  if (!verdict.ok) {
    console.error(`[relay] REJECTED — signature/expiry check failed: ${verdict.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("[relay] signature + validity window VERIFIED — the connected wallet really signed this authorization.");

  if (!live) {
    console.log("\n(verify-only run — pass --live, with a funded relayer key configured, to actually submit on-chain)");
    return;
  }

  const rpcUrl = process.env.CASPER_RPC_URL;
  if (!rpcUrl) throw new Error("[relay] CASPER_RPC_URL not set");
  if (!rpcUrl.includes("testnet")) {
    throw new Error("[relay] CASPER_RPC_URL must be a testnet endpoint — mainnet rejected by convention (DP-3)");
  }
  if (!settlementTokenPackageHash) throw new Error("[relay] KARMA_X402_CASPER_SETTLEMENT_TOKEN not set");
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const bareTokenHash = settlementTokenPackageHash.replace(/^hash-/, "");

  const rawHex = process.env.CASPER_RELAYER_SECRET_HEX;
  let relayerSigner: InstanceType<typeof PrivateKey>;
  if (rawHex) {
    relayerSigner = PrivateKey.fromHex(rawHex, KeyAlgorithm.SECP256K1);
    console.log("[relay] submitting with CASPER_RELAYER_SECRET_HEX (raw key)");
  } else {
    const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
    const password = process.env.KEYSTORE_PASSWORD;
    if (!password) throw new Error("[relay] set either CASPER_RELAYER_SECRET_HEX or KEYSTORE_PASSWORD");
    const agentId = process.argv[2];
    if (!agentId || agentId.startsWith("--")) {
      throw new Error("[relay] usage (keystore path): relay_casper_x402_envelope.ts <agentId> --envelope-file <path> --live");
    }
    await keystoreManager.load(keystorePath, password);
    relayerSigner = keystoreManager.getCasperKeypair(agentId);
  }

  const handler = new HttpHandler(rpcUrl);
  if (process.env.CASPER_RPC_API_KEY) handler.setCustomHeaders({ Authorization: process.env.CASPER_RPC_API_KEY });
  const rpc = new RpcClient(handler);

  const { txHash } = await settleTransferWithAuthorization(
    rpc,
    (args) => {
      const tx = new ContractCallBuilder()
        .from(relayerSigner.publicKey)
        .byPackageHash(bareTokenHash)
        .entryPoint("transfer_with_authorization")
        .runtimeArgs(args)
        .chainName(chainName)
        .payment(5_000_000_000)
        .build();
      tx.sign(relayerSigner);
      return tx;
    },
    envelope,
  );
  console.log(`\n[relay] submitted: ${txHash}`);
  console.log(`[relay] confirm on testnet.cspr.live: https://testnet.cspr.live/deploy/${txHash}`);
  console.log("[relay] this proves a human's own CSPR.click-signed authorization settled on-chain, relayed (gas-paid) by KARMA, never touching the human's key.");
}

main().catch((e) => {
  console.error("[relay] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
