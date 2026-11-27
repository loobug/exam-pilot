/**
 * popup 布局 + 图片题自动转视觉识别
 *   node tools/e2e-popup-image.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8846;
const API_PORT = 8847;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-image.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
const mock = await startMockApi(API_PORT);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k',
    model: 'mock-model', visionModel: 'mock-vision',
    temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: false, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: false, kbStrict: false, flashMs: 0
  });

  /* ---------- 1) popup 布局 ---------- */
  const popup = await browser.newPage();
  await popup.setViewport({ width: 360, height: 460 });
  await popup.goto('chrome-extension://' + extId + '/src/popup/popup.html', { waitUntil: 'domcontentloaded' });
  await sleep(700);

  const ui = await popup.evaluate(() => ({
    buttons: [...document.querySelectorAll('button')].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
    hasShot: !!document.getElementById('shot'),
    kbText: (document.getElementById('kb') || {}).textContent,
    modelText: (document.getElementById('model') || {}).textContent,
    sub: (document.getElementById('sub') || {}).textContent,
    bodyW: document.body.getBoundingClientRect().width
  }));
  console.log('popup:', JSON.stringify(ui, null, 1));

  check('弹窗里没有「截图解题」', !ui.hasShot && !ui.buttons.some(t => /截图/.test(t)), JSON.stringify(ui.buttons));
  check('保留打开面板 / 自动连做 / 设置', ui.buttons.some(t => /打开解题面板/.test(t)) && ui.buttons.some(t => /自动连做/.test(t)) && ui.buttons.some(t => /设置/.test(t)), JSON.stringify(ui.buttons));
  check('显示快捷键提示', ui.buttons.some(t => /Alt\+Shift\+Q/.test(t)), JSON.stringify(ui.buttons));
  check('状态区显示模型与知识库', /mock-model/.test(String(ui.modelText)) && /知识库|空/.test(String(ui.kbText)), String(ui.kbText));
  check('弹窗宽度合理（不超 380）', ui.bodyW <= 380 && ui.bodyW >= 300, ui.bodyW + 'px');

  await popup.screenshot({ path: path.join(ROOT, 'docs', 'shot-popup.png') }).catch(() => { });

  /* ---------- 2) 图片题自动转视觉 ---------- */
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-image.html`, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8846')) || {}).id;
  });

  const before = await worker.evaluate(async () => {
    const r = await fetch('http://127.0.0.1:' + 8847 + '/stats').then(x => x.json()).catch(() => ({}));
    return r.requests || 0;
  });

  const diag = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const list = await globalThis.__EXA_DEBUG__.extract();
        const dbg = {};
        // 直接看诊断结论
        const canvasCount = document.querySelectorAll('canvas').length;
        return { n: list.length, canvas: canvasCount };
      }
    });
    return r[0].result;
  }, tabId);

  // 触发识别流程（面板里的「识别本页」走同一条路径）
  await page.bringToFront();
  await worker.evaluate(async tid => {
    await chrome.tabs.sendMessage(tid, { type: 'cmd-extract' });
  }, tabId);
  await sleep(2500);

  const after = await worker.evaluate(async () => {
    const r = await fetch('http://127.0.0.1:' + 8847 + '/stats').then(x => x.json()).catch(() => ({}));
    return r.requests || 0;
  });

  console.log('\n图片题：canvas =', diag.canvas, ' 识别题数 =', diag.n, ' 模型请求', before, '→', after);

  check('canvas 题页面上确实没有可读文字（最多只有整页兜底）', diag.canvas > 0 && diag.n <= 1, `canvas=${diag.canvas} 识别=${diag.n}`);
  check('配了视觉模型后自动发起了识别请求', after > before, `${before} → ${after}`);

  const flash = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const b = document.querySelector('[data-ref="toast"]');
        return b ? b.textContent : null;
      }
    });
    return r[0].result;
  }, tabId).catch(() => null);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-image.png') }).catch(() => { });

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
