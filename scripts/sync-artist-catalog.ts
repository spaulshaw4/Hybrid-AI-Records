/**
 * Sync album folders from the public `artist-catalog` storage bucket into
 * `artist_tracks` (title, track_number, public audio CDN URL, artwork).
 *
 * Usage:
 *   npm run sync:catalog
 *   npm run sync:catalog -- "Gravity Left Behind"
 *   RADIO_READY=0 npm run sync:catalog
 *   RADIO_QUEUE_USER_ID=<uuid> npm run sync:catalog
 *
 * Env:
 *   SUPABASE_URL | VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ARTIST_CATALOG_BUCKET   (default: artist-catalog)
 *   RADIO_READY             (default: 1 — mark ingested rows radio_ready)
 *   RADIO_QUEUE_USER_ID     (optional — append radio_ready ids to that user's
 *                            radio_settings.queue when the table exists)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import {
  buildArtistCatalogPublicUrl,
  parseTrackFilename,
  pickAlbumArtwork,
} from "../src/lib/artist-catalog";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

function normalize(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  while (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function truthy(raw: string | undefined, fallback = false): boolean {
  const v = normalize(raw).toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isAudio(name: string): boolean {
  return /\.(mp3|wav|flac|m4a)$/i.test(name);
}

function isImage(name: string): boolean {
  return /\.(jpe?g|png|webp|gif)$/i.test(name);
}

/** Optional static metadata overlays keyed by folder / album title. */
const ALBUM_META: Record<
  string,
  { artist: string; genre: string; credits: string; division?: string; title?: string }
> = {
  "voices before the fall": {
    artist: "Sage Zimba",
    genre: "Afro Roots / Reggae",
    credits: "Written by Sage Zimba · Produced by Hybrid AI Records",
  },
  "campfire confessions": {
    artist: "Phillip S. Thomas",
    genre: "Dark Country / Gothic Folk",
    credits: "Written by Phillip S. Thomas · Produced by The Jester AI Legacy Records",
    division: "jester",
  },
  "the last bow": {
    title: "The Last Bow: A Tribute to The Jester",
    artist: "Stephen P. Shaw",
    genre: "Cinematic Rock",
    credits: "Written by Stephen P. Shaw · Produced by Hybrid AI Records",
  },
  "the last bow a tribute to the jester": {
    title: "The Last Bow: A Tribute to The Jester",
    artist: "Stephen P. Shaw",
    genre: "Cinematic Rock",
    credits: "Written by Stephen P. Shaw · Produced by Hybrid AI Records",
  },
  "collection of me": {
    title: "A Collection Of Me",
    artist: "Stacey LA Bradbury",
    genre: "Country Pop",
    credits: "Written by Stacey LA Bradbury · Produced by Hybrid AI Records",
  },
  "a collection of me": {
    artist: "Stacey LA Bradbury",
    genre: "Country Pop",
    credits: "Written by Stacey LA Bradbury · Produced by Hybrid AI Records",
  },
  "gravity left behind": {
    artist: "Stephen P. Shaw",
    genre: "Space Rock",
    credits: "Written by Stephen P. Shaw · Produced by Hybrid AI Records",
  },
  "this is not all": {
    artist: "Matthew Stern",
    genre: "Alternative Rock",
    credits: "Written by Matthew Stern · Produced by Hybrid AI Records",
  },
  "coordinates of light": {
    artist: "Stephen P. Shaw",
    genre: "Industrial Rock",
    credits:
      "Written by Stephen P. Shaw · Produced by Hybrid AI Records · Inspired by Famemoggler101",
  },
  "the journey": {
    artist: "Stephen P. Shaw",
    genre: "Southern Rock",
    credits: "Written by Stephen P. Shaw · Produced by Phillip S. Thomas (Jester AI)",
    division: "jester",
  },
};

