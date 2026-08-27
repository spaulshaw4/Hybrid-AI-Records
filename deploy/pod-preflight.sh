#!/usr/bin/env bash
# Run on the Runpod Jupyter/SSH terminal after copying repo files to /workspace.
# Secrets must already be in the environment (export or Supervisor).
set -euo pipefail

echo "== apt (pod) =="
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq rubberband-cli
  rubberband -h >/dev/null && echo "  rubberband-cli=ok"
fi
pip install -q supabase pyloudnorm pedalboard pyrubberband librosa soundfile boto3 mutagen requests python-multipart replicate fastapi uvicorn celery redis numpy scipy

echo "== dirs =="
mkdir -p /workspace/scripts /workspace/scratch /workspace/stems_output

echo "== required files =="
ls -la \
  /workspace/user_track.py \
  /workspace/sum_stems.py \
  /workspace/master_audio.py \
  /workspace/models.py \
  /workspace/stitch_engine.py \
  /workspace/matchmaker.py \
  /workspace/server.py \
  /workspace/tasks.py \
  /workspace/arranger.py \
  /workspace/mastering.py \
  /workspace/audio_telemetry.py \
  /workspace/audio_transcoder.py \
  /workspace/drum_quantizer.py \
  /workspace/sidechain.py \
  /workspace/spatial_fx.py \
  /workspace/rubberband_engine.py \
  /workspace/stem_qc.py \
  /workspace/r2_uploader.py \
  /workspace/vocal_processor.py \
  /workspace/hybrid_tokens.py \
  /workspace/scripts/ingest_full_fma.py \
  /workspace/scripts/process_vault.py \
  /workspace/scripts/monitor_demucs.py \
  /workspace/scripts/supabase_indexer.py \
  /workspace/scripts/watchdog.py

echo "== env (names only) =="
for key in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY R2_PUBLIC_DOMAIN R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME REDIS_URL RENDER_WEBHOOK_URL REPLICATE_API_TOKEN; do
  if [ -n "${!key:-}" ]; then
    echo "  $key=set"
  else
    echo "  $key=MISSING"
  fi
done

echo "== scratch mp3s =="
find /workspace/scratch -name '*.mp3' 2>/dev/null | wc -l

echo
echo "Start services:"
echo "  service redis-server start && redis-cli ping"
echo "  cd /workspace && PYTHONPATH=/workspace nohup python -m celery -A tasks worker --loglevel=info --concurrency=4 > /workspace/celery.log 2>&1 &"
echo "  cd /workspace && PYTHONPATH=/workspace nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 2 > /workspace/uvicorn.log 2>&1 &"
echo "  cd /workspace && nohup python scripts/watchdog.py > /workspace/watchdog.log 2>&1 &"
echo "  # idle_guard (optional, separate log): nohup python scripts/idle_guard.py > /workspace/idle_guard.log 2>&1 &"
echo "Start ingest only if scratch has MP3s:"
echo "  cd /workspace && nohup python scripts/ingest_full_fma.py > /workspace/ingest.log 2>&1 &"
echo "  tail -f /workspace/ingest.log"
