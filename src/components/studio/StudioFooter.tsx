export function StudioFooter() {
  return (
    <footer className="footer w-full mt-12 pt-6 pb-8 border-t border-zinc-900 bg-transparent text-zinc-500 text-xs">
      <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-center sm:text-start">
          © 2026 Hybrid AI Records LLC.
          <span className="mt-1 block">All Master Rights & Publishing Administered. All Rights Reserved.</span>
        </p>
        <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:justify-end">
          <a href="/licensing">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/licensing">Licensing & Ownership</a>
        </nav>
      </div>
    </footer>
  );
}
