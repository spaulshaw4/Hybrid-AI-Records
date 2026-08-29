# D:\MusicDatasets\scripts\test_pipeline_trigger.py
import os
import sys
import math
import wave
import struct
import time
import uuid
import subprocess
import numpy as np
from supabase import create_client, Client

# Loads .env / .env.local into os.environ before the credential reads below.
# os.environ.get() returns only the process environment and Python does not read
# .env on its own, so credentials configured in a file are otherwise invisible
# here. A value already present in the real environment still wins.
import os as _hybrid_os, sys as _hybrid_sys
_hybrid_sys.path.insert(0, _hybrid_os.path.dirname(_hybrid_os.path.abspath(__file__)))
import hybrid_env  # noqa: F401,E402

BASE_DIR = r"D:\MusicDatasets"
INCOMING_DIR = os.path.join(BASE_DIR, "incoming")
SLICES_DIR = os.path.join(BASE_DIR, "uploaded_slices")
RENDERS_DIR = os.path.join(BASE_DIR, "renders")
SCRIPTS_DIR = os.path.join(BASE_DIR, "scripts")
RUN_PIPELINE_SCRIPT = os.path.join(SCRIPTS_DIR, "run_master_pipeline.ps1")
LOCAL_SLICER_SCRIPT = os.path.join(SCRIPTS_DIR, "local_slicer.py")

# The whole pipeline keys off this: watchdog_slicing_daemon and local_slicer both
# derive genre from the parent folder name, and run_master_pipeline stages from
# uploaded_slices\<GenreLock>\. Staging under a session-named folder instead
# would label the slices with the session id and the render would find nothing.
GENRE_LOCK = "heavy_alternative_rock"

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from environment variables.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

SAMPLE_RATE = 44100

# run_master_pipeline enforces a 150-second (2:30) floor and stages
# DurationSeconds x PremixLayers slices. The probe runs at the floor with premix
# disabled, so it needs at least 150 one-second slices of source audio.
TARGET_DURATION_SEC = 150
PREMIX_LAYERS = 1

# Four stems long enough to clear the floor with margin: 4 x 45s = 180 slices.
STEM_SECONDS = 45.0
DURATION_SEC = STEM_SECONDS

# Each stem carries its own inter-channel phase offset in degrees.
#
# For two sines offset by theta, the normalised L/R correlation is cos(theta).
# Writing the same sample to both channels gives correlation 1.0, which fails
# the QC gate's 0.95 ceiling - correctly, since that master is mono and the
# width stage did nothing. Offsets are spread around 45 degrees (cos = 0.707),
# centred in the [0.25, 0.95] band with margin at both ends. Note 15 degrees
# would give 0.966 and still fail.
STEM_SPECS = {
    "drums":  {"freq": 60.0,  "phase_deg": 38.0},   # cos = 0.788
    "bass":   {"freq": 110.0, "phase_deg": 42.0},   # cos = 0.743
    "guitar": {"freq": 440.0, "phase_deg": 48.0},   # cos = 0.669
    "vocals": {"freq": 880.0, "phase_deg": 52.0},   # cos = 0.616
}

# Retained so existing callers that iterate frequencies still work
STEM_FREQUENCIES = {name: spec["freq"] for name, spec in STEM_SPECS.items()}

# Independent per-channel noise, as a fraction of amplitude. Adds broadband
# decorrelation so the correlation does not depend on a single tone's phase
# alone, which is closer to real material.
DECORRELATION_NOISE = 0.02


