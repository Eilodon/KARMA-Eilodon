// End-to-end toolchain validation for the Stellar ZK track (T4).
//
// Drives the full Groth16 pipeline against the dummy multiplier circuit:
//   1. compile circom → .r1cs + .wasm
//   2. powersoftau new + contribute + prepare phase2 (in-memory ptau, 4 constraints is plenty)
//   3. groth16 setup → .zkey + verification key
//   4. witness calculation from sample input { a, b }
//   5. groth16 prove → proof + public signals
//   6. groth16 verify → must return true
//
// Exits non-zero on any failure. This is the proof-of-life that the toolchain
// (circom binary + snarkjs CLI + WASM witness calc) all interoperate before the
// real AgentCredentialProof circuit is written.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CIRCOM = join(ROOT, "bin/circom");
const SNARKJS = join(ROOT, "node_modules/.bin/snarkjs");
const BUILD = join(ROOT, "build/dummy");
const CIRCUIT = join(ROOT, "dummy/multiplier.circom");
const PTAU0 = join(BUILD, "pot8_0000.ptau");
const PTAU1 = join(BUILD, "pot8_0001.ptau");
const PTAU = join(BUILD, "pot8_final.ptau");
const ZKEY = join(BUILD, "multiplier_0001.zkey");
const VKEY = join(BUILD, "verification_key.json");
const WASM = join(BUILD, "multiplier_js/multiplier.wasm");
const WTNS = join(BUILD, "witness.wtns");
const INPUT = join(BUILD, "input.json");
const PROOF = join(BUILD, "proof.json");
const PUBLIC = join(BUILD, "public.json");

function sh(label, cmd, args) {
  process.stdout.write(`[T4-dummy] ${label}... `);
  const t = Date.now();
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    process.stdout.write(`OK (${Date.now() - t}ms)\n`);
  } catch (e) {
    process.stdout.write(`FAIL\n`);
    if (e.stderr) console.error(e.stderr.toString());
    if (e.stdout) console.error(e.stdout.toString());
    throw e;
  }
}

async function main() {
  // Fresh build dir every run so prior artefacts can't mask a real failure.
  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true });
  mkdirSync(BUILD, { recursive: true });

  sh("compile circom", CIRCOM, [CIRCUIT, "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  sh("powersoftau new (bn128 power 8 ≙ 256 constraints)", SNARKJS, [
    "powersoftau", "new", "bn128", "8", PTAU0, "-v",
  ]);
  sh("powersoftau contribute (random entropy)", SNARKJS, [
    "powersoftau", "contribute", PTAU0, PTAU1,
    "--name=dummy-toolchain", "-v", "-e=toolchain-validation",
  ]);
  sh("powersoftau prepare phase2", SNARKJS, [
    "powersoftau", "prepare", "phase2", PTAU1, PTAU, "-v",
  ]);

  const R1CS = join(BUILD, "multiplier.r1cs");
  sh("groth16 setup", SNARKJS, ["groth16", "setup", R1CS, PTAU, ZKEY]);
  sh("export verification key", SNARKJS, ["zkey", "export", "verificationkey", ZKEY, VKEY]);

  // Sample input: prove 7 * 11 = 77 (proof reveals only `c`, not `a` or `b`).
  writeFileSync(INPUT, JSON.stringify({ a: 7, b: 11 }));
  // Use snarkjs CLI for witness calc — the circom-generated generate_witness.js is CommonJS
  // and breaks under "type":"module" in circuits/package.json.
  sh("witness (snarkjs wtns calculate)", SNARKJS, ["wtns", "calculate", WASM, INPUT, WTNS]);

  sh("groth16 prove", SNARKJS, ["groth16", "prove", ZKEY, WTNS, PROOF, PUBLIC]);
  const publicSignals = JSON.parse(readFileSync(PUBLIC, "utf8"));
  console.log(`           publicSignals (c) = ${publicSignals[0]} (expect 77)`);
  if (publicSignals[0] !== "77") {
    console.error("FAIL: public output mismatch");
    process.exit(1);
  }

  const vk = JSON.parse(readFileSync(VKEY, "utf8"));
  const proof = JSON.parse(readFileSync(PROOF, "utf8"));
  process.stdout.write("[T4-dummy] groth16 verify (positive)... ");
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  process.stdout.write(ok ? "OK\n" : "FAIL\n");
  if (!ok) process.exit(1);

  // Negative test: tamper with public signal → must reject.
  process.stdout.write("[T4-dummy] groth16 verify (tampered public input rejected)... ");
  const okBad = await snarkjs.groth16.verify(vk, ["999"], proof);
  process.stdout.write(!okBad ? "OK\n" : "FAIL\n");
  if (okBad) {
    console.error("FAIL: verifier accepted a tampered public signal");
    process.exit(1);
  }

  console.log("[T4-dummy] PASS — toolchain validated end-to-end");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
