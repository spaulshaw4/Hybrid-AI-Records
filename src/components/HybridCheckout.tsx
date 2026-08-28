// src/components/HybridCheckout.tsx
'use client';

import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import HybridProgressTracker from './HybridProgressTracker';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function HybridCheckout({ userId }: { userId: string }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Example local parameters
  const genreLock = "Heavy Alternative Rock";
  const stylePrompt = "Driving bassline with aggressive drum fills";

  const handleTwoDollarCheckout = async () => {
    setIsProcessing(true);
    setError(null);

    // Generate a unique session ID for the local Windows vault
    const sessionId = `hyb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const metadata = { style_prompt: stylePrompt, timestamp: new Date().toISOString() };

    try {
      // Execute atomic $2.00 token deduction and vault registration
      const { data, error: rpcError } = await supabase.rpc('spend_hybrid_token_and_create_session', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_genre_lock: genreLock,
        p_metadata: metadata
      });

      if (rpcError || !data) {
        throw new Error("Insufficient token balance. Please load a $2.00 token to continue.");
      }

      // Hand off to the Progress Tracker to monitor local Windows daemon
      setActiveSessionId(sessionId);
    } catch (err: any) {
      setError(err.message || "Failed to process the $2.00 token transaction.");
    } finally {
      setIsProcessing(false);
    }
  };

  if (activeSessionId) {
    return <HybridProgressTracker sessionId={activeSessionId} />;
  }

  return (
    <div className="p-6 bg-gray-950 border border-gray-800 rounded-2xl max-w-md w-full mx-auto space-y-6">
      <div className="border-b border-gray-800 pb-4">
        <h2 className="text-lg font-black text-white uppercase tracking-widest">Hybrid Generation</h2>
        <p className="text-xs text-gray-500 font-mono mt-1">Cost: 1 Hybrid Token ($2.00)</p>
      </div>

      <div className="space-y-4">
        <div className="p-4 bg-black border border-gray-800 rounded-lg">
          <span className="text-[10px] text-gray-500 font-mono uppercase block mb-1">Genre Lock</span>
          <span className="text-sm text-gray-300 font-bold">{genreLock}</span>
        </div>

        {error && (
          <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg text-xs text-red-400 font-mono">
            [ERROR] {error}
          </div>
        )}

        <button
          onClick={handleTwoDollarCheckout}
          disabled={isProcessing}
          className={`w-full py-4 rounded-xl font-black uppercase tracking-widest transition-all ${
            isProcessing
              ? 'bg-gray-800 text-gray-500 cursor-not-allowed'
              : 'bg-white text-black hover:bg-gray-200 active:scale-95'
          }`}
        >
          {isProcessing ? 'Authorizing...' : 'Generate ($2.00 Token)'}
        </button>
      </div>
    </div>
  );
}
