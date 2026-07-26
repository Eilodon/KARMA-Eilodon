/**
 * KARMA × Casper — live x402 HTTP loop (T13-live).
 *
 * Unlike `demo_casper_e2e.ts` (a fully in-memory state-machine walk), this script runs a REAL
 * local HTTP server and a REAL client `fetch()` against it, carrying a REAL EIP-712-signed
 * x402 payment envelope — and the provider runs REAL cryptographic verification
 * (`verifyCasperExactPayload`: rebuilds the `TransferAuthorization` digest and checks the
 * Casper-native signature against it), not a structural stub. The one piece this script does
 * NOT do by default is submit the on-chain `create_job` deploy that actually moves CSPR — that
 * needs a funded Testnet key, so it's gated behind `--live` (see `CasperLiveClient` /
 * `DEMO_CASPER.md`).
 *
 * Mirrors DEMO_STELLAR.md's provider-stub pattern: KARMA runs its own facilitator-equivalent
 * (verify the signed payload, no external `@x402/casper` package exists yet to depend on).
 *
 *   pnpm exec tsx src/scripts/demo_casper_x402_live.ts          # HTTP + crypto loop only
 *   pnpm exec tsx src/scripts/demo_casper_x402_live.ts --live   # + a real create_job deploy
 *     (needs CASPER_RPC_URL, KARMA_ODRA_REGISTRY, KEYSTORE_PATH/KEYSTORE_PASSWORD)
 */

import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import casperSdk from "casper-js-sdk";
import {
  CasperX402Plugin,
  CASPER_TESTNET_CAIP2,
  verifyCasperExactPayload,
  type CasperX402SignedPayload,
} from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey, casperAccountHash, casperPublicKeyHex } from "../lib/casper/keypair.js";
import { keystoreManager } from "../lib/keystore.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { fetchBtcUsdPrice, fetchUsTreasuryYield } from "../lib/casper/rwa_price_feed.js";

const { PublicKey } = casperSdk;

const PORT = 8934;
const PRICE_MOTES = "10000000"; // 0.01 CSPR
// Real `X402SettlementToken` deployed on Casper Testnet (contracts-odra/src/x402_settlement_token.rs) —
// canonical Locked deployment, 2026-07-25 redeploy (see DEMO_CASPER.md's redeploy chain). The
// previous fallback here (hash-b3387d59…) is the superseded Unlocked pre-redeploy token —
// verified live via RPC 2026-07-26, don't revert to it.
const SETTLEMENT_TOKEN_HASH =
  process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN ??
  "hash-6667f2d01cbf2af3b8ddca847c4e4294ea623f8bdc3dfe588af47ba56fc4cf3a";
// The `rwa_price_oracle` skill's on-chain id on the canonical registry (registered by
// demo_casper_rwa_oracle_lifecycle_live.ts) — override via env if a different registry/skill_id
// is being targeted. Booking this demo's escrow against the actual RWA-oracle skill (not an
// unrelated one) keeps the feed content and the on-chain job it's billed to consistent.
const RWA_SKILL_ID = BigInt(process.env.KARMA_RWA_SKILL_ID ?? "3");

