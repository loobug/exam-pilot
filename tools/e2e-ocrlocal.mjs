/**
 * 本地 OCR（Tesseract）：canvas 图片题 → 离线识别 → 结构化题目
 *   node tools/e2e-ocrlocal.mjs
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

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>本地OCR</title>
<style>body{font:15px/1.7 system-ui;margin:20px}canvas{border:1px solid #ddd;max-width:900px;display:block;background:#fff}</style>
</head><body>
<canvas id="cv" width="1400" height="520"></canvas>
<script>
const cv=document.getElementById('cv'), ctx=cv.getContext('2d');
ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height);
ctx.fillStyle='#000'; ctx.font='bold 40px "Microsoft YaHei",sans-serif';
ctx.fillText('1. 下列关于 TCP 协议的说法，正确的是（ ）', 40, 80);
ctx.font='36px "Microsoft YaHei",sans-serif';
['A. TCP 是无连接协议','B. TCP 提供可靠传输','C. TCP 不保证顺序','D. TCP 工作在网络层']
  .forEach((t,i)=>ctx.fillText(t, 70, 160+i*80));
</script></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8950, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 }
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'm', visionModel: '',
    ocrEngine: 'local',
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(400);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8950/', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8950')) || {}).id;
  });

  /* 1) 引擎状态（会创建 offscreen 并加载 Tesseract） */
  console.log('正在初始化本地 OCR 引擎（首次要加载 wasm + 语言包，可能要 10-30 秒）…');
  const t0 = Date.now();
  const st = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'ocr-engine-status' }));
  const bootMs = Date.now() - t0;
  console.log('引擎状态:', JSON.stringify(st), '耗时', bootMs + 'ms');
  check('本地 OCR 引擎可用', !!(st && st.ok && st.ready), JSON.stringify(st));

  /* 2) 直接识别图片 */
  const t1 = Date.now();
  const imgData = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const imgs = qxExtract.findQuestionImages(3);
        return { found: imgs.length, dataUrl: imgs.length ? imgs[0].dataUrl : '' };
      }
    });
    return r[0].result;
  }, tabId);
  const ocr = { found: imgData.found, resp: await opt.evaluate(async url => await chrome.runtime.sendMessage({ type: 'ocr-local-text', dataUrl: url }), imgData.dataUrl) };
  const ocrMs = Date.now() - t1;

  const text = (ocr.admin || ocr.resp && ocr.resp.text) || '';
  console.log('\nOCR 文本（' + ocrMs + 'ms）:');
  console.log(text.slice(0, 400) || '(空)');

  check('找到图片', ocr.found > 0, String(ocr.found));
  check('本地 OCR 返回文本', !!(ocr.resp && ocr.resp.ok && ocr.resp.text && ocr.resp.text.length > 10),
    JSON.stringify(ocr.resp && (ocr.resp.error || 'ok')));
  check('识别出题干关键字 TCP', /TCP/i.test(text), text.slice(0, 60));
  check('识别出选项字母', /[A-D]/.test(text), '');
  check('识别耗时在合理范围（< 90 秒）', ocrMs < 90000, ocrMs + 'ms');

  /* 3) 用页面解析器结构化 */
  const parsed = await worker.evaluate(async (tid, txt) => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async (txt) => {
        const list = qxExtract.scanPlainText(txt);
        return list.map(q => ({ kind: q.kind, stem: String(q.stem).slice(0, 40), opts: (q.options || []).length }));
      },
      args: [txt]
    });
    return r[0].result;
  }, tabId, text);

  console.log('\n结构化结果:', JSON.stringify(parsed, null, 1));
  check('OCR 文本能解析成题目', Array.isArray(parsed) && parsed.length > 0, JSON.stringify(parsed));
  check('解析出 4 个选项', !!(parsed[0] && parsed[0].opts >= 3), JSON.stringify(parsed[0]));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
