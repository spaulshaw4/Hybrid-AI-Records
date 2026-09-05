#!/usr/bin/env bash
# Launch FastAPI + Celery for the Hybrid studio engine.
# On the pod:  chmod +x /workspace/start_studio.sh && /workspace/start_studio.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ -d /workspace ]; then
  ROOT=/workspace
fi
cd "$ROOT"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p "$ROOT/scratch" /workspace/scratch 2>/dev/null || true

echo "Initializing Hybrid 1.0 Studio Engine..."

if command -v redis-cli >/dev/null 2>&1; then
  if ! redis-cli ping >/dev/null 2>&1; then
    if command -v service >/dev/null 2>&1; then
      service redis-server start || true
    elif command -v redis-server >/dev/null 2>&1; then
      redis-server --daemonize yes || true
    fi
  fi
  redis-cli ping >/dev/null 2>&1 && echo "Redis: PONG"
fi

# Live API stays on CPU so the MX450 trainer keeps the GPU lock.
export CUDA_VISIBLE_DEVICES=
export HYBRID_INFER_DEVICE=cpu
# Celery lives on tasks.celery_app, not server.celery_app
python3 -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 2 &
FASTAPI_PID=$!

celery -A tasks worker --loglevel=info --concurrency=4 &
CELERY_PID=$!

cleanup() {
  echo "Stopping studio processes..."
  kill "$FASTAPI_PID" "$CELERY_PID" 2>/dev/null || true
  wait "$FASTAPI_PID" "$CELERY_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "FastAPI running (PID: $FASTAPI_PID)"
echo "Celery worker running (PID: $CELERY_PID)  [celery -A tasks]"
echo "Studio engine active on http://0.0.0.0:8000"
wait
