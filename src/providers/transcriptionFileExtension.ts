// OpenAI's /audio/transcriptions decides an upload's format from its file
// name, so the name has to say what the bytes are. Naming every MIME type
// outside the TTS output list "audio.wav" (the old behavior) sent Discord
// voice messages (audio/ogg) and MP3s (audio/mpeg) as fake WAVs, and
// gpt-4o-transcribe answered each one "400 This model does not support
// the format".

const TRANSCRIPTION_EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/aac": "aac",
  "audio/pcm": "pcm",
};

/**
 * The file extension to upload `mimeType` audio under. Parameters such as
 * `; codecs=opus` are ignored; an unknown type keeps the old "wav" default.
 */
export function transcriptionFileExtension(mimeType: string): string {
  const baseType = mimeType.split(";")[0].trim().toLowerCase();
  return TRANSCRIPTION_EXTENSIONS[baseType] ?? "wav";
}
