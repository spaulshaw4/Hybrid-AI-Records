CREATE TABLE track_jobs (
    session_id          VARCHAR(64) PRIMARY KEY,
    title               VARCHAR(255) NOT NULL,
    genre               VARCHAR(64) NOT NULL,
    key_signature       VARCHAR(32) NOT NULL,
    bpm                 INTEGER NOT NULL,
    bars                INTEGER NOT NULL,
    prompt              TEXT NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    -- DOUBLE PRECISION (not NUMERIC): node-postgres returns NUMERIC as strings.
    lufs                DOUBLE PRECISION,
    true_peak_dbtp      DOUBLE PRECISION,
    provenance_score    DOUBLE PRECISION,
    provenance_status   VARCHAR(64),
    -- Bucket object keys issued with the upload URLs:
    -- {"master": {"key": ..., "contentType": ...}, "stem_drums": {...}, ...}.
    delivery_objects    JSONB,
    error_message       TEXT,
    -- Pipeline stage of a failure: dispatch | worker | delivery | storage.
    failed_stage        VARCHAR(32),
    isrc                VARCHAR(12) UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_track_jobs_status ON track_jobs (status, updated_at);
CREATE INDEX idx_track_jobs_created ON track_jobs (created_at DESC);
