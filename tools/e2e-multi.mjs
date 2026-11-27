/**
 * 多选题三种实现形态的识别 + 填涂验证
 *   node tools/e2e-multi.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8812;
const API_PORT = 8813;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-multi.html' : url);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1200, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
    apiKey: 'mock-key', model: 'mock-model', visionModel: '',
    temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '',
    kbEnabled: true, kbDirect: true, cacheEnabled: false, skipAnswered: true, concurrency: 1,
    followMode: false, stealth: false
  });
  await sleep(300);

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-multi.html`, { waitUntil: 'domcontentloaded' });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8812')) || {}).id;
  });

  const ident = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => qxExtract.extractAll({}).map(q => ({ kind: q.kind, stem: String(q.stem).slice(0, 24), opts: (q.options || []).map(o => o.label) }))
    });
    return r[0].result;
  }, tabId);
  console.log('\n识别：', JSON.stringify(ident, null, 1));

  check('识别出 3 道题', ident.length === 3, '实际 ' + ident.length);
  check('三道题都判为多选', ident.every(q => q.kind === 'multi'), JSON.stringify(ident.map(q => q.kind)));
  check('选项数量都为 4', ident.every(q => q.opts.length === 4), JSON.stringify(ident.map(q => q.opts.length)));

  // 解题 + 填涂
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        await globalThis.__EXA_DEBUG__.solveAll();
        for (let i = 0; i < 3; i++) {
          try { await globalThis.__EXA_DEBUG__.fillOne(i); } catch (e) { }
        }
      }
    });
  }, tabId);
  await sleep(1200);

  const state = await page.evaluate(() => ({
    m1: Array.from(document.querySelectorAll('#m1 input:checked')).map(x => x.value),
    m2: Array.from(document.querySelectorAll('#m2 input:checked')).map(x => x.value),
    m3: Array.from(document.querySelectorAll('#m3 .opt2.selected')).map(x => x.textContent.trim().slice(0, 1))
  }));
  console.log('\n填涂结果：', JSON.stringify(state));

  check('形态一（隐藏 checkbox + label 包裹）选中 2 个', state.m1.length === 2, JSON.stringify(state.m1));
  check('形态二（input 与 label 分离）选中 2 个', state.m2.length === 2, JSON.stringify(state.m2));
  check('形态三（自定义 div toggle）选中 2 个', state.m3.length === 2, JSON.stringify(state.m3));

  // 再点一次「填入」不应把已选的取消掉（幂等）
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => { for (let i = 0; i < 3; i++) { try { await globalThis.__EXA_DEBUG__.fillOne(i); } catch (e) { } } }
    });
  }, tabId);
  await sleep(800);
  const again = await page.evaluate(() => ({
    m1: Array.from(document.querySelectorAll('#m1 input:checked')).map(x => x.value),
    m2: Array.from(document.querySelectorAll('#m2 input:checked')).map(x => x.value),
    m3: Array.from(document.querySelectorAll('#m3 .opt2.selected')).map(x => x.textContent.trim().slice(0, 1))
  }));
  check('重复填入不会把已选项取消', again.m1.length === 2 && again.m2.length === 2 && again.m3.length === 2, JSON.stringify(again));

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-multi.png') }).catch(() => { });

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exit(bad.length ? 1 : 0);
}
