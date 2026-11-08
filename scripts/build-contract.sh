#!/usr/bin/env bash
# Build the Remiglo Registry wasm.
#
# RUSTFLAGS="--cfg near" is REQUIRED. near-sdk gates its host calls
# (panic messages, sha256, and friends) behind that custom cfg; a plain
# cargo build silently swaps in local fallbacks, and on chain every
# rejection then surfaces as a bare "WebAssembly trap" with no message.
# (The Stipend lesson, verified live on testnet 2026-11-05.)
set -euo pipefail
cd "$(dirname "$0")/../contracts/registry"
export PATH="$HOME/.cargo/bin:$PATH"
RUSTFLAGS="--cfg near" cargo build --target wasm32-unknown-unknown --release
echo "wasm: target/wasm32-unknown-unknown/release/remiglo_registry.wasm"
