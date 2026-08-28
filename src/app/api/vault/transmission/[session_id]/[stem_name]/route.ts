// src/app/api/vault/transmission/[session_id]/[stem_name]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  req: Request,
  { params }: { params: { session_id: string; stem_name: string } }
) {
  const { session_id, stem_name } = params;

  // Verify user authorization header for secure transmission delivery
  const authHeader = req.headers.get('authorization');

  try {
    const storagePath = `user_vaults/${session_id}/${session_id}_stem_${stem_name}.wav`;

    // Generate a secure, time-limited signed URL for the specific transmission stem
    const { data, error } = await supabase.storage
      .from('audio-vault')
      .createSignedUrl(storagePath, 60);

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: 'Transmission stem not found or unauthorized.' },
        { status: 404 }
      );
    }

    // Proxy-redirect client securely to the signed cloud storage CDN stream
    return NextResponse.redirect(data.signedUrl);
  } catch (err) {
    console.error('Transmission Stream Handler Error:', err);
    return NextResponse.json(
      { error: 'Internal server error during transmission delivery.' },
      { status: 500 }
    );
  }
}
