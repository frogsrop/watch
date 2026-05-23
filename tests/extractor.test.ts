import { describe, it, expect, afterAll } from 'vitest';
import { extractM3U8, closeBrowser, ExtractorError } from '../src/extractor.js';

const KINOGO_URL = process.env.KINOGO_URL ?? 'https://lv.kinogo.ec/9957--pacany-1.html';
const LIVE = process.env.RUN_LIVE_TESTS === '1';

describe('extractor', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it.skipIf(!LIVE)('extracts m3u8 from kinogo page (live)', async () => {
    const result = await extractM3U8(KINOGO_URL, { timeoutMs: 60_000 });
    expect(result.m3u8).toMatch(/\.m3u8/);
    expect(result.referer).toContain('cinemar.cc');
    expect(result.cookies.length).toBeGreaterThan(0);
  }, 90_000);

  it.skipIf(!LIVE)('throws ExtractorError on bad URL (live)', async () => {
    await expect(
      extractM3U8('https://lv.kinogo.ec/this-page-does-not-exist-9999999.html', {
        timeoutMs: 15_000,
      }),
    ).rejects.toBeInstanceOf(ExtractorError);
  }, 30_000);

  it('rejects malformed URLs immediately', async () => {
    await expect(extractM3U8('not-a-url', { timeoutMs: 5_000 })).rejects.toThrow();
  }, 15_000);
});