function albumMeta(folderName: string) {
  const key = folderName.toLowerCase().replace(/[:']/g, "").replace(/\s+/g, " ").trim();
  const hit =
    ALBUM_META[key] ||
    ALBUM_META[Object.keys(ALBUM_META).find((k) => key.startsWith(k)) ?? ""];
  return {
    albumTitle: hit?.title ?? folderName,
    artist: hit?.artist ?? "Hybrid AI Records",
    genre: hit?.genre ?? null,
    credits: hit?.credits ?? null,
    division: hit?.division ?? null,
  };
}

type StorageFile = { name: string };

async function listAlbumFiles(
  supabase: SupabaseClient,
  bucket: string,
  folder: string,
): Promise<StorageFile[]> {
  const { data, error } = await supabase.storage.from(bucket).list(folder, {
    limit: 500,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw new Error(`list ${folder}: ${error.message}`);
  // Files have an id; folders do not. Also keep extensioned names in case the
  // API omits id for some objects.
  return (data ?? []).filter(
    (f) =>
      Boolean(f.name) &&
      f.name !== ".emptyFolderPlaceholder" &&
      (f.id != null || isAudio(f.name) || isImage(f.name)),
  );
}

function publicUrl(supabaseUrl: string, bucket: string, path: string): string {
  // Encode each path segment so spaces in album/file names don't break streaming.
  return buildArtistCatalogPublicUrl(supabaseUrl, bucket, path);
}

/** Resolve album artwork CDN URL before track ingest. */
function resolveAlbumCoverUrl(
  supabaseUrl: string,
  bucket: string,
  folder: string,
  files: StorageFile[],
): { coverFile: string | null; coverUrl: string | null } {
  const coverFile = pickAlbumArtwork(files.map((f) => f.name));
  if (!coverFile) return { coverFile: null, coverUrl: null };
  return {
    coverFile,
    coverUrl: publicUrl(supabaseUrl, bucket, `${folder}/${coverFile}`),
  };
}

async function linkRadioQueue(
  supabase: SupabaseClient,
  userId: string,
  trackIds: string[],
): Promise<void> {
  if (!trackIds.length) return;
  const { data: row, error } = await supabase
    .from("radio_settings")
    .select("queue")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn(`radio_settings lookup skipped: ${error.message}`);
    return;
  }
  const existing = Array.isArray(row?.queue)
    ? (row!.queue as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const merged = [...existing];
  for (const id of trackIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  const payload = {
    user_id: userId,
    queue: merged.slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  const { error: upsertError } = await supabase.from("radio_settings").upsert(payload, {
    onConflict: "user_id",
  });
  if (upsertError) {
    console.warn(`radio_settings queue update skipped: ${upsertError.message}`);
    return;
  }
  console.log(`Linked ${trackIds.length} radio_ready id(s) into radio_settings.queue for ${userId}`);
}

async function main(): Promise<void> {
  const supabaseUrl =
    normalize(process.env.SUPABASE_URL) ||
    normalize(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
    normalize(process.env.VITE_SUPABASE_URL);
  const serviceKey = normalize(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = normalize(process.env.ARTIST_CATALOG_BUCKET) || "artist-catalog";
  const radioReady = truthy(process.env.RADIO_READY, true);
  const radioQueueUserId = normalize(process.env.RADIO_QUEUE_USER_ID) || null;
  const onlyAlbum = process.argv.slice(2).join(" ").trim();

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: roots, error: listError } = await supabase.storage.from(bucket).list("", {
    limit: 200,
    sortBy: { column: "name", order: "asc" },
  });
  if (listError) {
    console.error(`Failed to list ${bucket}:`, listError.message);
    process.exit(1);
  }

  const folders = (roots ?? [])
    .filter((f) => !f.id && f.name && f.name !== ".emptyFolderPlaceholder")
    .map((f) => f.name)
    .filter((name) => !onlyAlbum || name.toLowerCase() === onlyAlbum.toLowerCase());

  if (!folders.length) {
    console.error(
      onlyAlbum
        ? `No album folder matching "${onlyAlbum}" in ${bucket}`
        : `No album folders found in ${bucket}`,
    );
    process.exit(1);
  }

  console.log(`Syncing ${folders.length} album folder(s) from ${bucket} (radio_ready=${radioReady})`);

  const radioIds: string[] = [];
  let upserted = 0;

  for (const folder of folders) {
    const meta = albumMeta(folder);
    const albumId = slugify(meta.albumTitle);
    const files = await listAlbumFiles(supabase, bucket, folder);

    // Artwork first: one cover for the whole album folder, applied to every track.
    const { coverFile, coverUrl } = resolveAlbumCoverUrl(supabaseUrl, bucket, folder, files);
    const audioFiles = files.filter((f) => isAudio(f.name));

    const parsed = audioFiles.map((f, index) => {
      const { trackNumber, title } = parseTrackFilename(f.name);
      return {
        file: f.name,
        title,
        trackNumber: trackNumber ?? index + 1,
      };
    });
    parsed.sort((a, b) => a.trackNumber - b.trackNumber || a.title.localeCompare(b.title));
    const trackTotal = parsed.length;

    console.log(`\n${meta.albumTitle} (${folder}) — ${trackTotal} track(s)`);
    if (coverUrl && coverFile) {
      console.log(`  cover: ${coverFile}`);
      console.log(`         ${coverUrl.slice(0, 110)}`);
    } else {
      console.warn(`  cover: NONE found in folder (jpg/jpeg/png/webp/gif)`);
    }

    const rows = parsed.map((t) => {
      const storagePath = `${folder}/${t.file}`;
      const idBase = `${albumId}-${slugify(t.title) || "track"}`;
      const id =
        idBase.length >= 4
          ? idBase
          : `${idBase}-${createHash("sha1").update(storagePath).digest("hex").slice(0, 8)}`;
      const audioUrl = publicUrl(supabaseUrl, bucket, storagePath);
      if (radioReady) radioIds.push(id);
      return {
        id,
        album_id: albumId,
        album_title: meta.albumTitle,
        artist_name: meta.artist,
        title: t.title,
        track_number: t.trackNumber,
        track_total: trackTotal,
        audio_url: audioUrl,
        cover_url: coverUrl,
        storage_path: storagePath,
        genre: meta.genre,
        credits: meta.credits,
        division: meta.division,
        radio_ready: radioReady,
        price_tokens: 1,
        updated_at: new Date().toISOString(),
      };
    });

    if (!rows.length) {
      console.warn(`  no audio files — skipping upsert`);
      continue;
    }

    const { error: upsertError } = await supabase.from("artist_tracks").upsert(rows, {
      onConflict: "id",
    });
    if (upsertError) {
      console.error(`  upsert failed: ${upsertError.message}`);
      console.error(
        "  Hint: apply supabase/migrations/20260824220000_artist_tracks_catalog.sql then re-run.",
      );
      process.exit(1);
    }

    // Force cover_url onto every existing row for this album (including older ids).
    if (coverUrl) {
      const stamp = new Date().toISOString();
      const { error: byAlbumError, count: byAlbumCount } = await supabase
        .from("artist_tracks")
        .update({ cover_url: coverUrl, updated_at: stamp })
        .eq("album_id", albumId)
        .select("id", { count: "exact", head: true });
      const { error: byPathError, count: byPathCount } = await supabase
        .from("artist_tracks")
        .update({ cover_url: coverUrl, updated_at: stamp })
        .like("storage_path", `${folder}/%`)
        .select("id", { count: "exact", head: true });
      if (byAlbumError || byPathError) {
        console.warn(
          `  cover backfill warning: ${byAlbumError?.message ?? ""} ${byPathError?.message ?? ""}`.trim(),
        );
      } else {
        console.log(
          `  cover backfill: album_id=${byAlbumCount ?? 0}, path=${byPathCount ?? 0}`,
        );
      }
    }

    for (const row of rows) {
      upserted += 1;
      console.log(`  #${row.track_number} ${row.title}`);
      console.log(`     ${row.audio_url.slice(0, 100)}`);
    }
  }

  if (radioQueueUserId && radioIds.length) {
    await linkRadioQueue(supabase, radioQueueUserId, radioIds);
  }

  console.log(`\nCatalog sync complete — ${upserted} track(s) indexed into artist_tracks.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
