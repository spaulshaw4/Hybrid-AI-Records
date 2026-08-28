// src/app/api/generate-track/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PAYLOAD_DIR = 'D:\\MusicDatasets\\job_payloads';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { user_id, prompt, genre_lock, target_bpm, target_length_sec } = body;

    if (!user_id || !prompt) {
      return NextResponse.json(
        { error: 'Missing required parameters: user_id and prompt' },
        { status: 400 }
      );
    }

    // Step 1: Execute atomic token deduction RPC ($2.00 fee)
    const { data: deductionResult, error: rpcError } = await supabase.rpc('spend_hybrid_token', {
      user_id_input: user_id,
      amount: 2.00
    });

    if (rpcError || !deductionResult) {
      return NextResponse.json(
        { error: `Token deduction failed: ${rpcError?.message || 'Insufficient balance'}` },
        { status: 402 }
      );
    }

    // Step 2: Generate unique session ID and initialize vault record
    const sessionId = `session_${crypto.randomBytes(8).toString('hex')}`;

    const { error: vaultError } = await supabase.from('user_vaults').insert({
      session_id: sessionId,
      user_id: user_id,
      status: 'processing',
      metadata: { prompt, genre_lock, target_bpm, target_length_sec }
    });

    if (vaultError) {
      return NextResponse.json(
        { error: `Failed to initialize vault record: ${vaultError.message}` },
        { status: 500 }
      );
    }

    // Step 3: Write job payload JSON for the local worker daemon
    const jobPayload = {
      session_id: sessionId,
      user_id,
      prompt,
      genre_lock,
      target_bpm,
      target_length_sec,
      created_at: new Date().toISOString()
    };

    if (!fs.existsSync(PAYLOAD_DIR)) {
      fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
    }

    const payloadPath = path.join(PAYLOAD_DIR, `job_${sessionId}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(jobPayload, null, 2));

    return NextResponse.json({
      success: true,
      session_id: sessionId,
      message: 'Token deducted, vault initialized, and job payload dispatched to local engine.'
    });

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown server error';
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
