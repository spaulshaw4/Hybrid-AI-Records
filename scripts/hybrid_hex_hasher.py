# scripts/hybrid_hex_hasher.py
import os
import json
import hashlib


class HybridHexHasher:
    def __init__(self, manifest_path):
        with open(manifest_path, 'r') as f:
            self.manifest = json.load(f)

    def generate_stem_hex_checksum(self, file_path):
        """
        Computes a SHA-256 hexadecimal checksum for a rendered audio stem
        to guarantee transmission integrity across the Supabase vault.
        """
        sha256_hash = hashlib.sha256()
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()

    def verify_stem_integrity(self, file_path, expected_hex):
        computed_hex = self.generate_stem_hex_checksum(file_path)
        is_valid = computed_hex == expected_hex
        status = "MATCH" if is_valid else "MISMATCH"
        print(f"[HEX CHECK] File: {os.path.basename(file_path)} | Status: {status}")
        print(f"  - Expected: {expected_hex}")
        print(f"  - Computed: {computed_hex}")
        return is_valid


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True, help='Path to WAV stem file')
    parser.add_argument('--expected', required=True, help='Expected hex checksum')
    args = parser.parse_args()

    hasher = HybridHexHasher(r"D:\MusicDatasets\hybrid_engine_manifest.json")
    hasher.verify_stem_integrity(args.file, args.expected)
