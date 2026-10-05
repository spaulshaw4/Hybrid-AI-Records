import { createFileRoute } from "@tanstack/react-router";

import MurekaStudio from "@/components/MurekaStudio";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/simple-studio")({
  errorComponent: RouteErrorFallback,
  component: SimpleStudioPage,
});

function SimpleStudioPage() {
  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <MurekaStudio />
    </main>
  );
}
