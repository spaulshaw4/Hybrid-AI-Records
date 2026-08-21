import { useEffect, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";

type CoverImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "loading"> & {
  src: string;
  alt: string;
  /** Tried in order when `src` 404s or YouTube returns the 120px stub frame. */
  fallbackSrc?: string | string[];
  /** Above-the-fold artwork loads eagerly; everything else stays lazy. */
  priority?: boolean;
};

function isStubFrame(img: HTMLImageElement) {
  return img.naturalWidth > 0 && img.naturalWidth <= 120;
}

/**
 * Album / video artwork with decode defaults that stay cheap on mobile Safari.
 * High-resolution crest backgrounds are *not* used here — those go through
 * LivingBackground's 1024/4096 tier picker.
 */
export function CoverImage({
  src,
  fallbackSrc,
  alt,
  priority = false,
  className,
  sizes,
  width,
  height,
  onError,
  onLoad,
  ...rest
}: CoverImageProps) {
  const chain = [src, ...(Array.isArray(fallbackSrc) ? fallbackSrc : fallbackSrc ? [fallbackSrc] : [])];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [src]);

  const advance = () => {
    setIndex((current) => (current + 1 < chain.length ? current + 1 : current));
  };

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    advance();
    onError?.(event);
  };

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    if (isStubFrame(event.currentTarget)) advance();
    onLoad?.(event);
  };

  return (
    <img
      src={chain[Math.min(index, chain.length - 1)]}
      alt={alt}
      sizes={sizes}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "low"}
      draggable={false}
      className={className}
      onError={handleError}
      onLoad={handleLoad}
      {...rest}
    />
  );
}