function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  console.log("=".repeat(80));
  console.log("KARMA × Casper — live x402 HTTP loop (T13-live)");
  console.log("=".repeat(80));

  const providerKp = deriveCasperPrivateKey(new Uint8Array(32).fill(0x11));
  const requesterKp = deriveCasperPrivateKey(new Uint8Array(32).fill(0x22));
  const payee = casperAccountHash(providerKp);
  const network = CASPER_TESTNET_CAIP2;

  const clientPlugin = new CasperX402Plugin("http://localhost:" + PORT, () => requesterKp, {
    settlementTokenPackageHash: SETTLEMENT_TOKEN_HASH,
    // Deliberately "" (NOT `undefined`) — `CasperX402Plugin`'s constructor does
    // `opts.rpcUrl ?? process.env.CASPER_RPC_URL`, so `undefined` here would still fall through
    // to the env var and silently attempt an on-chain settleOnChain if the shell happens to have
    // CASPER_RPC_URL set. `requesterKp` is an unfunded deterministic demo key (fill 0x22), not a
    // funded account — that broadcast would just fail on insufficient balance. This script's x402
    // leg is HTTP + signature-verify only; the real funded-key settlement broadcast lives in
    // demo_casper_x402_settlement_live.ts. `""` is falsy so `payWithEnvelope`'s `if (this.rpcUrl)`
    // check correctly skips settleOnChain, independent of ambient env.
    rpcUrl: "",
  });

  // ── Provider (resource server) ──────────────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const paymentSig = req.headers["payment-signature"];
    if (!paymentSig || typeof paymentSig !== "string") {
      res.writeHead(402, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network, asset: "KX402", amount: PRICE_MOTES, payTo: payee }],
        }),
      );
      return;
    }

    console.log("[provider] PAYMENT-SIGNATURE received, verifying (real EIP-712 digest + Casper-native signature)...");
    const envelope = JSON.parse(Buffer.from(paymentSig, "base64").toString("utf8")) as CasperX402SignedPayload;
    const verdict = verifyCasperExactPayload(envelope, {
      expectedPayee: payee,
      expectedNetwork: network,
      settlementTokenPackageHash: SETTLEMENT_TOKEN_HASH,
    });
    if (!verdict.ok) {
      console.log("[provider] REJECTED:", verdict.reason);
      res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    console.log("[provider] verified OK — payer:", envelope.payload.from);

    // Fulfil: two REAL live RWA oracle quotes, each signed with the provider's Casper key —
    // each independently falls back to a fixed value (logged, never silent) if its network
    // call fails, so a demo run never hard-crashes on a flaky connection.
    //   1. BTC/USD spot price (CoinGecko).
    //   2. Average yield on outstanding U.S. Treasury Bills (U.S. Treasury Fiscal Data API) —
    //      a genuine real-world-asset benchmark rate, not a crypto-native price.
    const [btcQuote, ustQuote] = await Promise.all([fetchBtcUsdPrice(), fetchUsTreasuryYield()]);
    if (btcQuote.source === "fallback" || ustQuote.source === "fallback") {
      // Fail-closed (not fail-open): a fixed fallback value is fine to SHOW in a UI, but must
      // never be signed and sold as if it were a live quote — that's exactly the "generic
      // oracle with a fixed fallback" failure mode this demo is supposed to prove KARMA avoids.
      console.log("[provider] REJECTED: a live quote fell back to a fixed value — refusing to sign/sell it as evidence.");
      res.writeHead(503, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "upstream_price_feed_unavailable" }),
      );
      return;
    }
    const feeds = [
      { feed: btcQuote.feed, price: btcQuote.price, timestamp: btcQuote.timestamp, source: btcQuote.source },
      { feed: ustQuote.feed, price: ustQuote.price, timestamp: ustQuote.timestamp, source: ustQuote.source },
    ];
    console.log(`[provider] price feed: ${btcQuote.feed} = $${btcQuote.price} (source: ${btcQuote.source})`);
    console.log(`[provider] price feed: ${ustQuote.feed} = ${ustQuote.price}% (source: ${ustQuote.source})`);
    const feedCanonical = JSON.stringify(feeds);
    // `signAndAddAlgorithmBytes` (not plain `.sign()`) — casper-js-sdk's `PublicKey.verifySignature`
    // slices off a leading algorithm-tag byte before checking the signature; plain `.sign()`'s
    // raw 64-byte compact output has no such tag, so a genuinely independent verifier (below)
    // would reject a validly-signed feed. This is the same convention Casper uses on-chain.
    const feedSig = providerKp.signAndAddAlgorithmBytes(new TextEncoder().encode(feedCanonical));

    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        feeds,
        signature: Buffer.from(feedSig).toString("hex"),
        // Sent over the wire so a genuinely separate client can verify independently — not
        // assumed out-of-band just because provider and client happen to share a process here.
        providerPublicKeyHex: casperPublicKeyHex(providerKp),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[demo] provider stub listening on http://localhost:${PORT}/invoke`);

  // ── Client (requester) ───────────────────────────────────────────────────────────────────
  console.log("[client] step 1: probe /invoke (no payment)");
  const probe = await fetch(`http://localhost:${PORT}/invoke`, { method: "POST" });
  if (probe.status !== 402) throw new Error(`expected 402, got ${probe.status}`);
  const paymentRequired = (await probe.json()) as {
    accepts: Array<{ amount: string; payTo: string }>;
  };
  box("Step 1 — 402 Payment Required (real HTTP)", [
    `accepts[0].amount = ${paymentRequired.accepts[0].amount} motes`,
    `accepts[0].payTo  = ${paymentRequired.accepts[0].payTo}`,
  ]);

  console.log("[client] step 2: sign a real x402 payment envelope (EIP-712 TransferAuthorization digest)...");
  const { envelope, receipt } = await clientPlugin.payWithEnvelope(
    { skillId: RWA_SKILL_ID.toString(), price: PRICE_MOTES, asset: "KX402", payTo: payee, network },
    { agentId: "agent-requester" },
  );
  const paymentSig = Buffer.from(JSON.stringify(envelope)).toString("base64");
  box("Step 2 — signed envelope", [
    `payer     = ${envelope.payload.from}`,
    `payee     = ${envelope.payload.to}`,
    `value     = ${envelope.payload.value} (settlement-token units)`,
    `signature = ${receipt.signature?.slice(0, 24)}...`,
  ]);

  console.log("[client] step 3: POST /invoke with PAYMENT-SIGNATURE — one request, real signature verified server-side");
  const final = await fetch(`http://localhost:${PORT}/invoke`, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": paymentSig },
  });
  const body = (await final.json()) as {
    feeds?: Array<{ feed: string; price: string; timestamp: number; source: string }>;
    signature?: string;
    providerPublicKeyHex?: string;
    error?: unknown;
  };
  box("Step 3 — provider response", [
    `status = ${final.status}`,
    `feeds  = ${JSON.stringify(body.feeds ?? body.error)}`,
  ]);
  if (!final.ok) {
    server.close();
    process.exit(1);
  }

  console.log("[client] step 3.5: independently verify the provider's signature over the feed (public key received over HTTP, not assumed out-of-band)...");
  const providerPub = PublicKey.fromHex(body.providerPublicKeyHex!);
  // `verifySignature` THROWS on a bad signature (casper-js-sdk's `PublicKey.verifySignature`
  // does `if (!n) throw ErrInvalidSignature`) rather than returning false — confirmed against a
  // deliberately tampered signature before relying on this. Caught here so a real mismatch
  // prints a clean MISMATCH box instead of an uncaught stack trace.
  let feedVerified: boolean;
  try {
    feedVerified = providerPub.verifySignature(
      new TextEncoder().encode(JSON.stringify(body.feeds)),
      Buffer.from(body.signature!, "hex"),
    );
  } catch {
    feedVerified = false;
  }
  box("Step 3.5 — feed signature verification", [
    `provider pubkey = ${body.providerPublicKeyHex!.slice(0, 20)}...`,
    `result          = ${feedVerified ? "MATCH — signature verifies against the feed bytes" : "MISMATCH — reject"}`,
  ]);
  server.close();
  if (!feedVerified) process.exit(1);

  if (!live) {
    console.log(
      "\n[demo] HTTP + crypto loop PASS (offline). Re-run with --live (+ CASPER_RPC_URL / " +
      "KARMA_ODRA_REGISTRY / KEYSTORE_PATH / KEYSTORE_PASSWORD) to also submit the real " +
      "create_job settlement deploy.",
    );
    return;
  }

  const rpcUrl = process.env.CASPER_RPC_URL;
  const contract = process.env.KARMA_ODRA_REGISTRY;
  if (!rpcUrl || !contract) throw new Error("[demo] --live needs CASPER_RPC_URL + KARMA_ODRA_REGISTRY");
  await keystoreManager.load(process.env.KEYSTORE_PATH!, process.env.KEYSTORE_PASSWORD!);
  const agentId = process.env.KARMA_AGENT_ID ?? keystoreManager.list()[0];
  if (!agentId) throw new Error("[demo] keystore has no agents loaded");
  const client = new CasperLiveClient({
    rpcUrl,
    contractHash: contract,
    rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
  });
  // Real sha256 over a small canonical struct, not a truncated JSON.stringify() — the previous
  // version here was just the first 32 bytes of the envelope's JSON serialization (constant
  // across re-runs sharing the same skillId literal), so any second --live run would collide on
  // job_by_task_hash and revert DuplicateTaskHash. nonce + ts make every run's hash unique.
  const taskHash = createHash("sha256")
    .update(JSON.stringify({
      payer: envelope.payload.from,
      payee: envelope.payload.to,
      value: envelope.payload.value,
      nonce: envelope.payload.nonce,
      skillId: RWA_SKILL_ID.toString(),
      salt: randomBytes(8).toString("hex"),
      ts: Date.now(),
    }))
    .digest("hex");
  const { txHash } = await client.createJob(keystoreManager.getCasperKeypair(agentId), {
    skillId: RWA_SKILL_ID,
    taskHashHex: taskHash,
    deadlineSecs: 259_200n,
    escrowMotes: BigInt(PRICE_MOTES),
  });
  box("Step 4 — create_job settled on Casper Testnet", [`transaction hash = ${txHash}`]);
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
