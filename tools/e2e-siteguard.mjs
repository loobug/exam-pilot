/**
 * 非考试页不该空转 + 网站白名单
 *   node tools/e2e-siteguard.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8864;
const API_PORT = 8865;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 一个"非考试页"：网关配置后台
const ADMIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>模型网关 · Providers</title>
<style>body{font:14px/1.7 system-ui;margin:0;padding:20px;background:#f6f7fb}
.card{background:#fff;border:1px solid #e5e8f0;border-radius:10px;padding:16px;max-width:760px}
h3{margin:0 0 10px}label{display:block;margin:8px 0}input{width:320px;padding:6px 8px;border:1px solid #ccd;border-radius:6px}</style>
</head><body><div class="card">
<h3>新建渠道 · Google</h3>
<label>Base URL <input value="https://generativelanguage.googleapis.com" /></label>
<label>API Key <input value="sk-xxxx" /></label>
<label>模型 <input value="gemini-2.5-pro" /></label>
<div style="margin-top:12px;color:#778">这里是一堆配置项和说明文字，页面上没有任何题目。</div>
</div></body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-bank.html' : url);
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
  executablePath: CHROME, headless: true, protocolTimeout: 240000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1200, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  const base = {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 1024, timeoutSec: 20,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: true, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: false, flashMs: 0, siteAllow: ''
  };
  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, base);
  const applySettings = async patch => worker.evaluate(async p => {
    const cur = await chrome.storage.local.get('settings');
    const next = Object.assign({}, cur.settings || {}, p);
    await chrome.storage.local.set({ settings: next });
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) { chrome.tabs.sendMessage(t.id, { type: 'settings-changed' }).catch(() => { }); }
    }
  }, patch);

  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.text();
    if (/\[exa\]/.test(t)) console.log('  console:', t);
  });

  /* ---------- 1) 非考试页：连续空识别后自停 ---------- */
  await page.goto(`http://127.0.0.1:${WEB_PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await sleep(1000);

  const tabA = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8864') && t.url.includes('admin')) || {}).id;
  });

  // 等它自己空转一阵（每 1.5s 一次，8 次约 12s）
  await sleep(16000);

  const idle = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const s = globalThis.__EXA_DEBUG__.selfCheck();
        return { 停用: s.跟随.本页已停用, 空识别: s.跟随.连续空识别, 已解: s.已解 };
      }
    });
    return r[0].result;
  }, tabA);
  console.log('\n非考试页:', JSON.stringify(idle));
  check('非考试页没有任何解答', idle.已解 === 0, '已解 ' + idle.已解);
  check('连续空识别后自动停用该页', idle.停用 === true, JSON.stringify(idle));

  /* ---------- 2) 白名单：只在允许的域名跑 ---------- */
  await applySettings({ siteAllow: 'exam.example.com' });
  await sleep(1500);

  const blocked = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ allowed: globalThis.__EXA_DEBUG__.siteAllowed(), sa: (globalThis.__EXA_DEBUG__.selfCheck().settings || {}).siteAllow }) 
    });
    return r[0].result;
  }, tabA);
  console.log('白名单状态:', JSON.stringify(blocked));
  check('不在白名单时判定为不允许', blocked && blocked.allowed === false, JSON.stringify(blocked));

  // 切成允许当前站
  await applySettings({ siteAllow: '127.0.0.1' });
  await sleep(600);
  const okState = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => globalThis.__EXA_DEBUG__.siteAllowed()
    });
    return r[0].result;
  }, tabA);
  check('填了匹配域名后判定为允许', okState === true, String(okState));

  /* ---------- 3) 考试页仍然正常作答 ---------- */
  const exam = await browser.newPage();
  await exam.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=0&seed=6`, { waitUntil: 'domcontentloaded' });
  await exam.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
  await sleep(3000);

  const tabB = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8864') && t.url.includes('exam-bank')) || {}).id;
  });
  const examState = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ res: globalThis.__EXA_DEBUG__.results().length, picked: document.querySelectorAll('.option.on').length })
    });
    return r[0].result;
  }, tabB);
  console.log('考试页:', JSON.stringify(examState));
  check('白名单内的考试页照常自动作答', examState.res > 0 && examState.picked > 0, JSON.stringify(examState));

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
