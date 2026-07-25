/**
 * Streaming/chunked payment for a long-running task, WITHOUT any new contract code — "Design C"
 * from the streaming-payment research: a long task is split into N chunks, and each chunk runs
 * through the escrow rail's existing, unmodified lifecycle (create_job -> deliver_result ->
 * confirm_completion), exactly as `demo_casper_full_job_lifecycle.ts` does once. Every chunk gets
 * the SAME dispute-bond + reputation protection as any other job — nothing new to audit, nothing
 * new to trust, because nothing new was added to the contract.
 *
 * This directly answers two gaps found while researching KARMA's own escrow rail:
 *   1. Neither the escrow rail (`escrow_amount` is set once at `create_job`, never incremented —
 *      confirmed by reading every use of `escrow_amount` in agent_skill_registry.rs) nor the x402
 *      rail (`X402SettlementToken` has no batch/channel entry point — confirmed by reading
 *      x402_settlement_token.rs) has a native multi-release primitive.
 *   2. The two rails settle in different assets entirely (native CSPR via `attached_value()` vs.
 *      the wrapped CEP-18 `X402SettlementToken`), so "streaming via x402" and "escrow-protected"
 *      were previously mutually exclusive.
 * Design C sidesteps both: N ordinary escrow jobs, linked by a task_hash derived from a shared
 * series id, is dispute-protected AND reputation-bearing per chunk, and costs whatever N ordinary
 * jobs cost — real numbers measured from a prior live run of this repo's own transactions:
 * ~1 CSPR for a plain call (register_skill/deliver_result/confirm_completion), ~4.6 CSPR for the
 * payable proxy-session call (create_job) — at ~$0.0015/CSPR that's roughly $0.01 per chunk, not
 * a new fee model.
 *
 * Trade-off, stated plainly: `create_job` is `#[odra(payable)]` (native CSPR, no EIP-712-style
 * relay), so the requester must actively co-sign every chunk — there is no "approve once, pull
 * unattended" mode here (that's CEP-18 `approve`/`transfer_from` on `X402SettlementToken`
 * instead — a different, complementary design for when dispute protection isn't needed). Fine
 * for an autonomous requester agent that stays online for the task's duration; a poor fit for a
 * human wallet expected to sign per chunk.
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env — same funded pair
 * `demo_casper_full_job_lifecycle.ts` uses. Not run live in this session (no funded Testnet key
 * available here); typechecked and structured to match that script's proven pattern exactly.
 *
 *   pnpm exec tsx src/scripts/demo_casper_streaming_installments.ts [chunkCount]
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { jsonSafe } from "../lib/serialize.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler } = casperSdk;

const PRICE_PER_CHUNK_MOTES = 100_000_000n; // 0.1 CSPR per chunk

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Derives chunk N's task_hash from a shared series id — how a requester/observer discovers and
 *  re-groups the N jobs belonging to one logical streaming task (there is no on-chain "series"
 *  concept; grouping is a client-side convention over the existing task_hash field). */
function chunkTaskHash(seriesId: string, chunkIndex: number): string {
  return sha256Hex(`${seriesId}:chunk:${chunkIndex}`);
}

interface ChunkCost {
  chunkIndex: number;
  jobId: bigint;
  createJobConsumedMotes: bigint;
  deliverResultConsumedMotes: bigint;
  confirmCompletionConsumedMotes: bigint;
}

