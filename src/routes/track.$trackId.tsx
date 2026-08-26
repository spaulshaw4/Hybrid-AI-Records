import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Download, Share2 } from "lucide-react";
import { toast } from "sonner";

import { CoverImage } from "@/components/CoverImage";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { STREAM_TRACKS, type StreamTrack } from "@/lib/radio-tracks";
import { absoluteUrl, DEFAULT_OG_IMAGE, pageHead, SITE_ORIGIN } from "@/lib/social-meta";
import { hybridTrackDownloadFileName, hybridTrackDownloadTitle } from "@/lib/track-download-name";

type TrackLoaderData = { track: StreamTrack };

export const Route = createFileRoute("/track/$trackId")({
  errorComponent: RouteErrorFallback,
  loader: ({ params }): TrackLoaderData => {
    const track = STREAM_TRACKS.find((item) => item.id === params.trackId);
    if (!track) throw notFound();
    return { track };
  },
  head: ({ loaderData, params }) => {
    const title = loaderData?.track?.title?.trim() || "Track";
    const cover = loaderData?.track?.cover
      ? absoluteUrl(loaderData.track.cover)
      : DEFAULT_OG_IMAGE;
    return pageHead({
      path: `/track/${params.trackId}`,
      title: `${title} - Hybrid AI Records`,
      description: "Stream and create on Hybrid AI Records",
      socialTitle: `${title} - Hybrid AI Records`,
      socialDescription: "Stream and create on Hybrid AI Records",
      image: cover,
      imageAlt: `${title} — Hybrid AI Records`,
      type: "music.song",
      card: "summary_large_image",
    });
  },
  component: TrackSharePage,
});

function handleDownload(track: StreamTrack) {
  const fileName = hybridTrackDownloadFileName(track.title);
  const link = document.createElement("a");
  link.href = track.src;
  link.download = fileName;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function handleShare(track: StreamTrack) {
  const trackTitle = hybridTrackDownloadTitle(track.title);
  const pageUrl = `${SITE_ORIGIN}/track/${track.id}`;
  const audioUrl = track.src;

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: `${trackTitle} - Hybrid AI Records`,
        text: `Listen to ${trackTitle} on Hybrid AI Records`,
        url: audioUrl || pageUrl,
      });
      return;
    } catch {
      /* canceled or failed */
      return;
    }
  }

  try {
    await navigator.clipboard.writeText(audioUrl || pageUrl);
    toast.success("Link copied to clipboard!");
  } catch {
    toast.message("Copy this link", { description: audioUrl || pageUrl });
  }
}

function TrackSharePage() {
  const { track } = Route.useLoaderData();
  const trackTitle = hybridTrackDownloadTitle(track.title);

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col gap-6 px-4 py-10 text-zinc-100">
      <p className="text-sm text-muted-foreground">
        <Link to="/artists" className="underline-offset-2 hover:underline">
          ← Artist catalog
        </Link>
      </p>

      <div className="flex flex-col gap-6 rounded-xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl sm:flex-row">
        <CoverImage
          src={track.cover || DEFAULT_OG_IMAGE}
          alt={`${trackTitle} cover`}
          className="aspect-square w-full max-w-[220px] shrink-0 rounded-lg object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{trackTitle}</h1>
            <p className="text-sm text-muted-foreground">{track.artist}</p>
            {track.album ? (
              <p className="text-xs text-muted-foreground">{track.album}</p>
            ) : null}
          </div>

          <audio
            controls
            controlsList="nodownload"
            preload="metadata"
            src={track.src}
            className="w-full"
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => handleDownload(track)}
              className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700"
            >
              <Download className="h-4 w-4" aria-hidden />
              Download
            </button>
            <button
              type="button"
              onClick={() => void handleShare(track)}
              className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-2 font-semibold text-white hover:bg-neutral-700"
            >
              <Share2 className="h-4 w-4" aria-hidden />
              Share
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
