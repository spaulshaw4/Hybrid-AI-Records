/** Quiet Too Lost / BMG line. Logos are decorative; the caption names both partners. */
export function PartnerDistribution() {
  return (
    <div className="px-4 pb-8 pt-6 text-center">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-2.5">
        <div className="flex items-center justify-center gap-5">
          <img
            src="/assets/logos/too-lost.svg"
            alt=""
            width={112}
            height={16}
            className="h-3.5 w-auto opacity-50 transition duration-200 hover:opacity-90 hover:brightness-125"
          />
          <img
            src="/assets/logos/bmg.svg"
            alt=""
            width={40}
            height={16}
            className="h-3.5 w-auto opacity-50 transition duration-200 hover:opacity-90 hover:brightness-125"
          />
        </div>
        <p className="max-w-md text-[11px] leading-relaxed tracking-wide text-zinc-500">
          Global Distribution via Too Lost • Publishing Administration in Partnership with BMG
        </p>
      </div>
    </div>
  );
}
