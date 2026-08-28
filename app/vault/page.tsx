// app/vault/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export default function VaultDashboardPage() {
  const [vaults, setVaults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    async function fetchVaults() {
      const { data, error } = await supabase
        .from('user_vaults')
        .select('*')
        .order('created_at', { ascending: false });

      if (data && !error) {
        setVaults(data);
      }
      setLoading(false);
    }

    fetchVaults();

    const channel = supabase
      .channel('vault-dashboard-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_vaults' },
        () => {
          fetchVaults();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return <div className="p-8 bg-zinc-950 text-white min-h-screen font-mono text-sm">Loading master vault ledger...</div>;
  }

  return (
    <div className="p-8 bg-zinc-950 text-white min-h-screen max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 border-b border-zinc-800 pb-4">Hybrid 1.0 - Master Vault Ledger</h1>

      <div className="space-y-4">
        {vaults.length === 0 ? (
          <p className="text-zinc-500 text-sm font-mono">No generation sessions found in the vault.</p>
        ) : (
          vaults.map((vault) => (
            <div key={vault.session_id} className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl space-y-3 shadow-lg">
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs text-zinc-400">Session: {vault.session_id}</span>
                <span className={`px-2.5 py-1 text-xs font-semibold rounded-full uppercase tracking-wider border ${
                  vault.status === 'completed' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20' :
                  vault.status === 'processing' ? 'text-amber-400 border-amber-500/30 bg-amber-950/20 animate-pulse' :
                  vault.status === 'failed' ? 'text-rose-400 border-rose-500/30 bg-rose-950/20' :
                  'text-zinc-400 border-zinc-700 bg-zinc-900'
                }`}>
                  {vault.status}
                </span>
              </div>

              <div className="text-sm font-mono text-zinc-300 space-y-1">
                <p><strong className="text-zinc-400">Genre Lock:</strong> {vault.genre_lock}</p>
                <p><strong className="text-zinc-400">Cryptographic Hash:</strong> {vault.master_hash || 'Pending lock'}</p>
                <p><strong className="text-zinc-400">Timestamp:</strong> {new Date(vault.created_at).toISOString()}</p>
              </div>

              {vault.status === 'completed' && vault.storage_url && (
                <div className="pt-2 space-y-3">
                  <audio controls className="w-full h-10 accent-emerald-500">
                    <source src={vault.storage_url} type="audio/wav" />
                    Your browser does not support the audio element.
                  </audio>
                  <a
                    href={vault.storage_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold rounded transition text-white"
                  >
                    Download Master WAV
                  </a>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