def generate_sine_stem_wav(file_path: str, frequency: float, duration: float = 5.0,
                           sample_rate: int = 44100, phase_deg: float = 45.0,
                           amplitude: float = 0.5, seed: int = 0):
    """
    Write a decorrelated stereo test stem.

    Vectorised: the previous per-sample Python loop ran 220,500 iterations per
    stem, four stems per run.
    """
    total_samples = int(sample_rate * duration)
    t = np.arange(total_samples, dtype=np.float64) / sample_rate

    # Trapezoidal fade to avoid a click at either boundary
    env = np.minimum(1.0, t / 0.2) * np.minimum(1.0, (duration - t) / 0.2)
    env = np.clip(env, 0.0, 1.0)

    phase_rad = np.radians(phase_deg)
    left = amplitude * np.sin(2.0 * np.pi * frequency * t)
    right = amplitude * np.sin(2.0 * np.pi * frequency * t + phase_rad)

    rng = np.random.default_rng(seed)
    noise_scale = DECORRELATION_NOISE * amplitude
    left += rng.normal(0.0, noise_scale, total_samples)
    right += rng.normal(0.0, noise_scale, total_samples)

    stereo = np.column_stack((left * env, right * env))

    quantized = np.clip(stereo * 32767.0, -32768.0, 32767.0).astype("<i2")

    with wave.open(file_path, "w") as wav_file:
        wav_file.setnchannels(2)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(quantized.tobytes())

    # Report what was actually produced, so a fixture drifting out of band is
    # visible here rather than surfacing later as a QC failure.
    l, r = stereo[:, 0], stereo[:, 1]
    denom = np.sqrt(np.sum(l ** 2) * np.sum(r ** 2)) + 1e-12
    return float(np.sum(l * r) / denom)


