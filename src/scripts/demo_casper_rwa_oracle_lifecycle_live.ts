/**
 * Full RWA-oracle lifecycle on the canonical, Locked, governance-hardened Casper contract —
 * register_skill(rwa_price_oracle) -> deposit_bond -> create_job -> attest_rationale ->
 * deliver_result -> confirm_completion -> withdraw, with REAL BTC/UST feed data bound into the
 * on-chain result_hash. Closes the gap a code audit found: the `rwa_price_oracle` skill referenced
 * throughout README/DEMO_CASPER.md's "Real-World Applicability" claim was never actually registered
 * on the current canonical contract (`hash-2262a0a9…`) — only on superseded predecessors.
 *
 * Mirrors demo_casper_full_job_lifecycle.ts's proven pattern (same two funded governance-signer
 * wallets already in .env, same probe-next-free-id / waitForFinalization approach — re-runnable
 * across takes without assuming a fresh/empty registry) but adds: real RWA feed fetch with
 * fail-closed on fallback (same principle as demo_casper_x402_live.ts), a signed provider receipt
 * whose sha256 becomes the on-chain result_hash (independently recomputable by any verifier), and
 * attest_rationale binding the requester's plain-English purchase reasoning to the job.
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env (same as
 * demo_casper_full_job_lifecycle.ts). Provider = governance signer 1, requester = governance
 * signer 2 — deliberately different accounts so settle_completion's self-deal guard doesn't zero
 * reputation signals.
 *
 *   pnpm exec tsx src/scripts/demo_casper_rwa_oracle_lifecycle_live.ts
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { casperPublicKeyHex } from "../lib/casper/keypair.js";
import { fetchBtcUsdPrice, fetchUsTreasuryYield } from "../lib/casper/rwa_price_feed.js";
import {
  buildProvenanceReceipt,
  canonicalize,
  assertNotFallback,
  type RwaProvenanceReceipt,
} from "../lib/casper/rwa_provenance_receipt.js";
import { jsonSafe } from "../lib/serialize.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler } = casperSdk;

const PRICE_PER_CALL_MOTES = 10_000_000n; // 0.01 CSPR — matches register_rwa_oracle_skill.ts's SKILL config
const BOND_MOTES = 1_000_000_000n; // 1 CSPR Tier-2 Sybil bond (PD-007) — not contract-required for
// create_job (verified: `_create_job` never reads `bonded_amount`), included for narrative
// consistency with the other full-lifecycle demo.

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function waitForExecution(rpc: InstanceType<typeof casperSdk.RpcClient>, txHash: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      // See demo_casper_full_job_lifecycle.ts's own comment: `errorMessage` can come back
      // present-but-undefined for an already-succeeded tx on this SDK version — only accept
      // once it's unambiguously null (success) or a string (revert).
      const executionResult = (
        exec as { executionResult?: { errorMessage?: string | null } } | undefined
      )?.executionResult;
      if (executionResult?.errorMessage !== undefined) {
        if (executionResult.errorMessage) throw new Error(`[${label}] on-chain execution failed: ${executionResult.errorMessage}`);
        console.log(`  [${label}] finalized: errorMessage: null (success)`);
        return;
      }
      console.log(`  [${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`[${label}]`)) throw e;
      console.log(`  [${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  throw new Error(`[${label}] never finalized after 150s`);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CASPER_RPC_URL!;
  const apiKey = process.env.CASPER_RPC_API_KEY;
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const contractHash = process.env.CASPER_CONTRACT_HASH!;

  const provider = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const requester = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const providerAccountHash = provider.publicKey.accountHash().toPrefixedString();
  const requesterAccountHash = requester.publicKey.accountHash().toPrefixedString();
  console.log("provider (signer 1, owns rwa_price_oracle):", providerAccountHash);
  console.log("requester (signer 2, buys the feed):       ", requesterAccountHash);
  console.log("registry:", contractHash);

  const handler = new HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  console.log("\nlock_status:", await client.getLockStatus());

  // Re-runnable: probe for an already-registered "rwa_price_oracle" skill (e.g. a prior run of
  // this exact script that got this far before an unrelated later step failed) instead of
  // registering a second, duplicate skill entry every retry.
  let skillId = 1n;
  let alreadyRegistered = false;
  for (;;) {
    const s = await client.getSkill(skillId);
    if (s === undefined) break;
    if (s.name === "rwa_price_oracle") {
      alreadyRegistered = true;
      break;
    }
    skillId += 1n;
  }

  let registerSkillTx = "(skipped — already registered)";
  if (alreadyRegistered) {
    console.log(`\n1. register_skill — SKIPPED, rwa_price_oracle already registered as skill_id=${skillId}`);
  } else {
    console.log(`\n1. register_skill (rwa_price_oracle, will be skill_id=${skillId})...`);
    const reg = await client.registerSkill(provider, {
      name: "rwa_price_oracle",
      description:
        "Signed real-world-asset price feed (BTC/USD + US Treasury Bill avg yield). Returns a " +
        "Casper-signed JSON envelope: { feeds, providerPublicKeyHex, signature }.",
      mcpEndpoint: "casper-mcp://providers/rwa_price_oracle",
      pricePerCallMotes: PRICE_PER_CALL_MOTES,
      minReputationToInvoke: 0,
      identityPolicy: 0,
    });
    registerSkillTx = reg.txHash;
    console.log("  tx:", reg.txHash);
    await waitForExecution(rpc, reg.txHash, "register_skill");
  }

  let depositBondTx = "(skipped — already bonded)";
  const alreadyBonded = BigInt(await client.bondedOf(providerAccountHash)) >= BOND_MOTES;
  if (alreadyBonded) {
    console.log("\n2. deposit_bond — SKIPPED, provider already bonded >= 1 CSPR");
  } else {
    console.log("\n2. deposit_bond (Tier-2 Sybil bond, PD-007)...");
    const bond = await client.depositBond(provider, BOND_MOTES);
    depositBondTx = bond.txHash;
    console.log("  tx:", bond.txHash);
    await waitForExecution(rpc, bond.txHash, "deposit_bond");
  }

  console.log("\n3. fetching REAL RWA quotes (fail-closed on fallback)...");
  const [btcQuote, ustQuote] = await Promise.all([fetchBtcUsdPrice(), fetchUsTreasuryYield()]);
  console.log(`   ${btcQuote.feed} = $${btcQuote.price} (source: ${btcQuote.source})`);
  console.log(`   ${ustQuote.feed} = ${ustQuote.price}% (source: ${ustQuote.source})`);
  // Fail-closed on either quote — same principle as demo_casper_x402_live.ts's Step 3 guard, now
  // the shared assertNotFallback() validator (T14/T15) instead of an inline check.
  assertNotFallback(btcQuote.source);
  assertNotFallback(ustQuote.source);

  let jobId = 1n;
  while ((await client.getJob(jobId)) !== undefined) jobId += 1n;
  // Real sha256 over a small canonical struct (requester/skill/feeds-requested/nonce/timestamp) —
  // not a truncated JSON.stringify() slice, which would be constant across runs and collide on
  // job_by_task_hash (DuplicateTaskHash) the second time this script runs.
  const taskHash = sha256Hex(JSON.stringify({
    requester: requesterAccountHash,
    skillId: skillId.toString(),
    feedsRequested: ["BTC/USD", "UST-BILLS/AVG-YIELD"],
    nonce: randomBytes(16).toString("hex"),
    ts: Date.now(),
  }));
  console.log(`\n4. create_job (will be job_id=${jobId}; requester escrows ${PRICE_PER_CALL_MOTES} motes)...`);
  const job = await client.createJob(requester, {
    skillId,
    taskHashHex: taskHash,
    deadlineSecs: 3600n,
    escrowMotes: PRICE_PER_CALL_MOTES,
  });
  console.log("  tx:", job.txHash);
  await waitForExecution(rpc, job.txHash, "create_job");

  const rationale =
    `Requester selected rwa_price_oracle (skill_id=${skillId}) — the registered RWA-oracle ` +
    `skill on this registry — at ${PRICE_PER_CALL_MOTES} motes (0.01 CSPR) per call. Feeds ` +
    "requested: BTC/USD (CoinGecko) and UST-BILLS/AVG-YIELD (U.S. Treasury Fiscal Data API), " +
    "both required to be a live quote (source != \"fallback\") at purchase time or the job is " +
    "not created at all.";
  const rationaleHash = createHash("sha256").update(rationale).digest();
  console.log("\n5. attest_rationale (requester)...");
  console.log("   rationale:", rationale);
  const attest = await client.attestRationale(requester, jobId, rationaleHash);
  console.log("  tx:", attest.txHash);
  await waitForExecution(rpc, attest.txHash, "attest_rationale");

  // Full 10-field provenance receipt per feed (T14) — one receipt per source, not one bundle
  // covering both, since every field below (sourceUrl, normalizedValue, ...) is singular-value-
  // oriented. `providerSignature` signs the receipt's OTHER 9 fields (it can't sign itself) —
  // build unsigned, sign that canonical payload, then attach the signature. Same
  // signAndAddAlgorithmBytes convention as demo_casper_x402_live.ts (plain .sign() output isn't
  // directly verifiable via PublicKey.verifySignature, which strips a leading algorithm-tag byte
  // before checking).
  const FRESHNESS_MS = 5 * 60_000; // quote considered fresh for 5 minutes from retrieval
  const providerPublicKey = casperPublicKeyHex(provider);
  const receipts: RwaProvenanceReceipt[] = [btcQuote, ustQuote].map((quote) => {
    const unsigned = buildProvenanceReceipt({
      jobId,
      requestHash: taskHash,
      quote,
      freshnessMs: FRESHNESS_MS,
      providerPublicKey,
      providerSignature: "",
    });
    const { providerSignature, ...signablePayload } = unsigned;
    void providerSignature; // placeholder value ("") — deliberately excluded from the signed payload
    const sig = provider.signAndAddAlgorithmBytes(new TextEncoder().encode(canonicalize(signablePayload)));
    return { ...unsigned, providerSignature: Buffer.from(sig).toString("hex") };
  });
  const resultHash = sha256Hex(canonicalize(receipts));
  console.log("\n6. deliver_result (provider) — result_hash binds the signed feed receipts...");
  console.log("   receipts:", canonicalize(receipts));
  console.log("   result_hash (sha256 of canonicalized receipts):", resultHash);
  const deliver = await client.deliverResult(provider, { jobId, resultHashHex: resultHash });
  console.log("  tx:", deliver.txHash);
  await waitForExecution(rpc, deliver.txHash, "deliver_result");

  console.log("\n7. confirm_completion (requester)...");
  const confirm = await client.confirmCompletion(requester, jobId);
  console.log("  tx:", confirm.txHash);
  await waitForExecution(rpc, confirm.txHash, "confirm_completion");

  console.log("\n8. withdraw (provider pulls payout)...");
  const withdraw = await client.withdraw(provider);
  console.log("  tx:", withdraw.txHash);
  await waitForExecution(rpc, withdraw.txHash, "withdraw");

  console.log("\nverifying final state...");
  const skill = await client.getSkill(skillId);
  const finalJob = await client.getJob(jobId);
  const onChainRationaleHash = await client.getRationaleHash(jobId);
  console.log(`  getSkill(${skillId}):`, JSON.stringify(jsonSafe(skill)));
  console.log(`  getJob(${jobId}):`, JSON.stringify(jsonSafe(finalJob)));
  console.log(`  getRationaleHash(${jobId}):`, onChainRationaleHash);
  console.log(`  rationale hash matches sha256(rationale text)?`, onChainRationaleHash === rationaleHash.toString("hex"));
  console.log(`  result_hash on-chain matches sha256(canonicalized receipts)?`, finalJob?.resultHash && Buffer.from(finalJob.resultHash).toString("hex") === resultHash);

  console.log("\n=== tx-by-tx summary ===");
  console.log(JSON.stringify({
    skillId: skillId.toString(),
    jobId: jobId.toString(),
    register_skill: registerSkillTx,
    deposit_bond: depositBondTx,
    create_job: job.txHash,
    attest_rationale: attest.txHash,
    deliver_result: deliver.txHash,
    confirm_completion: confirm.txHash,
    withdraw: withdraw.txHash,
    taskHash,
    rationaleHashHex: rationaleHash.toString("hex"),
    resultHash,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
