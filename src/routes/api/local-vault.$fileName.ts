import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/local-vault/$fileName")({
  server: {
    handlers: {
      GET: handleGet,
    },
  },
});

async function handleGet({ params }: { params: { fileName: string } }): Promise<Response> {
  const { readLocalAudioFile } = await import("@/lib/local-vault.server");
  const file = await readLocalAudioFile(params.fileName ?? "");
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, max-age=3600",
    },
  });
}
