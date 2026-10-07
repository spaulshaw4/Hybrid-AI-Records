import { describe, expect, it } from "vitest";
import { isMp3FrameOrId3, wavToMp3 } from "@/lib/audio/wavToMp3";

function pcm16Wav(channels: number, factBeforeData: boolean): Buffer {
  const sampleRate = 44100;
  const frames = 1152;
  const dataLen = frames * channels * 2;
  // A real fact chunk (8-byte header + 4-byte sample-count payload) sits between
  // fmt and data, so the data id starts at offset 48 rather than 44.
  const factPayloadLen = 4;
  const factChunkLen = factBeforeData ? 8 + factPayloadLen : 0;
  const dataHeaderAt = 36 + factChunkLen;
  const pcmAt = dataHeaderAt + 8;
  const buffer = Buffer.alloc(pcmAt + dataLen);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  if (factBeforeData) {
    buffer.write("fact", 36);
    buffer.writeUInt32LE(factPayloadLen, 40);
    buffer.writeUInt32LE(frames, 44);
  }
  buffer.write("data", dataHeaderAt);
  buffer.writeUInt32LE(dataLen, dataHeaderAt + 4);
  for (let i = 0; i < frames * channels; i++) {
    buffer.writeInt16LE((i % 50) - 25, pcmAt + i * 2);
  }
  return buffer;
}

function createShiftedWavBuffer(sampleCount = 1152): Buffer {
  const numChannels = 2;
  const sampleRate = 44100;
  const bitsPerSample = 16;
  const dataSize = sampleCount * numChannels * (bitsPerSample / 8);
  const junkChunkId = "JUNK";
  const junkChunkData = Buffer.alloc(12, 0);
  const junkChunkSize = junkChunkData.length;
  const riffSize = 4 + 24 + (8 + junkChunkSize) + (8 + dataSize);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0);
  header.writeInt32LE(riffSize, 4);
  header.write("WAVE", 8);
  const fmtChunk = Buffer.alloc(24);
  fmtChunk.write("fmt ", 0);
  fmtChunk.writeInt32LE(16, 4);
  fmtChunk.writeInt16LE(1, 8);
  fmtChunk.writeInt16LE(numChannels, 10);
  fmtChunk.writeInt32LE(sampleRate, 12);
  fmtChunk.writeInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 16);
  fmtChunk.writeInt16LE(numChannels * (bitsPerSample / 8), 20);
  fmtChunk.writeInt16LE(bitsPerSample, 22);
  const junkChunk = Buffer.alloc(8 + junkChunkSize);
  junkChunk.write(junkChunkId, 0);
  junkChunk.writeInt32LE(junkChunkSize, 4);
  junkChunkData.copy(junkChunk, 8);
  const dataChunkHeader = Buffer.alloc(8);
  dataChunkHeader.write("data", 0);
  dataChunkHeader.writeInt32LE(dataSize, 4);
  const samples = Buffer.alloc(dataSize);
  for (let i = 0; i < samples.length; i += 2) {
    samples.writeInt16LE(1000, i);
  }
  return Buffer.concat([header, fmtChunk, junkChunk, dataChunkHeader, samples]);
}

function expectMp3(bytes: Buffer): void {
  expect(bytes.subarray(0, 4).toString("ascii")).not.toBe("RIFF");
  expect(isMp3FrameOrId3(bytes)).toBe(true);
  const frame = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
  const id3 = bytes.subarray(0, 3).toString("ascii") === "ID3";
  expect(frame || id3).toBe(true);
}

describe("wavToMp3", () => {
  it("throws when the buffer is smaller than 44 bytes", () => {
    expect(() => wavToMp3(Buffer.alloc(10))).toThrow("Invalid WAV: Buffer smaller than 44 bytes.");
  });

  it("throws when the RIFF/WAVE header is missing", () => {
    const bytes = Buffer.alloc(44);
    bytes.write("RIFF", 0);
    bytes.write("XXXX", 8);
    expect(() => wavToMp3(bytes)).toThrow("Invalid WAV: Missing RIFF/WAVE header.");
  });

  it("returns the same WAV bytes when the file is not 16-bit", () => {
    const wav = pcm16Wav(1, false);
    wav.writeUInt16LE(24, 34);
    expect(wavToMp3(wav)).toBe(wav);
    expect(isMp3FrameOrId3(wav)).toBe(false);
  });

  it("encodes 16-bit stereo PCM when the data chunk is not at offset 44", () => {
    const shifted = createShiftedWavBuffer();
    expect(shifted.toString("ascii", 44, 48)).not.toBe("data");
    expect(shifted.toString("ascii", 56, 60)).toBe("data");
    const plain = pcm16Wav(2, false);
    for (let i = 44; i < plain.length; i += 2) {
      plain.writeInt16LE(1000, i);
    }
    const mp3 = wavToMp3(shifted);
    expectMp3(mp3);
    expect(Buffer.compare(mp3, wavToMp3(plain))).toBe(0);
  });

  it("copies lame chunks by byteOffset and byteLength when the WAV sits in a larger pool", () => {
    const wav = pcm16Wav(1, false);
    const pooled = Buffer.concat([Buffer.alloc(32, 0x7f), wav]);
    const view = pooled.subarray(32);
    expect(view.byteOffset).toBeGreaterThan(0);
    const mp3 = wavToMp3(view);
    expectMp3(mp3);
    expect(Buffer.compare(mp3, wavToMp3(Buffer.from(wav)))).toBe(0);
  });
});
