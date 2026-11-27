/** 分段计时：识别 / 知识库 / 模型各花多久 */
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

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>计时用</title></head><body>
<div class="qtext" id="stem">接到工单后多长时间内要主动联系客户？</div>
<label class="option"><input type="radio" name="q" value="A"><span>A. 一小时</span></label>
<label class="option"><input type="radio" name="q" value="B"><span>B. 两小时</span></label>
<label class="option"><input type="radio" name="q" value="C"><span>C. 30 分钟</span></label>
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => web.listen(8898, '127.0.0.1', r));

// Mock 模型：延迟 800ms（模拟真实 API）
let apiCalls = 0;
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    apiCalls += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const payload = { type: 'single', answer: 'C', confidence: 0.9, reasoning: 'mock' };
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 800);
  });
});
await new Promise(r => api.listen(8899, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:8899/v1', apiKey: 'k', model: 'mock',
    visionModel: '', temperature: 0.2, maxTokens: 512, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 5, kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. 接到工单后多长时间内要主动联系客户？
A. 一小时
B. 两小时
C. 30 分钟
答案：C
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8898/', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8898')) || {}).id;
  });

  /* 库内题：分段计时 */
  apiCalls = 0;
  const t0 = Date.now();
  const kbPath = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        const marks = {};
        let t = performance.now();
        d.clearResults();
        const list = await d.extract();
        marks.extract = Math.round(performance.now() - t);

        t = performance.now();
        await d.solveAll();
        marks.solveAll = Math.round(performance.now() - t);

        const res = d.results();
        marks.answer = res[0] && res[0].answer;
        marks.src = res[0] && res[0].source && res[0].source.kind;

        // 单独测一次纯知识库查询
        const kb = await chrome.runtime.sendMessage({
          type: 'kbTest', question: list[0].stem, options: list[0].options
        });
        marks.kbTest = kb && kb.mode;
        return marks;
      }
    });
    return r[0].result;
  }, tabId);
  const kbTotal = Date.now() - t0;
  console.log('\n=== 库内题（命中知识库）===');
  console.log(JSON.stringify(kbPath), '总耗时', kbTotal + 'ms', '模型调用', apiCalls + ' 次');

  /* 库外题 */
  await page.evaluate(() => { document.getElementById('stem').textContent = '这道题知识库里完全没有收录，测试走模型要多久？'; });
  await sleep(200);
  apiCalls = 0;
  const t1 = Date.now();
  const aiPath = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        const marks = {};
        let t = performance.now();
        d.clearResults();
        const list = await d.extract();
        marks.extract = Math.round(performance.now() - t);
        t = performance.now();
        await d.solveAll();
        marks.solveAll = Math.round(performance.now() - t);
        const res = d.results();
        marks.src = res[0] && res[0].source && res[0].source.kind;
        return marks;
      }
    });
    return r[0].result;
  }, tabId);
  const aiTotal = Date.now() - t1;
  console.log('\n=== 库外题（走模型）===');
  console.log(JSON.stringify(aiPath), '总耗时', aiTotal + 'ms', '模型调用', apiCalls + ' 次');

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); api.close(); }
