import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  try {
    const dbPath = 'D:\\MusicDatasets\\hybrid_platform.db';
    const db = new Database(dbPath, { readonly: true });

    const row = db.prepare(`
      SELECT session_id, status, vault_path, completed_at 
      FROM user_vaults 
      WHERE session_id = ?
    `).get(sessionId) as { session_id: string; status: string; vault_path: string; completed_at: string } | undefined;

    db.close();

    if (!row) {
      return NextResponse.json({ status: 'not_found' });
    }

    // If completed, list the stems available
    let stems: string[] = [];
    if (row.status === 'completed' && row.vault_path) {
      const fs = await import('fs');
      if (fs.existsSync(row.vault_path)) {
        stems = fs.readdirSync(row.vault_path)
          .filter((f: string) => f.endsWith('.wav'))
          .map((f: string) => path.join(row.vault_path, f));
      }
    }

    return NextResponse.json({
      session_id: row.session_id,
      status: row.status,
      vault_path: row.vault_path,
      completed_at: row.completed_at,
      stems
    });

  } catch (error) {
    console.error('Vault status error:', error);
    return NextResponse.json({ error: 'Database query failed' }, { status: 500 });
  }
}
