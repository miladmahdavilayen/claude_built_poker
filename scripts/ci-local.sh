#!/usr/bin/env bash
# The full CI pipeline, on this machine: what must pass before anything is
# pushed (and what the self-hosted runner's CI workflow runs too).
#
#   scripts/ci-local.sh            everything
#   scripts/ci-local.sh --no-e2e   skip the browser suite (quick checks only)
#
# Steps, in order, stopping at the first failure:
#   install (frozen lockfile) → lint → typecheck → unit tests → build →
#   simulation smoke (20,000 hands) → browser suite (Playwright, natively,
#   with the Mac's GPU — Metal — never in Docker).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN_E2E=1
for arg in "$@"; do
  case "$arg" in
    --no-e2e) RUN_E2E=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

LOG_DIR="${CI_LOCAL_LOG_DIR:-$ROOT/.ci-local}"
mkdir -p "$LOG_DIR"
SUMMARY=()
STARTED=$(date +%s)

step() {
  local name="$1"
  shift
  local log="$LOG_DIR/$(echo "$name" | tr ' A-Z' '-a-z').log"
  local t0
  t0=$(date +%s)
  printf '▶ %-22s' "$name"
  if "$@" >"$log" 2>&1; then
    local dt=$(($(date +%s) - t0))
    printf ' ✓ %ss\n' "$dt"
    SUMMARY+=("✓ $name (${dt}s)")
  else
    local dt=$(($(date +%s) - t0))
    printf ' ✗ %ss\n\n' "$dt"
    tail -n 60 "$log"
    echo
    echo "✗ $name failed — full log: $log"
    exit 1
  fi
}

# The browser suite starts its own API and web servers on fixed ports: a
# leftover from an earlier run would make it fail confusingly, so say so now.
check_ports() {
  local busy=()
  for port in 4210 5273; do
    if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then busy+=("$port"); fi
  done
  if [ "${#busy[@]}" -gt 0 ]; then
    echo "Ports in use: ${busy[*]} — another test run (or its leftover servers) is holding them." >&2
    return 1
  fi
}

step "install" pnpm install --frozen-lockfile
step "lint" pnpm lint
step "typecheck" pnpm typecheck
step "unit tests" pnpm test
step "build" pnpm --filter @pokerclause/web build
step "simulation smoke" pnpm --filter @pokerclause/sim sim -- --hands 20000 --seats random --mix adversarial --seed "local-$(date +%s)"
if [ "$RUN_E2E" = 1 ]; then
  step "browser ports free" check_ports
  step "playwright chromium" bash -c 'cd apps/web && npx playwright install chromium'
  step "browser suite" bash -c 'cd apps/web && pnpm e2e'
fi

echo
echo "Pipeline passed in $(($(date +%s) - STARTED))s:"
printf '  %s\n' "${SUMMARY[@]}"
