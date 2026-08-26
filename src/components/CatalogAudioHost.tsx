import { useEffect, useRef } from "react";
import { bindCatalogAudioElement } from "@/lib/catalog-player";

/**
 * Persistent root <audio> so catalog / artist / radio playback shares one
 * element that stays mounted across route transitions.
 */
export function CatalogAudioHost() {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    bindCatalogAudioElement(el);
    console.log("[catalog-player] root <audio> bound", { id: el.id });
  }, []);

  return (
    <audio
      ref={ref}
      id="hybrid-catalog-audio"
      preload="metadata"
      playsInline
      className="pointer-events-none fixed h-0 w-0 opacity-0"
      aria-hidden
    />
  );
}
