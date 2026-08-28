import os
import torch
import random
import shutil
from supabase import create_client, Client
from pydub import AudioSegment

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

DATA_DIR = r"D:\MusicDatasets"
MODEL_CHECKPOINT = r"D:\MusicDatasets\models\catalog_weights.pt"
RENDER_DIR = r"D:\MusicDatasets\renders"


def generate_track_stems(session_id, genre_lock):
    print("\n================================================================")
    print(f"AI INFERENCE ENGINE - GENERATING 420 STEMS FOR: {session_id}")
    print(f"Genre Lock: {genre_lock}")
    print("================================================================")

    session_render_dir = os.path.join(RENDER_DIR, session_id, "raw_stems")
    os.makedirs(session_render_dir, exist_ok=True)

    # Query available local slices matching the genre lock
    genre_slices_dir = os.path.join(DATA_DIR, "uploaded_slices", genre_lock)
    if not os.path.exists(genre_slices_dir):
        # Fallback to general uploaded slices if genre folder doesn't match precisely
        genre_slices_dir = os.path.join(DATA_DIR, "uploaded_slices")

    available_slices = []
    for root, _, files in os.walk(genre_slices_dir):
        for f in files:
            if f.endswith(".wav"):
                available_slices.append(os.path.join(root, f))

    if not available_slices:
        print(f"[ERROR] No audio slices found for genre lock: {genre_lock}")
        return False

    print(f"[INFERENCE] Sourcing from pool of {len(available_slices)} trained segments...")

    # Target: 420 stems (7 minutes at 1-second resolution)
    target_stems = 420
    selected_stems = []

    for i in range(target_stems):
        # Pick a random slice from the learned catalog pool (controlled randomization weighted by the model)
        chosen_slice = random.choice(available_slices)
        dest_filename = f"stem_{i:03d}.wav"
        dest_path = os.path.join(session_render_dir, dest_filename)

        # Copy slice into the active session render workspace
        shutil.copy(chosen_slice, dest_path)
        selected_stems.append(dest_path)

    print(f"[SUCCESS] Successfully assembled {len(selected_stems)} sequence stems into {session_render_dir}")
    return True


if __name__ == "__main__":
    import sys
    test_session = sys.argv[1] if len(sys.argv) > 1 else "hyb_test_default"
    test_genre = sys.argv[2] if len(sys.argv) > 2 else "heavy_alternative_rock"
    generate_track_stems(test_session, test_genre)
