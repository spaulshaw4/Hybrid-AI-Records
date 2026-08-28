'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';

interface TrackPayload {
  session_id: string;
  user_id: string;
  genre_lock: string;
  target_bpm: number;
  target_length_sec: number;
  vocal_mode: 'none' | 'custom' | 'ai';
  vocal_prompt?: string;
  vocal_file_path?: string;
  lyrics: string;
  arrangement_tags: string[];
}

const GENRE_OPTIONS = [
  { id: 'heavy_rock', label: 'Heavy Alternative Rock', color: 'from-red-600 to-orange-600' },
  { id: 'nu_metal', label: 'Nu-Metal', color: 'from-purple-600 to-pink-600' },
  { id: 'rap_rock', label: 'Rap-Rock', color: 'from-yellow-600 to-red-600' },
  { id: 'industrial', label: 'Industrial', color: 'from-gray-600 to-zinc-700' },
  { id: 'trap', label: 'Trap / 808', color: 'from-pink-600 to-purple-600' },
  { id: 'amapiano', label: 'Amapiano', color: 'from-green-600 to-teal-600' },
  { id: 'cinematic', label: 'Cinematic / Orchestral', color: 'from-blue-600 to-indigo-600' },
  { id: 'acoustic', label: 'Acoustic', color: 'from-amber-600 to-yellow-600' },
];

const LENGTH_OPTIONS = [
  { sec: 120, label: '2:00' },
  { sec: 150, label: '2:30' },
  { sec: 180, label: '3:00' },
  { sec: 210, label: '3:30' },
  { sec: 240, label: '4:00' },
];

interface TrackBuilderProps {
  userId: string;
  onGenerate: (payload: TrackPayload) => Promise<void>;
}

