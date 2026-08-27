import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";

export interface StemUrls {
  drums?: string;
  bass?: string;
  vocals?: string;
  other?: string;
}

const STEM_TYPES = ["drums", "bass", "vocals", "other"] as const;

export function useStemMixer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [volumes, setVolumes] = useState<Record<string, number>>({
    drums: 0,
    bass: 0,
    vocals: 0,
    other: 0,
  });
  const [mutes, setMutes] = useState<Record<string, boolean>>({
    drums: false,
    bass: false,
    vocals: false,
    other: false,
  });
  const playersRef = useRef<Record<string, Tone.Player>>({});
  const gainsRef = useRef<Record<string, Tone.Gain>>({});
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;

  const disposeNodes = () => {
    Object.values(playersRef.current).forEach((player) => player.dispose());
    Object.values(gainsRef.current).forEach((gain) => gain.dispose());
    playersRef.current = {};
    gainsRef.current = {};
  };

  const loadStems = async (stemUrls: StemUrls) => {
    setIsLoaded(false);
    setIsPlaying(false);
    Tone.Transport.stop();
    await Tone.start();

    disposeNodes();

    const loadPromises = Object.entries(stemUrls).map(([stemType, url]) => {
      if (!url) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const gainNode = new Tone.Gain(1).toDestination();
        const player = new Tone.Player({
          url,
          loop: true,
          onload: () => resolve(),
          onerror: (error) => reject(error instanceof Error ? error : new Error(String(error))),
        }).connect(gainNode);
        player.sync().start(0);
        playersRef.current[stemType] = player;
        gainsRef.current[stemType] = gainNode;
      });
    });

    await Promise.all(loadPromises);
    setIsLoaded(true);
  };

  const togglePlayback = async () => {
    if (!isLoaded) return;
    if (Tone.Transport.state === "started") {
      Tone.Transport.pause();
      setIsPlaying(false);
    } else {
      await Tone.start();
      Tone.Transport.start();
      setIsPlaying(true);
    }
  };

  const setStemVolume = (stemType: string, valInDb: number) => {
    setVolumes((prev) => ({ ...prev, [stemType]: valInDb }));
    if (gainsRef.current[stemType] && !mutes[stemType]) {
      gainsRef.current[stemType].gain.value = Tone.dbToGain(valInDb);
    }
  };

  const toggleMute = (stemType: string) => {
    setMutes((prev) => {
      const nextState = !prev[stemType];
      if (gainsRef.current[stemType]) {
        gainsRef.current[stemType].gain.value = nextState
          ? 0
          : Tone.dbToGain(volumesRef.current[stemType] || 0);
      }
      return { ...prev, [stemType]: nextState };
    });
  };

  useEffect(() => {
    return () => {
      Tone.Transport.stop();
      disposeNodes();
    };
  }, []);

  return {
    isLoaded,
    isPlaying,
    volumes,
    mutes,
    stemTypes: STEM_TYPES,
    loadStems,
    togglePlayback,
    setStemVolume,
    toggleMute,
  };
}