async function waitForFinalization(
  rpc: InstanceType<typeof casperSdk.RpcClient>,
  txHash: string,
  label: string,
): Promise<bigint> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec) {
        const err = exec.executionResult?.errorMessage;
        const consumed = BigInt(exec.executionResult?.consumed ?? 0);
        console.log(`    [${label}] finalized. errorMessage: ${err === null ? "null (success)" : err}, consumed: ${consumed} motes`);
        return consumed;
      }
      console.log(`    [${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`    [${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`    [${label}] gave up waiting for finalization after 30 attempts`);
  return 0n;
}

async function main(): Promise<void> {
  const chunkCount = Number(process.argv[2] ?? "3");
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error(`chunkCount must be a positive integer, got ${process.argv[2]}`);
  }

  const rpcUrl = process.env.CASPER_RPC_URL!;
  const apiKey = process.env.CASPER_RPC_API_KEY;
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const contractHash = process.env.CASPER_CONTRACT_HASH!;

  const provider = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const requester = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  console.log("provider (signer 1):", provider.publicKey.accountHash().toPrefixedString());
  console.log("requester (signer 2):", requester.publicKey.accountHash().toPrefixedString());
  console.log(`streaming ${chunkCount} chunk(s) of ${PRICE_PER_CHUNK_MOTES} motes each\n`);

  const handler = new HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  // One skill for the whole series — price_per_call is the per-chunk price, not the task total.
  let skillId = 1n;
  while ((await client.getSkill(skillId)) !== undefined) skillId += 1n;
  console.log(`0. register_skill for the series (will be skill_id=${skillId})...`);
  const reg = await client.registerSkill(provider, {
    name: "casper_streaming_installments_demo",
    description: "KARMA streaming/chunked payment demo — one skill, N escrow-protected chunk jobs",
    mcpEndpoint: "https://demo.karma.local/mcp/streaming-installments",
    pricePerCallMotes: PRICE_PER_CHUNK_MOTES,
    minReputationToInvoke: 0,
    identityPolicy: 0,
  });
  console.log("   tx:", reg.txHash);
  await waitForFinalization(rpc, reg.txHash, "register_skill");

  const seriesId = `karma-streaming-demo-${Date.now()}`;
  const costs: ChunkCost[] = [];

  for (let i = 0; i < chunkCount; i += 1) {
    console.log(`\nchunk ${i + 1}/${chunkCount} ──────────────────────────────`);

    let jobId = 1n;
    while ((await client.getJob(jobId)) !== undefined) jobId += 1n;
    const taskHash = chunkTaskHash(seriesId, i);
    console.log(`  1. create_job (job_id=${jobId}, task_hash=${taskHash.slice(0, 16)}…)`);
    const job = await client.createJob(requester, {
      skillId,
      taskHashHex: taskHash,
      deadlineSecs: 3600n,
      escrowMotes: PRICE_PER_CHUNK_MOTES,
    });
    console.log("     tx:", job.txHash);
    const createJobConsumed = await waitForFinalization(rpc, job.txHash, "create_job");

    const resultHash = sha256Hex(`${seriesId}:result:${i}`);
    console.log("  2. deliver_result (provider)");
    const deliver = await client.deliverResult(provider, { jobId, resultHashHex: resultHash });
    console.log("     tx:", deliver.txHash);
    const deliverConsumed = await waitForFinalization(rpc, deliver.txHash, "deliver_result");

    console.log("  3. confirm_completion (requester) — same dispute window + reputation bump as any other job");
    const confirm = await client.confirmCompletion(requester, jobId);
    console.log("     tx:", confirm.txHash);
    const confirmConsumed = await waitForFinalization(rpc, confirm.txHash, "confirm_completion");

    costs.push({
      chunkIndex: i,
      jobId,
      createJobConsumedMotes: createJobConsumed,
      deliverResultConsumedMotes: deliverConsumed,
      confirmCompletionConsumedMotes: confirmConsumed,
    });
  }

  console.log("\nverifying final state...");
  const skill = await client.getSkill(skillId);
  console.log(`  getSkill(${skillId}):`, JSON.stringify(jsonSafe(skill)));

  const totalConsumedMotes = costs.reduce(
    (sum, c) => sum + c.createJobConsumedMotes + c.deliverResultConsumedMotes + c.confirmCompletionConsumedMotes,
    0n,
  );
  console.log(`\n${chunkCount} chunk(s), real gas consumed (motes, not the payment ceiling):`);
  for (const c of costs) {
    const chunkTotal = c.createJobConsumedMotes + c.deliverResultConsumedMotes + c.confirmCompletionConsumedMotes;
    console.log(
      `  chunk ${c.chunkIndex} (job_id=${c.jobId}): create_job=${c.createJobConsumedMotes} + deliver_result=${c.deliverResultConsumedMotes} + confirm_completion=${c.confirmCompletionConsumedMotes} = ${chunkTotal} motes`,
    );
  }
  console.log(`  total: ${totalConsumedMotes} motes ≈ ${Number(totalConsumedMotes) / 1e9} CSPR for ${chunkCount} escrow-protected chunk(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
