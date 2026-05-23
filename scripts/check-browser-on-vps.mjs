import { chromium } from 'playwright';
const channel = process.env.WATCH_CHROME_CHANNEL || undefined;
const b = await chromium.launch({ channel, headless: false, args: ['--no-sandbox'] });
console.log('version:', await b.version());
const ctx = await b.newContext();
const p = await ctx.newPage();
const ua = await p.evaluate(() => navigator.userAgent);
const canH264 = await p.evaluate(() => {
  const v = document.createElement('video');
  return {
    h264: v.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    hls: v.canPlayType('application/vnd.apple.mpegurl'),
  };
});
console.log('UA:', ua);
console.log('canPlay:', JSON.stringify(canH264));
await b.close();
