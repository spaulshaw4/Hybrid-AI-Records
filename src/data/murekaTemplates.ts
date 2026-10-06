export interface TrackTemplate {
  id: string;
  category: "Trending" | "Rock" | "Hip-hop" | "Electronic" | "R&B" | "Pop" | "Latin";
  title: string;
  subtitle: string;
  prompt: string;
  recommendedGender: "male" | "female";
  isInstrumentalDefault: boolean;
}

export const MUREKA_TEMPLATES: TrackTemplate[] = [
  {
    id: "rock-grunge-acoustic",
    category: "Rock",
    title: "Heavy Grunge Acoustic",
    subtitle: "Aggressive rhythmic acoustic guitar with heavy post-grunge drive.",
    prompt:
      "90s post-grunge heavy acoustic rock at 84 BPM, raw, heavy, driving. Open with aggressive percussive acoustic guitar strumming on heavy gauge strings. Thick distorted bass enters locked with a punchy rock drum kit. Gritty raspy male vocals, dynamic lift in the chorus with heavy cymbal crashes and driving acoustic rhythm.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "oklahoma-red-dirt",
    category: "Rock",
    title: "Oklahoma Red Dirt",
    subtitle: "Fingerpicked steel-string acoustic with reflective storytelling.",
    prompt:
      "Slow Oklahoma Red Dirt folk ballad at 76 BPM, lyrical, reflective and expansive. Open with 2 bars of fingerpicked steel-string acoustic guitar using open chords and ringing upper strings; lead vocal enters after bar 2. Gentle bass warmth, no heavy drums, intimate male vocal with natural room reverb.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "rock-workout",
    category: "Rock",
    title: "Rock Workout Motivation",
    subtitle: "For lifting something heavy and making it personal.",
    prompt:
      "High-energy modern hard rock at 135 BPM, aggressive, anthemic. Punchy live drum grooves, tight distorted bassline, driving rhythm guitars, energetic male vocal delivery designed for forward momentum.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "southern-rock-swamp",
    category: "Rock",
    title: "Southern Swamp Rock",
    subtitle: "Thick slide guitar, swampy groove, and raspy delivery.",
    prompt:
      "Gritty Southern rock at 92 BPM, swampy, driving groove. Resonator slide guitar riff over a heavy foot-stomping rhythm, overdriven tube bass, unpolished raspy male lead vocals with soulful backing harmonies.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "deep-focus-bgm",
    category: "Electronic",
    title: "Deep Focus Ambient BGM",
    subtitle: "Keeps the brain awake without asking it to applaud.",
    prompt:
      "Chill ambient study beat at 80 BPM, warm vintage electric piano chords, soft side-chained tape warmth, gentle sub-bass, unquantized laid-back drum groove, instrumental only.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "east-coast-boom-bap",
    category: "Hip-hop",
    title: "East Coast Boom Bap",
    subtitle: "Dense rhymes over vintage chops and hard snare.",
    prompt:
      "Classic East Coast boom bap at 90 BPM. Gritty vinyl jazz chops, warm upright bassline, sharp acoustic snare, rhythmic and articulate male vocal delivery with pocket groove.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "cozy-coffee-shop",
    category: "Trending",
    title: "Cozy Coffee Shop Jazz",
    subtitle: "Piano jazz that knows how to stay in the background.",
    prompt:
      "Intimate coffee shop jazz trio at 72 BPM. Upright acoustic bass, brushed snare drums, gentle grand piano chords, warm room acoustics, strictly instrumental.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "soul-feel",
    category: "R&B",
    title: "Soul Feel",
    subtitle: "Soft lights, honest feelings, and an expressive singer.",
    prompt:
      "Late-night contemporary R&B at 74 BPM. Mellow Rhodes keys, warm 808 bass, tight rimshot groove, soulful dynamic male vocal with falsetto runs in the bridge.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
];
