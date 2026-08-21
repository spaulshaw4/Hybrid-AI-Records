export const BRAND_EAGLE_PUBLIC = "/brand/lockup-usa-512.png";
export const BRAND_EAGLE_SRC = "/brand/lockup-usa-256.png";
export const BRAND_EAGLE_WIDTH = 256;
export const BRAND_EAGLE_HEIGHT = 256;

const BRAND_EAGLE_SRCSET =
  "/brand/lockup-usa-96.png 96w, /brand/lockup-usa-144.png 144w, /brand/lockup-usa-192.png 192w, /brand/lockup-usa-256.png 256w, /brand/lockup-usa-384.png 384w, /brand/lockup-usa-512.png 512w";

/**
 * Full Hybrid AI Records LLC lockup. Transparent PNGs so the paper field
 * never reads as a white box on the studio mesh.
 */
export function BrandEagle({
  className = "h-28 w-auto",
  alt = "Hybrid AI Records LLC",
  decorative = false,
  priority = false,
  src = BRAND_EAGLE_SRC,
  sizes = "(min-width: 640px) 144px, 112px",
}: {
  className?: string;
  alt?: string;
  decorative?: boolean;
  priority?: boolean;
  src?: string;
  sizes?: string;
}) {
  const responsive = src === BRAND_EAGLE_SRC;
  return (
    <img
      src={src}
      srcSet={responsive ? BRAND_EAGLE_SRCSET : undefined}
      sizes={responsive ? sizes : undefined}
      alt={decorative ? "" : alt}
      aria-hidden={decorative || undefined}
      width={BRAND_EAGLE_WIDTH}
      height={BRAND_EAGLE_HEIGHT}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      draggable={false}
      className={`select-none bg-transparent object-contain [image-rendering:auto] ${className}`}
    />
  );
}

export default BrandEagle;
