import { describe, it, expect } from 'vitest';
import {
  isAllowedHost,
  signUrl,
  verifyUrl,
  buildProxyPath,
  decodeProxyPath,
  rewriteManifest,
} from '../src/hls-proxy.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const ROOM = 'roomXYZ';
const SELF = 'https://watch.example.com';

describe('isAllowedHost', () => {
  it('allows cinemap.cc subdomains', () => {
    expect(isAllowedHost('https://v206.cinemap.cc/foo/hls.m3u8')).toBe(true);
    expect(isAllowedHost('https://cinemap.cc/foo')).toBe(true);
  });
  it('allows cinemar.cc', () => {
    expect(isAllowedHost('https://cinemar.cc/static/preview/479/x.vtt')).toBe(true);
  });
  it('rejects arbitrary domains', () => {
    expect(isAllowedHost('https://evil.com/anything')).toBe(false);
    expect(isAllowedHost('not a url')).toBe(false);
  });
});

describe('signUrl / verifyUrl', () => {
  it('signs and verifies round-trip', () => {
    const url = 'https://v206.cinemap.cc/abc/seg.ts';
    const sig = signUrl(ROOM, url, SECRET);
    expect(verifyUrl(ROOM, url, sig, SECRET)).toBe(true);
  });
  it('rejects wrong sig', () => {
    const url = 'https://v206.cinemap.cc/abc/seg.ts';
    const sig = signUrl(ROOM, url, SECRET);
    expect(verifyUrl(ROOM, url, sig.slice(0, -1) + 'X', SECRET)).toBe(false);
  });
  it('rejects sig from different room', () => {
    const url = 'https://v206.cinemap.cc/abc/seg.ts';
    const sig = signUrl('otherRoom', url, SECRET);
    expect(verifyUrl(ROOM, url, sig, SECRET)).toBe(false);
  });
});

describe('buildProxyPath / decodeProxyPath', () => {
  it('round-trips a URL through encode/decode', () => {
    const url = 'https://v206.cinemap.cc/md5(abc,1234)/tvseries/x/y/hls.m3u8?token=z';
    const path = buildProxyPath(ROOM, url, SECRET, SELF);
    const m = path.match(/\/hls\/[^/]+\/p\/([^.]+)\.([^/]+)$/);
    expect(m).toBeTruthy();
    expect(decodeProxyPath(m![1]!)).toBe(url);
  });
});

describe('rewriteManifest', () => {
  it('rewrites absolute segment URLs', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.000,',
      'https://v206.cinemap.cc/abc/seg0.ts',
      '#EXTINF:6.000,',
      'https://v206.cinemap.cc/abc/seg1.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    const rewritten = rewriteManifest(
      manifest,
      'https://v206.cinemap.cc/abc/playlist.m3u8',
      ROOM,
      SECRET,
      SELF,
    );

    expect(rewritten).toContain(`${SELF}/hls/${ROOM}/p/`);
    expect(rewritten).not.toContain('v206.cinemap.cc/abc/seg0.ts');
    expect(rewritten).toContain('#EXTINF:6.000,');
    expect(rewritten).toContain('#EXT-X-ENDLIST');
  });

  it('rewrites relative segment URLs (resolves against base)', () => {
    const manifest = ['#EXTM3U', '#EXTINF:6.000,', 'seg0.ts', '#EXTINF:6.000,', 'seg1.ts'].join('\n');
    const rewritten = rewriteManifest(
      manifest,
      'https://v206.cinemap.cc/abc/playlist.m3u8',
      ROOM,
      SECRET,
      SELF,
    );
    const encodedSeg0 = Buffer.from(
      'https://v206.cinemap.cc/abc/seg0.ts',
      'utf8',
    ).toString('base64url');
    expect(rewritten).toContain(encodedSeg0);
  });

  it('rewrites URI="..." attributes in #EXT-X tags', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ru",URI="audio_ru.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=500000',
      'variant_low.m3u8',
    ].join('\n');
    const rewritten = rewriteManifest(
      manifest,
      'https://v206.cinemap.cc/abc/master.m3u8',
      ROOM,
      SECRET,
      SELF,
    );
    expect(rewritten).toMatch(/URI="https:\/\/watch\.example\.com\/hls\/roomXYZ\/p\/[^"]+"/);
    expect(rewritten).toContain(`${SELF}/hls/${ROOM}/p/`);
  });

  it('leaves disallowed hosts unchanged', () => {
    const manifest = '#EXTM3U\n#EXTINF:6.000,\nhttps://evil.com/seg0.ts\n';
    const rewritten = rewriteManifest(
      manifest,
      'https://v206.cinemap.cc/abc/playlist.m3u8',
      ROOM,
      SECRET,
      SELF,
    );
    expect(rewritten).toContain('https://evil.com/seg0.ts');
  });
});
