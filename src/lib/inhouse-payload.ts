// src/lib/inhouse-payload.ts

export interface InHousePayload {
  genre_lock: string;
  style_prompt: string;
  lyrics: string;
  timestamp: string;
}

export function buildInHousePayload(genreLock: string, stylePrompt: string, lyrics?: string): InHousePayload {
  return {
    genre_lock: genreLock,
    style_prompt: stylePrompt.trim(),
    lyrics: lyrics || "",
    timestamp: new Date().toISOString()
  };
}
