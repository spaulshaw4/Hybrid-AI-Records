"""Neural models for Hybrid AI Forge.

Sklearn stem-role artifacts (``*.joblib``) live in this directory.
Import the residual CNN explicitly::

    from models.stem_classifier import AudioStemClassifier
"""

from __future__ import annotations

__all__ = ["AudioStemClassifier", "ConvBlock", "get_loss_and_optimizer"]


def __getattr__(name: str):
    if name in __all__:
        from . import stem_classifier as _sc

        return getattr(_sc, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
