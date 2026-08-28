// src/components/HybridStemMixer.tsx (Updated for Supabase Cloud Streaming)
'use client';

import React, { useRef, useState } from 'react';

interface HybridStemMixerProps {
  sessionId: string;
}

export default function HybridStemMixer({ sessionId }: HybridStemMixerProps) {
  const stems = ['percussion_kick', 'bass_engine', 'mid_melody', 'vocal_lead'];
  const audioRefs = useRef<{ [key: string]: HTMLAudioElement | null }>({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [volumes, setVolumes] = useState<{ [key: string]: number }>({
    percussion_kick: 0.8,
    bass_engine: 0.8,
    mid_melody: 0.8,
    vocal_lead: 0.9,
  });

  const togglePlayMaster = () => {
    const playState = !isPlaying;
    setIsPlaying(playState);

    stems.forEach((stem) => {
      const audio = audioRefs.current[stem];
      if (audio) {
        if (playState) {
          audio.currentTime = 0;
          audio.play().catch((e) => console.log('Playback error:', e));
        } else {
          audio.pause();
        }
      }
    });
  };

  const handleVolumeChange = (stem: string, value: string) => {
    const newVol = parseFloat(value);
    setVolumes((prev) => ({ ...prev, [stem]: newVol }));
    const audio = audioRefs.current[stem];
    if (audio) {
      audio.volume = newVol;
    }
  };

  const downloadStem = (stemName: string) => {
    const url = `/api/vault/stream/${sessionId}/${sessionId}_stem_${stemName}.wav`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sessionId}_stem_${stemName}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="bg-gray-900 p-8 rounded-xl text-white max-w-3xl mx-auto shadow-2xl border border-gray-800">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-black tracking-widest text-red-500">CLOUD AUDIO VAULT</h2>
          <p className="text-xs text-gray-400 font-mono mt-1">Session: {sessionId}</p>
        </div>
        <button
          onClick={togglePlayMaster}
          className="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-lg font-black tracking-wider uppercase transition-all shadow-lg shadow-red-600/30"
        >
          {isPlaying ? 'PAUSE MASTER' : 'PLAY MASTER MIX'}
        </button>
      </div>

      {/* Master Track Player */}
      <div className="mb-8 p-4 bg-gray-800/60 rounded-lg border border-gray-700/50">
        <span className="block text-xs uppercase font-bold text-gray-400 mb-2">Cloud Master Render Output</span>
        <audio controls className="w-full accent-red-600">
          <source src={`/api/vault/stream/${sessionId}/${sessionId}_MASTER.wav`} type="audio/wav" />
          Your browser does not support the audio element.
        </audio>
      </div>

      {/* Isolated Stem Controls */}
      <div className="space-y-4">
        <h3 className="text-xs uppercase font-bold text-gray-400 tracking-wider">Multi-Track Cloud Stems</h3>
        {stems.map((stem) => (
          <div key={stem} className="flex items-center justify-between bg-gray-800/80 p-4 rounded-lg border border-gray-700">
            <span className="w-36 uppercase text-xs font-black tracking-wider text-gray-300">
              {stem.replace('_', ' ')}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volumes[stem]}
              onChange={(e) => handleVolumeChange(stem, e.target.value)}
              className="flex-grow mx-6 accent-red-600 cursor-pointer"
            />
            <button
              onClick={() => downloadStem(stem)}
              className="bg-gray-700 hover:bg-gray-600 text-xs font-bold px-4 py-2 rounded uppercase tracking-wider transition-all border border-gray-600"
            >
              Export WAV
            </button>

            {/* Hidden Synchronized Audio Element fetching via Supabase Stream Proxy */}
            <audio
              ref={(el) => {
                audioRefs.current[stem] = el;
              }}
              src={`/api/vault/stream/${sessionId}/${sessionId}_stem_${stem}.wav`}
              preload="auto"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
