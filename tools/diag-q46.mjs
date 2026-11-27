/** 复现：题库选项顺序与页面不同（C/D 对调）时是否命中并答对 */
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

// 页面选项顺序：A B C(初步验收报告) D(客户评价结果) —— 与题库的 C/D 对调
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>单选题</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body>
<div class="q">
  <div class="qtext">项目移交时必须包含以下哪项资料？</div>
  <label class="option"><input type="radio" name="q46" value="A"><span>A. 项目设计方案（售前方案）</span></label>
  <label class="option"><input type="radio" name="q46" value="B"><span>B. 项目经验总结</span></label>
  <label class="option"><input type="radio" name="q46" value="C"><span>C. 项目初步验收报告</span></label>
  <label class="option"><input type="radio" name="q46" value="D"><span>D. 客户评价结果</span></label>
</div>
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8911, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
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
  await page.goto('http://127.0.0.1:8911/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8911')) || {}).id;
  });

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
        await d.fillOne(0);
        const picked = [...document.querySelectorAll('input:checked')].map(i => i.value);
        return {
          pageOptions: q && (q.options || []).map(o => o.label + ':' + o.text),
          kbMode: kb && kb.mode,
          kbExact: kb && kb.exact,
          kbAnswer: kb && kb.answer,
          kbTopQ: kb && kb.hits && kb.hits[0] && kb.hits[0].q,
          kbTopA: kb && kb.hits && kb.hits[0] && kb.hits[0].a,
          kbHits: kb && kb.hits && kb.hits.length,
          answer: res[0] && res[0].answer,
          src: res[0] && res[0].source && res[0].source.kind,
          picked
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log(JSON.stringify(out, null, 1));
  const ok = Array.isArray(out.picked) && out.picked.includes('A');
  console.log(`\n${ok ? 'PASS' : 'FAIL'} 应选 A，实际 ${JSON.stringify(out.picked)}`);

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
