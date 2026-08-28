-- supabase/migrations/003_audio_embeddings_pgvector.sql
-- Vector embeddings for AI similarity search on audio slices

-- Enable the pgvector extension if not already active
CREATE EXTENSION IF NOT EXISTS vector;

-- Create table for storing 1-second audio slice embeddings
CREATE TABLE IF NOT EXISTS audio_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename TEXT NOT NULL,
    genre TEXT NOT NULL,
    embedding vector(512), -- Matches the 512-dim latent space tensor
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create an HNSW index for lightning-fast similarity lookups during AI generation
CREATE INDEX ON audio_embeddings USING hnsw (embedding vector_cosine_ops);

-- Index on genre for filtered similarity queries
CREATE INDEX idx_audio_embeddings_genre ON audio_embeddings(genre);
