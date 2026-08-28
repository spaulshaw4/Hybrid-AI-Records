// src/components/TransmissionMixer.tsx
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface TransmissionMixerProps {
  sessionId: string;
}

export default function TransmissionMixer({ sessionId }: TransmissionMixerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volumes, setVolumes] = useState({
    drums: 0.9,
    bass: 0.9,
    melody: 0.8,
    vocal: 0.95,
    master: 1.0,
  });

  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  useEffect(() => {
    async function fetchStemUrls() {
      const stems = ['drums', 'bass', 'melody', 'vocal', 'MASTER_SUM'];
      const urls: Record<string, string> = {};

      for (const stem of stems) {
        const filePath = `user_vaults/${sessionId}/${sessionId}_${
          stem === 'MASTER_SUM' ? 'MASTER_SUM' : 'processed_' + stem
        }.wav`;

        // Generate 1-hour signed URL for each stem
        const { data: signedData } = await supabase.storage
          .from('audio-vault')
          .createSignedUrl(filePath, 3600);

        if (signedData?.signedUrl) {
          urls[stem] = signedData.signedUrl;
        }
      }

      setAudioUrls(urls);
    }

    fetchStemUrls();
  }, [sessionId]);

  const handleVolumeChange = (stem: keyof typeof volumes, value: number) => {
    setVolumes((prev) => ({ ...prev, [stem]: value }));
    if (audioRefs.current[stem]) {
      audioRefs.current[stem]!.volume = value * volumes.master;
    }
  };

  const togglePlayAll = () => {
    if (isPlaying) {
      Object.values(audioRefs.current).forEach((audio) => audio?.pause());
      setIsPlaying(false);
    } else {
      Object.values(audioRefs.current).forEach((audio) => {
        if (audio) {
          audio.currentTime = 0;
          audio.play().catch((err) => console.log('Playback error:', err));
        }
      });
      setIsPlaying(true);
    }
  };

  return (
    <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl shadow-xl space-y-6">
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h2 className="text-lg font-black tracking-widest text-white">
            TRANSMISSION STEM MIXER
          </h2>
          <p className="text-xs text-gray-400 font-mono">Session: {sessionId}</p>
        </div>
        <button
          onClick={togglePlayAll}
          className={`px-6 py-2 rounded-xl font-bold uppercase tracking-wider text-xs transition-all ${
            isPlaying
              ? 'bg-amber-600 hover:bg-amber-700 text-white'
              : 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-600/30'
          }`}
        >
          {isPlaying ? 'Pause All Stems' : 'Play Synced Master'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Object.keys(volumes).map((stem) => {
          if (stem === 'master') return null;
          return (
            <div
              key={stem}
              className="p-4 bg-gray-950 border border-gray-800 rounded-xl space-y-3"
            >
              <div className="flex justify-between text-xs font-mono uppercase text-gray-300">
                <span>{stem}</span>
                <span>{Math.round(volumes[stem as keyof typeof volumes] * 100)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volumes[stem as keyof typeof volumes]}
                onChange={(e) =>
                  handleVolumeChange(stem as keyof typeof volumes, Number(e.target.value))
                }
                className="w-full accent-red-600 cursor-pointer"
              />
              {audioUrls[stem] && (
                <audio
                  ref={(el) => {
                    audioRefs.current[stem] = el;
                  }}
                  src={audioUrls[stem]}
                  preload="auto"
                  loop
                />
              )}
            </div>
          );
        })}
      </div>

      {audioUrls['MASTER_SUM'] && (
        <div className="p-4 bg-gray-950 border border-gray-800 rounded-xl flex items-center justify-between">
          <span className="text-xs font-mono uppercase text-gray-400">
            Master Summed Bus Stream
          </span>
          <audio
            ref={(el) => {
              audioRefs.current['master'] = el;
            }}
            src={audioUrls['MASTER_SUM']}
            controls
            className="w-2/3"
          />
        </div>
      )}
    </div>
  );
}
