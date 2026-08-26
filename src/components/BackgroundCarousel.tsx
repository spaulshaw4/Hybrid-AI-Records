import React, { useState, useEffect } from 'react';

import americanCrest from "@/assets/brand-crest-us.jpg";
import jesterCrest from "@/assets/hybrid-ai-records-jester.jpg";
import nigerianCrest from "@/assets/hybrid-ai-records-nigeria.jpg";
import lithuanianCrest from "@/assets/hybrid-ai-records-lithuania.jpg";

const LOGOS = [
  { id: 'american', src: americanCrest, alt: 'Hybrid AI American Crest' },
  { id: 'jester', src: jesterCrest, alt: 'The Jester Logo' },
  { id: 'nigerian', src: nigerianCrest, alt: 'Nigerian Edition Logo' },
  { id: 'lithuanian', src: lithuanianCrest, alt: 'Lithuanian Edition Logo' },
];

export const BackgroundCarousel: React.FC = () => {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % LOGOS.length);
    }, 7000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      aria-hidden="true"
      className="living-bg fixed inset-0 pointer-events-none z-0 overflow-hidden bg-[#F8FAFC]"
    >
      {/* Responsive sizing / opacity tokens to keep the crest visible as a
          watermark without pinning a large, fully-opaque texture on mobile GPUs. */}
      <style>{`
        .bg-carousel-layer {
          --carousel-opacity: 0.75;
          --carousel-size: min(82vw, 720px);
        }
        @media (max-width: 640px) {
          .bg-carousel-layer {
            --carousel-opacity: 0.50;
            --carousel-size: min(68vw, 320px);
          }
        }
        @media (min-width: 641px) and (max-width: 1024px) {
          .bg-carousel-layer {
            --carousel-opacity: 0.60;
            --carousel-size: min(74vw, 480px);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .bg-carousel-layer {
            --carousel-opacity: 0.40;
            --carousel-size: min(60vw, 280px);
          }
        }
      `}</style>

      {/* 1. Base Crimson Ambient Glow (Deepest Layer) */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_12%_8%,rgba(225,29,72,0.42)_0%,transparent_62%),radial-gradient(ellipse_at_90%_92%,rgba(37,99,235,0.4)_0%,transparent_60%),radial-gradient(ellipse_at_50%_42%,rgba(255,255,255,0.95)_0%,transparent_72%)] z-0" />

      {/* 2. Guilloche / Subtle Ray Overlay (Optional Accent Layer) */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(255,255,255,0.55)_0%,transparent_74%)] z-0" />

      {/* 3. Rotating Crests (Rendered ABOVE the glow so they do not get drowned out) */}
      {LOGOS.map((logo, idx) => (
        <div
          key={logo.id}
          className="bg-carousel-layer absolute inset-0 z-10 transition-opacity duration-1000 ease-in-out"
          style={{
            opacity: idx === currentIndex ? 'var(--carousel-opacity)' : 0,
            backgroundImage: `url(${logo.src})`,
            backgroundPosition: 'center 20%',
            backgroundRepeat: 'no-repeat',
            backgroundSize: 'var(--carousel-size) auto',
            mixBlendMode: 'normal',
            willChange: 'opacity',
          }}
        />
      ))}

      {/* 4. Subtle Vignette overlay to keep foreground text readable */}
      <div className="absolute inset-0 z-20 bg-gradient-to-b from-transparent via-[#F8FAFC]/20 to-[#F1F5F9]/50" />
    </div>
  );
};
