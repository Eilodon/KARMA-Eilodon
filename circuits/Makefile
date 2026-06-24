# KARMA ZK circuits — Stellar ZK track (T4 + T1.1)
#
# `make toolchain` installs circom + snarkjs locally (idempotent).
# `make dummy` runs the toolchain-validation pipeline (multiplier circuit).
# `make credential` runs the AgentCredentialProof end-to-end pipeline (T4).
# `make repagg` runs the ReputationAggregationProof end-to-end pipeline (T1.1).
# `make all` runs every pipeline.

SHELL := /usr/bin/env bash

.PHONY: all toolchain dummy credential repagg clean

all: toolchain dummy credential repagg

toolchain:
	@bash scripts/install-toolchain.sh

dummy: toolchain
	@node test/dummy_multiplier.test.mjs

credential: toolchain
	@node test/agent_credential.test.mjs

repagg: toolchain
	@node test/reputation_aggregation.test.mjs

clean:
	@rm -rf build/
