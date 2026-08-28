import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import type { NextApiRequest, NextApiResponse } from 'next';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface JobPayload {
  session_id: string;
  user_id: string;
  genre_lock: string;
  target_bpm: number;
  target_length_sec: number;
  vocal_mode: string;
  vocal_prompt?: string;
  vocal_file_path?: string;
  lyrics: string;
  arrangement_tags: string[];
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jobData: JobPayload = req.body;

  if (!jobData.session_id || !jobData.user_id) {
    return res.status(400).json({ error: 'Missing session_id or user_id' });
  }

  try {
    // 1. Execute Secure Token Deduction via Supabase RPC
    const { data: tokenSuccess, error: rpcError } = await supabase.rpc('spend_hybrid_token', {
      user_uuid: jobData.user_id
    });

    if (rpcError || !tokenSuccess) {
      console.error('Token deduction failed:', rpcError?.message);
      return res.status(402).json({ error: 'Insufficient balance or transaction failed.' });
    }

    // 2. Initialize user_vaults row as 'processing' for real-time tracking
    const { error: dbError } = await supabase
      .from('user_vaults')
      .insert([
        {
          session_id: jobData.session_id,
          user_id: jobData.user_id,
          status: 'processing',
          genre: jobData.genre_lock,
          target_bpm: jobData.target_bpm,
          vault_path: null,
          metadata: {
            vocal_mode: jobData.vocal_mode,
            vocal_prompt: jobData.vocal_prompt,
            target_length_sec: jobData.target_length_sec,
            arrangement_tags: jobData.arrangement_tags
          }
        }
      ]);

    if (dbError) {
      console.error('Database insertion error:', dbError.message);
      return res.status(500).json({ error: 'Failed to initialize vault record.' });
    }

    // 3. Write Payload to Local D: Drive
    const payloadDir = 'D:\\MusicDatasets\\job_payloads';
    if (!fs.existsSync(payloadDir)) {
      fs.mkdirSync(payloadDir, { recursive: true });
    }

    const payloadPath = path.join(payloadDir, `job_${jobData.session_id}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(jobData, null, 2));

    // 4. Spawn Local Offline Python Engine
    const engineProcess = spawn('python', [
      'D:\\MusicDatasets\\scripts\\master_engine.py',
      '--payload',
      payloadPath
    ], {
      detached: true,
      stdio: 'ignore',
      shell: true
    });

    engineProcess.unref();

    console.log(`[${jobData.session_id}] Engine spawned successfully`);

    return res.status(200).json({
      status: 'processing',
      session_id: jobData.session_id,
      message: 'Engine successfully spawned. Stems rendering locally.'
    });

  } catch (err) {
    console.error('Generation Pipeline Error:', err);
    return res.status(500).json({ error: 'Internal server error during engine trigger.' });
  }
}
