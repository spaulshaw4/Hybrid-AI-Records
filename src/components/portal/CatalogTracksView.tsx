import { useState } from "react";

import { ArtistCatalog } from "@/routes/artists";

/** Portal catalog tab — the artist catalog page, with album selection kept local. */
export function CatalogTracksView() {
  const [album, setAlbum] = useState<string | undefined>();

  return (
    <ArtistCatalog
      embedded
      albumParam={album}
      onOpenAlbum={setAlbum}
      onBackToAlbums={() => setAlbum(undefined)}
    />
  );
}
