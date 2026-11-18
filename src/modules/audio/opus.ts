import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Speech } from '../ai/voice.js';

export interface OpusAudio { data: Buffer; duration: number }
export type Converter = (speech: Speech, signal: AbortSignal) => Promise<OpusAudio>;
export function createOpusConverter(ffmpeg = 'ffmpeg', temporaryRoot = tmpdir()): Converter {
  return async ({ pcm, sampleRate }, signal) => {
    signal.throwIfAborted();
    const directory = await mkdtemp(join(temporaryRoot, 'pilotai-voice-'));
    const input = join(directory, 'speech.pcm');
    const output = join(directory, 'speech.ogg');
    try {
      await writeFile(input, pcm, { mode: 0o600 });
      await new Promise<void>((done, reject) => {
        execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', input,
          '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-ar', '48000', '-ac', '1', '-f', 'ogg', output],
        { signal, timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 },
        (error) => {
          if (!error) { done(); return; }
          const code = signal.aborted ? 'VOICE_CANCELLED' : error.code === 'ENOENT' ? 'VOICE_FFMPEG_NOT_FOUND' :
            error.code === 'EACCES' || error.code === 'EPERM' ? 'VOICE_FFMPEG_PERMISSION' :
              error.killed ? 'VOICE_FFMPEG_TIMEOUT' : 'VOICE_FFMPEG';
          reject(new Error(code));
        });
      });
      signal.throwIfAborted();
      const data = await readFile(output);
      if (data.subarray(0, 4).toString() !== 'OggS' || !data.includes(Buffer.from('OpusHead'))) throw new Error('VOICE_OGG');
      return { data, duration: Math.max(1, Math.ceil(pcm.length / (sampleRate * 2))) };
    } finally {
      // Only delete the unique directory created here, inside the selected temp root.
      const target = resolve(directory);
      if (!target.startsWith(resolve(temporaryRoot) + sep) || !target.split(sep).at(-1)?.startsWith('pilotai-voice-')) {
        throw new Error('VOICE_TEMP_PATH');
      }
      await rm(target, { recursive: true, force: true });
    }
  };
}
