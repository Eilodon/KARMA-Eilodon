#!/usr/bin/env bash
# Builds the real, deployable karma_odra.wasm — a working replacement for `cargo odra build`,
# which (as of cargo-odra 0.1.7 against odra 2.8.1) shells out to a bin-target invocation that
# doesn't match odra-build's actual API. See contracts-odra/README.md for the full diagnosis.
#
# ODRA_MODULE must equal the contract's `HasIdent::ident()` value ("AgentSkillRegistry" — the
# bare type name, not the full path from Odra.toml's `fqn`). ODRA_BACKEND=casper selects the
# wasm-target host-function glue. --import-undefined tells the linker that casper_revert /
# casper_get_named_arg / etc. are real Casper host functions supplied at execution time, not
# missing symbols.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

rustup target add wasm32-unknown-unknown --toolchain nightly >/dev/null

RUSTFLAGS="-C link-arg=--import-undefined" \
ODRA_MODULE=AgentSkillRegistry \
ODRA_BACKEND=casper \
cargo +nightly build --target wasm32-unknown-unknown --release --lib

mkdir -p wasm
cp target/wasm32-unknown-unknown/release/karma_odra.wasm wasm/karma_odra.wasm
echo "wrote wasm/karma_odra.wasm ($(wc -c < wasm/karma_odra.wasm) bytes)"
