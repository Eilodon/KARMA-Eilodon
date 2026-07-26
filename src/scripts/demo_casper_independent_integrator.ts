/**
 * Independent third-party integrator demo (P5).
 *
 * Every other `demo_casper_*` script in this repo acts as KARMA's own agent, signing with
 * KARMA's own keystore (`KeystoreManager`) via `karma.tool.ts`'s orchestration. This script
 * deliberately does neither. It proves the deployed `AgentSkillRegistry`'s public interface is
 * independently consumable — by an identity with zero relationship to KARMA's keystore, config,
 * or tooling — which is the concrete first step toward the roadmap item "get a second
 * independently authored implementation" before submitting `CEP-0000` upstream (see
 * docs/standards/CEP-0000-agent-skill-trust-registry.md and README.md "Roadmap & team").
 *
 * What makes this "independent," specifically:
 *   - The identity is a FRESH secp256k1 keypair generated in-memory on every run, via
 *     `viem/accounts`' generic key generator — the same primitive any outside developer would
 *     reach for, not KARMA's `keystore.json` / `KeystoreManager`.
 *   - The only inputs are values already public in README.md's "Live deployment" table
 *     (`CASPER_RPC_URL`, the `AgentSkillRegistry` package hash) — nothing KARMA-internal.
 *   - It reuses `CasperLiveClient` (the low-level Odra CLValue/RPC codec — a technical utility
 *     any implementer would also need to get byte-correct) but never `karma.tool.ts`'s
 *     orchestration layer or any KARMA agent identity.
 *
 * Modes:
 *   pnpm exec tsx src/scripts/demo_casper_independent_integrator.ts                  # dry-run, no network
 *   pnpm exec tsx src/scripts/demo_casper_independent_integrator.ts --live           # read-only, live RPC, no funds needed
 *   pnpm exec tsx src/scripts/demo_casper_independent_integrator.ts --live --write   # also submits a real deploy —
 *     the freshly generated address must be funded from the testnet faucet first; the script
 *     prints the address and exits with funding instructions if the deploy fails for lack of funds.
 *
 * Env (only read in --live):
 *   CASPER_RPC_URL      e.g. https://node.testnet.cspr.cloud/rpc — must contain "testnet"; mainnet
 *                        is rejected, same DP-3 guard convention as every other live script here.
 *   KARMA_ODRA_REGISTRY the published AgentSkillRegistry package hash (README.md "Live deployment").
 *   CASPER_RPC_API_KEY  optional — some hosted RPC providers (cspr.cloud) now require an API key;
 *                        passed through as-is as an `Authorization` header, no "Bearer " prefix.
 *   DEMO_SKILL_ID       skill id to discover/read (default "1" — on the current custody-hardened
 *                        deploy this is `casper_panel_dispute_demo`; verified live 2026-07-26,
 *                        override via DEMO_SKILL_ID if the target deploy differs).
 */

import { Buffer } from "node:buffer";
import { generatePrivateKey } from "viem/accounts";
import { deriveCasperPrivateKey, casperPublicKeyHex, casperAccountHash } from "../lib/casper/keypair.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";

interface RunArgs {
  live: boolean;
  write: boolean;
  rpcUrl?: string;
  contract?: string;
  skillId: bigint;
}

