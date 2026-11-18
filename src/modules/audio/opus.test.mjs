import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createOpusConverter } from '../../../dist/modules/audio/opus.js';

test('real FFmpeg produces OGG/Opus and cleans temporary files on success, failure and cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pilotai-opus-test-'));
  t.after(async () => {
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    assert.ok(target.split(sep).at(-1).startsWith('pilotai-opus-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const speech = { pcm: Buffer.alloc(24000 * 2), sampleRate: 24000 };
  const result = await createOpusConverter(process.env.FFMPEG_PATH || 'ffmpeg', root)(speech, new AbortController().signal);
  assert.equal(result.data.subarray(0, 4).toString(), 'OggS');
  assert.ok(result.data.includes(Buffer.from('OpusHead')));
  assert.equal(result.duration, 1);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(createOpusConverter(join(root, 'missing-ffmpeg'), root)(speech, new AbortController().signal), /VOICE_FFMPEG/);
  assert.deepEqual(await readdir(root), []);
  const controller = new AbortController();
  const work = createOpusConverter(process.env.FFMPEG_PATH || 'ffmpeg', root)(speech, controller.signal);
  controller.abort();
  await assert.rejects(work);
  assert.deepEqual(await readdir(root), []);
});
