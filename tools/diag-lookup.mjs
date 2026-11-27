/** 在浏览器里直接调用 kbLookup 诊断，避免走全流程 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8872;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-judge.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run']
});
try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;
  const KB = `1. 客户满意是服务人员最终价值体现，也是我们持续追求的目标。\nA. 错误\nB. 正确\n答案：B\n`;
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-test.txt', size: text.length, mime: 'text/plain', text });
  }, KB);
  await opt.close();

  await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: {
      baseUrl: '', apiKey: 'k', model: 'm', kbEnabled: true, kbDirect: true, kbTopK: 3,
      kbStrict: false, followMode: false, stealth: true, flashMs: 0, siteAllow: ''
    }});
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8872')) || {}).id;
  });
  const out = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: async () => {
      const list = await globalThis.__EXA_DEBUG__.extract();
      const q = list[0];
      const st = await globalThis.__EXA_DEBUG__.kbCheck();
      const settings = globalThis.__EXA_DEBUG__.settings ? await globalThis.__EXA_DEBUG__.settings() : null;
      return { q: { stem: q.stem, kind: q.kind, options: q.options }, st, settings };
    }});
    return r[0].result;
  }, tabId);
  console.log(JSON.stringify(out, null, 2));
} catch (e) { console.error(e); }
finally { await browser.close(); server.close(); }
