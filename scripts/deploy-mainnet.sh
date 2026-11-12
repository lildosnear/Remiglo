#!/usr/bin/env bash
# Deploy the Remiglo Registry contract to MAINNET and set it up.
#
# This mirrors the testnet deployment (scripts/deploy-registry-toplevel.ts,
# which put the registry on remiglo.testnet on 2026-11-06) step for step:
#
#   1. rebuild the wasm with scripts/build-contract.sh
#   2. deploy the wasm to the account (no init call in the deploy itself)
#   3. initialise:            new { owner }
#   4. register first merchant: register_merchant { merchant, admins: [account] }
#      The first merchant is the account itself, exactly as on testnet.
#   5. opening policy:        set_policy { merchant,
#        per_payout_cap: "100000000"      = 100 USDC per payout
#        daily_budget:   "1000000000"     = 1000 USDC per day
#        approval_threshold: "500000000"  = 500 USDC }
#   6. verify with view calls (get_owner, get_merchant, get_policy,
#      check_spend at 50 USDC and 600 USDC)
#
# Contract methods and argument shapes come from
# contracts/registry/src/lib.rs; the argument values are the ones the
# testnet deploy used.
#
# Prerequisites (docs/MAINNET-RUNBOOK.md sections 1 and 2):
#   - The account already exists on mainnet and is funded (about 5 NEAR;
#     the 257 KB wasm alone locks about 2.6 NEAR of storage).
#   - Its full access key file sits at keys/remiglo.near.json
#     (NEAR JSON key format). keys/ is gitignored; never commit it.
#   - near-cli-rs is installed (`near` on PATH).
#
# Usage:
#   scripts/deploy-mainnet.sh --dry-run   # print every command, run none
#   scripts/deploy-mainnet.sh             # real run, asks to confirm first
#
# Environment:
#   REGISTRY_CONTRACT_ID   account to deploy to (default remiglo.near)
#   REGISTRY_KEY_FILE      key file path (default keys/remiglo.near.json)
#   START_AT               resume at step N (1..6) if a run stopped midway.
#                          Steps 3 to 5 are one time only: `new` panics
#                          with "already initialized" and register_merchant
#                          with "merchant already registered" if repeated,
#                          which is harmless but stops the script.
#
# This script was written for the mainnet launch and has NOT been run
# against mainnet. Always review a --dry-run first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ACCOUNT="${REGISTRY_CONTRACT_ID:-remiglo.near}"
KEY_FILE="${REGISTRY_KEY_FILE:-keys/remiglo.near.json}"
WASM="contracts/registry/target/wasm32-unknown-unknown/release/remiglo_registry.wasm"
NETWORK="mainnet"
START_AT="${START_AT:-1}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown argument: $arg (only --dry-run is supported)" >&2; exit 2 ;;
  esac
done

# Safety rail: this script is mainnet only. A testnet account name here
# means the wrong terminal or the wrong env file; stop before anything.
case "$ACCOUNT" in
  *.testnet|testnet)
    echo "REFUSING: REGISTRY_CONTRACT_ID is '$ACCOUNT', a testnet account." >&2
    echo "This script deploys to mainnet only." >&2
    exit 1
    ;;
esac

run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

step() {
  local n="$1"; shift
  if [ "$START_AT" -gt "$n" ]; then
    echo "--- step $n skipped (START_AT=$START_AT): $*"
    return 1
  fi
  echo "--- step $n: $*"
  return 0
}

echo "Remiglo Registry mainnet deploy"
echo "  account:  $ACCOUNT"
echo "  key file: $KEY_FILE"
echo "  network:  $NETWORK"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  mode:     DRY RUN (nothing will be executed)"
fi

