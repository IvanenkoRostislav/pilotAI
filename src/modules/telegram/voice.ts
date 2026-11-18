import { Api, type TelegramClient } from 'teleproto';
import type { VoiceService } from '../ai/voice.js';
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, VoiceError } from '../ai/voice.js';
import type { Converter } from '../audio/opus.js';
import { errorInfo, type Logger } from '../logger/logger.js';

export function voiceDocument(message: Api.Message): Api.Document | undefined {
  if (!(message.media instanceof Api.MessageMediaDocument)) return;
  const document = message.media.document;
  if (!(document instanceof Api.Document)) return;
  const audio = document.attributes.find((a) => a instanceof Api.DocumentAttributeAudio && a.voice);
  if (!audio) return;
  if (Number(document.size) > MAX_VOICE_BYTES || (audio as Api.DocumentAttributeAudio).duration > MAX_VOICE_SECONDS) {
    throw new Error('VOICE_SIZE');
  }
  if (document.mimeType !== 'audio/ogg') throw new Error('VOICE_FORMAT');
  return document;
}

export async function deliverVoice(
  client: TelegramClient, target: Api.User, service: VoiceService, convert: Converter,
  text: string, signal: AbortSignal, audit: Logger, sessionId: string | null,
  isCurrent: () => boolean = () => true,
): Promise<'voice' | 'text'> {
  let audio;
  let stage: 'tts' | 'ffmpeg' = 'tts';
  try {
    const speech = await service.synthesise(text, signal);
    stage = 'ffmpeg';
    audio = await convert(speech, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('AGENT_SUPERSEDED');
    audit.technical('warn', 'voice.text_fallback', { stage, ...errorInfo(error),
      ...(error instanceof VoiceError ? { model: error.model } : {}) }, sessionId);
    return 'text';
  }
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error('AGENT_SUPERSEDED');
  // Buffer avoids temporary upload files; the .ogg name supplies audio/ogg MIME.
  const file = Object.assign(audio.data, { name: 'reply.ogg' });
  // Do not retry with text on uncertain Telegram delivery (would risk duplicates).
  await client.sendFile(target, { file, voiceNote: true, forceDocument: false,
    attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: audio.duration })],
    caption: '', formattingEntities: [] });
  return 'voice';
}
