import { describe, expect, it } from "vitest";
import { isMp3FrameOrId3, wavToMp3 } from "@/lib/audio/wavToMp3";

function pcm16Wav(channels: number, junkBeforeData: boolean): Buffer {
  const sampleRate = 44100;
  const frames = 1152;
  const dataLen = frames * channels * 2;
  const junkLen = junkBeforeData ? 8 : 0;
  const dataHeaderAt = 36 + junkLen;
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
  if (junkLen > 0) {
    buffer.write("JUNK", 36);
    buffer.writeUInt32LE(junkLen, 40);
  }
  buffer.write("data", dataHeaderAt);
  buffer.writeUInt32LE(dataLen, dataHeaderAt + 4);
  for (let i = 0; i < frames * channels; i++) {
    buffer.writeInt16LE((i % 50) - 25, pcmAt + i * 2);
  }
  return buffer;
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
    const shifted = pcm16Wav(2, true);
    expect(shifted.toString("ascii", 44, 48)).not.toBe("data");
    const plain = pcm16Wav(2, false);
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
