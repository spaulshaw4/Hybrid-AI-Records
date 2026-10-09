export function Footer() {
  return (
    <footer className="w-full px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-3">
        <div className="flex items-center gap-6">
          <img
            src="/assets/logos/too-lost.svg"
            alt="Too Lost"
            className="h-6 w-auto object-contain brightness-0 invert"
          />
          <div className="h-4 w-px bg-zinc-700" />
          <img
            src="/assets/logos/bmg.svg"
            alt="BMG"
            className="h-6 w-auto object-contain brightness-0 invert"
          />
        </div>
        <p className="text-center text-[11px] text-zinc-500">
          Global Distribution via Too Lost • Global Publishing Administration via BMG
        </p>
      </div>
    </footer>
  );
}
