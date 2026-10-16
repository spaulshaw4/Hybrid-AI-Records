import type { ReactNode } from "react";

export function PatriotGlassStudio({ children }: { children: ReactNode }) {
  const beamGradient = `conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 260deg,
    #ef4444 295deg,
    #ffffff 330deg,
    #3b82f6 360deg
  )`;
  return (
    <div className="relative group mx-auto my-6 w-full max-w-md md:max-w-4xl" data-testid="patriot-glass-studio">
      <div
        aria-hidden="true"
        className="absolute -inset-1 rounded-3xl overflow-hidden pointer-events-none opacity-40 blur-2xl transition-all duration-700 ease-out group-hover:opacity-85 group-hover:blur-3xl group-hover:-inset-2"
        style={{ overflow: "clip" }}
      >
        <div className="absolute inset-[-150%] animate-border-beam" style={{ background: beamGradient }} />
      </div>
      <div
        className="relative w-full min-w-0 overflow-hidden rounded-3xl p-[1.5px] shadow-2xl transition-shadow duration-500 group-hover:shadow-[0_0_50px_rgba(59,130,246,0.2)]"
        style={{ overflow: "clip" }}
      >
        <div
          aria-hidden="true"
          className="absolute inset-[-150%] animate-border-beam pointer-events-none transition-[filter] duration-300 group-hover:brightness-125"
          style={{ background: beamGradient }}
        />
        <div className="relative h-full w-full min-w-0 max-w-full rounded-[calc(1.5rem-1.5px)] border border-white/10 bg-neutral-950/75 p-4 text-white shadow-inner backdrop-blur-xl md:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
