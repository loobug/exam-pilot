/**
 * 真实考试站点全卷体检：每道题是否命中知识库、答案是否正确
 *   node tools/diag-siteaudit.mjs
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
await new Promise(r => web.listen(8920, '127.0.0.1', r));

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
    kbStrict: false, flashMs: 0, siteAllow: ''
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
  await page.goto('http://127.0.0.1:8920/', { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8920')) || {}).id;
  });

  /* 逐题走一遍：识别当前题 → kbCheck → 记录 */
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r = await worker.evaluate(async tid => {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          d.clearResults();
          const list = await d.extract();
          if (!list.length) return null;
          const q = list[0];
          const kb = await d.kbCheck();
          return {
            stem: String(q.stem || '').replace(/\s+/g, ' ').slice(0, 34),
            opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 14)),
            mode: kb && kb.mode,
            exact: kb && kb.exact,
            answer: kb && kb.answer,
            topQ: kb && kb.hits && kb.hits[0] && String(kb.hits[0].q).slice(0, 30),
            topA: kb && kb.hits && kb.hits[0] && kb.hits[0].a
          };
        }
      });
      return out[0].result;
    }, tabId);
    if (!r) break;
    rows.push(r);
    const moved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /下一题|下一頁|下一页/.test(x.innerText));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!moved) break;
    await sleep(320);
  }

  console.log(`\n共 ${rows.length} 题\n`);
  let hit = 0;
  rows.forEach((r, i) => {
    const mark = r.mode === 'kb' ? '✓' : (r.mode === 'kb+ai' ? '~' : '✗');
    if (r.mode === 'kb') hit++;
    console.log(`${mark} ${String(i + 1).padStart(2)} [${r.mode || '-'}${r.exact ? '/exact' : ''}] ${r.stem}`);
    if (r.mode !== 'kb') {
      console.log(`     页面选项: ${JSON.stringify(r.opts)}`);
      console.log(`     库最像: ${r.topQ || '无'}  →  库答案 ${r.topA || '-'}`);
    }
  });
  console.log(`\n直接命中 ${hit}/${rows.length}（${Math.round(hit / rows.length * 100)}%）`);

  /* 重点：项目移交那道 */
  const target = rows.find(r => /项目移交/.test(r.stem));
  console.log('\n=== 项目移交那道题 ===');
  console.log(JSON.stringify(target, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
