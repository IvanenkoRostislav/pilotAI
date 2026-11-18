// Explicit diagnostic only: no Telegram connection, no account/session access.
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createVoiceService, DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_TTS_MODEL } from '../dist/modules/ai/voice.js';
import { createOpusConverter } from '../dist/modules/audio/opus.js';
dotenv.config({ quiet: true });
if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
const config = {
  apiKey: process.env.GEMINI_API_KEY,
  transcriptionModel: process.env.GEMINI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
  ttsModel: process.env.GEMINI_TTS_MODEL || DEFAULT_TTS_MODEL,
  voice: process.env.GEMINI_TTS_VOICE || 'Kore',
};
const ai = new GoogleGenAI({ apiKey: config.apiKey, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });
let failed = false;
for (const model of [config.transcriptionModel, config.ttsModel]) {
  try {
    const info = await ai.models.get({ model });
    console.log(JSON.stringify({ model, available: true, supportedActions: info.supportedActions,
      inputTokenLimit: info.inputTokenLimit, outputTokenLimit: info.outputTokenLimit }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ model, available: false, status: error.status ?? null }));
  }
}
// This opt-in probe consumes API quota: a short synthetic greeting only.
if (!failed && process.argv.includes('--smoke')) {
  try {
    const service = createVoiceService(config);
    const signal = AbortSignal.timeout(90_000);
    const audio = await createOpusConverter(process.env.FFMPEG_PATH || 'ffmpeg')(
      await service.synthesise('Good afternoon. May I book a table for two, please?', signal), signal);
    const transcript = await service.transcribe(audio.data, signal);
    console.log(JSON.stringify({ smoke: true, oggOpus: true, duration: audio.duration, transcript }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ smoke: false, error: /^VOICE_/.test(error.message) ? error.message : 'PROBE_FAILED' }));
  }
}
process.exitCode = failed ? 1 : 0;
