import { TooLostError } from "@/lib/too-lost/errors";
import type {
  DeliveryWrite,
  DraftReleaseInput,
  Release,
  ReleaseList,
  SubmitWrite,
  TrackWrite,
  UploadTarget,
} from "@/lib/too-lost/types";

interface MockStore {
  seq: number;
  trackSeq: number;
  releases: Release[];
}

const globalStore = globalThis as typeof globalThis & { __tooLostMock?: MockStore };

function store(): MockStore {
  if (!globalStore.__tooLostMock) {
    globalStore.__tooLostMock = { seq: 1000, trackSeq: 5000, releases: seed() };
  }
  return globalStore.__tooLostMock;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function touch(release: Release): Release {
  release.updatedAt = new Date().toISOString();
  return release;
}

function requireRelease(id: number): Release {
  const release = store().releases.find((item) => item.id === id);
  if (!release) throw new TooLostError("Release not found.", 404);
  return release;
}

export class MockTooLostClient {
  async listReleases(status?: string, page = 1, perPage = 20): Promise<ReleaseList> {
    const filtered = store()
      .releases.filter((release) => (status ? release.status === status : true))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const start = (page - 1) * perPage;
    return {
      data: clone(filtered.slice(start, start + perPage)),
      totalItems: filtered.length,
    };
  }

  async getRelease(releaseId: number): Promise<{ data: Release }> {
    return { data: clone(requireRelease(releaseId)) };
  }

  async createDraftRelease(payload: DraftReleaseInput): Promise<{ data: Release }> {
    const current = store();
    const release: Release = touch({
      id: ++current.seq,
      title: payload.title,
      type: payload.type,
      label: payload.label,
      upc: payload.upc,
      status: "draft",
      participants: payload.participants,
      tracks: [],
    });
    current.releases.unshift(release);
    return { data: clone(release) };
  }

  async validateUpc(upc: string): Promise<void> {
    if (upc === "000000000000") throw new TooLostError("UPC is not valid.", 422);
  }

  async validateIsrc(isrc: string): Promise<void> {
    if (isrc.endsWith("0000000")) throw new TooLostError("ISRC is not valid.", 422);
  }

  async getArtworkUploadUrl(
    releaseId: number,
    fileName: string,
    _contentType: "image/jpeg" | "image/png",
  ): Promise<{ data: UploadTarget }> {
    requireRelease(releaseId);
    return {
      data: {
        uploadUrl: "/api/mock/upload",
        fileKey: `covers/${releaseId}/${fileName}`,
        headers: { "x-mock-upload": "1" },
      },
    };
  }

  async getTrackUploadUrl(
    releaseId: number,
    fileName: string,
    _contentType: string,
    _kind: "audio",
  ): Promise<{ data: UploadTarget }> {
    requireRelease(releaseId);
    return {
      data: {
        uploadUrl: "/api/mock/upload",
        fileKey: `audio/${releaseId}/${fileName}`,
        headers: { "x-mock-upload": "1" },
      },
    };
  }

  async updateMetadata(releaseId: number, metadata: Record<string, unknown>): Promise<{ data: Release }> {
    if (metadata.coverFileKey && metadata.coverUrl) {
      throw new TooLostError("Send coverFileKey or coverUrl, never both.", 422);
    }
    const release = requireRelease(releaseId);
    if (typeof metadata.title === "string") release.title = metadata.title;
    if (metadata.type === "Single" || metadata.type === "EP" || metadata.type === "Album") {
      release.type = metadata.type;
    }
    if (typeof metadata.label === "string") release.label = metadata.label;
    if (typeof metadata.upc === "string") release.upc = metadata.upc;
    if (Array.isArray(metadata.participants)) {
      release.participants = metadata.participants as Release["participants"];
    }
    if (typeof metadata.coverFileKey === "string") {
      release.coverFileKey = metadata.coverFileKey;
      delete release.coverUrl;
    }
    return { data: clone(touch(release)) };
  }

  async setTracklist(releaseId: number, tracks: TrackWrite[]): Promise<{ data: Release }> {
    const release = requireRelease(releaseId);
    const current = store();
    release.tracks = tracks.map((track) => ({
      ...track,
      id: ++current.trackSeq,
    }));
    return { data: clone(touch(release)) };
  }

  async updateDelivery(releaseId: number, delivery: DeliveryWrite): Promise<{ data: Release }> {
    const release = requireRelease(releaseId);
    release.delivery = delivery;
    return { data: clone(touch(release)) };
  }

  async submitRelease(
    releaseId: number,
    _payload: SubmitWrite,
  ): Promise<{ data: Release; message: string }> {
    const release = requireRelease(releaseId);
    if (release.status !== "draft") {
      throw new TooLostError("Only a draft can be submitted.", 409);
    }
    release.status = "in_review";
    return {
      data: clone(touch(release)),
      message: "Release submitted for review.",
    };
  }
}

function seed(): Release[] {
  return [
    {
      id: 101,
      title: "Northline",
      type: "Album",
      label: "Harbor & Co",
      status: "live",
      upc: "123456789012",
      participants: [{ name: "Ada Voss", role: ["primary"] }],
      coverFileKey: "covers/northline.jpg",
      tracks: [
        {
          id: 1,
          title: "Northline",
          language: "en",
          audioFileKey: "audio/northline.flac",
          tiktokStartTime: "00:30",
          lyrics: { explicit: false },
          artists: [{ name: "Ada Voss", role: ["primary"] }],
          writers: [
            { name: "Ada Voss", role: ["instrumentalist"] },
            { name: "Ada Voss", role: ["lyricist"] },
          ],
        },
      ],
      delivery: {
        platforms: ["Spotify", "Apple Music", "Amazon Music"],
        territories: ["worldwide"],
        additional: { youtube: true },
      },
      updatedAt: "2026-09-02T15:00:00.000Z",
    },
    {
      id: 102,
      title: "Glass Harbor",
      type: "Single",
      label: "Harbor & Co",
      status: "in_review",
      participants: [{ name: "Mina Cho", role: ["primary"] }],
      coverFileKey: "covers/glass-harbor.jpg",
      tracks: [
        {
          id: 2,
          title: "Glass Harbor",
          language: "en",
          audioFileKey: "audio/glass-harbor.wav",
          tiktokStartTime: "00:15",
          lyrics: { explicit: false },
          artists: [{ name: "Mina Cho", role: ["primary"] }],
          writers: [
            { name: "Mina Cho", role: ["instrumentalist"] },
            { name: "Noah Pell", role: ["lyricist"] },
          ],
        },
      ],
      delivery: {
        platforms: ["Spotify", "Apple Music", "YouTube Music", "Tidal"],
        territories: ["worldwide"],
        additional: { youtube: true },
      },
      updatedAt: "2026-09-18T11:00:00.000Z",
    },
    {
      id: 103,
      title: "Paper Boats",
      type: "Single",
      status: "draft",
      participants: [{ name: "Leo March", role: ["primary"] }],
      tracks: [],
      updatedAt: "2026-09-28T09:00:00.000Z",
    },
    {
      id: 104,
      title: "Red Room",
      type: "EP",
      status: "takedown_pending",
      participants: [{ name: "Ada Voss", role: ["primary"] }],
      coverFileKey: "covers/red-room.jpg",
      tracks: [
        {
          id: 3,
          title: "Red Room",
          language: "en",
          audioFileKey: "audio/red-room.flac",
          tiktokStartTime: "00:45",
          lyrics: { explicit: true },
          artists: [{ name: "Ada Voss", role: ["primary"] }],
          writers: [
            { name: "Ada Voss", role: ["instrumentalist"] },
            { name: "Ada Voss", role: ["lyricist"] },
          ],
        },
      ],
      delivery: {
        platforms: ["Spotify", "Deezer"],
        territories: ["worldwide"],
        additional: { youtube: false },
      },
      updatedAt: "2026-08-14T09:00:00.000Z",
    },
    {
      id: 105,
      title: "Low Tide",
      type: "EP",
      label: "March Records",
      status: "draft",
      participants: [{ name: "Leo March", role: ["primary"] }],
      coverFileKey: "covers/low-tide.jpg",
      tracks: [
        {
          id: 4,
          title: "Keel",
          language: "en",
          audioFileKey: "audio/keel.flac",
          tiktokStartTime: "01:05",
          lyrics: { explicit: false },
          artists: [{ name: "Leo March", role: ["primary"] }],
          writers: [
            { name: "Leo March", role: ["instrumentalist"] },
            { name: "Inez March", role: ["lyricist"] },
          ],
        },
      ],
      updatedAt: "2026-10-01T16:30:00.000Z",
    },
  ];
}
