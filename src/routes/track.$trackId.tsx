import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Download, Share2 } from "lucide-react";
import { toast } from "sonner";

import { CoverImage } from "@/components/CoverImage";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STREAM_TRACKS, type StreamTrack } from "@/lib/radio-tracks";
import { absoluteUrl, DEFAULT_OG_IMAGE, pageHead, SITE_ORIGIN } from "@/lib/social-meta";

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

async function handleShare(track: StreamTrack) {
  const url = `${SITE_ORIGIN}/track/${track.id}`;
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: `${track.title} | Hybrid AI Records`,
        text: `Check out this track created on Hybrid AI Records: ${track.title}`,
        url,
      });
      return;
    } catch (err) {
      console.log("Share canceled or failed", err);
      return;
    }
  }
  try {
    await navigator.clipboard.writeText(track.src || url);
    toast.success("Link copied to clipboard!");
  } catch {
    toast.message("Copy this link", { description: url });
  }
}

function TrackSharePage() {
  const { track } = Route.useLoaderData();
  const downloadName = `${track.title || "Hybrid-AI-Track"} - Hybrid AI Records.mp3`;

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
          alt={`${track.title} cover`}
          className="aspect-square w-full max-w-[220px] shrink-0 rounded-lg object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{track.title}</h1>
            <p className="text-sm text-muted-foreground">{track.artist}</p>
            {track.album ? (
              <p className="text-xs text-muted-foreground">{track.album}</p>
            ) : null}
          </div>

          <audio controls preload="metadata" src={track.src} className="w-full" />

          <div className="flex flex-wrap gap-2">
            <a
              href={track.src}
              download={downloadName}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({ variant: "default", size: "sm" }),
                "inline-flex items-center gap-2",
              )}
            >
              <Download className="size-3.5" aria-hidden />
              Download Track
            </a>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleShare(track)}
            >
              <Share2 className="size-3.5" aria-hidden />
              Share
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
