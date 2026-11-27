/** 截图：展示页面答案来源与新按钮 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-answers.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(8798, '127.0.0.1', r));

const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 940 }
});
const sw = await b.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
const w = await sw.worker();
await w.evaluate(async () => {
  await chrome.storage.local.set({
    settings: {
      baseUrl: 'https://api.deepseek.com/v1', apiKey: '{{SECRET_kne5jgiu}}',
      model: 'deepseek-chat', visionModel: '', temperature: 0.2, maxTokens: 2048,
      timeoutSec: 90, doubleCheck: false, autoFillAfterSolve: true,
      extraHeaders: '', systemPrompt: '', kbEnabled: true, kbDirect: true,
      cacheEnabled: true, cacheTtlDays: 7, skipAnswered: true, concurrency: 2
    }
  });
});

const p = await b.newPage();
await p.goto('http://127.0.0.1:8798/exam-answers.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 900));

const tabId = await w.evaluate(async () => {
  const all = await chrome.tabs.query({});
  return (all.find(t => t.url && t.url.includes('exam-answers')) || {}).id;
});
await w.evaluate(async tid => {
  await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: () => globalThis.__EXA_DEBUG__.solveAll()
  });
}, tabId);

await new Promise(r => setTimeout(r, 3500));
await p.screenshot({ path: path.join(ROOT, 'docs', 'shot-opt-panel.png') });
console.log('saved docs/shot-opt-panel.png');
await b.close();
server.close();
