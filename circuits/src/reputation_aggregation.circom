pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// ReputationAggregationProof (Stellar ZK track, T1.1) — portfolio-level credential.
//
// Agent proves "I have an average score ≥ minAvgScore over ≥ minJobs jobs spread
// across ≥ minDistinctCategories distinct skill categories", WITHOUT revealing
// which providers, which jobs, or per-category scores.
//
// Public (verified on-chain):
//   minAvgScore               weighted-average threshold (0..100, integer)
//   minDistinctCategories     breadth requirement (prevents single-category gaming)
//   minJobs                   minimum track record
//   nullifier                 Poseidon(agentSecret, epoch) — per-epoch replay guard
//   epochRoot                 issuer-published Merkle root of all jobs in the epoch
//
// Private (NEVER revealed):
//   agentSecret               agent's secret
//   epoch                     epoch identifier (binds nullifier to a specific root)
//   providerId[N]             provider per job tuple
//   categoryId[N]             skill-category per tuple (>=1 when valid; sentinel 0 = padding)
//   score[N]                  per-job score 0..100
//   jobCount[N]               jobs aggregated under this (provider, category) tuple
//   validMask[N]              1 = real tuple, 0 = padding
//   pathElements[N][DEPTH]    Merkle siblings to epochRoot
//   pathIndices[N][DEPTH]     leaf-side bits per level
//
// Packing convention (enforced in-circuit):
//   - validMask is non-increasing along i (all real tuples first, then padding).
//   - Real tuples are sorted by categoryId ascending (lets us count distinct
//     categories in a single linear pass using adjacent-difference IsZero).
//
// Leaf shape: leaf = Poseidon(providerId, categoryId, score, jobCount).
// The off-chain prover service publishes epochRoot as the Merkle root of these
// leaves over all jobs in the epoch (zero-padded to 2^DEPTH).
//
// Tree depth: hackathon scope = 8 (256 leaves per epoch). Per-tuple constraint cost
// ≈ 1 Poseidon(4) + DEPTH × Poseidon(2) ≈ ~1.8k constraints. With N=8 tuples plus
// aggregation logic the circuit is ~15k constraints — ptau 2^14 (16k) gives headroom.
//
// THIS CIRCUIT IS A SIBLING of AgentCredentialProof, NOT a replacement. They prove
// different facts (single skill-gate vs portfolio summary). The two verifier
// contracts on Soroban are deliberately separate so audit + nullifier domains stay
// disjoint.

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
        pathIndices[i] * (1 - pathIndices[i]) === 0;

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

