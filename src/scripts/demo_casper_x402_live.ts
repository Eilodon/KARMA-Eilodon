/**
 * KARMA × Casper — live x402 HTTP loop (T13-live).
 *
 * Unlike `demo_casper_e2e.ts` (a fully in-memory state-machine walk), this script runs a REAL
 * local HTTP server and a REAL client `fetch()` against it, carrying a REAL secp256k1-signed
 * x402 payment envelope — and the provider runs REAL cryptographic verification
 * (`verifyCasperExactPayload`, node:crypto ECDSA/SHA-256 against the DER signature), not a
 * structural stub. The one piece this script does NOT do by default is submit the on-chain
 * `create_job` deploy that actually moves CSPR — that needs a funded Testnet key, so it's gated
 * behind `--live` (see `CasperLiveClient` / `DEMO_CASPER.md`).
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
import { CasperX402Plugin, verifyCasperExactPayload, type CasperX402SignedPayload } from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
import { keystoreManager } from "../lib/keystore.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { fetchBtcUsdPrice } from "../lib/casper/rwa_price_feed.js";

const PORT = 8934;
const PRICE_MOTES = "10000000"; // 0.01 CSPR

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
  const network = "casper:testnet";

  const clientPlugin = new CasperX402Plugin("http://localhost:" + PORT, () => requesterKp);

  // ── Provider (resource server) ──────────────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    const xPayment = req.headers["x-payment"];
    if (!xPayment || typeof xPayment !== "string") {
      res.writeHead(402, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", network, asset: "CSPR", amount: PRICE_MOTES, payTo: payee }],
        }),
      );
      return;
    }

    console.log("[provider] X-Payment received, verifying (real ECDSA/SHA-256, no facilitator round-trip)...");
    const envelope = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8")) as CasperX402SignedPayload;
    const verdict = verifyCasperExactPayload(envelope, { expectedPayee: payee, expectedNetwork: network });
    if (!verdict.ok) {
      console.log("[provider] REJECTED:", verdict.reason);
      res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify({ error: verdict.reason }));
      return;
    }
    console.log("[provider] verified OK — payer:", envelope.payload.payer);

    // Fulfil: a REAL live BTC/USD quote (CoinGecko), signed with the provider's Casper key —
    // falls back to a fixed price (logged, never silent) if the network call fails.
    const quote = await fetchBtcUsdPrice();
    const feed = { feed: quote.feed, price: quote.price, timestamp: quote.timestamp };
    console.log(`[provider] price feed: ${feed.feed} = $${feed.price} (source: ${quote.source})`);
    const feedCanonical = JSON.stringify(feed);
    const feedSig = providerKp.sign(new TextEncoder().encode(feedCanonical));

    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ feed, signature: Buffer.from(feedSig).toString("hex"), source: quote.source }),
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

  console.log("[client] step 2: sign a real x402 payment envelope (secp256k1/SHA-256/DER)...");
  const { envelope, receipt } = await clientPlugin.payWithEnvelope(
    { skillId: "1", price: PRICE_MOTES, asset: "CSPR", payTo: payee, network },
    { agentId: "agent-requester" },
  );
  const xPayment = Buffer.from(JSON.stringify(envelope)).toString("base64");
  box("Step 2 — signed envelope", [
    `payer     = ${envelope.payload.payer}`,
    `payee     = ${envelope.payload.payee}`,
    `amount    = ${envelope.payload.amount} motes`,
    `signature = ${receipt.txHash?.slice(0, 24)}...`,
  ]);

  console.log("[client] step 3: POST /invoke with X-Payment — one request, real signature verified server-side");
  const final = await fetch(`http://localhost:${PORT}/invoke`, {
    method: "POST",
    headers: { "X-Payment": xPayment },
  });
  const body = (await final.json()) as { feed?: unknown; error?: unknown };
  box("Step 3 — provider response", [
    `status = ${final.status}`,
    `feed   = ${JSON.stringify(body.feed ?? body.error)}`,
  ]);
  server.close();
  if (!final.ok) process.exit(1);

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
  const taskHash = Buffer.from(JSON.stringify({ envelope, skillId: 1 })).toString("hex").slice(0, 64);
  const { txHash } = await client.createJob(keystoreManager.getCasperKeypair(agentId), {
    skillId: 1n,
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
