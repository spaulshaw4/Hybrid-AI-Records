-- Add master_hash and storage_url columns to user_vaults table
-- These columns are used by the hex pipeline hook and cloud uploader

ALTER TABLE public.user_vaults 
ADD COLUMN IF NOT EXISTS master_hash text,
ADD COLUMN IF NOT EXISTS storage_url text;
