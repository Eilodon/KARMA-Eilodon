pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// AgentCredentialProof — closes KARMA's "enforcement split" (synthesis §2):
// an agent proves it holds a credential whose committed reputation meets a skill's
// `minReputation`, AND that the credential is a leaf in the issuer's published job
// history merkle root, AND derives a per-skill nullifier — without revealing the
// credential secret, the actual score, or which leaf was used.
//
// Public  (verified on-chain):
//   skillId               the skill being invoked
//   minReputation         the skill's on-chain reputation threshold
//   nullifier             Poseidon(credentialSecret, skillId) — per-skill replay guard
//   credentialCommitment  Poseidon(credentialSecret)
//   jobHistoryRoot        the issuer-published merkle root the leaf must live under
//
// Private (NEVER revealed):
//   credentialSecret      agent's private credential secret
//   reputationScore       actual score (only the >= minReputation fact escapes)
//   pathElements[depth]   merkle siblings on the path to the leaf
//   pathIndices[depth]    0 = leaf-on-left, 1 = leaf-on-right, per level
//
// Tree depth: hackathon scope = 8 (supports 256 leaves; ~2k constraints — fits comfortably
// inside a 2^12 powers-of-tau. Production would bump to 16 with a corresponding ptau.)

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component muxL[depth];
    component muxR[depth];
    signal current[depth + 1];
    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] must be a bit (0 or 1). Mux1 produces an undefined-but-consistent
        // value otherwise; constrain explicitly so a malicious prover cannot fudge sides.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // (left, right) = pathIndices[i]==0 ? (current, sibling) : (sibling, current)
        muxL[i] = Mux1();
        muxL[i].c[0] <== current[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== current[i];
        muxR[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxL[i].out;
        hashers[i].inputs[1] <== muxR[i].out;
        current[i + 1] <== hashers[i].out;
    }

    root <== current[depth];
}

template AgentCredentialProof(depth) {
    // Public inputs (verified on-chain).
    signal input skillId;
    signal input minReputation;
    signal input nullifier;
    signal input credentialCommitment;
    signal input jobHistoryRoot;

    // Private inputs.
    signal input credentialSecret;
    signal input reputationScore;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // (1) credentialCommitment == Poseidon(credentialSecret)
    component commitHash = Poseidon(1);
    commitHash.inputs[0] <== credentialSecret;
    commitHash.out === credentialCommitment;

    // (2) reputationScore in [0, 100], and >= minReputation. Range-check both via Num2Bits(7)
    //     (7 bits ⇒ values fit in [0, 127] — enough headroom for the 0..100 reputation domain).
    //     Then comparators evaluate over the constrained-bit range.
    component repBits = Num2Bits(7);
    repBits.in <== reputationScore;
    component minBits = Num2Bits(7);
    minBits.in <== minReputation;

    // reputationScore <= 100 (range)
    component lt100 = LessEqThan(7);
    lt100.in[0] <== reputationScore;
    lt100.in[1] <== 100;
    lt100.out === 1;

    // reputationScore >= minReputation (gate)
    component gte = GreaterEqThan(7);
    gte.in[0] <== reputationScore;
    gte.in[1] <== minReputation;
    gte.out === 1;

    // (3) credentialCommitment is a leaf under jobHistoryRoot.
    component merkle = MerkleProof(depth);
    merkle.leaf <== credentialCommitment;
    for (var i = 0; i < depth; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    merkle.root === jobHistoryRoot;

    // (4) nullifier == Poseidon(credentialSecret, skillId) — per-skill replay guard.
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== credentialSecret;
    nullHash.inputs[1] <== skillId;
    nullHash.out === nullifier;
}

component main { public [skillId, minReputation, nullifier, credentialCommitment, jobHistoryRoot] } = AgentCredentialProof(8);
