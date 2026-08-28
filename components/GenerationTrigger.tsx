// components/GenerationTrigger.tsx
'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function GenerationStatusCard({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<string>('pending');
  const [storageUrl, setStorageUrl] = useState<string | null>(null);
  const [masterHash, setMasterHash] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    async function fetchInitialState() {
      const { data, error } = await supabase
        .from('user_vaults')
        .select('*')
        .eq('session_id', sessionId)
        .single();

      if (data && !error) {
        setStatus(data.status);
        setStorageUrl(data.storage_url);
        setMasterHash(data.master_hash);
      }
    }

    fetchInitialState();

    const channel = supabase
      .channel(`vault-${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_vaults',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: any) => {
          const updated = payload.new;
          setStatus(updated.status);
          setStorageUrl(updated.storage_url);
          setMasterHash(updated.master_hash);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId]);

  const getStatusColor = () => {
    switch (status) {
      case 'completed': return 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20';
      case 'processing': return 'text-amber-400 border-amber-500/30 bg-amber-950/20 animate-pulse';
      case 'failed': return 'text-rose-400 border-rose-500/30 bg-rose-950/20';
      default: return 'text-zinc-400 border-zinc-700 bg-zinc-900';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-bold text-lg text-white">Session Monitor</h3>
        <span className={`px-3 py-1 text-xs font-semibold rounded-full border uppercase tracking-wider ${getStatusColor()}`}>
          {status}
        </span>
      </div>

      <div className="space-y-2 text-sm text-zinc-400 bg-zinc-950 p-4 rounded border border-zinc-800 font-mono">
        <p><strong className="text-zinc-300">Session ID:</strong> {sessionId}</p>
        <p><strong className="text-zinc-300">Hash:</strong> {masterHash ? `${masterHash.slice(0, 16)}...` : 'Pending lock'}</p>
      </div>

      {status === 'completed' && storageUrl && (
        <div className="space-y-3">
          <audio controls className="w-full h-10 accent-emerald-500">
            <source src={storageUrl} type="audio/wav" />
            Your browser does not support the audio element.
          </audio>
          <a
            href={storageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center w-full py-2 bg-emerald-600 hover:bg-emerald-500 rounded font-semibold transition text-white text-sm"
          >
            Download Master WAV
          </a>
        </div>
      )}
    </div>
  );
}

export default function GenerationTrigger({ userId }: { userId: string }) {
  const [genreLock, setGenreLock] = useState('heavy_alternative_rock');
  const [status, setStatus] = useState<'idle' | 'processing' | 'error'>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const handleGenerate = async () => {
    setStatus('processing');
    setErrorMessage('');

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, genreLock }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to initialize session.');
      }

      setSessionId(data.sessionId);
    } catch (err: any) {
      setStatus('error');
      setErrorMessage(err.message);
    }
  };

  return (
    <div className="p-6 bg-zinc-900 text-white rounded-xl max-w-md mx-auto border border-zinc-800">
      <h2 className="text-xl font-bold mb-4">Hybrid 1.0 Master Generation</h2>

      {!sessionId ? (
        <>
          <label className="block text-sm text-zinc-400 mb-2">Select Genre Lock</label>
          <select 
            value={genreLock}
            onChange={(e) => setGenreLock(e.target.value)}
            className="w-full p-2 bg-zinc-800 border border-zinc-700 rounded mb-4 text-white"
          >
            <option value="heavy_alternative_rock">Heavy Alternative Rock</option>
            <option value="nu_metal">Nu-Metal</option>
            <option value="rap_rock">Rap-Rock</option>
            <option value="amapiano">Amapiano</option>
          </select>

          <button
            onClick={handleGenerate}
            disabled={status === 'processing'}
            className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 rounded font-semibold transition disabled:opacity-50"
          >
            {status === 'processing' ? 'Initializing ($2.00)...' : 'Initialize Generation ($2.00)'}
          </button>

          {status === 'error' && errorMessage && (
            <p className="mt-4 text-sm text-rose-300 bg-rose-950/30 p-3 rounded border border-rose-800">
              {errorMessage}
            </p>
          )}
        </>
      ) : (
        <GenerationStatusCard sessionId={sessionId} />
      )}
    </div>
  );
}
