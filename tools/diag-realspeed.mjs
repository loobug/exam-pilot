/** 真实考试页全流程计时：识别 / 解题 / 填涂各花多久 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const web = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const f = path.join(SITE, url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => web.listen(8900, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 10, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5, kbStrict: false, flashMs: 0, siteAllow: ''
  });

  // 导入真实题库
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8900/', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(800);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8900')) || {}).id;
  });

  /* 1) 单题全流程分段计时 */
  const single = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        const marks = {};
        let t = performance.now();
        d.clearResults();
        const list = await d.extract();
        marks.extractAll = Math.round(performance.now() - t);
        marks.n = list.length;

        t = performance.now();
        const kb = await d.kbCheck();
        marks.kbCheck = Math.round(performance.now() - t);
        marks.kbMode = kb && kb.mode;

        t = performance.now();
        await d.solveAll();
        marks.solveAll = Math.round(performance.now() - t);

        t = performance.now();
        await d.fillOne(0);
        marks.fill = Math.round(performance.now() - t);

        const res = d.results();
        marks.src = res[0] && res[0].source && res[0].source.kind;
        marks.ms = res[0] && res[0].__ms;
        return marks;
      }
    });
    return r[0].result;
  }, tabId);
  console.log('\n=== 单题全流程（真实题库）===');
  console.log(JSON.stringify(single, null, 1));

  /* 2) 连续 5 题：每题解+填 */
  const series = [];
  for (let i = 0; i < 5; i++) {
    const t = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          const t0 = performance.now();
          d.clearResults();
          const list = await d.extract();
          const t1 = performance.now();
          if (!list.length) return { err: 'no-q' };
          await d.solveAll();
          const t2 = performance.now();
          await d.fillOne(0);
          const t3 = performance.now();
          const res = d.results();
          return {
            extract: Math.round(t1 - t0),
            solve: Math.round(t2 - t1),
            fill: Math.round(t3 - t2),
            src: res[0] && res[0].source && res[0].source.kind
          };
        }
      });
      return r[0].result;
    }, tabId);
    series.push(t);
    // 翻到下一题
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /下一题/.test(x.innerText));
      if (b) b.click();
    });
    await sleep(300);
  }
  console.log('\n=== 连续 5 题 ===');
  series.forEach((x, i) => console.log(`#${i + 1}`, JSON.stringify(x)));
  const sum = k => series.reduce((a, x) => a + (x[k] || 0), 0);
  console.log(`合计：识别 ${sum('extract')}ms / 解题 ${sum('solve')}ms / 填涂 ${sum('fill')}ms`);

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