template ReputationAggregation(N, DEPTH) {
    // ── Public ─────────────────────────────────────────────────────────────
    signal input minAvgScore;
    signal input minDistinctCategories;
    signal input minJobs;
    signal input nullifier;
    signal input epochRoot;

    // ── Private ────────────────────────────────────────────────────────────
    signal input agentSecret;
    signal input epoch;
    signal input providerId[N];
    signal input categoryId[N];
    signal input score[N];
    signal input jobCount[N];
    signal input validMask[N];
    signal input pathElements[N][DEPTH];
    signal input pathIndices[N][DEPTH];

    // ── (1) Nullifier ──────────────────────────────────────────────────────
    component nullHash = Poseidon(2);
    nullHash.inputs[0] <== agentSecret;
    nullHash.inputs[1] <== epoch;
    nullHash.out === nullifier;

    // ── (2) Per-tuple range + leaf + Merkle membership ─────────────────────
    component leafHasher[N];
    component merkle[N];
    component scoreBits[N];
    component scoreLE100[N];
    component jobBits[N];
    component catBits[N];
    signal weighted[N];        // score[i] * jobCount[i]                    (deg 2)
    signal contribScore[N];    // weighted[i] * validMask[i]                (deg 2 — uses weighted)
    signal contribJobs[N];     // jobCount[i] * validMask[i]                (deg 2)
    signal rootDelta[N];       // merkle[i].root - epochRoot                (deg 1)

    for (var i = 0; i < N; i++) {
        // validMask[i] ∈ {0, 1}
        validMask[i] * (1 - validMask[i]) === 0;

        // score[i] ∈ [0, 100] — Num2Bits(7) ⇒ [0,127], LessEqThan locks at 100.
        scoreBits[i] = Num2Bits(7);
        scoreBits[i].in <== score[i];
        scoreLE100[i] = LessEqThan(7);
        scoreLE100[i].in[0] <== score[i];
        scoreLE100[i].in[1] <== 100;
        scoreLE100[i].out === 1;

        // jobCount[i] ∈ [0, 2^16) — caps a single (provider,category) tuple's contribution
        // so a prover cannot overflow the aggregate via a single huge jobCount.
        jobBits[i] = Num2Bits(16);
        jobBits[i].in <== jobCount[i];

        // categoryId[i] ∈ [0, 2^32) — sentinel 0 = padding; real categories ≥ 1.
        catBits[i] = Num2Bits(32);
        catBits[i].in <== categoryId[i];

        // Leaf commitment.
        leafHasher[i] = Poseidon(4);
        leafHasher[i].inputs[0] <== providerId[i];
        leafHasher[i].inputs[1] <== categoryId[i];
        leafHasher[i].inputs[2] <== score[i];
        leafHasher[i].inputs[3] <== jobCount[i];

        // Merkle membership.
        merkle[i] = MerkleProof(DEPTH);
        merkle[i].leaf <== leafHasher[i].out;
        for (var d = 0; d < DEPTH; d++) {
            merkle[i].pathElements[d] <== pathElements[i][d];
            merkle[i].pathIndices[d] <== pathIndices[i][d];
        }
        // Gated equality: validMask=1 ⇒ merkle.root must equal epochRoot;
        // validMask=0 ⇒ no constraint (allows padding without a real witness).
        rootDelta[i] <== merkle[i].root - epochRoot;
        validMask[i] * rootDelta[i] === 0;

        // Aggregate contributions (zero when validMask=0).
        weighted[i] <== score[i] * jobCount[i];
        contribScore[i] <== weighted[i] * validMask[i];
        contribJobs[i] <== jobCount[i] * validMask[i];
    }

    // ── (3) Packing: validMask non-increasing (all real, then all padding) ─
    // For i in [0, N-2]: if validMask[i] = 0, then validMask[i+1] must be 0.
    // (1 - validMask[i]) * validMask[i+1] === 0
    for (var i = 0; i < N - 1; i++) {
        (1 - validMask[i]) * validMask[i + 1] === 0;
    }

    // ── (4) Sort + distinct-category count ─────────────────────────────────
    // Prover sorts real tuples by categoryId ascending. We enforce categoryId[i+1] >=
    // categoryId[i] whenever both are valid, then count adjacent-difference.
    component catSortLE[N - 1];
    signal bothValid[N - 1];
    for (var i = 0; i < N - 1; i++) {
        catSortLE[i] = LessEqThan(32);
        catSortLE[i].in[0] <== categoryId[i];
        catSortLE[i].in[1] <== categoryId[i + 1];
        // Enforce sort only when both are valid (degree 3 → split via bothValid signal).
        bothValid[i] <== validMask[i] * validMask[i + 1];
        bothValid[i] * (1 - catSortLE[i].out) === 0;
    }

    // distinct[i] = validMask[i] AND (i == 0 OR categoryId[i] != categoryId[i-1])
    component sameAsPrev[N];      // sameAsPrev[i].out = 1 iff categoryId[i] == categoryId[i-1]
    signal distinctIndicator[N];  // 1 iff tuple i opens a new distinct category
    signal notSamePrev[N];
    var distinctAcc = 0;
    for (var i = 0; i < N; i++) {
        if (i == 0) {
            // First tuple: distinct iff valid.
            distinctIndicator[i] <== validMask[i];
            // (declare unused signals so Circom doesn't complain)
            sameAsPrev[i] = IsZero();
            sameAsPrev[i].in <== 0;
            notSamePrev[i] <== 1;
        } else {
            sameAsPrev[i] = IsZero();
            sameAsPrev[i].in <== categoryId[i] - categoryId[i - 1];
            notSamePrev[i] <== 1 - sameAsPrev[i].out;
            distinctIndicator[i] <== validMask[i] * notSamePrev[i];
        }
        distinctAcc += distinctIndicator[i];
    }

    // ── (5) Aggregate gates ────────────────────────────────────────────────
    // totalJobs   = Σ jobCount[i] * validMask[i]
    // totalWScore = Σ score[i] * jobCount[i] * validMask[i]
    // distinct    = Σ distinctIndicator[i]
    //
    // Gates:
    //   totalJobs   ≥ minJobs
    //   distinct    ≥ minDistinctCategories
    //   totalWScore ≥ minAvgScore × totalJobs   (weighted average ≥ threshold)
    var totalJobsAcc = 0;
    var totalWScoreAcc = 0;
    for (var i = 0; i < N; i++) {
        totalJobsAcc += contribJobs[i];
        totalWScoreAcc += contribScore[i];
    }
    signal totalJobs;
    signal totalWScore;
    signal distinct;
    totalJobs <== totalJobsAcc;
    totalWScore <== totalWScoreAcc;
    distinct <== distinctAcc;

    // Aggregate bit-widths:
    //   totalJobs ≤ N × (2^16 - 1)            → 19 bits @ N=8
    //   totalWScore ≤ N × 100 × (2^16 - 1)    → 26 bits @ N=8
    //   minAvgScore × totalJobs ≤ 100 × totalJobs → 26 bits
    component totalJobsBits = Num2Bits(20);
    totalJobsBits.in <== totalJobs;
    component totalWScoreBits = Num2Bits(28);
    totalWScoreBits.in <== totalWScore;

    // (a) totalJobs >= minJobs — minJobs fits in 20 bits comfortably.
    component minJobsBits = Num2Bits(20);
    minJobsBits.in <== minJobs;
    component jobsGate = GreaterEqThan(20);
    jobsGate.in[0] <== totalJobs;
    jobsGate.in[1] <== minJobs;
    jobsGate.out === 1;

    // (b) distinct >= minDistinctCategories — both fit comfortably in 8 bits.
    component minDistBits = Num2Bits(8);
    minDistBits.in <== minDistinctCategories;
    component distBits = Num2Bits(8);
    distBits.in <== distinct;
    component distGate = GreaterEqThan(8);
    distGate.in[0] <== distinct;
    distGate.in[1] <== minDistinctCategories;
    distGate.out === 1;

    // (c) totalWScore >= minAvgScore * totalJobs.
    component minAvgBits = Num2Bits(7);
    minAvgBits.in <== minAvgScore;
    component avgLE100 = LessEqThan(7);
    avgLE100.in[0] <== minAvgScore;
    avgLE100.in[1] <== 100;
    avgLE100.out === 1;

    signal minWScore;
    minWScore <== minAvgScore * totalJobs;
    component wScoreGate = GreaterEqThan(28);
    wScoreGate.in[0] <== totalWScore;
    wScoreGate.in[1] <== minWScore;
    wScoreGate.out === 1;
}

// Hackathon scope: N=8 tuples, DEPTH=8 (256 leaves per epoch).
// Public-signals order is asserted in circuits/test/reputation_aggregation.test.mjs and
// MUST match what the Soroban verifier consumes.
component main { public [minAvgScore, minDistinctCategories, minJobs, nullifier, epochRoot] } =
    ReputationAggregation(8, 8);