function parseArgs(argv: string[]): RunArgs {
  return {
    live: argv.includes("--live"),
    write: argv.includes("--write"),
    rpcUrl: process.env.CASPER_RPC_URL,
    contract: process.env.KARMA_ODRA_REGISTRY,
    skillId: BigInt(process.env.DEMO_SKILL_ID ?? "1"),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A brand-new identity, generated fresh on every run — never KARMA's keystore. */
function generateIndependentIdentity() {
  const rawHex = generatePrivateKey(); // viem/accounts: generic random secp256k1 key, 0x-prefixed
  const signer = deriveCasperPrivateKey(hexToBytes(rawHex));
  return {
    signer,
    publicKeyHex: casperPublicKeyHex(signer),
    accountHash: casperAccountHash(signer),
  };
}

function printDryRun(args: RunArgs): void {
  const identity = generateIndependentIdentity();
  console.log("=".repeat(80));
  console.log("Independent third-party integrator (DRY-RUN, P5)");
  console.log("=".repeat(80));
  console.log(`
This run generated a throwaway identity with ZERO relationship to KARMA's keystore:
  public key   : ${identity.publicKeyHex}
  account hash : ${identity.accountHash}

With --live, this script would, using ONLY the public RPC URL + published registry hash from
README.md's "Live deployment" table:
  1. Read the registry's lock status (getLockStatus) — proves the contract is publicly readable.
  2. Discover skill #${args.skillId} (getSkill) — proves skills are discoverable with no KARMA-side allowlist.
  3. Read this fresh identity's own on-chain reputation (agentReputationOf) — expected
     BASE_REPUTATION (50, the contract's neutral starting score for any never-before-seen agent —
     see agent_reputation() in contracts-odra/src/agent_skill_registry.rs), proving a brand-new
     identity is admitted at a defined neutral score, not gated out or silently allowlisted.

With --live --write, after funding the printed account hash from a Casper Testnet faucet, it
would additionally call registerSkill as this fresh identity — proving the write path is open
to any identity, not just KARMA's own agents.
`);
  console.log("Fund from: https://testnet.cspr.live/tools/faucet (paste the account hash above)");
}

async function runLive(args: RunArgs): Promise<void> {
  if (!args.rpcUrl) throw new Error("[independent-integrator] CASPER_RPC_URL not set");
  if (!args.rpcUrl.includes("testnet")) {
    throw new Error("[independent-integrator] CASPER_RPC_URL must be a testnet endpoint — mainnet rejected by convention");
  }
  if (!args.contract) throw new Error("[independent-integrator] KARMA_ODRA_REGISTRY (package hash) not set");

  const identity = generateIndependentIdentity();
  console.log("[independent-integrator] fresh identity generated this run (not KARMA's keystore):");
  console.log(`  public key   : ${identity.publicKeyHex}`);
  console.log(`  account hash : ${identity.accountHash}`);

  const client = new CasperLiveClient({
    rpcUrl: args.rpcUrl,
    contractHash: args.contract,
    rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
  });

  const lockStatus = await client.getLockStatus();
  console.log(`\n[1/3] registry lock status : ${lockStatus ?? "(unavailable)"}`);

  const skill = await client.getSkill(args.skillId);
  if (skill) {
    const jsonSafe = JSON.stringify(
      skill,
      (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
    console.log(`[2/3] discovered skill #${args.skillId} :`, jsonSafe);
  } else {
    console.log(`[2/3] skill #${args.skillId} not found — set DEMO_SKILL_ID to a valid id`);
  }

  const reputation = await client.agentReputationOf(identity.accountHash);
  console.log(
    `[3/3] this fresh identity's on-chain reputation : ${reputation} ` +
      "(expected 50 = BASE_REPUTATION, the protocol's neutral starting score — not 0, and not gated)",
  );

  if (!args.write) {
    console.log("\n(read-only run — pass --write, after funding the account hash above, to also submit a live deploy)");
    return;
  }

  if (!skill) {
    console.log("\n[independent-integrator] skipping --write: target skill was not found above.");
    return;
  }

  console.log(`\n[write] submitting createJob as the fresh identity against skill #${args.skillId}...`);
  try {
    const taskHash = new Uint8Array(32).fill(1); // deterministic placeholder — a real integrator would hash real task content
    const taskHashHex = Buffer.from(taskHash).toString("hex");
    const { txHash } = await client.createJob(
      identity.signer,
      { skillId: args.skillId, taskHashHex, deadlineSecs: 3600n, escrowMotes: skill.pricePerCallMotes },
    );
    console.log(`[write] submitted — transaction hash: ${txHash}`);
    console.log("[write] confirm on testnet.cspr.live — this proves an unrelated identity can create a job unaided.");
  } catch (error) {
    console.error(
      "[write] FAILED — most likely the fresh account above isn't funded yet. Fund it at " +
        "https://testnet.cspr.live/tools/faucet and re-run with --live --write.",
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.live) {
    printDryRun(args);
    return;
  }
  await runLive(args);
}

main().catch((e) => {
  console.error("[independent-integrator] FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
