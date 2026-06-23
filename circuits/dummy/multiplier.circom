pragma circom 2.1.0;

// Toolchain-validation dummy circuit. Proves knowledge of a, b such that a * b = c
// (the classic snarkjs tutorial circuit). Used by `node test/dummy_multiplier.test.mjs`
// to validate the FULL pipeline — circom compile → witness → Groth16 setup → prove →
// verify — works end-to-end BEFORE writing the real AgentCredentialProof circuit.
// Per the plan's risk register, T4's biggest threat is toolchain setup, not circuit logic.

template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = Multiplier();
