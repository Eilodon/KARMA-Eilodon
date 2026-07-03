// End-to-end test for AgentCredentialProof (Stellar ZK track, T4 real circuit).
//
// Drives the same Groth16 pipeline as the dummy multiplier but exercises the real
// constraints: Poseidon commitment + range proof + Merkle membership + per-skill
// nullifier. Witness inputs are computed off-circuit using circomlibjs (same
// Poseidon constants as circomlib/circuits/poseidon.circom), so a green run proves
// the JS-side prover input format matches what the circuit expects.
//
// Coverage:
//   1. Happy path                 — valid commitment, score 80 ≥ minRep 60, leaf at index 0
//   2. Negative: bad commitment   — credentialCommitment doesn't match Poseidon(secret)
//   3. Negative: insufficient rep — score 40 < minRep 60
//   4. Negative: wrong merkle root — claimed root differs from the tree's actual root
//   5. Negative: tampered nullifier — nullifier doesn't match Poseidon(secret, skillId)

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
const BUILD = join(ROOT, "build/agent_credential");
const CIRCUIT = join(ROOT, "src/agent_credential.circom");
const DEPTH = 8;
// Powers-of-tau power. Real circuit ~3.3k constraints; pot13 (8192) gives headroom.
const POT_POWER = 13;

const PTAU0 = join(BUILD, `pot${POT_POWER}_0000.ptau`);
const PTAU1 = join(BUILD, `pot${POT_POWER}_0001.ptau`);
const PTAU = join(BUILD, `pot${POT_POWER}_final.ptau`);
const R1CS = join(BUILD, "agent_credential.r1cs");
const WASM = join(BUILD, "agent_credential_js/agent_credential.wasm");
const ZKEY = join(BUILD, "agent_credential_0001.zkey");
const VKEY = join(BUILD, "verification_key.json");

function sh(label, cmd, args) {
  process.stdout.write(`[T4] ${label}... `);
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
    "--name=karma-zk-hackathon", "-e=karma-stellar-zk-track",
  ]);
  sh("powersoftau prepare phase2", SNARKJS, ["powersoftau", "prepare", "phase2", PTAU1, PTAU]);
  sh("groth16 setup", SNARKJS, ["groth16", "setup", R1CS, PTAU, ZKEY]);
  sh("export verification key", SNARKJS, ["zkey", "export", "verificationkey", ZKEY, VKEY]);
}

/** Build a depth-D merkle tree of zeros with `leaf` placed at `leafIndex`.
 *  Returns { root, pathElements, pathIndices } shaped for the circuit. */