# ------------------------------------------------------------ preflight
if [ ! -f "$KEY_FILE" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "warning: key file $KEY_FILE does not exist yet (fine for a dry run)"
  else
    echo "ERROR: key file $KEY_FILE not found." >&2
    echo "Export the $ACCOUNT key from the wallet into that path first" >&2
    echo "(runbook section 2). Never commit this file." >&2
    exit 1
  fi
fi
if ! command -v near >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "warning: near-cli-rs ('near') is not on PATH (fine for a dry run)"
  else
    echo "ERROR: near-cli-rs ('near') is not on PATH. Install it first." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" -eq 0 ]; then
  echo
  echo "This will deploy a contract to $ACCOUNT on MAINNET with real funds."
  read -r -p "Type the account id to continue: " CONFIRM
  if [ "$CONFIRM" != "$ACCOUNT" ]; then
    echo "Confirmation did not match. Aborting."
    exit 1
  fi
fi

# ------------------------------------------------------------ 1. build
if step 1 "rebuild the registry wasm"; then
  run ./scripts/build-contract.sh
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ ! -f "$WASM" ]; then
      echo "ERROR: build finished but $WASM is missing." >&2
      exit 1
    fi
    echo "wasm: $WASM ($(stat -c%s "$WASM") bytes)"
  else
    echo "+ test -f $WASM && stat -c%s $WASM   # verified after a real build"
  fi
fi

# ------------------------------------------------------------ 2. deploy
if step 2 "deploy the wasm to $ACCOUNT"; then
  run near contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
    network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
fi

# ------------------------------------------------------------ 3. init
if step 3 "initialise the registry (owner = $ACCOUNT)"; then
  run near contract call-function as-transaction "$ACCOUNT" new \
    json-args "{\"owner\":\"$ACCOUNT\"}" \
    prepaid-gas '30 TeraGas' attached-deposit '0 NEAR' \
    sign-as "$ACCOUNT" \
    network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
fi

# ------------------------------------------------- 4. register merchant
if step 4 "register $ACCOUNT as the first merchant (admin: itself)"; then
  run near contract call-function as-transaction "$ACCOUNT" register_merchant \
    json-args "{\"merchant\":\"$ACCOUNT\",\"admins\":[\"$ACCOUNT\"]}" \
    prepaid-gas '30 TeraGas' attached-deposit '0 NEAR' \
    sign-as "$ACCOUNT" \
    network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
fi

# ------------------------------------------------------- 5. set policy
if step 5 "set the opening policy (cap 100, budget 1000, threshold 500 USDC)"; then
  run near contract call-function as-transaction "$ACCOUNT" set_policy \
    json-args "{\"merchant\":\"$ACCOUNT\",\"per_payout_cap\":\"100000000\",\"daily_budget\":\"1000000000\",\"approval_threshold\":\"500000000\"}" \
    prepaid-gas '30 TeraGas' attached-deposit '0 NEAR' \
    sign-as "$ACCOUNT" \
    network-config "$NETWORK" sign-with-access-key-file "$KEY_FILE" send
fi

# ------------------------------------------------------------ 6. verify
if step 6 "verify with view calls"; then
  run near contract call-function as-read-only "$ACCOUNT" get_owner \
    json-args '{}' network-config "$NETWORK" now
  run near contract call-function as-read-only "$ACCOUNT" get_merchant \
    json-args "{\"merchant\":\"$ACCOUNT\"}" network-config "$NETWORK" now
  run near contract call-function as-read-only "$ACCOUNT" get_policy \
    json-args "{\"merchant\":\"$ACCOUNT\"}" network-config "$NETWORK" now
  run near contract call-function as-read-only "$ACCOUNT" check_spend \
    json-args "{\"merchant\":\"$ACCOUNT\",\"amount\":\"50000000\"}" network-config "$NETWORK" now
  run near contract call-function as-read-only "$ACCOUNT" check_spend \
    json-args "{\"merchant\":\"$ACCOUNT\",\"amount\":\"600000000\"}" network-config "$NETWORK" now
fi

echo
echo "Done. Expected verification results:"
echo "  get_owner    -> \"$ACCOUNT\""
echo "  get_policy   -> per_payout_cap 100000000, daily_budget 1000000000, approval_threshold 500000000"
echo "  check_spend 50 USDC  -> [] (clean)"
echo "  check_spend 600 USDC -> [\"over_cap\", \"approval_required\"]"
echo "Account on the explorer: https://nearblocks.io/address/$ACCOUNT"
