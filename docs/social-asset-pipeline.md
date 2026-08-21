# Social share-asset pipeline

Single source of truth: `src/assets/social-banner.svg` (the parent banner) and
the brand crest it embeds, `src/assets/brand-crest-us.jpg`.

Everything else — the story/square SVGs and all nine raster cuts — is generated.
Never hand-edit a generated file; edit the parent and re-run the pipeline.

## Commands

| Command | What it does |
| --- | --- |
| `bun run social:sync` | Rebuild + republish only if a source changed |
| `bun run social:sync:force` | Rebuild + republish unconditionally |
| `bun run social:check` | Exit 1 if any variant is stale or a pointer is missing (CI gate) |
| `bun run social:watch` | Poll the sources and sync automatically while you iterate |

## What a sync does

1. Regenerates the SVG family (`social-banner.svg`, `-story.svg`, `-square.svg`)
   from the crest artwork.
2. Renders every raster variant at 2x and downsamples with LANCZOS:
   - JPG: 2400x1260 (master), 1200x630, 1920x1080, 1080x1080 (x2), 1080x1920
   - PNG: 1200x630, 1080x1080, 1080x1920
3. Uploads each file to the CDN with `lovable-assets create` and rewrites the
   committed `src/assets/*.asset.json` pointers.
4. Records source hashes in `src/assets/social-pipeline.manifest.json`.

`src/lib/social-meta.ts` imports the pointer files, so `og:image` /
`twitter:image` pick up new URLs with no code change.

## Change detection

The manifest stores a SHA-256 of each source: the parent SVG, the crest JPG,
`scripts/generate_social_from_logo.py`, and `scripts/social_pipeline.py`.
A sync is a no-op when all four match, which makes the pipeline safe to run on
every build or in a pre-commit hook.

## Notes

- CDN assets are immutable — each sync mints new URLs. Old URLs stay alive so
  previously published deploys and shared links don't break.
- Requires `rsvg-convert` and Python `Pillow` (both present in the sandbox).
