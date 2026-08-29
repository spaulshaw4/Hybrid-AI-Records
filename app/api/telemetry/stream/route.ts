// app/api/telemetry/stream/route.ts
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // 1. Send initial 50 records as snapshot
      const { data: initialLogs, error } = await supabaseAdmin
        .from('pipeline_telemetry_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (!error && initialLogs) {
        const initPayload = JSON.stringify({ type: 'INIT', data: initialLogs });
        controller.enqueue(encoder.encode(`data: ${initPayload}\n\n`));
      }

      // 2. Subscribe to realtime inserts using service_role on server
      const channelId = `sse-telemetry-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const channel = supabaseAdmin
        .channel(channelId)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'pipeline_telemetry_logs' },
          (payload) => {
            const insertPayload = JSON.stringify({ type: 'INSERT', data: payload.new });
            try {
              controller.enqueue(encoder.encode(`data: ${insertPayload}\n\n`));
            } catch {
              // Stream closed by client
            }
          }
        )
        .subscribe();

      // 3. Keep-alive heartbeat every 15 seconds
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      // 4. Clean up subscriptions and timers on disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        supabaseAdmin.removeChannel(channel);
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
