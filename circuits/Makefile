# KARMA ZK circuits — Stellar ZK track (T4)
#
# `make toolchain` installs circom + snarkjs locally (idempotent).
# `make dummy` runs the toolchain-validation pipeline (multiplier circuit).
# `make credential` runs the AgentCredentialProof end-to-end pipeline.
# `make all` does both.

SHELL := /usr/bin/env bash

.PHONY: all toolchain dummy credential clean

all: toolchain dummy credential

toolchain:
	@bash scripts/install-toolchain.sh

dummy: toolchain
	@node test/dummy_multiplier.test.mjs

credential: toolchain
	@node test/agent_credential.test.mjs

clean:
	@rm -rf build/
