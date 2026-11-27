/**
 * 真实站点：多选实际填涂 + 答案标签是否显示
 *   node tools/diag-multifill.mjs
 */
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
const web = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const f = path.join(SITE, url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => web.listen(8924, '127.0.0.1', r));

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
    temperature: 0.2, maxTokens: 512, timeoutSec: 3, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashMs: 1500, siteAllow: ''
  });

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
  await page.goto('http://127.0.0.1:8924/', { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8924')) || {}).id;
  });

  /* 走到第一道多选题 */
  let found = false;
  for (let i = 0; i < 30; i++) {
    const kind = await page.evaluate(() => {
      const b = document.querySelector('.qmeta .badge');
      return b ? b.textContent.trim() : '';
    });
    if (kind === '多选题') { found = true; break; }
    const moved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /下一题/.test(x.innerText));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!moved) break;
    await sleep(280);
  }
  console.log('找到多选题:', found);
  if (!found) throw new Error('本次抽题没有多选题');

  const out = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        const list = await d.extract();
        const q = list[0];
        const kb = await d.kbCheck();
        await d.solveAll();
        const res = d.results();
        const before = [...document.querySelectorAll('.option.on')].map(b => b.dataset.i);
        await d.fillOne(0);
        await new Promise(r => setTimeout(r, 400));
        const after = [...document.querySelectorAll('.option.on')].map(b => b.dataset.i);
        return {
          kind: q && q.kind,
          optCount: (q.options || []).length,
          kbMode: kb && kb.mode,
          kbAnswer: kb && kb.answer,
          answer: res[0] && res[0].answer,
          src: res[0] && res[0].source && res[0].source.kind,
          before, after,
          ansTag: (document.querySelector('.anstag') || {}).textContent || '(无标签)',
          flashInfo: (typeof qxOverlay !== "undefined" && qxOverlay.lastFlashInfo) ? qxOverlay.lastFlashInfo() : null
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log(JSON.stringify(out, null, 1));
  const n = (out.after || []).length;
  console.log(`\n${n >= 2 ? 'PASS' : 'FAIL'} 多选题选中 ${n} 个：${JSON.stringify(out.after)}`);

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
