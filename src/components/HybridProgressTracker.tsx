// src/components/HybridProgressTracker.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface TrackerProps {
  sessionId: string;
}

interface VaultData {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  genre_lock: string;
  metadata: any;
}

export default function HybridProgressTracker({ sessionId }: TrackerProps) {
  const [vaultData, setVaultData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 1. Fetch initial state
    async function fetchInitialStatus() {
      const { data, error } = await supabase
        .from('user_vaults')
        .select('status, genre_lock, metadata')
        .eq('session_id', sessionId)
        .single();

      if (error) {
        setError('Failed to locate session in vault.');
        return;
      }
      if (data) setVaultData(data as VaultData);
    }

    fetchInitialStatus();

    // 2. Subscribe to real-time daemon updates
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
        (payload) => {
          setVaultData(payload.new as VaultData);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId]);

  if (error) {
    return <div className="p-4 border border-red-800 bg-red-900/20 text-red-400 font-mono text-sm rounded-xl">{error}</div>;
  }

  if (!vaultData) {
    return <div className="p-4 font-mono text-sm text-gray-400 animate-pulse">Establishing secure link to vault ledger...</div>;
  }

  return (
    <div className="p-6 bg-gray-950 border border-gray-800 rounded-2xl max-w-2xl w-full mx-auto space-y-6">
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h2 className="text-sm font-black tracking-widest text-white uppercase">Session: {sessionId.slice(0, 8)}...</h2>
          <p className="text-xs text-gray-500 font-mono">Genre Lock: {vaultData.genre_lock}</p>
        </div>

        {/* Status Badge */}
        <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center space-x-2
          ${vaultData.status === 'completed' ? 'bg-green-900/40 text-green-400 border border-green-800' : ''}
          ${vaultData.status === 'processing' ? 'bg-blue-900/40 text-blue-400 border border-blue-800' : ''}
          ${vaultData.status === 'pending' ? 'bg-amber-900/40 text-amber-400 border border-amber-800' : ''}
          ${vaultData.status === 'failed' ? 'bg-red-900/40 text-red-400 border border-red-800' : ''}
        `}>
          {vaultData.status === 'processing' && <span className="h-2 w-2 bg-blue-400 rounded-full animate-ping mr-1"></span>}
          <span>{vaultData.status}</span>
        </div>
      </div>

      {/* Progress Timeline */}
      <div className="space-y-4 font-mono text-xs">
        <div className={`flex items-center space-x-3 ${vaultData.status !== 'pending' ? 'text-gray-400' : 'text-white'}`}>
          <span className="text-amber-500">[{vaultData.status !== 'pending' ? '✓' : '...'}]</span>
          <span>Job registered. Waiting for local worker daemon...</span>
        </div>

        <div className={`flex items-center space-x-3 ${(vaultData.status === 'processing' || vaultData.status === 'completed') ? 'text-white' : 'text-gray-600'}`}>
          <span className="text-blue-500">[{vaultData.status === 'completed' ? '✓' : vaultData.status === 'processing' ? '...' : ' '}]</span>
          <span>Local Engine & Cylinder Orchestrator generating stems...</span>
        </div>

        <div className={`flex items-center space-x-3 ${vaultData.status === 'completed' ? 'text-green-400' : 'text-gray-600'}`}>
          <span className="text-green-500">[{vaultData.status === 'completed' ? '✓' : ' '}]</span>
          <span>Bus summation and cryptographic hex hashing complete.</span>
        </div>
      </div>

      {/* Cryptographic Ledger Reveal */}
      {vaultData.status === 'completed' && vaultData.metadata?.hex_checksums && (
        <div className="mt-6 p-4 bg-black border border-gray-800 rounded-lg space-y-2">
          <h3 className="text-[10px] uppercase text-gray-500 font-mono tracking-widest mb-3">Verified Hex Ledger</h3>
          {Object.entries(vaultData.metadata.hex_checksums).map(([stem, hash]) => (
            <div key={stem} className="flex justify-between items-center text-[10px] font-mono border-b border-gray-900 pb-1">
              <span className="text-gray-400 w-24">{stem}</span>
              <span className="text-green-500 truncate ml-4">{String(hash)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
