/**
 * 速度基准：整卷多题并行 vs 串行；知识库预热前后首次检索耗时
 *   node tools/e2e-speed.mjs
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
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 整卷页面：6 道单选
const N = 6;
const pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>整卷</title>
<style>.q{margin:14px 0}.qtext{font-weight:700}</style></head><body>
${Array.from({ length: N }, (_, i) => `
<div class="q">
  <div class="qtext">第 ${i + 1} 题 测试题目内容 ${i + 1}，请选择正确答案。</div>
  <label class="option"><input type="radio" name="q${i}" value="A"><span>A. 选项甲</span></label>
  <label class="option"><input type="radio" name="q${i}" value="B"><span>B. 选项乙</span></label>
</div>`).join('')}
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise(r => web.listen(8895, '127.0.0.1', r));

// Mock API：每题固定延迟 300ms，模拟真实模型时延
const API_DELAY = 300;
let concurrentPeak = 0, concurrentNow = 0;
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  concurrentNow += 1;
  concurrentPeak = Math.max(concurrentPeak, concurrentNow);
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const payload = { type: 'single', answer: 'A', confidence: 0.9, reasoning: 'mock' };
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      concurrentNow -= 1;
    }, API_DELAY);
  });
});
await new Promise(r => api.listen(8896, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  const base = {
    baseUrl: 'http://127.0.0.1:8896/v1', apiKey: 'k', model: 'mock',
    visionModel: '', temperature: 0.2, maxTokens: 512, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, skipAnswered: false,
    kbEnabled: false, flashMs: 0, siteAllow: ''
  };

  const setConc = async n => {
    await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, Object.assign({}, base, { concurrency: n }));
    await sleep(300);
  };

  const page = await browser.newPage();
  const tabIdOf = async () => worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8895')) || {}).id;
  });

  const runAll = async label => {
    await page.goto('http://127.0.0.1:8895/', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const tabId = await tabIdOf();
    const t0 = Date.now();
    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          globalThis.__EXA_DEBUG__.clearResults();
          const list = await globalThis.__EXA_DEBUG__.extract();
          await globalThis.__EXA_DEBUG__.solveAll();
          return { n: list.length, solved: globalThis.__EXA_DEBUG__.results().length };
        }
      });
      return r[0].result;
    }, tabId);
    const dt = Date.now() - t0;
    console.log(`[${label}] ${out.n} 题 / 解出 ${out.solved}，耗时 ${dt}ms`);
    return { dt, ...out };
  };

  /* 串行 */
  await setConc(1);
  concurrentPeak = 0;
  const serial = await runAll('并发1');
  const peakSerial = concurrentPeak;

  /* 并发 3 */
  await setConc(3);
  concurrentPeak = 0;
  const par = await runAll('并发3');
  const peakPar = concurrentPeak;

  console.log(`\n峰值并发请求：串行 ${peakSerial}，并发3 ${peakPar}`);
  console.log(`提速：${serial.dt}ms → ${par.dt}ms（${Math.round((1 - par.dt / serial.dt) * 100)}%）`);

  check('两轮都解出全部题目', serial.solved === N && par.solved === N, `${serial.solved}/${par.solved}`);
  check('并发确实并行发出请求', peakPar > peakSerial, `峰值 ${peakSerial} → ${peakPar}`);
  check('整卷耗时明显下降（≥30%）', par.dt < serial.dt * 0.7, `${serial.dt}ms → ${par.dt}ms`);

  /* 知识库预热效果 */
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  const timing = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    // 冷检索（首次，要载入内存索引）
    const t1 = performance.now();
    await kb.search('工单响应时限', { exactQuestion: '工单响应时限', topK: 3 });
    const cold = performance.now() - t1;
    // 热检索
    const t2 = performance.now();
    await kb.search('工单响应时限', { exactQuestion: '工单响应时限', topK: 3 });
    const warm = performance.now() - t2;
    return { cold: Math.round(cold), warm: Math.round(warm) };
  }, kbText);
  console.log(`\n知识库检索：首次 ${timing.cold}ms，预热后 ${timing.warm}ms`);
  check('预热后检索显著更快', timing.warm < timing.cold, `${timing.cold}ms → ${timing.warm}ms`);
  check('预热后单次检索 < 30ms', timing.warm < 30, timing.warm + 'ms');

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
