#!/usr/bin/env bash
# Installs the chart on the current (kind) cluster with test-only Postgres and Redis and the mock
# provider, sends one chat request through the Service, and waits for its usage row (M17).
# Expects the images ai-gateway-gateway:ci and ai-gateway-worker:ci loaded into the cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
chart="$here/../ai-gateway"

kubectl apply -f "$here/backing-services.yaml"
kubectl rollout status deploy/postgres deploy/redis --timeout=180s

# Throwaway values made here, for this cluster only: nothing secret is committed.
key="gw_$(openssl rand -hex 8)_$(openssl rand -hex 32)"
kubectl create secret generic ai-gateway \
  --from-literal=DATABASE_URL=postgres://gateway@postgres:5432/gateway \
  --from-literal=REDIS_URL=redis://redis:6379 \
  --from-literal=API_KEY_PEPPER="$(openssl rand -hex 32)" \
  --from-literal=BOOTSTRAP_API_KEY="$key"

# Server-side validation of every rendered manifest against the cluster's API.
helm template gw "$chart" -f "$here/kind-values.yaml" | kubectl apply --dry-run=server -f -

helm install gw "$chart" -f "$here/kind-values.yaml" --wait --timeout 5m

kubectl port-forward svc/gw 18080:80 >/dev/null 2>&1 &
forward=$!
trap 'kill $forward 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:18080/ready >/dev/null && break
  sleep 1
done

status=$(curl -s -D headers.txt -o body.json -w '%{http_code}' \
  http://127.0.0.1:18080/v1/chat/completions \
  -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d '{"model":"mock-1","messages":[{"role":"user","content":"Say hello"}]}')
echo "chat request: HTTP $status"
cat body.json
echo
test "$status" = 200
request_id=$(grep -i '^x-request-id:' headers.txt | cut -d' ' -f2 | tr -d '\r')
echo "request $request_id"

# The worker Deployment stores the usage event; wait for its row.
for _ in $(seq 1 60); do
  rows=$(kubectl exec deploy/postgres -- psql -U gateway -d gateway -tAc \
    "SELECT count(*) FROM usage_events WHERE request_id = '$request_id'")
  if [ "$rows" = 1 ]; then
    echo "usage row stored"
    exit 0
  fi
  sleep 2
done
echo "no usage row for $request_id" >&2
kubectl logs deploy/gw-worker --tail=100 >&2 || true
exit 1
