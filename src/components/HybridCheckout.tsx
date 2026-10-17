// src/components/HybridCheckout.tsx
'use client';

import React, { useState } from 'react';
import HybridProgressTracker from './HybridProgressTracker';

export default function HybridCheckout({ userId: _userId }: { userId: string }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId] = useState<string | null>(null);

  // Example local parameters
  const genreLock = "Heavy Alternative Rock";

  const handleTwoDollarCheckout = () => {
    setIsProcessing(true);
    setError(null);
    // Spend stays on the server (dispatchInHouseJob / spend_hybrid_tokens).
    // This screen must not debit token_balances, profiles.d_tokens, or hybrid_tokens.
    setError("Token spend runs on the server. Use the studio generate path.");
    setIsProcessing(false);
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
