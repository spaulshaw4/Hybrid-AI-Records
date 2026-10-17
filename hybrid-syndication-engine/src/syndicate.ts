import { TrackPayload } from "./types";
import { notifyWebSubHub } from "./layer1-indexing/websub";
import {
  generateAlbumJsonLd,
  generateLyricsJsonLd,
  generateStemsJsonLd,
  generateTrackJsonLd,
} from "./layer2-metadata/jsonld";
import { generateOpenGraphTags } from "./layer2-metadata/opengraph";
import { buildMRSSFeed } from "./layer3-feeds/mrss-builder";
import { buildRadioDirectoryDescriptor, RadioDirectoryDescriptor } from "./layer4-radio/directory";
import { buildShortformClipRequest, ShortformClipRequest } from "./layer5-shortform/clip";
import { buildReleaseUrls, ReleaseUrls } from "./urls";

export interface SyndicationResult {
  urls: ReleaseUrls;
  jsonLd: {
    album: ReturnType<typeof generateAlbumJsonLd>;
    track: ReturnType<typeof generateTrackJsonLd>;
    lyrics: ReturnType<typeof generateLyricsJsonLd>;
    stems: ReturnType<typeof generateStemsJsonLd>;
  };
  openGraph: string;
  mrss: string;
  radio: RadioDirectoryDescriptor;
  clip: ShortformClipRequest;
  webSub: boolean;
}

export async function syndicateRelease(track: TrackPayload): Promise<SyndicationResult> {
  const urls = buildReleaseUrls(track);
  const jsonLd = {
    album: generateAlbumJsonLd(track, urls.album, urls.track),
    track: generateTrackJsonLd(track, urls.track),
    lyrics: generateLyricsJsonLd(track, urls.lyrics),
    stems: generateStemsJsonLd(track, urls.stems),
  };
  const openGraph = generateOpenGraphTags(track, urls.track);
  const mrss = buildMRSSFeed([track]);
  const radio = buildRadioDirectoryDescriptor(track);
  const clip = buildShortformClipRequest(track, urls.track);

  console.log("[Syndicate] Local URL family:");
  console.log(urls.album);
  console.log(urls.track);
  console.log(urls.lyrics);
  console.log(urls.stems);

  const webSub = await notifyWebSubHub(radio.feedUrl);

  return {
    urls,
    jsonLd,
    openGraph,
    mrss,
    radio,
    clip,
    webSub,
  };
}
