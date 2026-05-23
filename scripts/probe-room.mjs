import { chromium } from 'playwright';

const URL = process.argv[2];
if (!URL) {
  console.error('usage: node probe-room.mjs <room-url>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const consoleLines = [];
const requests = [];
const wsFrames = [];

page.on('console', (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
page.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes(URL.split('/')[2])) requests.push({ method: 'RESP', status: r.status(), url: u });
});
page.on('websocket', (ws) => {
  consoleLines.push(`[ws] open ${ws.url()}`);
  ws.on('framesent', (f) => wsFrames.push({ dir: 'send', payload: typeof f.payload === 'string' ? f.payload.slice(0, 200) : '<binary>' }));
  ws.on('framereceived', (f) => wsFrames.push({ dir: 'recv', payload: typeof f.payload === 'string' ? f.payload.slice(0, 200) : '<binary>' }));
  ws.on('close', () => consoleLines.push(`[ws] CLOSED ${ws.url()}`));
  ws.on('socketerror', (e) => consoleLines.push(`[ws] ERROR ${e}`));
});

await page.goto(URL, { waitUntil: 'load', timeout: 30_000 });
await page.waitForTimeout(8000);

console.log('=== console / pageerror / ws lifecycle ===');
for (const l of consoleLines) console.log(l);

console.log('\n=== HTTP requests (to our origin) ===');
for (const r of requests.slice(0, 40)) {
  console.log(JSON.stringify(r));
}

console.log('\n=== WS frames (first 20) ===');
for (const f of wsFrames.slice(0, 20)) {
  console.log(`${f.dir}: ${f.payload}`);
}

await browser.close();
