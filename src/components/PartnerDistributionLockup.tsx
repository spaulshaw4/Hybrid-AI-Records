export const PartnerDistributionLockup = () => {
  return (
    <div className="w-full flex flex-col items-center justify-center py-6 px-4 select-none">
      <div className="flex items-center justify-center gap-6 mb-3">
        <span className="text-xl md:text-2xl font-black tracking-tight text-white font-sans">
          Too Lost
        </span>
        <div className="h-6 w-px bg-white/20" />
        <div className="flex items-center gap-2.5">
          <img
            src="/assets/logos/bmg.svg"
            alt="BMG Global Publishing Administration"
            className="h-6 md:h-7 w-auto object-contain brightness-0 invert"
          />
          <span className="text-xl md:text-2xl font-extrabold tracking-wider text-white font-sans">
            BMG
          </span>
        </div>
      </div>
      <p className="text-xs md:text-sm font-medium text-blue-100/90 text-center tracking-wide">
        Global Distribution via Too Lost • Global Publishing Administration via BMG
      </p>
    </div>
  );
};