export default function TrackBuilder({ userId, onGenerate }: TrackBuilderProps) {
  // Step 1: Lyrics & Structure
  const [lyrics, setLyrics] = useState('');
  
  // Step 2: Style Lock
  const [genre, setGenre] = useState('nu_metal');
  const [bpm, setBpm] = useState(118);
  const [targetLength, setTargetLength] = useState(180);
  
  // Step 3: Vocal Direction
  const [vocalMode, setVocalMode] = useState<'none' | 'custom' | 'ai'>('ai');
  const [vocalPrompt, setVocalPrompt] = useState('rasp, male baritone');
  const [vocalFile, setVocalFile] = useState<File | null>(null);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse arrangement tags from lyrics
  const arrangementTags = useMemo(() => {
    const tags: string[] = [];
    const regex = /\[(Verse|Chorus|Bridge|Intro|Outro|Pre-Chorus|Hook)\]/gi;
    let match;
    while ((match = regex.exec(lyrics)) !== null) {
      tags.push(match[1].toLowerCase().replace('-', ''));
    }
    // Default structure if no tags found
    return tags.length > 0 ? tags : ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro'];
  }, [lyrics]);

  // Build the payload
  const buildPayload = useCallback((): TrackPayload => {
    const sessionId = `hybrid_${Date.now()}_${uuidv4().slice(0, 8)}`;
    
    return {
      session_id: sessionId,
      user_id: userId,
      genre_lock: genre,
      target_bpm: bpm,
      target_length_sec: targetLength,
      vocal_mode: vocalMode,
      vocal_prompt: vocalMode === 'ai' ? vocalPrompt : undefined,
      vocal_file_path: vocalMode === 'custom' && vocalFile 
        ? `D:\\MusicDatasets\\uploads\\${vocalFile.name}` 
        : undefined,
      lyrics,
      arrangement_tags: arrangementTags,
    };
  }, [userId, genre, bpm, targetLength, vocalMode, vocalPrompt, vocalFile, lyrics, arrangementTags]);

  // Handle generation
  const handleGenerate = async () => {
    setError(null);
    setIsGenerating(true);
    
    try {
      const payload = buildPayload();
      await onGenerate(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle file upload
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVocalFile(file);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      {/* STEP 1: Lyrics & Structure */}
      <section className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center font-bold">1</span>
          <h2 className="text-xl font-bold text-white">Title & Lyrics</h2>
        </div>
        
        <p className="text-gray-400 text-sm mb-4">
          Use [Verse], [Chorus], [Bridge], [Intro], [Outro] tags to structure your song.
          The engine will automatically arrange sections with dynamic energy drops.
        </p>
        
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          placeholder={`[Intro]\n\n[Verse]\nYour lyrics here...\n\n[Chorus]\nHook goes here...\n\n[Bridge]\n\n[Outro]`}
          className="w-full h-64 bg-gray-800 text-white rounded-xl p-4 border border-gray-700 focus:border-red-500 focus:outline-none resize-none font-mono text-sm"
        />
        
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-xs text-gray-500">Detected structure:</span>
          {arrangementTags.map((tag, i) => (
            <span key={i} className="px-2 py-1 bg-gray-800 text-gray-300 rounded text-xs uppercase">
              {tag}
            </span>
          ))}
        </div>
      </section>

      {/* STEP 2: Style Lock */}
      <section className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center font-bold">2</span>
          <h2 className="text-xl font-bold text-white">Style Lock</h2>
        </div>

        {/* Genre Selection */}
        <div className="mb-6">
          <label className="block text-gray-400 text-sm mb-3">Genre</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {GENRE_OPTIONS.map(g => (
              <button
                key={g.id}
                onClick={() => setGenre(g.id)}
                className={`p-3 rounded-xl text-sm font-bold transition-all ${
                  genre === g.id
                    ? `bg-gradient-to-r ${g.color} text-white scale-105 shadow-lg`
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* BPM Slider */}
        <div className="mb-6">
          <div className="flex justify-between mb-2">
            <label className="text-gray-400 text-sm">Tempo</label>
            <span className="text-red-500 font-bold font-mono">{bpm} BPM</span>
          </div>
          <input
            type="range"
            min="60"
            max="180"
            value={bpm}
            onChange={(e) => setBpm(parseInt(e.target.value))}
            className="w-full h-3 bg-gray-800 rounded-full appearance-none cursor-pointer accent-red-500"
          />
          <div className="flex justify-between text-xs text-gray-600 mt-1">
            <span>60</span>
            <span>90</span>
            <span>120</span>
            <span>150</span>
            <span>180</span>
          </div>
        </div>

        {/* Track Length */}
        <div>
          <label className="block text-gray-400 text-sm mb-3">Track Length</label>
          <div className="flex gap-3">
            {LENGTH_OPTIONS.map(opt => (
              <button
                key={opt.sec}
                onClick={() => setTargetLength(opt.sec)}
                className={`flex-1 py-3 rounded-xl font-bold transition ${
                  targetLength === opt.sec
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* STEP 3: Vocal Direction */}
      <section className="bg-gray-900 rounded-2xl p-6 border border-gray-800">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center font-bold">3</span>
          <h2 className="text-xl font-bold text-white">Vocal Direction</h2>
        </div>

        {/* Vocal Mode Selection */}
        <div className="flex gap-3 mb-6">
          {[
            { mode: 'ai' as const, label: 'AI Vocals', icon: '🤖' },
            { mode: 'custom' as const, label: 'Upload Recording', icon: '🎤' },
            { mode: 'none' as const, label: 'Instrumental Only', icon: '🎸' },
          ].map(opt => (
            <button
              key={opt.mode}
              onClick={() => setVocalMode(opt.mode)}
              className={`flex-1 py-4 rounded-xl font-bold transition flex flex-col items-center gap-2 ${
                vocalMode === opt.mode
                  ? 'bg-gradient-to-r from-red-600 to-orange-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              <span className="text-2xl">{opt.icon}</span>
              <span className="text-sm">{opt.label}</span>
            </button>
          ))}
        </div>

        {/* AI Vocal Prompt */}
        {vocalMode === 'ai' && (
          <div>
            <label className="block text-gray-400 text-sm mb-2">Vocal Style Prompt</label>
            <input
              type="text"
              value={vocalPrompt}
              onChange={(e) => setVocalPrompt(e.target.value)}
              placeholder="e.g., rasp, male baritone, aggressive"
              className="w-full bg-gray-800 text-white rounded-xl p-4 border border-gray-700 focus:border-red-500 focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-2">
              Describe the vocal character: tone, gender, style, emotion
            </p>
          </div>
        )}

        {/* Custom Upload */}
        {vocalMode === 'custom' && (
          <div>
            <label className="block text-gray-400 text-sm mb-2">Upload Your Vocal Take</label>
            <div className="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center hover:border-red-500 transition cursor-pointer">
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileChange}
                className="hidden"
                id="vocal-upload"
              />
              <label htmlFor="vocal-upload" className="cursor-pointer">
                {vocalFile ? (
                  <div className="text-green-400">
                    <span className="text-3xl">✓</span>
                    <p className="mt-2 font-bold">{vocalFile.name}</p>
                  </div>
                ) : (
                  <div className="text-gray-500">
                    <span className="text-3xl">🎤</span>
                    <p className="mt-2">Drop your .wav or .mp3 here</p>
                  </div>
                )}
              </label>
            </div>
          </div>
        )}
      </section>

      {/* Generate Button */}
      <div className="text-center">
        {error && (
          <p className="text-red-500 mb-4">{error}</p>
        )}
        
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className={`px-12 py-5 rounded-2xl font-black text-xl transition-all transform ${
            isGenerating
              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
              : 'bg-gradient-to-r from-red-600 to-orange-600 text-white hover:scale-105 shadow-2xl hover:shadow-red-500/30'
          }`}
        >
          {isGenerating ? (
            <span className="flex items-center gap-3">
              <span className="animate-spin">⚙️</span> GENERATING...
            </span>
          ) : (
            <span>🎵 GENERATE TRACK — $2.00</span>
          )}
        </button>
        
        <p className="text-gray-500 text-sm mt-3">
          1 Hybrid Token will be deducted from your balance
        </p>
      </div>

      {/* Debug: Show Payload Preview */}
      <details className="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <summary className="text-gray-500 text-sm cursor-pointer">Preview JSON Payload</summary>
        <pre className="mt-4 text-xs text-gray-400 overflow-auto">
          {JSON.stringify(buildPayload(), null, 2)}
        </pre>
      </details>
    </div>
  );
}
