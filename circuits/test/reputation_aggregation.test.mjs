// End-to-end test for ReputationAggregationProof (Stellar ZK track, T1.1).
//
// Same Groth16 pipeline as AgentCredentialProof, larger circuit. Asserts:
//   1. Happy path — 6 real tuples across 5 distinct categories, weighted avg 80,
//      totalJobs 30 ≥ minJobs 10; verifier accepts.
//   2. Public-signals order matches the Soroban verifier contract.
//   3. Negative: tampered nullifier (epoch mismatch) rejected at witness gen.
//   4. Negative: distinct-category gate violated (4 distinct vs minDistinct 5).
//   5. Negative: weighted-average gate violated (avg 50 vs minAvgScore 80).
//   6. Negative: totalJobs gate violated (8 vs minJobs 30).
//   7. Negative: tuple Merkle proof not in epochRoot.
//   8. Negative: unsorted categories rejected.
//   9. Negative: padding-before-valid (packing convention violated) rejected.
//  10. Verifier-side: tampered public signal on a valid proof rejected.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CIRCOM = join(ROOT, "bin/circom");
const SNARKJS = join(ROOT, "node_modules/.bin/snarkjs");
const BUILD = join(ROOT, "build/reputation_aggregation");
const CIRCUIT = join(ROOT, "src/reputation_aggregation.circom");
const N = 8;
const DEPTH = 8;
// Real circuit measured at ~40k R1CS constraints (19k non-linear + 21k linear). snarkjs
// requires pot ≥ ceil(log2(2 × nConstraints)) → pot16 (65,536 slots). Phase-2 prep at
// pot16 takes ~15 min on a single core; only done once at setup, then proofs are fast.
const POT_POWER = 16;

const PTAU0 = join(BUILD, `pot${POT_POWER}_0000.ptau`);
const PTAU1 = join(BUILD, `pot${POT_POWER}_0001.ptau`);
const PTAU = join(BUILD, `pot${POT_POWER}_final.ptau`);
const R1CS = join(BUILD, "reputation_aggregation.r1cs");
const WASM = join(BUILD, "reputation_aggregation_js/reputation_aggregation.wasm");
const ZKEY = join(BUILD, "reputation_aggregation_0001.zkey");
const VKEY = join(BUILD, "verification_key.json");

function sh(label, cmd, args) {
  process.stdout.write(`[T1.1] ${label}... `);
  const t = Date.now();
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    process.stdout.write(`OK (${Date.now() - t}ms)\n`);
  } catch (e) {
    process.stdout.write(`FAIL\n`);
    if (e.stdout) console.error(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
    throw e;
  }
}

async function setupOnce() {
  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true });
  mkdirSync(BUILD, { recursive: true });

  sh("compile circom", CIRCOM, [CIRCUIT, "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  sh(`powersoftau new (bn128 power ${POT_POWER})`, SNARKJS, [
    "powersoftau", "new", "bn128", String(POT_POWER), PTAU0,
  ]);
  sh("powersoftau contribute", SNARKJS, [
    "powersoftau", "contribute", PTAU0, PTAU1,
    "--name=karma-zk-hackathon", "-e=karma-stellar-zk-track-t1.1",
  ]);
  sh("powersoftau prepare phase2", SNARKJS, ["powersoftau", "prepare", "phase2", PTAU1, PTAU]);
  sh("groth16 setup", SNARKJS, ["groth16", "setup", R1CS, PTAU, ZKEY]);
  sh("export verification key", SNARKJS, ["zkey", "export", "verificationkey", ZKEY, VKEY]);
}

/** Build a depth-D Merkle tree of `leaves` (zero-padded to 2^D) using Poseidon(2).
 *  Returns { root, levels } where levels[0] = leaves, levels[D] = [root]. */
function buildSparseTree(poseidon, F, depth, leaves) {
  const size = 2 ** depth;
  let level = new Array(size).fill(0n);
  for (let i = 0; i < leaves.length; i++) level[i] = leaves[i];
  const levels = [level.map((x) => x.toString())];
  for (let d = 0; d < depth; d++) {
    const next = new Array(level.length / 2);
    for (let i = 0; i < next.length; i++) {
      next[i] = F.toObject(poseidon([level[2 * i], level[2 * i + 1]]));
    }
    levels.push(next.map((x) => x.toString()));
    level = next;
  }
  return { root: level[0].toString(), levels };
}

function pathFor(levels, leafIndex, depth) {
  const elements = [];
  const indices = [];
  let idx = leafIndex;
  for (let d = 0; d < depth; d++) {
    const isRight = idx & 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    elements.push(levels[d][siblingIdx]);
    indices.push(isRight);
    idx >>= 1;
  }
  return { elements, indices };
}

