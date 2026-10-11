import { RadioPlayer } from "@/components/RadioPlayer";
import { STREAM_TRACKS } from "@/lib/radio-tracks";

/** Portal radio tab — RadioPlayer loads the live station and falls back to the catalog queue. */
export function RadioPlayerView() {
  return (
    <section aria-labelledby="portal-radio" className="mt-10">
      <h1 id="portal-radio" className="font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
        Hybrid AI Radio
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Every official Hybrid AI Records release — one continuous broadcast.
      </p>
      <div className="mx-auto mt-8 max-w-2xl">
        <RadioPlayer tracks={STREAM_TRACKS} />
      </div>
    </section>
  );
}
