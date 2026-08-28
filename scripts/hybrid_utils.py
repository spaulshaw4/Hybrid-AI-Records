# scripts/hybrid_utils.py
import hashlib
import uuid


def generate_hex_session_id(seed_string=None):
    """
    Generates a cryptographically secure 16-character hexadecimal identifier
    for session tracking and vault isolation in the Hybrid 1.0 engine.
    """
    if seed_string:
        return hashlib.sha256(seed_string.encode()).hexdigest()[:16]
    return uuid.uuid4().hex[:16]


if __name__ == "__main__":
    print(f"Generated Hex Session ID: {generate_hex_session_id()}")
