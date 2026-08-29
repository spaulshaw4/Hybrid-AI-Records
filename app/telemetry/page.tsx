// app/telemetry/page.tsx
'use client';

import { useEffect, useState } from 'react';

interface TelemetryRecord {
  id: string;
  event_type: string;
  user_id: string;
  job_id: string | null;
  metadata: {
    session_id?: string;
    execution_duration_sec?: number;
    genre_lock?: string;
    error?: string;
    hardware?: {
      cpu_utilization_pct: number;
      ram_total_gb: number;
      ram_used_gb: number;
      ram_utilization_pct: number;
      disk_target: string;
      disk_free_gb: number;
      disk_total_gb: number;
      disk_utilization_pct: number;
    };
    timestamp_unix?: number;
  };
  created_at: string;
}

export default function TelemetryDashboardPage() {
  const [logs, setLogs] = useState<TelemetryRecord[]>([]);
  const [latestHw, setLatestHw] = useState<TelemetryRecord['metadata']['hardware'] | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const eventSource = new EventSource('/api/telemetry/stream');

    eventSource.onopen = () => {
      setIsConnected(true);
      setLoading(false);
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload.type === 'INIT') {
          const records = payload.data as TelemetryRecord[];
          setLogs(records);
          const recordWithHw = records.find((r) => r.metadata?.hardware);
          if (recordWithHw?.metadata?.hardware) {
            setLatestHw(recordWithHw.metadata.hardware);
          }
          setLoading(false);
        } else if (payload.type === 'INSERT') {
          const newRecord = payload.data as TelemetryRecord;
          setLogs((prev) => [newRecord, ...prev.slice(0, 49)]);
          if (newRecord.metadata?.hardware) {
            setLatestHw(newRecord.metadata.hardware);
          }
        }
      } catch (err) {
        console.error('[SSE ERROR] Failed to parse telemetry packet:', err);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  if (loading) {
    return <div className="p-8 bg-zinc-950 text-white min-h-screen font-mono text-sm">Opening secure SSE tunnel to telemetry gateway...</div>;
  }

  return (
    <div className="p-8 bg-zinc-950 text-white min-h-screen max-w-6xl mx-auto font-mono">
      <div className="flex justify-between items-center mb-6 border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Hybrid 1.0 - Workstation Telemetry</h1>
          <p className="text-xs text-zinc-500 mt-1">Encapsulated Server-Sent Events (SSE) stream via service role</p>
        </div>
        <span className={`flex items-center gap-2 px-3 py-1 border text-xs rounded-full ${
          isConnected
            ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-400'
            : 'bg-rose-950/40 border-rose-500/30 text-rose-400'
        }`}>
          <span className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></span>
          {isConnected ? 'SECURE SSE LIVE' : 'RECONNECTING'}
        </span>
      </div>

      {/* Hardware Utilization Matrix */}
      {latestHw && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl space-y-2">
            <div className="text-xs text-zinc-400 font-semibold uppercase">CPU Load</div>
            <div className="text-2xl font-bold text-zinc-100">{latestHw.cpu_utilization_pct}%</div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full ${latestHw.cpu_utilization_pct > 80 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, latestHw.cpu_utilization_pct)}%` }}
              ></div>
            </div>
          </div>

          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl space-y-2">
            <div className="text-xs text-zinc-400 font-semibold uppercase">System RAM</div>
            <div className="text-2xl font-bold text-zinc-100">{latestHw.ram_used_gb} / {latestHw.ram_total_gb} GB</div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full ${latestHw.ram_utilization_pct > 85 ? 'bg-rose-500' : 'bg-cyan-500'}`}
                style={{ width: `${Math.min(100, latestHw.ram_utilization_pct)}%` }}
              ></div>
            </div>
          </div>

          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl space-y-2">
            <div className="text-xs text-zinc-400 font-semibold uppercase">{latestHw.disk_target} Storage Volume</div>
            <div className="text-2xl font-bold text-zinc-100">{latestHw.disk_free_gb} GB Free</div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full ${latestHw.disk_utilization_pct > 90 ? 'bg-rose-500' : 'bg-amber-500'}`}
                style={{ width: `${Math.min(100, latestHw.disk_utilization_pct)}%` }}
              ></div>
            </div>
          </div>
        </div>
      )}

      {/* Realtime Event Stream */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg">
        <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider mb-4">Pipeline Execution Log Stream</h2>
        <div className="divide-y divide-zinc-800/60 max-h-[520px] overflow-y-auto">
          {logs.length === 0 ? (
            <p className="text-zinc-500 text-xs py-4">No telemetry records captured yet.</p>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="py-3 flex flex-col md:flex-row md:items-center justify-between text-xs gap-2">
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    log.event_type.includes('complete') ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                    log.event_type.includes('fail') ? 'bg-rose-950 text-rose-400 border border-rose-800' :
                    log.event_type.includes('start') ? 'bg-cyan-950 text-cyan-400 border border-cyan-800' :
                    'bg-zinc-800 text-zinc-300'
                  }`}>
                    {log.event_type}
                  </span>
                  <span className="text-zinc-300 font-semibold">
                    {log.metadata?.session_id || 'Global Event'}
                  </span>
                  {log.metadata?.execution_duration_sec !== undefined && (
                    <span className="text-zinc-500">
                      ({log.metadata.execution_duration_sec}s)
                    </span>
                  )}
                  {log.metadata?.error && (
                    <span className="text-rose-400 truncate max-w-md">
                      Error: {log.metadata.error}
                    </span>
                  )}
                </div>
                <div className="text-zinc-500 text-[11px]">
                  {new Date(log.created_at).toLocaleTimeString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
