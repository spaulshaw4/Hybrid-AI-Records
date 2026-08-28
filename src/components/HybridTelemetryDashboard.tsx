// src/components/HybridTelemetryDashboard.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface VaultSession {
  session_id: string;
  user_id: string;
  status: string;
  created_at: string;
  metadata: any;
}

export default function HybridTelemetryDashboard() {
  const [sessions, setSessions] = useState<VaultSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<VaultSession | null>(null);

  useEffect(() => {
    async function fetchVaultSessions() {
      setLoading(true);
      const { data, error } = await supabase
        .from('user_vaults')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

      if (!error && data) {
        setSessions(data);
        if (data.length > 0) setSelectedSession(data[0]);
      }
      setLoading(false);
    }

    fetchVaultSessions();

    // Subscribe to real-time updates across all vaults
    const channel = supabase
      .channel('global-vault-telemetry')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_vaults' },
        (payload) => {
          const updated = payload.new as VaultSession;
          setSessions((prev) => {
            const index = prev.findIndex((s) => s.session_id === updated.session_id);
            if (index >= 0) {
              const copy = [...prev];
              copy[index] = updated;
              return copy;
            } else {
              return [updated, ...prev.slice(0, 9)];
            }
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="p-6 bg-gray-900 border border-gray-800 rounded-2xl shadow-xl max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h2 className="text-lg font-black tracking-widest text-white">HYBRID 1.0 TELEMETRY DASHBOARD</h2>
          <p className="text-xs text-gray-400 font-mono">Real-time Cloud Vault & Hex Integrity Monitoring</p>
        </div>
        <div className="flex items-center space-x-2">
          <span className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse"></span>
          <span className="text-xs font-mono text-gray-300">Supabase Realtime Live</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 bg-gray-950 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400">Recent Sessions</h3>
          {loading ? (
            <p className="text-xs text-gray-500 font-mono">Loading telemetry...</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-gray-500 font-mono">No active sessions found.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {sessions.map((s) => (
                <button
                  key={s.session_id}
                  onClick={() => setSelectedSession(s)}
                  className={`w-full text-left p-3 rounded-xl border transition-all font-mono text-xs ${
                    selectedSession?.session_id === s.session_id
                      ? 'bg-red-600/10 border-red-600 text-white'
                      : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-700'
                  }`}
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-bold text-white truncate w-28">{s.session_id}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                        s.status === 'completed'
                          ? 'bg-green-500/20 text-green-400'
                          : s.status === 'failed'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-amber-500/20 text-amber-400'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-500 truncate">
                    Genre: {s.metadata?.genre_lock || 'N/A'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="md:col-span-2 bg-gray-950 border border-gray-800 rounded-xl p-6 space-y-4">
          <h3 className="text-xs font-mono uppercase tracking-wider text-gray-400">Session Telemetry & Cryptographic Fingerprints</h3>
          {selectedSession ? (
            <div className="space-y-4 font-mono text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-gray-900 border border-gray-800 rounded-lg">
                  <span className="text-gray-500 block mb-1 uppercase text-[10px]">Session ID</span>
                  <span className="text-white font-bold">{selectedSession.session_id}</span>
                </div>
                <div className="p-3 bg-gray-900 border border-gray-800 rounded-lg">
                  <span className="text-gray-500 block mb-1 uppercase text-[10px]">Execution Status</span>
                  <span className="text-white font-bold uppercase">{selectedSession.status}</span>
                </div>
              </div>

              <div className="p-4 bg-gray-900 border border-gray-800 rounded-lg space-y-2">
                <span className="text-gray-500 uppercase text-[10px] block">Metadata & Parameters</span>
                <pre className="text-gray-300 text-[11px] overflow-x-auto bg-gray-950 p-3 rounded border border-gray-800">
                  {JSON.stringify(selectedSession.metadata, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500 font-mono">Select a session to inspect telemetry details.</p>
          )}
        </div>
      </div>
    </div>
  );
}
