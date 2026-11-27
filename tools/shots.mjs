/** 生成 options / popup 界面截图（docs/） */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';

const b = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--no-first-run'],
  defaultViewport: { width: 980, height: 1180 }
});
const sw = await b.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
const worker = await sw.worker();
const extId = new URL(sw.url()).host;

await worker.evaluate(async () => {
  await chrome.storage.local.set({
    settings: {
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo-xxxxxxxxxxxxxxxx',
      model: 'deepseek-chat', visionModel: '', temperature: 0.2, maxTokens: 2048,
      timeoutSec: 90, doubleCheck: true, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: ''
    }
  });
});

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });

const o = await b.newPage();
await o.setViewport({ width: 980, height: 1180 });
await o.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 400));
await o.screenshot({ path: path.join(ROOT, 'docs', 'shot-options.png'), fullPage: true });

const p = await b.newPage();
await p.setViewport({ width: 330, height: 340 });
await p.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: path.join(ROOT, 'docs', 'shot-popup.png') });

console.log('extension id =', extId);
await b.close();
