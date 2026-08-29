# D:\MusicDatasets\scripts\hybrid_env.py
r"""
===============================================================================
HYBRID 1.0 - ENVIRONMENT LOADER
===============================================================================
Loads .env / .env.local into os.environ so the pipeline scripts see credentials
that live in a file rather than in the shell.

Why this exists
---------------
Every pipeline script reads its credentials with os.environ.get(), which returns
only the *process* environment. Python does not read .env files on its own, so
credentials sitting in .env were invisible to the daemons even though they were
correctly configured for the Next.js app. Four scripts in this codebase already
carried a private copy of this loader (watchdog, idle_guard, supabase_indexer,
batch_generate_ep); this is that pattern in one place.

Precedence: a variable already present in the real environment always wins. A
Machine-scope value or one exported in the shell is therefore never overridden
by a stale file, which matters when a service is deliberately configured
differently from a developer's checkout.

Search order for the file, first hit wins per directory:
  1. HYBRID_ENV_FILE, if set - an explicit path
  2. the script's own directory, then its parents
  3. the current working directory, then its parents

The upward walk matters because scripts run from D:\MusicDatasets\scripts while
.env may live in the repository root on another drive.
"""

import os
from pathlib import Path

ENV_FILENAMES = (".env.local", ".env")

# Names worth reporting on, so a missing credential is visible rather than
# surfacing later as an authentication failure.
KEY_VARIABLES = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")

_loaded_from = []
_already_run = False


def _parse_env_file(path: Path) -> dict:
    """
    Minimal .env parser.

    Handles `export KEY=value`, inline `#` comments outside quotes, and single or
    double quoted values. Deliberately not a full shell parser: no variable
    interpolation, no multi-line values. A service-role key containing a literal
    `#` must therefore be quoted, which is normal .env practice.
    """
    values = {}

    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except Exception:
        return values

    for raw_line in text.splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        if line.lower().startswith("export "):
            line = line[7:].lstrip()

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()

        if not key or not key.replace("_", "").isalnum():
            continue

        quoted = len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"')

        if quoted:
            value = value[1:-1]
        else:
            # Strip a trailing comment only when the value is unquoted
            hash_pos = value.find(" #")
            if hash_pos != -1:
                value = value[:hash_pos].rstrip()

        if value:
            values[key] = value

    return values


def _candidate_files():
    seen = set()
    candidates = []

    explicit = os.environ.get("HYBRID_ENV_FILE")
    if explicit:
        p = Path(explicit)
        if p.is_file():
            candidates.append(p)
            seen.add(p.resolve())

    roots = []
    try:
        roots.append(Path(__file__).resolve().parent)
    except NameError:
        pass
    roots.append(Path.cwd())

    for root in roots:
        for directory in [root, *root.parents]:
            for name in ENV_FILENAMES:
                p = directory / name
                if p.is_file():
                    resolved = p.resolve()
                    if resolved not in seen:
                        candidates.append(p)
                        seen.add(resolved)

    return candidates


def load_env(verbose: bool = False, force: bool = False) -> dict:
    """
    Populate os.environ from the first .env files found. Idempotent.

    Returns the mapping of variables this call actually set.
    """
    global _already_run

    if _already_run and not force:
        return {}

    applied = {}

    for path in _candidate_files():
        parsed = _parse_env_file(path)
        if not parsed:
            continue

        newly_set = []
        for key, value in parsed.items():
            # Real environment wins
            if key not in os.environ or not os.environ[key].strip():
                os.environ[key] = value
                applied[key] = value
                newly_set.append(key)

        if newly_set:
            _loaded_from.append((str(path), len(newly_set)))
            if verbose:
                print(f"[ENV] {path} -> {len(newly_set)} variable(s)")

    _already_run = True
    return applied


def require(*names, hint: str = None) -> dict:
    """
    Load, then confirm the named variables are present and non-empty.

    Raises with the paths actually searched, because the usual failure is a file
    that exists somewhere other than where the script looked.
    """
    load_env()

    resolved = {}
    missing = []

    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            resolved[name] = value
        else:
            missing.append(name)

    if missing:
        searched = [str(p) for p in _candidate_files()] or ["(no .env file found)"]
        message = [
            f"Missing required environment variable(s): {', '.join(missing)}",
            "Searched:",
        ]
        message += [f"  {s}" for s in searched]
        if hint:
            message.append(hint)
        else:
            message.append("Set them in .env, or export them, or point HYBRID_ENV_FILE "
                           "at the file. For a Windows service, use Machine scope so the "
                           "daemon inherits them.")
        raise RuntimeError("\n".join(message))

    return resolved


def status() -> dict:
    """Report which key variables resolved, without exposing their values."""
    load_env()

    return {
        "files_loaded": list(_loaded_from),
        "candidates": [str(p) for p in _candidate_files()],
        "variables": {
            name: bool(os.environ.get(name, "").strip())
            for name in KEY_VARIABLES
        },
    }


# Import-time load, so `import hybrid_env` is enough for existing scripts that
# already call os.environ.get() at module level.
load_env()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hybrid 1.0 environment loader")
    parser.add_argument("--check", action="store_true",
                        help="Report resolution status without printing values")
    parser.add_argument("--list-names", action="store_true",
                        help="List every variable name loaded, values redacted")
    args = parser.parse_args()

    info = status()

    print("=" * 66)
    print("HYBRID 1.0 ENVIRONMENT RESOLUTION")
    print("=" * 66)

    print("\nCandidate files, in search order:")
    for c in info["candidates"]:
        print(f"  {c}")
    if not info["candidates"]:
        print("  (none found)")

    print("\nLoaded:")
    for path, count in info["files_loaded"]:
        print(f"  {path}  ->  {count} variable(s)")
    if not info["files_loaded"]:
        print("  nothing applied (variables may already be in the environment)")

    print("\nRequired variables:")
    for name, present in info["variables"].items():
        print(f"  {name:<32} {'RESOLVED' if present else 'MISSING'}")

    if args.list_names:
        print("\nAll names now in environment matching the project prefixes:")
        prefixes = ("SUPABASE", "NEXT_PUBLIC", "VITE", "R2_", "DATABASE", "DIRECT")
        for name in sorted(os.environ):
            if any(name.startswith(p) for p in prefixes):
                print(f"  {name}")

    print()
    all_ok = all(info["variables"].values())
    print(f"Verdict: {'ready' if all_ok else 'NOT ready - see MISSING above'}")
    raise SystemExit(0 if all_ok else 1)