function leafOf(poseidon, F, t) {
  return F.toObject(
    poseidon([BigInt(t.providerId), BigInt(t.categoryId), BigInt(t.score), BigInt(t.jobCount)]),
  );
}

/** Build a complete circuit input given an array of real tuples (≤ N).
 *  Pads to N with validMask=0; computes nullifier; builds Merkle witnesses. */
function buildInput(poseidon, F, realTuples, agentSecret, epoch) {
  if (realTuples.length > N) throw new Error(`too many tuples: ${realTuples.length} > ${N}`);
  // Leaves at positions 0..realTuples.length-1; rest zero.
  const realLeaves = realTuples.map((t) => leafOf(poseidon, F, t));
  const { root, levels } = buildSparseTree(poseidon, F, DEPTH, realLeaves);

  const providerId = [];
  const categoryId = [];
  const score = [];
  const jobCount = [];
  const validMask = [];
  const pathElements = [];
  const pathIndices = [];

  for (let i = 0; i < N; i++) {
    if (i < realTuples.length) {
      const t = realTuples[i];
      providerId.push(String(t.providerId));
      categoryId.push(String(t.categoryId));
      score.push(String(t.score));
      jobCount.push(String(t.jobCount));
      validMask.push("1");
      const { elements, indices } = pathFor(levels, i, DEPTH);
      pathElements.push(elements);
      pathIndices.push(indices.map(String));
    } else {
      // Padding: zero fields, validMask=0; path can be anything well-formed (we use zeros).
      providerId.push("0");
      categoryId.push("0");
      score.push("0");
      jobCount.push("0");
      validMask.push("0");
      pathElements.push(new Array(DEPTH).fill("0"));
      pathIndices.push(new Array(DEPTH).fill("0"));
    }
  }

  const nullifier = F.toObject(poseidon([BigInt(agentSecret), BigInt(epoch)])).toString();

  return {
    nullifier,
    epochRoot: root,
    agentSecret: String(agentSecret),
    epoch: String(epoch),
    providerId,
    categoryId,
    score,
    jobCount,
    validMask,
    pathElements,
    pathIndices,
  };
}

async function genWitness(input, label) {
  const inputFile = join(BUILD, `${label}.input.json`);
  const wtnsFile = join(BUILD, `${label}.witness.wtns`);
  writeFileSync(inputFile, JSON.stringify(input));
  execFileSync(SNARKJS, ["wtns", "calculate", WASM, inputFile, wtnsFile], { stdio: "pipe" });
  return wtnsFile;
}

