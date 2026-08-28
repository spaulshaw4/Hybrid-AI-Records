// src/app/api/vault/[session_id]/[file_name]/route.ts (Next.js App Router Stem Streaming Endpoint)
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  req: Request,
  { params }: { params: { session_id: string; file_name: string } }
) {
  const { session_id, file_name } = params;

  // Validate inputs to prevent directory traversal attacks
  if (session_id.includes('..') || file_name.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Strictly lock path to D:\MusicDatasets\User_Audio_Vault
  const vaultBaseDir = 'D:\\MusicDatasets\\User_Audio_Vault';
  const filePath = path.join(vaultBaseDir, session_id, file_name);

  // Verify the resolved path is still within the vault directory
  if (!filePath.startsWith(vaultBaseDir)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: 'Audio stem not found or still generating.' },
      { status: 404 }
    );
  }

  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.get('range');

    // Determine content type based on file extension
    const ext = path.extname(file_name).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';

    if (range) {
      // Handle range requests for audio seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      // Use streaming for large files
      const fileStream = fs.createReadStream(filePath, { start, end });
      const chunks: Buffer[] = [];

      for await (const chunk of fileStream) {
        chunks.push(chunk as Buffer);
      }

      const buffer = Buffer.concat(chunks);

      return new NextResponse(buffer, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize.toString(),
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } else {
      // Full file request
      const fileBuffer = fs.readFileSync(filePath);

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          'Content-Length': fileSize.toString(),
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'Content-Disposition': `inline; filename="${file_name}"`,
        },
      });
    }
  } catch (err) {
    console.error('Audio Streaming Error:', err);
    return NextResponse.json(
      { error: 'Internal server error while streaming audio.' },
      { status: 500 }
    );
  }
}
