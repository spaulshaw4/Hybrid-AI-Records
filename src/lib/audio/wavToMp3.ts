import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Mp3EncoderInstance = {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
};

type LameJsModule = {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderInstance;
};

/**
 * lamejs looks up MPEGMode, Lame, and BitStream as free variables.
 * Node's module build does not attach them, so they are installed before Mp3Encoder.
 */
function loadLamejs(): LameJsModule {
  const runtime = globalThis as typeof globalThis & {
    MPEGMode?: unknown;
    Lame?: unknown;
    BitStream?: unknown;
  };
  if (!runtime.MPEGMode) runtime.MPEGMode = require("lamejs/src/js/MPEGMode.js");
  if (!runtime.Lame) runtime.Lame = require("lamejs/src/js/Lame.js");
  if (!runtime.BitStream) runtime.BitStream = require("lamejs/src/js/BitStream.js");
  return require("lamejs") as LameJsModule;
}

/** Real MPEG frame sync, or an ID3 tag. Anything else is not an uploadable MP3. */
export function isMp3FrameOrId3(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return true;
  return bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function copyLameChunk(mp3buf: Int8Array): Buffer {
  return Buffer.from(mp3buf.buffer, mp3buf.byteOffset, mp3buf.byteLength);
}

function findDataSubchunk(wavBuffer: Buffer): { dataOffset: number; dataSize: number } | null {
  let offset = 12;
  while (offset + 8 <= wavBuffer.length) {
    const id = wavBuffer.toString("ascii", offset, offset + 4);
    const size = wavBuffer.readUInt32LE(offset + 4);
    if (id === "data") {
      return { dataOffset: offset + 8, dataSize: size };
    }
    const step = 8 + size + (size % 2);
    if (step <= 8) break;
    offset += step;
  }
  return null;
}

/**
 * 320 kbps MP3 from 16-bit PCM.
 * Non-16-bit input and a result that is not a real MP3 come back as the original WAV buffer.
 */
export function wavToMp3(wavBuffer: Buffer): Buffer {
  if (wavBuffer.length < 44) {
    throw new Error("Invalid WAV: Buffer smaller than 44 bytes.");
  }
  if (wavBuffer.toString("ascii", 0, 4) !== "RIFF" || wavBuffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV: Missing RIFF/WAVE header.");
  }

  const channels = wavBuffer.readUInt16LE(22);
  const sampleRate = wavBuffer.readUInt32LE(24);
  const bitDepth = wavBuffer.readUInt16LE(34);
  if (bitDepth !== 16) {
    return wavBuffer;
  }

  const data = findDataSubchunk(wavBuffer);
  if (!data) {
    throw new Error("Invalid WAV: Missing data chunk.");
  }

  const available = Math.max(0, wavBuffer.length - data.dataOffset);
  const payloadBytes = Math.min(data.dataSize, available);
  const sampleCount = Math.floor(payloadBytes / 2);
  const samples = new Int16Array(wavBuffer.buffer, wavBuffer.byteOffset + data.dataOffset, sampleCount);

  const { Mp3Encoder } = loadLamejs();
  const encoder = new Mp3Encoder(channels, sampleRate, 320);
  const blockSize = 1152;
  const chunks: Buffer[] = [];

  if (channels === 1) {
    for (let i = 0; i < samples.length; i += blockSize) {
      const mp3buf = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
      chunks.push(copyLameChunk(mp3buf));
    }
  } else {
    const left = new Int16Array(Math.floor(samples.length / 2));
    const right = new Int16Array(Math.floor(samples.length / 2));
    for (let i = 0; i < samples.length; i += 2) {
      left[i / 2] = samples[i] ?? 0;
      right[i / 2] = samples[i + 1] ?? 0;
    }
    for (let i = 0; i < left.length; i += blockSize) {
      const mp3buf = encoder.encodeBuffer(
        left.subarray(i, i + blockSize),
        right.subarray(i, i + blockSize),
      );
      chunks.push(copyLameChunk(mp3buf));
    }
  }

  chunks.push(copyLameChunk(encoder.flush()));
  const mp3Buffer = Buffer.concat(chunks);
  if (!isMp3FrameOrId3(mp3Buffer)) {
    return wavBuffer;
  }
  return mp3Buffer;
}