async function proveAndVerify(input, label) {
  const wtns = await genWitness(input, label);
  const proofFile = join(BUILD, `${label}.proof.json`);
  const publicFile = join(BUILD, `${label}.public.json`);
  execFileSync(SNARKJS, ["groth16", "prove", ZKEY, wtns, proofFile, publicFile], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const publicSignals = JSON.parse(readFileSync(publicFile, "utf8"));
  const vk = JSON.parse(readFileSync(VKEY, "utf8"));
  return { proof, publicSignals, vk };
}

async function main() {
  await setupOnce();

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const agentSecret = 99887766554433221100n;
  const epoch = 2026_06n; // YYYYMM-style label; the prover service is free to choose any scheme

  // Happy path: 6 real tuples across 5 distinct categories.
  //   cat 1: provider 100, score 80, 5 jobs   → weighted 400
  //   cat 1: provider 200, score 90, 5 jobs   → weighted 450   (same category)
  //   cat 2: provider 300, score 70, 5 jobs   → weighted 350
  //   cat 3: provider 400, score 85, 5 jobs   → weighted 425
  //   cat 4: provider 500, score 75, 5 jobs   → weighted 375
  //   cat 5: provider 600, score 80, 5 jobs   → weighted 400
  //   totalJobs = 30, totalWeighted = 2400, weighted average = 80.0
  //   distinct categories = 5 (1, 2, 3, 4, 5)
  const realTuples = [
    { providerId: 100, categoryId: 1, score: 80, jobCount: 5 },
    { providerId: 200, categoryId: 1, score: 90, jobCount: 5 },
    { providerId: 300, categoryId: 2, score: 70, jobCount: 5 },
    { providerId: 400, categoryId: 3, score: 85, jobCount: 5 },
    { providerId: 500, categoryId: 4, score: 75, jobCount: 5 },
    { providerId: 600, categoryId: 5, score: 80, jobCount: 5 },
  ];

  const baseInput = buildInput(poseidon, F, realTuples, agentSecret, epoch);

  // Public gates.
  const minAvgScore = "80";
  const minDistinctCategories = "5";
  const minJobs = "10";

  const happyInput = {
    minAvgScore,
    minDistinctCategories,
    minJobs,
    ...baseInput,
  };

  process.stdout.write("[T1.1] happy path: prove + verify... ");
  const { proof, publicSignals, vk } = await proveAndVerify(happyInput, "happy");
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  process.stdout.write(ok ? "OK\n" : "FAIL\n");
  if (!ok) process.exit(1);
  console.log(`       public signals: ${publicSignals.join(", ")}`);

  // Asserted public-signals order — Soroban verifier consumes verbatim.
  const expectedOrder = [
    minAvgScore,
    minDistinctCategories,
    minJobs,
    baseInput.nullifier,
    baseInput.epochRoot,
  ];
  if (JSON.stringify(publicSignals) !== JSON.stringify(expectedOrder)) {
    console.error("FAIL: publicSignals order mismatch");
    console.error("  got:    ", publicSignals);
    console.error("  expect: ", expectedOrder);
    process.exit(1);
  }
  console.log("[T1.1] public-signals order matches Soroban verifier contract");

  // Negative 1: tampered nullifier (epoch mismatch).
  try {
    await genWitness({ ...happyInput, nullifier: "13" }, "bad_null");
    console.error("FAIL: tampered nullifier was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative bad-nullifier: rejected ✓");
  }

  // Negative 2: insufficient distinct categories (raise gate to 6, we only have 5).
  try {
    await genWitness(
      { ...happyInput, minDistinctCategories: "6" },
      "few_categories",
    );
    console.error("FAIL: insufficient distinct categories was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative few-categories: rejected ✓");
  }

  // Negative 3: insufficient weighted-average (raise gate to 95, actual avg is 80).
  try {
    await genWitness({ ...happyInput, minAvgScore: "95" }, "low_avg");
    console.error("FAIL: insufficient weighted-average was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative low-weighted-average: rejected ✓");
  }

  // Negative 4: insufficient totalJobs (raise gate to 100, we have 30).
  try {
    await genWitness({ ...happyInput, minJobs: "100" }, "few_jobs");
    console.error("FAIL: insufficient totalJobs was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative few-jobs: rejected ✓");
  }

  // Negative 5: tampered epochRoot — Merkle membership constraint must fire.
  try {
    await genWitness({ ...happyInput, epochRoot: "7" }, "bad_root");
    console.error("FAIL: wrong epochRoot was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative bad-epochRoot: rejected ✓");
  }

  // Negative 6: unsorted categories. Swap tuple[2] (cat=2) with tuple[5] (cat=5).
  const unsortedReal = [...realTuples];
  [unsortedReal[2], unsortedReal[5]] = [unsortedReal[5], unsortedReal[2]];
  const unsortedBase = buildInput(poseidon, F, unsortedReal, agentSecret, epoch);
  try {
    await genWitness(
      { minAvgScore, minDistinctCategories, minJobs, ...unsortedBase },
      "unsorted",
    );
    console.error("FAIL: unsorted categories were accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative unsorted-categories: rejected ✓");
  }

  // Negative 7: packing violation — valid tuple after a padding slot.
  //   Take a 3-tuple input, then forcibly mark slot 1 as padding while keeping slot 2 valid.
  const trio = realTuples.slice(0, 3);
  const trioBase = buildInput(poseidon, F, trio, agentSecret, epoch);
  const trioBroken = {
    ...trioBase,
    validMask: ["1", "0", "1", "0", "0", "0", "0", "0"],
  };
  try {
    await genWitness(
      { minAvgScore: "1", minDistinctCategories: "1", minJobs: "1", ...trioBroken },
      "packing",
    );
    console.error("FAIL: padding-before-valid (packing violation) was accepted");
    process.exit(1);
  } catch {
    console.log("[T1.1] negative packing-violation: rejected ✓");
  }

  // Verifier-side: tampered public signal on a valid proof must be rejected.
  process.stdout.write("[T1.1] verifier rejects tampered public input... ");
  const tampered = [...publicSignals];
  tampered[0] = "1"; // claim minAvgScore=1
  const okBad = await snarkjs.groth16.verify(vk, tampered, proof);
  process.stdout.write(!okBad ? "OK\n" : "FAIL\n");
  if (okBad) process.exit(1);

  console.log("[T1.1] PASS — ReputationAggregationProof end-to-end");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
