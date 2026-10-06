export type TemplateCategory =
  | "Trending"
  | "Pop"
  | "Hip-hop"
  | "Phonk"
  | "Trap"
  | "Drill"
  | "Electronic"
  | "Rock"
  | "R&B"
  | "Latin";
export interface TrackTemplate {
  id: string;
  category: TemplateCategory;
  title: string;
  subtitle: string;
  prompt: string;
  recommendedGender: "male" | "female";
  isInstrumentalDefault: boolean;
}
export const MUREKA_CATEGORIES: string[] = [
  "All",
  "Trending",
  "Pop",
  "Hip-hop",
  "Phonk",
  "Trap",
  "Drill",
  "Electronic",
  "Rock",
  "R&B",
  "Latin",
];
export const MUREKA_TEMPLATES: TrackTemplate[] = [
  // ==================== ROCK & COUNTRY ====================
  {
    id: "rock-grunge-acoustic",
    category: "Rock",
    title: "Heavy Grunge Acoustic",
    subtitle: "Aggressive rhythmic acoustic guitar with heavy post-grunge drive.",
    prompt:
      "90s post-grunge acoustic rock at 84 BPM, raw, heavy, driving. Open with 4 bars of aggressive, percussive acoustic guitar strumming on heavy gauge strings. Thick distorted bass enters locked with punchy rock drum kit. Gritty raspy male vocals, dynamic lift in the chorus with heavy cymbal crashes.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "nashville-neo-traditional-honky-tonk",
    category: "Rock",
    title: "Nashville Neo-Traditional Honky-Tonk",
    subtitle: "Dry acoustic guitar and distant pedal steel cross a lonely Texas range.",
    prompt:
      "Classic Nashville neo-traditional honky-tonk country at 86 BPM. Dry acoustic rhythm guitar, weeping pedal steel fills, warm walking electric bass, acoustic shuffle snare, soulful baritone male storytelling vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "texas-red-dirt-country-rock",
    category: "Rock",
    title: "Texas Red Dirt Country Rock",
    subtitle: "Fingerpicked guitar and a patient fiddle carry an Oklahoma story.",
    prompt:
      "Authentic Red Dirt country rock at 78 BPM. Fingerpicked steel-string acoustic guitar, weeping fiddle fills, upright bass, steady brushed drums, heartfelt weathered male storytelling vocals with natural room acoustic resonance.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "southern-swamp-rock",
    category: "Rock",
    title: "Southern Swamp Rock",
    subtitle: "Thick slide guitar, swampy groove, and raspy delivery.",
    prompt:
      "Gritty Southern swamp rock at 92 BPM. Resonator slide guitar riff over heavy foot-stomping rhythm, overdriven tube bass, unpolished raspy male lead vocals with soulful backing harmonies.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "high-voltage-riff-rock",
    category: "Rock",
    title: "High-Voltage Riff Rock",
    subtitle: "A dry blues riff, cracked snare and smoke-worn shout do the heavy lifting.",
    prompt:
      "Classic blues-infused hard rock at 120 BPM. Dry overdriven tube guitar riff, cracking live snare, thumping kick, punchy live bass, gritty smoke-worn male vocal belt with natural blues swagger.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "punk-rock",
    category: "Rock",
    title: "Punk Rock",
    subtitle: "Three chords, one shouted count-in and zero patience. Punk reaches the chorus first.",
    prompt:
      "Fast 90s skate punk rock at 165 BPM. Fast distorted power chords, blistering four-on-the-floor punk drums, aggressive driving bass, raw shouted male vocals with anthemic gang backing vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "british-twin-guitar-metal",
    category: "Rock",
    title: "British Twin-Guitar Metal",
    subtitle: "Machine-tight guitars and factory hits drive heavy industrial rock.",
    prompt:
      "Heavy metal at 138 BPM. Galloping synchronized twin-guitar harmonies, aggressive double-bass drumming, deep metal bass, commanding powerful male vocals with soaring sustain.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "japanese-pop-rock",
    category: "Rock",
    title: "Japanese Pop-Rock",
    subtitle: "Japanese pop-rock turns a husky confession into an explosive chorus.",
    prompt:
      "Dynamic J-Rock at 145 BPM. Intricate melodic electric guitar riffs, driving high-tempo drum fills, energetic bass, passionate husky male vocal delivery exploding into a soaring anthemic chorus.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "celtic-folk",
    category: "Rock",
    title: "Celtic Folk",
    subtitle: "A weathered voice carries a Celtic farewell across fiddle and drone.",
    prompt:
      "Traditional Celtic folk at 75 BPM. Acoustic guitar picking, evocative wooden flute, traditional fiddle drone, low bodhrán drum, weathered emotive male baritone lead.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "rock-workout-motivation",
    category: "Rock",
    title: "Rock Workout Motivation",
    subtitle: "For lifting something heavy and making it personal.",
    prompt:
      "High-energy modern hard rock at 135 BPM, aggressive, anthemic. Heavy live drum grooves, tight distorted bassline, driving rhythm guitars, energetic male vocal delivery designed for forward momentum.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  // ==================== LATIN & REGGAETON ====================
  {
    id: "colombian-afro-latin-pop",
    category: "Latin",
    title: "Colombian Afro-Latin Pop",
    subtitle: "Colombian Afro-pop drifts through dark dancehall and airy R&B. Warm vocals...",
    prompt:
      "Colombian Afro-Latin fusion at 100 BPM. Warm afrobeat log drums, subtle dancehall dembow pattern, bright nylon acoustic guitar chops, rich airy bilingual male vocals with smooth falsetto harmonies.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "dominican-urban-bachata",
    category: "Latin",
    title: "Dominican Urban Bachata",
    subtitle: "Urban bachata lets requinto guitar carry the heartbreak. The güira keeps it moving.",
    prompt:
      "Modern Dominican urban bachata at 128 BPM. Crisp rhythmic güira scraping, syncopated bongo rolls, melodic requinto lead guitar plucks, deep electric bass, passionate high-register male vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "sunny-cafe-bossa-nova",
    category: "Latin",
    title: "Sunny Cafe Bossa Nova",
    subtitle: "A café soundtrack with its sunglasses already on.",
    prompt:
      "Warm acoustic bossa nova at 110 BPM. Classic nylon-string acoustic guitar syncopation, soft brushed percussion, acoustic upright bass, warm gentle flute melody, instrumental relaxation.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "brazilian-brega-funk",
    category: "Latin",
    title: "Brazilian Brega Funk",
    subtitle: "Recife brega funk pairs a crooked beat with cheeky chants. Homemade energy.",
    prompt:
      "Recife brega funk at 140 BPM. Crooked metallic snare cadence, bouncing sub-bass, cheerful synth stabs, cheeky rhythmic Portuguese male vocal shouts and flow.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "mexican-corridos-tumbados",
    category: "Latin",
    title: "Mexican Corridos Tumbados",
    subtitle: "Romantic corrido tumbado lets guitars carry the ache. No drums, just a voice and requinto.",
    prompt:
      "Authentic Corridos Tumbados at 128 BPM in 3/4 time. Intricate requinto 12-string guitar leads, deep tololoche acoustic bass, rhythmic acoustic guitar strumming, raw emotive Mexican male vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "latin-style",
    category: "Latin",
    title: "Latin Style",
    subtitle: "Sunshine with a little side-eye.",
    prompt:
      "Acoustic Latin groove at 98 BPM. Fast intricate nylon-string guitar picking, cajón and percussion syncopation, warm bass guitar, melodic passionate male vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "puerto-rican-reggaeton-nocturno",
    category: "Latin",
    title: "Puerto Rican Reggaetón Nocturno",
    subtitle: "Midnight reggaeton built for dark rooms and low ceilings.",
    prompt:
      "Dark sensual reggaeton at 92 BPM. Classic dembow percussion groove, sub-heavy kick drum, atmospheric minor synth pads, smooth confident Spanish male vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  // ==================== POP ====================
  {
    id: "bedroom-pop",
    category: "Pop",
    title: "Bedroom Pop",
    subtitle: "Soft guitars and strings turn a bedroom confession into chamber pop. Feelings first.",
    prompt:
      "Intimate lo-fi bedroom pop at 82 BPM. Chorus-soaked clean Stratocaster riffs, delicate cassette tape saturation, soft chamber string quartet swells, whispery intimate male lead vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "c-pop-melody-rap",
    category: "Pop",
    title: "C-Pop × melody rap",
    subtitle: "Melodic Mandarin pop hooks woven seamlessly into modern trap flows.",
    prompt:
      "Modern Chinese melodic rap at 125 BPM. Plucked guzheng acoustic accents over warm 808 bass, crisp trap snare, emotive melodic singing hook transitioning to rapid rhythmic rap verses.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "c-pop",
    category: "Pop",
    title: "C-pop",
    subtitle: "Mandarin melodies lead a polished pop arrangement. The chorus knows exactly where to soar.",
    prompt:
      "Polished Chinese pop at 98 BPM. Pristine grand piano intro, lush acoustic rhythm guitars, sweeping orchestral strings, smooth heartfelt male vocals with clean studio polish.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "fun-lifestyle-podcast-intro",
    category: "Pop",
    title: "Fun Lifestyle Podcast Intro",
    subtitle: "Your podcast just arrived carrying a banjo and suspiciously good energy.",
    prompt:
      "Bouncy upbeat lifestyle theme at 118 BPM. Energetic fingerpicked banjo, sunny acoustic guitar strumming, stomping acoustic kick and handclaps, cheerful whistle melody, strictly instrumental.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "fresh-air-walk",
    category: "Pop",
    title: "Fresh Air Walk",
    subtitle: "Clean morning strides with bright acoustic guitars and easy rhythm.",
    prompt:
      "Sunny acoustic daytime pop at 108 BPM. Crisp steel-string guitar strums, cheerful glockenspiel notes, warm bassline, light wooden percussion, uplifting instrumental groove.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "confidence-boost",
    category: "Pop",
    title: "Confidence Boost",
    subtitle: "Posture corrected, outfit approved, unnecessary apology cancelled.",
    prompt:
      "Empowering energetic modern pop at 120 BPM. Punchy synth bass, driving claps, disco-funk electric guitar licks, charismatic assertive female vocals with punchy attitude.",
    recommendedGender: "female",
    isInstrumentalDefault: false,
  },
  {
    id: "acoustic-singer-songwriter-pop",
    category: "Pop",
    title: "Acoustic Singer-Songwriter Pop",
    subtitle: "One guitar, one storyteller, and nowhere for the truth to hide. Folk keeps it honest.",
    prompt:
      "Intimate acoustic folk-pop at 74 BPM. Dynamic steel-string fingerpicking, subtle room reverb, warm acoustic bass, honest expressive male vocal delivery with close-mic warmth.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "golden-hour-road-trip",
    category: "Pop",
    title: "Golden Hour Road Trip",
    subtitle: "Sunlit pop for open roads and bad navigation. Every wrong turn gets a soundtrack.",
    prompt:
      "Uplifting sunlit acoustic pop at 116 BPM. Bright acoustic strumming, live bass warmth, modern kick and claps, bright melodic male vocal hook designed for summer driving.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "romantic-wedding-duet",
    category: "Pop",
    title: "Romantic Wedding Duet",
    subtitle: "Two verses, two voices, one very expensive seating chart.",
    prompt:
      "Heartfelt acoustic orchestral ballad at 68 BPM. Grand piano arpeggio, delicate string quartet swells, intimate acoustic guitar, sweet male and female vocal harmonies.",
    recommendedGender: "female",
    isInstrumentalDefault: false,
  },
  {
    id: "main-character-glow",
    category: "Pop",
    title: "Main Character Glow",
    subtitle: "Outfit changed, camera turned, confidence successfully located.",
    prompt:
      "Upbeat confident pop at 118 BPM. Slinky bassline, crisp snapping drums, disco rhythm guitar chucks, charismatic playful female vocals.",
    recommendedGender: "female",
    isInstrumentalDefault: false,
  },
  // ==================== HIP-HOP, TRAP & DRILL ====================
  {
    id: "girl-crush-hip-hop",
    category: "Hip-hop",
    title: "Girl-Crush Hip-Hop",
    subtitle: "Girl-crush hip-hop pairs a husky rap with airy R&B. Confidence owns the room.",
    prompt:
      "Heavy modern girl-crush hip-hop at 104 BPM. Punchy compressed drums, distorted 808 glide, moody synth stabs, husky female rap verses transitioning to soaring airy R&B vocals.",
    recommendedGender: "female",
    isInstrumentalDefault: false,
  },
  {
    id: "gangsta-rap",
    category: "Hip-hop",
    title: "Gangsta Rap",
    subtitle: "Gangsta rap delivers street reports over hard drums and turntable cuts. No filter.",
    prompt:
      "90s West Coast gangsta rap at 92 BPM. Heavy boom-bap kick, crisp snare, rhythmic vinyl scratch cuts, deep funk bassline, confident raw male rap delivery with commanding cadence.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "brooklyn-drill",
    category: "Drill",
    title: "Brooklyn Drill",
    subtitle: "Brooklyn Drill stalks off-grid kicks and sliding 808s. A gravel voice keeps the pace.",
    prompt:
      "Dark UK/Brooklyn drill at 142 BPM. Sliding pitch-bent 808 sub bass, stuttering off-grid hi-hats, dark minor piano chops, cold gritty male drill flow with heavy presence.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "atlanta-trap",
    category: "Trap",
    title: "Atlanta Trap",
    subtitle: "Atlanta Trap makes dark space feel expensive with long 808s and clipped hats.",
    prompt:
      "Dark Atlanta trap at 140 BPM. Bell-like synth arpeggios drenched in cavernous reverb, rolling long-decay 808 sub bass, fast triplet hi-hat rolls, confident melodic trap vocal delivery.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "east-coast-boom-bap",
    category: "Hip-hop",
    title: "East Coast Boom Bap",
    subtitle: "Dense rhymes over vintage chops and hard snare.",
    prompt:
      "Classic East Coast boom bap at 90 BPM. Vinyl jazz chops, warm upright bassline, sharp acoustic snare, rhythmic and articulate male vocal delivery with pocket groove.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "technical-rap",
    category: "Hip-hop",
    title: "Technical Rap",
    subtitle: "Technical rap shifts through rhyme chains without losing a word. Speed serves the bars.",
    prompt:
      "Fast intricate underground hip-hop at 105 BPM. Punchy acoustic drums, walking acoustic bass, sharp brass hits, rapid-fire articulate male lyrical delivery.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "melodic-rap",
    category: "Hip-hop",
    title: "Melodic Rap",
    subtitle: "Melodic rap melts clipped verses into woozy hooks and ghost vocals. Even the beat sighs.",
    prompt:
      "Smooth melodic trap at 130 BPM. Plucked acoustic guitar loop, soft sliding 808 bass, airy background vocal harmonies, autotuned emotional male singing and rapping.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "emo-rap",
    category: "Hip-hop",
    title: "Emo Rap",
    subtitle: "Emo rap turns private damage into a hook for the walk home. It hurts first and plays forever.",
    prompt:
      "Emotional alternative rap at 124 BPM. Clean electric guitar arpeggios, sad trap 808 bounce, heartfelt vulnerable male vocals blending sung melody with rap cadences.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  // ==================== PHONK ====================
  {
    id: "brazilian-phonk",
    category: "Phonk",
    title: "Brazilian Phonk",
    subtitle: "Cute villain, catastrophic bass.",
    prompt:
      "Aggressive Brazilian Phonk at 130 BPM. Heavily distorted 808 cowbell leads, catastrophic sub-bass slides, syncopated funk carioca drums, punchy distorted transients, energetic vocal chops.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "dark-anime-brazilian-phonk",
    category: "Phonk",
    title: "Dark Anime Brazilian Phonk",
    subtitle: "Cute villain vocals meet brutal Brazilian phonk. The arcade boss just took over.",
    prompt:
      "High-octane Dark Anime Phonk at 135 BPM. Piercing pitch-shifted female vocal chops over brutal Brazilian automotivo basslines, frantic distorted cowbells, heavy clipping sub drops.",
    recommendedGender: "female",
    isInstrumentalDefault: false,
  },
  {
    id: "automotivo-brazilian-phonk",
    category: "Phonk",
    title: "Automotivo Brazilian Phonk",
    subtitle: "Brazilian street funk meets heavy automotivo bass. Even parked cars shake.",
    prompt:
      "Brutal automotivo street phonk at 132 BPM. Wall-shaking square-wave sub bass, raw acoustic rimshots, minimal hypnotic percussion, aggressive male favela vocal chants.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  // ==================== ELECTRONIC & LO-FI ====================
  {
    id: "lofi-study-beats",
    category: "Electronic",
    title: "Lo-fi Study Beats",
    subtitle: "The assignment is still due, but at least the room sounds organized.",
    prompt:
      "Chill relaxed lo-fi hip hop at 76 BPM. Warm Rhodes electric piano chords, soft vinyl warmth, mellow sub bass, lazy swing drum beat, strictly instrumental.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "healing-piano-and-ambient",
    category: "Electronic",
    title: "Healing Piano and Ambient",
    subtitle: "Gentle piano with no emotional ambush waiting in the chorus.",
    prompt:
      "Meditative ambient felt piano at 60 BPM. Soft warm piano voicings drenched in lush algorithmic reverb, gentle evolving warm pads, zero percussion, soothing healing music.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "deep-focus-ambient-bgm",
    category: "Electronic",
    title: "Deep Focus Ambient BGM",
    subtitle: "Keeps the brain awake without asking it to applaud.",
    prompt:
      "Minimal electronic study beat at 80 BPM. Warm vintage electric piano chords, soft tape saturation, gentle sub-bass, unquantized laid-back drum groove, instrumental only.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "deep-house-relax",
    category: "Electronic",
    title: "Deep House Relax",
    subtitle: "Warm deep house keeps the floor moving without festival drama. The bass breathes.",
    prompt:
      "Warm melodic deep house at 122 BPM. Lush filtered organ chords, sub-heavy four-on-the-floor kick, subtle open hi-hat swing, warm round synth bassline, strictly instrumental.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "vhs-memories-of-tomorrow",
    category: "Electronic",
    title: "VHS Memories of Tomorrow",
    subtitle: "A future memory recorded on VHS, all synth haze and soft neon. Nostalgia on repeat.",
    prompt:
      "80s synthwave dream at 105 BPM. Analogue Juno synthesizer pads, gated reverb snare hits, pulsing arpeggiated bassline, warm nostalgic tape saturation, instrumental only.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "coding-electronic-bgm",
    category: "Electronic",
    title: "Coding Electronic BGM",
    subtitle: "Four-on-the-floor focus for when the code finally starts cooperating.",
    prompt:
      "Progressive minimal electronic at 124 BPM. Clean four-on-the-floor kick drum, subtle modular synth blips, warm rolling bassline, zero distracting vocals, pure focus BGM.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  // ==================== R&B ====================
  {
    id: "soul-feel",
    category: "R&B",
    title: "Soul Feel",
    subtitle: "Soft lights, honest feelings and a singer who knows when not to oversing.",
    prompt:
      "Late-night contemporary R&B at 74 BPM. Mellow Rhodes electric piano, deep 808 warmth, tight rimshot groove, soulful nuanced male vocals with gentle runs.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "midnight-heartbreak",
    category: "R&B",
    title: "Midnight Heartbreak",
    subtitle: "For the ride home after the conversation you've already replayed three times.",
    prompt:
      "Mood-drenched slow R&B at 66 BPM. Dark filtered synth pads, deep sub kick, sparse finger snaps, melancholic falsetto male vocals drenched in plate reverb.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "disco-funk-pop",
    category: "R&B",
    title: "Disco-Funk Pop",
    subtitle: "Elastic bass and smoky vocals give disco-funk a slow strut. The mirror ball turns.",
    prompt:
      "Groovy disco funk at 114 BPM. Slap bassline with elastic bounce, rhythmic rhythm guitar chucks, four-on-the-floor disco kick, smooth smoky male vocals.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  // ==================== TRENDING ====================
  {
    id: "dark-rival-character-theme",
    category: "Trending",
    title: "Dark Rival Character Theme",
    subtitle: "Not the villain—just the hero with a much worse coping strategy.",
    prompt:
      "Dark cinematic rock hybrid at 110 BPM. Low distorted cello ostinato, heavy industrial synth bass, driving acoustic-electronic hybrid percussion, brooding baritone vocals with aggressive dynamic rise.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "allow-yourself-to-cry",
    category: "Trending",
    title: "Allow Yourself to Cry",
    subtitle: "Let it out. Even your mascara deserves an honest day off.",
    prompt:
      "Intimate emotional piano ballad at 65 BPM. Warm grand piano chords, delicate cello countermelody, soft room acoustics, vulnerable raw male vocal delivery that swells in the bridge.",
    recommendedGender: "male",
    isInstrumentalDefault: false,
  },
  {
    id: "cozy-coffee-shop-jazz",
    category: "Trending",
    title: "Cozy Coffee Shop Jazz",
    subtitle: "Coffee-shop jazz that knows how to stay in the background.",
    prompt:
      "Intimate coffee shop jazz trio at 72 BPM. Upright acoustic bass, brushed snare drums, gentle grand piano chords, warm room acoustics, strictly instrumental.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
  {
    id: "anxiety-reset",
    category: "Trending",
    title: "Anxiety Reset",
    subtitle: "A soft reboot for an overloaded brain.",
    prompt:
      "Deep ambient soundscape at 60 BPM. Warm analog synthesizer drone, gentle ocean-wave white noise, soft 432Hz sine tone pulses, zero beats, deeply calming meditation music.",
    recommendedGender: "male",
    isInstrumentalDefault: true,
  },
];