def run_smoke_test():
    session_id = f"smoke_test_{int(time.time())}_{uuid.uuid4().hex[:6]}"

    # Stage into the genre folder, not a session folder - see GENRE_LOCK note above
    session_dir = os.path.join(INCOMING_DIR, GENRE_LOCK)
    os.makedirs(session_dir, exist_ok=True)

    print("================================================================")
    print("HYBRID 1.0 - END-TO-END PIPELINE INTEGRATION PROBE")
    print(f"Session ID       : {session_id}")
    print(f"Staging Path     : {session_dir}")
    print(f"Genre Lock       : {GENRE_LOCK}")
    print("================================================================")

    # 1. Generate 4 synthetic audio stems
    print("\n[STEP 1/6] Synthesizing multitrack test audio stems...")
    for seed, (stem_name, spec) in enumerate(STEM_SPECS.items()):
        stem_path = os.path.join(session_dir, f"{session_id}_{stem_name}.wav")
        correlation = generate_sine_stem_wav(
            stem_path,
            frequency=spec["freq"],
            duration=DURATION_SEC,
            sample_rate=SAMPLE_RATE,
            phase_deg=spec["phase_deg"],
            seed=seed,
        )
        size_kb = round(os.path.getsize(stem_path) / 1024, 1)
        print(f"  -> Generated {os.path.basename(stem_path)} "
              f"({spec['freq']} Hz, {spec['phase_deg']}d offset, "
              f"L/R corr {correlation:.3f}, {size_kb} KB)")

    # 2. Slice explicitly rather than waiting on the watchdog service, so the
    #    probe is self-contained and does not silently pass when it is stopped.
    print("\n[STEP 2/6] Slicing staged stems into 1000ms segments...")
    if os.path.exists(LOCAL_SLICER_SCRIPT):
        slice_proc = subprocess.run([sys.executable, LOCAL_SLICER_SCRIPT], capture_output=True, text=True)
        for line in (slice_proc.stdout or "").splitlines():
            if "SUCCESS" in line or "ERROR" in line or "INGEST" in line:
                print(f"  {line.strip()}")
        if slice_proc.returncode != 0:
            print(f"[WARN] local_slicer exited {slice_proc.returncode}")
            if slice_proc.stderr:
                print(slice_proc.stderr[:500])
    else:
        print(f"[WARN] {LOCAL_SLICER_SCRIPT} not found; relying on the watchdog daemon.")
        time.sleep(5)

    genre_slice_dir = os.path.join(SLICES_DIR, GENRE_LOCK)
    slice_count = len([f for f in os.listdir(genre_slice_dir) if f.endswith(".wav")]) if os.path.isdir(genre_slice_dir) else 0
    print(f"  -> {slice_count} slice(s) available in {genre_slice_dir}")

    required = TARGET_DURATION_SEC * PREMIX_LAYERS

    if slice_count == 0:
        print("\n[FATAL] No slices produced. run_master_pipeline will abort on an empty genre pool.")
        sys.exit(1)

    if slice_count < required:
        print(f"\n[FATAL] {slice_count} slices available but {required} needed for a "
              f"{TARGET_DURATION_SEC}s render at {PREMIX_LAYERS} layer(s).")
        print("        The pipeline enforces a 150-second minimum track length.")
        sys.exit(1)

    # 3. Register session in user_vaults ledger
    print("\n[STEP 3/6] Creating database entry in user_vaults...")
    test_user_id = "00000000-0000-0000-0000-000000000001"

    try:
        supabase.table("user_vaults").insert({
            "session_id": session_id,
            "user_id": test_user_id,
            "genre_lock": GENRE_LOCK,
            "status": "pending",
            "metadata": {
                "smoke_test": True,
                "stem_count": len(STEM_FREQUENCIES),
                "duration_sec": DURATION_SEC
            }
        }).execute()
        print("  -> Ledger record registered as 'pending'.")
    except Exception as e:
        print(f"[FATAL ERROR] Supabase insert failed: {e}")
        sys.exit(1)

    # 4. Execute master orchestration pipeline
    print("\n[STEP 4/6] Executing run_master_pipeline.ps1...")
    start_time = time.time()

    cmd = [
        "powershell.exe",
        "-ExecutionPolicy", "Bypass",
        "-File", RUN_PIPELINE_SCRIPT,
        "-SessionId", session_id,
        "-GenreLock", GENRE_LOCK,
        "-UserId", test_user_id,
        "-DurationSeconds", str(TARGET_DURATION_SEC),
        "-PremixLayers", str(PREMIX_LAYERS)
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = round(time.time() - start_time, 2)

    print(proc.stdout)
    if proc.stderr:
        print(f"[POWERSHELL STDERR]\n{proc.stderr}")

    # 5. Verify output artifacts on D: drive
    print("\n[STEP 5/6] Verifying local render artifacts...")
    render_session_dir = os.path.join(RENDERS_DIR, session_id)
    master_file = os.path.join(render_session_dir, "master_output.wav")

    if os.path.exists(master_file):
        master_size_mb = round(os.path.getsize(master_file) / (1024 * 1024), 2)
        print(f"  -> Master file exists: {master_file} ({master_size_mb} MB)")
    else:
        print(f"  -> [WARN] Local master output not found at {master_file}")

    # 6. Validate Supabase final state and telemetry emission
    print("\n[STEP 6/6] Checking final database state and telemetry stream...")
    time.sleep(1)

    vault_res = supabase.table("user_vaults").select("*").eq("session_id", session_id).execute()
    vault_status = "UNKNOWN"
    master_hash = None
    storage_url = None

    if vault_res.data:
        vault_status = vault_res.data[0].get("status")
        master_hash = vault_res.data[0].get("master_hash")
        storage_url = vault_res.data[0].get("storage_url")

    telemetry_res = (
        supabase.table("pipeline_telemetry_logs")
        .select("event_type, created_at")
        .filter("metadata->>session_id", "eq", session_id)
        .order("created_at", desc=False)
        .execute()
    )
    logged_events = [r.get("event_type") for r in (telemetry_res.data or [])]

    print(f"  - Ledger Status       : {vault_status}")
    print(f"  - Cryptographic Hash  : {master_hash or 'None'}")
    print(f"  - Storage URL         : {storage_url or 'None'}")
    print(f"  - Telemetry Pipeline  : {' -> '.join(logged_events) if logged_events else 'None captured'}")
    print(f"  - Total Test Duration : {elapsed}s")

    print("\n================================================================")
    if vault_status == "completed" and storage_url and len(logged_events) >= 5:
        print("RESULT: [PASS] End-to-end pipeline test executed successfully.")
    else:
        print("RESULT: [FAIL / INCOMPLETE] Pipeline did not reach final verified state.")
    print("================================================================")


if __name__ == "__main__":
    run_smoke_test()