function buildMerkleProof(poseidon, F, depth, leaf, leafIndex) {
  const ZERO = 0n;
  // Pre-compute Poseidon-of-zeros per level (the canonical "empty subtree" hash).
  const zeroNodes = [ZERO];
  for (let i = 0; i < depth; i++) {
    const z = zeroNodes[i];
    zeroNodes.push(F.toObject(poseidon([z, z])));
  }
  let current = leaf;
  let idx = leafIndex;
  const pathElements = [];
  const pathIndices = [];
  for (let i = 0; i < depth; i++) {
    const sibling = zeroNodes[i];
    pathElements.push(sibling.toString());
    const isRight = idx & 1; // current is on the RIGHT when index bit is 1
    pathIndices.push(isRight);
    const left = isRight ? sibling : current;
    const right = isRight ? current : sibling;
    current = F.toObject(poseidon([left, right]));
    idx >>= 1;
  }
  return { root: current.toString(), pathElements, pathIndices };
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

  const credentialSecret = 12345678901234567890n; // fits in bn128 scalar field
  const skillId = 42n;
  const nullifier = F.toObject(poseidon([credentialSecret, skillId])).toString();
  const reputationScore = 80n;
  const minReputation = 60n;
  // Leaf/commitment binds BOTH secret and score — a holder cannot self-declare a different
  // score than the one actually committed by the issuer (see agent_credential.circom).
  const credentialCommitment = F.toObject(poseidon([credentialSecret, reputationScore])).toString();

  const { root, pathElements, pathIndices } = buildMerkleProof(
    poseidon, F, DEPTH, F.toObject(poseidon([credentialSecret, reputationScore])), /* leafIndex */ 0,
  );

  // 1) Happy path — every constraint satisfied; verifier accepts; public signals echo.
  const happyInput = {
    skillId: skillId.toString(),
    minReputation: minReputation.toString(),
    nullifier,
    credentialCommitment,
    jobHistoryRoot: root,
    credentialSecret: credentialSecret.toString(),
    reputationScore: reputationScore.toString(),
    pathElements,
    pathIndices: pathIndices.map(String),
  };

  process.stdout.write("[T4] happy path: prove + verify... ");
  const { proof, publicSignals, vk } = await proveAndVerify(happyInput, "happy");
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  process.stdout.write(ok ? "OK\n" : "FAIL\n");
  if (!ok) process.exit(1);
  console.log(`       public signals: ${publicSignals.join(", ")}`);

  // The public-signal order matches the order they appear in `component main { public [...] }`.
  // We assert it is what the Soroban verifier will need to consume verbatim.
  const expectedPublicOrder = [
    skillId.toString(),
    minReputation.toString(),
    nullifier,
    credentialCommitment,
    root,
  ];
  if (JSON.stringify(publicSignals) !== JSON.stringify(expectedPublicOrder)) {
    console.error("FAIL: publicSignals order mismatch");
    console.error("  got:    ", publicSignals);
    console.error("  expect: ", expectedPublicOrder);
    process.exit(1);
  }
  console.log("[T4] public-signals order matches Soroban verifier contract");

  // 2) Negative: bad credentialCommitment — witness gen must throw on the constraint check.
  try {
    await genWitness({ ...happyInput, credentialCommitment: "9999" }, "bad_commit");
    console.error("FAIL: bad credentialCommitment was accepted");
    process.exit(1);
  } catch {
    console.log("[T4] negative bad-commitment: rejected ✓");
  }

  // 3) Negative: insufficient reputation — build a SEPARATE, self-consistent commitment for
  //    score=40 (own leaf + tree) so this isolates the reputation-gate check from the
  //    commitment-binding check already covered by test 2.
  const lowScore = 40n;
  const lowCommitment = F.toObject(poseidon([credentialSecret, lowScore])).toString();
  const lowTree = buildMerkleProof(
    poseidon, F, DEPTH, F.toObject(poseidon([credentialSecret, lowScore])), /* leafIndex */ 0,
  );
  try {
    await genWitness({
      ...happyInput,
      reputationScore: lowScore.toString(),
      credentialCommitment: lowCommitment,
      jobHistoryRoot: lowTree.root,
      pathElements: lowTree.pathElements,
      pathIndices: lowTree.pathIndices.map(String),
    }, "low_rep");
    console.error("FAIL: insufficient reputation was accepted");
    process.exit(1);
  } catch {
    console.log("[T4] negative low-reputation: rejected ✓");
  }

  // 4) Negative: wrong merkle root.
  try {
    await genWitness({ ...happyInput, jobHistoryRoot: "7" }, "bad_root");
    console.error("FAIL: wrong merkle root was accepted");
    process.exit(1);
  } catch {
    console.log("[T4] negative bad-merkle-root: rejected ✓");
  }

  // 5) Negative: tampered nullifier.
  try {
    await genWitness({ ...happyInput, nullifier: "13" }, "bad_null");
    console.error("FAIL: tampered nullifier was accepted");
    process.exit(1);
  } catch {
    console.log("[T4] negative bad-nullifier: rejected ✓");
  }

  // 6) Verifier-side: tampered public signal on a valid proof must be rejected.
  process.stdout.write("[T4] verifier rejects tampered public input... ");
  const tampered = [...publicSignals];
  tampered[1] = "0"; // claim minReputation=0
  const okBad = await snarkjs.groth16.verify(vk, tampered, proof);
  process.stdout.write(!okBad ? "OK\n" : "FAIL\n");
  if (okBad) process.exit(1);

  console.log("[T4] PASS — AgentCredentialProof end-to-end");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
