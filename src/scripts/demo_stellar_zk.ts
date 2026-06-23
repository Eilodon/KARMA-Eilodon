/**
 * KARMA Stellar ZK + x402 — offline orchestration demo (T8).
 *
 * Drives the full off-chain side of the Stellar fast-lane:
 *   1. Generate AgentCredentialProof for agent-alpha against an issuer-published merkle
 *      tree (uses circuits/ build artefacts produced by `make credential`).
 *   2. Build an x402 payment receipt via StellarX402Plugin (T7).
 *   3. Construct the HTTP request envelope (headers + body) that a provider stub would
 *      receive — the synthesis §5.6 wire format.
 *   4. Show what a provider would verify: proof shape, nullifier, payment receipt.
 *
 * This script is OFFLINE — it does NOT hit Stellar Testnet, the x402 facilitator, or any
 * real provider endpoint. Live deploy + execute is documented in DEMO_STELLAR.md and
 * gated behind real Stellar testnet credentials (out of scope for an ephemeral sandbox).
 *
 *   pnpm exec tsx src/scripts/demo_stellar_zk.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarX402Plugin } from "../plugins/x402_stellar.js";
import { deriveStellarKeypair } from "../lib/stellar/keypair.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const CIRCUITS = join(REPO, "circuits");

function ensureCircuitsBuilt(): void {
  const credentialBuild = join(CIRCUITS, "build/agent_credential");
  if (!existsSync(credentialBuild)) {
    console.log("[demo] circuits not built yet — running `make credential`...");
    execFileSync("make", ["credential"], { cwd: CIRCUITS, stdio: "inherit" });
  } else {
    console.log("[demo] circuits already built (build/agent_credential/ found)");
  }
}

function loadFixture(name: string): unknown {
  const path = join(CIRCUITS, "build/agent_credential", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("KARMA Stellar ZK + x402 — offline orchestration demo (T8)");
  console.log("=".repeat(80));

  // ── Step 1: ensure proof artefacts exist, then load happy-path proof + public signals.
  ensureCircuitsBuilt();
  const proof = loadFixture("happy.proof.json") as Record<string, unknown>;
  const publicSignals = loadFixture("happy.public.json") as string[];
  const [skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot] = publicSignals;
  box("AgentCredentialProof — public signals", [
    `skillId               = ${skillId}`,
    `minReputation         = ${minReputation}`,
    `nullifier             = ${nullifier.slice(0, 18)}...${nullifier.slice(-6)}`,
    `credentialCommitment  = ${credentialCommitment.slice(0, 18)}...${credentialCommitment.slice(-6)}`,
    `jobHistoryRoot        = ${jobHistoryRoot.slice(0, 18)}...${jobHistoryRoot.slice(-6)}`,
  ]);

  // ── Step 2: build the x402 payment receipt with the T7 plugin (testnet, USDC, $0.01).
  // For a demo run without the real keystore, derive the Stellar Keypair from a deterministic
  // fixture secp256k1 seed (same shape KeystoreManager produces at runtime via T6).
  const fakeSecp = new Uint8Array(32).fill(0x42);
  const stellarKp = deriveStellarKeypair(fakeSecp);
  const skillProviderPayee = "GDFAKEDEMODESTINATIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // placeholder
  const plugin = new StellarX402Plugin("https://www.x402.org/facilitator", () => stellarKp);
  const receipt = await plugin.pay(
    {
      skillId,
      price: "0.01",
      asset: "",
      payTo: skillProviderPayee,
      network: "stellar:testnet",
    },
    { agentId: "agent-alpha" },
  );
  box("x402 PaymentReceipt", [
    `rail            = ${receipt.rail}`,
    `network         = ${receipt.network}`,
    `payer           = ${receipt.payer}`,
    `payee           = ${receipt.payee.slice(0, 24)}...`,
    `amount          = ${receipt.amount} (smallest units, 7-decimal USDC)`,
    `asset (USDC)    = ${receipt.asset}`,
    `facilitator     = ${receipt.facilitatorRef}`,
  ]);
  if (!(await plugin.verify(receipt))) {
    console.error("[demo] FAIL — plugin verify rejected its own receipt");
    process.exit(1);
  }
  console.log("[demo] plugin.verify(receipt) → true (structural sanity OK)");

  // ── Step 3: construct the HTTP request envelope that the provider would receive.
  // Header names per synthesis §5.6. Body carries the (off-chain) task params.
  const headers = {
    "X-Payment-Receipt": JSON.stringify(receipt),
    "X-Reputation-Proof": Buffer.from(JSON.stringify(proof)).toString("base64"),
    "X-Nullifier": nullifier,
    "X-Skill-Id": skillId,
    "X-Public-Signals": Buffer.from(JSON.stringify(publicSignals)).toString("base64"),
    "Content-Type": "application/json",
  };
  console.log("\n┌── HTTP request envelope (what the provider sees) ──");
  console.log("│ POST /invoke HTTP/1.1");
  console.log(`│ Host: ${skillProviderPayee.slice(0, 14)}…example.com`);
  for (const [k, v] of Object.entries(headers)) {
    const display = v.length > 80 ? `${v.slice(0, 64)}…(${v.length} bytes total)` : v;
    console.log(`│ ${k}: ${display}`);
  }
  console.log("│");
  console.log(`│ {"task_params": "summarize this dataset"}`);
  console.log("└──────────────────────────────────────────────────");

  // ── Step 4: show what a provider/Soroban contract verifies, end-to-end:
  console.log("\n┌── Provider/Soroban-side verification (the trust mechanism) ──");
  console.log("│ 1. Decode X-Payment-Receipt — facilitator confirms USDC settle on Stellar Testnet");
  console.log("│ 2. Decode X-Reputation-Proof — Soroban verifier runs Groth16 over Bn254 (T5)");
  console.log("│ 3. Check X-Nullifier not in NullifierStore on Soroban — replay rejected");
  console.log("│ 4. Verify public signals order: [skillId, minRep, nullifier, cred, root]");
  console.log("│ 5. If all pass → execute skill, return result.  No KARMA server in the loop.");
  console.log("└──────────────────────────────────────────────────────────────");

  console.log("\n[demo] offline orchestration PASS");
  console.log("[demo] next step: see DEMO_STELLAR.md for the live deploy + run instructions.");
  console.log("[demo] derived Stellar address (would receive testnet USDC at this address):");
  console.log("       " + Keypair.fromPublicKey(stellarKp.publicKey()).publicKey());
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
