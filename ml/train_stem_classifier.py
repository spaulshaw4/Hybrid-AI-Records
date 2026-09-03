"""Shim: training lives in ``engine.train_stem_classifier``.

    python -m ml.train_stem_classifier
    python engine/train_stem_classifier.py
"""
from __future__ import annotations

from engine.train_stem_classifier import (  # noqa: F401
    DEFAULT_CACHE,
    DEFAULT_MODEL,
    backfill_stem_type_ml,
    build_feature_matrix,
    confusion,
    fit_classifier,
    main,
    print_report,
    run_training,
    select_subset,
    sklearn_available,
)


if __name__ == "__main__":
    import multiprocessing as mp

    mp.freeze_support()
    raise SystemExit(main())
