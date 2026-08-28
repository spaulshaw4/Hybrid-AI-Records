// src/components/HybridTrackCreator.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface HybridTrackCreatorProps {
  userId: string;
}

export default function HybridTrackCreator({ userId }: HybridTrackCreatorProps) {
  const [prompt, setPrompt] = useState('');
  const [genre, setGenre] = useState('nu_metal');
  const [bpm, setBpm] = useState(118);
  const [lengthSec, setLengthSec] = useState(180);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>('idle');

  // Listen to Supabase Realtime updates on user_vaults for active session
  useEffect(() => {
    if (!activeSessionId) return;

    const channel = supabase
      .channel(`vault-listener-${activeSessionId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_vaults',
          filter: `session_id=eq.${activeSessionId}`,
        },
        (payload) => {
          const newData = payload.new as { status?: string };
          if (newData && newData.status) {
            setSessionStatus(newData.status);
            if (newData.status === 'completed') {
              setLoading(false);
              setStatusMessage('Transmission complete. Stems rendered and locked in vault.');
            } else if (newData.status === 'failed') {
              setLoading(false);
              setStatusMessage('Pipeline execution failed. Check local worker logs.');
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeSessionId]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatusMessage('Deducting token ($2.00) & dispatching generation payload...');

    try {
      const res = await fetch('/api/generate-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          prompt,
          genre_lock: genre,
          target_bpm: bpm,
          target_length_sec: lengthSec,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch track generation.');
      }

      setActiveSessionId(data.session_id);
      setSessionStatus('processing');
      setStatusMessage(
        `Job dispatched successfully [Session: ${data.session_id}]. Waiting for worker daemon...`
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown generation error';
      setLoading(false);
      setStatusMessage(`Error: ${errorMsg}`);
    }
  };

  return (
    <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl shadow-xl max-w-2xl mx-auto space-y-6">
      <div className="border-b border-gray-800 pb-4">
        <h2 className="text-lg font-black tracking-widest text-white">
          HYBRID 1.0 ALPHA CREATOR
        </h2>
        <p className="text-xs text-gray-400 font-mono">
          Tokenized Audio Generation & Multi-Cylinder Pipeline
        </p>
      </div>

      <form onSubmit={handleGenerate} className="space-y-4">
        <div>
          <label className="block text-xs font-mono uppercase text-gray-300 mb-2">
            Concept / Lyrics Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter lyrical themes or sonic direction..."
            rows={3}
            className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white text-sm focus:border-red-600 focus:outline-none"
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-mono uppercase text-gray-300 mb-2">
              Genre Lock
            </label>
            <select
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white text-sm focus:border-red-600 focus:outline-none"
            >
              <option value="nu_metal">Nu-Metal / Rock</option>
              <option value="heavy_alt">Heavy Alternative</option>
              <option value="rap_rock">Rap-Rock</option>
              <option value="amapiano">Amapiano</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-mono uppercase text-gray-300 mb-2">
              Target BPM
            </label>
            <input
              type="number"
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
              className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white text-sm focus:border-red-600 focus:outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-mono uppercase text-gray-300 mb-2">
              Length (Sec)
            </label>
            <input
              type="number"
              value={lengthSec}
              onChange={(e) => setLengthSec(Number(e.target.value))}
              className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-white text-sm focus:border-red-600 focus:outline-none"
              required
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-bold uppercase tracking-wider text-xs rounded-xl shadow-lg shadow-red-600/30 transition-all disabled:opacity-50"
        >
          {loading ? 'Processing Generation ($2.00 Token)...' : 'Initialize Hybrid Generation ($2.00)'}
        </button>
      </form>

      {statusMessage && (
        <div className="p-4 bg-gray-950 border border-gray-800 rounded-xl space-y-2">
          <div className="flex justify-between items-center text-xs font-mono">
            <span className="text-gray-400 uppercase">Pipeline Status</span>
            <span
              className={`font-bold ${
                sessionStatus === 'completed'
                  ? 'text-green-500'
                  : sessionStatus === 'failed'
                  ? 'text-red-500'
                  : 'text-amber-500'
              }`}
            >
              {sessionStatus.toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-gray-300 font-mono">{statusMessage}</p>
        </div>
      )}
    </div>
  );
}
