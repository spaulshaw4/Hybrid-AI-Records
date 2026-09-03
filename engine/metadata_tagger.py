"""Thin wrapper around ``scripts.audio_metadata_tagger`` — no second BWF writer."""
from __future__ import annotations

import os
import runpy
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PARENT = os.path.abspath(os.path.join(_HERE, ".."))
_SCRIPTS = os.path.join(_PARENT, "scripts")
for path in (_PARENT, _SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from audio_metadata_tagger import (  # noqa: E402, F401
    build_bext,
    build_info_list,
    normalise_isrc,
)


def main() -> int:
    target = os.path.join(_SCRIPTS, "audio_metadata_tagger.py")
    if not os.path.isfile(target):
        print(f"[ERROR] missing {target}", file=sys.stderr)
        return 1
    sys.argv[0] = target
    runpy.run_path(target, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
