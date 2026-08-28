// components/GenerationTrigger.tsx
'use client';

import { useState } from 'react';

export default function GenerationTrigger({ userId }: { userId: string }) {
  const [genreLock, setGenreLock] = useState('heavy_alternative_rock');
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const handleGenerate = async () => {
    setStatus('processing');
    setMessage('Initializing generation session ($2.00 token deduction)...');

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
      setMessage(`Session active: ${data.sessionId}. Daemon poller is processing local render.`);
      setStatus('completed');
    } catch (err: any) {
      setStatus('failed');
      setMessage(err.message);
    }
  };

  return (
    <div className="p-6 bg-zinc-900 text-white rounded-xl max-w-md mx-auto border border-zinc-800">
      <h2 className="text-xl font-bold mb-4">Hybrid 1.0 Master Generation</h2>

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
        {status === 'processing' ? 'Initializing...' : 'Initialize Generation ($2.00)'}
      </button>

      {message && (
        <p className="mt-4 text-sm text-zinc-300 bg-zinc-800 p-3 rounded border border-zinc-700">
          {message}
        </p>
      )}
    </div>
  );
}
