"""Uvicorn entry for the local CPU worker.

    uvicorn main:app --host 127.0.0.1 --port 8880 --reload
"""

from api.headless_job_runner import app

__all__ = ["app"]
