// app/api/generate/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { userId, genreLock } = body;

    if (!userId || !genreLock) {
      return NextResponse.json({ error: 'Missing userId or genreLock' }, { status: 400 });
    }

    // Verify user token balance for the $2.50 hybrid tier
    const { data: tokenData, error: tokenError } = await supabase
      .from('user_token_balances')
      .select('hybrid_tokens')
      .eq('user_id', userId)
      .single();

    if (tokenError || !tokenData || tokenData.hybrid_tokens < 1) {
      return NextResponse.json({ error: 'Insufficient hybrid tokens ($2.00 session cost required).' }, { status: 402 });
    }

    // Deduct 1 hybrid token
    const { error: updateError } = await supabase
      .from('user_token_balances')
      .update({ 
        hybrid_tokens: tokenData.hybrid_tokens - 1, 
        updated_at: new Date().toISOString() 
      })
      .eq('user_id', userId);

    if (updateError) {
      throw new Error('Failed to process token ledger deduction.');
    }

    const sessionId = `hyb_${userId.slice(0, 8)}_${Date.now()}`;

    // Insert pending session into the user_vaults ledger matching the exact schema
    const { error: insertError } = await supabase
      .from('user_vaults')
      .insert({
        session_id: sessionId,
        user_id: userId,
        genre_lock: genreLock,
        status: 'pending',
        metadata: {
          token_cost_usd: 2.00,
          trigger_source: 'web_frontend'
        }
      });

    if (insertError) {
      throw new Error(insertError.message);
    }

    return NextResponse.json({
      success: true,
      sessionId,
      status: 'pending',
      message: 'Generation session initialized. Hybrid token deducted ($2.00). Daemon poller queued.'
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
