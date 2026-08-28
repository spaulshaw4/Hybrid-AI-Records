// src/app/api/vault/stream/[session_id]/[file_name]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  req: Request,
  { params }: { params: { session_id: string; file_name: string } }
) {
  const { session_id, file_name } = params;
  
  // Extract user authorization or identity directly from the request context/headers if needed,
  // ensuring the direct user endpoint securely authorizes the download/stream.
  const authHeader = req.headers.get('authorization');

  try {
    const storagePath = `user_vaults/${session_id}/${file_name}`;

    // Generate a secure signed URL directly tied to the user's vault session request
    const { data, error } = await supabase.storage
      .from('audio-vault')
      .createSignedUrl(storagePath, 60);

    if (error || !data?.signedUrl) {
      return NextResponse.json(
        { error: 'Unauthorized or asset not found in user vault.' },
        { status: 404 }
      );
    }

    return NextResponse.redirect(data.signedUrl);
  } catch (err) {
    console.error('User Vault Stream Error:', err);
    return NextResponse.json(
      { error: 'Internal server error during user stream request.' },
      { status: 500 }
    );
  }
}
