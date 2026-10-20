#!/usr/bin/env bash
# Checks that the tools needed for the AI Gateway project are installed.
# Usage: bash scripts/check-env.sh

ok=0
check() {
  local name="$1" cmd="$2"
  if out=$(eval "$cmd" 2>/dev/null); then
    printf '  [ok]   %-16s %s\n' "$name" "$(echo "$out" | head -n1)"
  else
    printf '  [MISS] %s\n' "$name"
    ok=1
  fi
}

echo "Checking prerequisites..."
check "git"            "git --version"
check "node"           "node --version"
check "corepack"       "corepack --version"
check "pnpm"           "pnpm --version"
check "docker"         "docker --version"
check "docker compose" "docker compose version"

if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt 22 ]; then
    echo "  [WARN] Node $major found; this project expects Node 22 or newer."
    ok=1
  fi
fi

if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "  [WARN] Docker is installed but the daemon is not running. Start Docker Desktop."
  ok=1
fi

[ "$ok" -eq 0 ] && echo "All set." || echo "Fix the items above, then run this again."
exit "$ok"
