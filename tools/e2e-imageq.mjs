/**
 * 图片题识别：canvas 画的题 → OCR → 结构化题目 → 走知识库
 *   node tools/e2e-imageq.mjs
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

const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>图片题</title>
<style>body{font:15px/1.7 system-ui;margin:20px}canvas{border:1px solid #ddd;max-width:760px;display:block}</style>
</head><body>
<div class="card"><canvas id="cv" width="1520" height="620"></canvas></div>
<script>
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height);
ctx.fillStyle='#111'; ctx.font='bold 34px "Microsoft YaHei",sans-serif';
ctx.fillText('1. 下列关于 TCP 协议的说法，正确的是（ ）', 48, 90);
ctx.font='30px "Microsoft YaHei",sans-serif';
['A. TCP 是无连接协议','B. TCP 提供可靠传输','C. TCP 不保证顺序','D. TCP 工作在网络层']
  .forEach((t,i)=>ctx.fillText(t, 76, 170+i*62));
</script></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8940, '127.0.0.1', r));

/* Mock 模型：带图片的请求返回 OCR 结果，纯文本请求返回解题结果 */
let ocrCalls = 0, solveCalls = 0;
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const hasImage = body.includes('image_url');
    let payload;
    if (hasImage) {
      ocrCalls++;
      payload = {
        stem: '下列关于 TCP 协议的说法，正确的是（ ）',
        kind: 'single',
        options: [
          { label: 'A', text: 'TCP 是无连接协议' },
          { label: 'B', text: 'TCP 提供可靠传输' },
          { label: 'C', text: 'TCP 不保证顺序' },
          { label: 'D', text: 'TCP 工作在网络层' }
        ]
      };
    } else {
      solveCalls++;
      payload = { type: 'single', answer: 'B', confidence: 0.92, reasoning: 'TCP 是面向连接的可靠传输协议' };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise(r => api.listen(8941, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 }
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:8941/v1', apiKey: 'k', model: 'mock-text', visionModel: 'mock-vision',
    temperature: 0.2, maxTokens: 1200, timeoutSec: 15, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  /* 知识库里放这道题，验证图片题也能命中知识库 */
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. 下列关于 TCP 协议的说法，正确的是（ ）？
A. TCP 是无连接协议
B. TCP 提供可靠传输
C. TCP 不保证顺序
D. TCP 工作在网络层
答案：B
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'tcp.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8940/', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8940')) || {}).id;
  });

  /* 1) 先确认 DOM 里确实没有可读文字 */
  const domInfo = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({
        textLen: (document.body.innerText || '').trim().length,
        canvases: document.querySelectorAll('canvas').length,
        normal: qxExtract.extractAll({ fallback: true }).length
      })
    });
    return r[0].result;
  }, tabId);
  console.log('页面情况:', JSON.stringify(domInfo));
  check('DOM 里没有可读题目（确实是图片题）', domInfo.normal === 0 && domInfo.canvases > 0, JSON.stringify(domInfo));

  /* 2) 找图 + OCR */
  const ocr = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const imgs = qxExtract.findQuestionImages(6);
        if (!imgs.length) return { found: 0 };
        const resp = await chrome.runtime.sendMessage({ type: 'ocr-question', dataUrl: imgs[0].dataUrl });
        return {
          found: imgs.length,
          urlLen: imgs[0].dataUrl.length,
          kind: imgs[0].kind,
          ocr: resp
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log('找图结果:', JSON.stringify({ found: ocr.found, urlLen: ocr.urlLen, kind: ocr.kind }));
  console.log('OCR 结果:', JSON.stringify(ocr.ocr));

  check('找到题目图片', ocr.found > 0, String(ocr.found));
  check('图片转成了 dataURL', (ocr.urlLen || 0) > 1000, String(ocr.urlLen));
  check('OCR 成功返回题目', !!(ocr.ocr && ocr.ocr.ok), JSON.stringify(ocr.ocr && ocr.ocr.error));
  check('识别出题干', !!(ocr.ocr && ocr.ocr.stem && ocr.ocr.stem.includes('TCP')), String(ocr.ocr && ocr.ocr.stem));
  check('识别出 4 个选项', !!(ocr.ocr && ocr.ocr.options && ocr.ocr.options.length === 4), String(ocr.ocr && ocr.ocr.options && ocr.ocr.options.length));
  check('题型判为单选', !!(ocr.ocr && ocr.ocr.kind === 'single'), String(ocr.ocr && ocr.ocr.kind));
  check('确实调用了视觉模型', ocrCalls > 0, String(ocrCalls));

  /* 3) 完整流程：识别 → 解题（应命中知识库） */
  const full = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const imgs = qxExtract.findQuestionImages(6);
        const resp = await chrome.runtime.sendMessage({ type: 'ocr-question', dataUrl: imgs[0].dataUrl });
        if (!resp || !resp.ok) return { error: resp && resp.error };
        const kb = await chrome.runtime.sendMessage({
          type: 'kbTest', question: resp.stem, options: resp.options, kind: resp.kind
        });
        return {
          stem: resp.stem,
          kbMode: kb && kb.mode,
          kbAnswer: kb && kb.answer,
          topQ: kb && kb.hits && kb.hits[0] && kb.hits[0].q
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log('完整链路:', JSON.stringify(full, null, 1));
  check('OCR 出的题干能命中知识库', full.kbMode === 'kb', `mode=${full.kbMode}`);
  check('知识库给出正确答案 B', full.kbAnswer === 'B', String(full.kbAnswer));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  api.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
