// src/components/TrackGenerator.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import HybridStemMixer from './HybridStemMixer';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface TrackGeneratorProps {
  sessionId: string;
}

export default function TrackGenerator({ sessionId }: TrackGeneratorProps) {
  const [status, setStatus] = useState<'processing' | 'completed' | 'failed'>('processing');

  useEffect(() => {
    // Check initial status on mount
    async function checkStatus() {
      const { data, error } = await supabase
        .from('user_vaults')
        .select('status')
        .eq('session_id', sessionId)
        .single();

      if (data && data.status) {
        setStatus(data.status);
      }
    }
    checkStatus();

    // Subscribe to real-time updates from Supabase WebSocket channel
    const channel = supabase
      .channel(`vault_listener_${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_vaults',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload: { new: { status?: string } }) => {
          if (payload.new && payload.new.status) {
            setStatus(payload.new.status as 'processing' | 'completed' | 'failed');
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId]);

  if (status === 'processing') {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-gray-900 rounded-xl text-white shadow-2xl max-w-3xl mx-auto border border-gray-800">
        <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-red-600 mb-6"></div>
        <h2 className="text-xl font-black tracking-wider mb-2">ASSEMBLING UNIQUE STEMS...</h2>
        <p className="text-gray-400 text-sm text-center max-w-md">
          Slicing audio loops, synchronizing key and BPM parameters, applying structural
          arrangement mutations, and syncing final stems to Supabase Cloud Storage.
        </p>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="p-8 bg-red-950/50 border border-red-600 rounded-xl text-white max-w-3xl mx-auto text-center shadow-2xl">
        <h2 className="text-xl font-bold mb-2">Generation Failed</h2>
        <p className="text-gray-300 text-sm">
          The local offline engine encountered an error while processing this session.
        </p>
      </div>
    );
  }

  // Once completed, render the cloud-connected interactive stem mixer
  return <HybridStemMixer sessionId={sessionId} />;
}
