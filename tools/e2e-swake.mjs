/**
 * service worker 被回收后能否自己唤醒并继续解题
 *   node tools/e2e-swake.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8866;
const API_PORT = 8867;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
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
  executablePath: CHROME, headless: true, protocolTimeout: 300000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  let worker = await sw.worker();

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: false, flashMs: 0, siteAllow: ''
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=0&seed=8`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
  await sleep(500);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8866')) || {}).id;
  });

  const solveOnce = async label => {
    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          globalThis.__EXA_DEBUG__.clearResults();
          const list = await globalThis.__EXA_DEBUG__.extract();
          if (!list.length) return { n: 0 };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          return { n: list.length, solved: res.length, answer: res[0] && res[0].answer, err: res[0] && res[0].error };
        }
      });
      return r[0].result;
    }, tabId).catch(e => ({ error: String(e && e.message || e) }));
    console.log(`[${label}]`, JSON.stringify(out));
    return out;
  };

  /* 1) 首次解题：确认基线正常 */
  const first = await solveOnce('首次');
  check('首次解题成功', first.solved > 0, JSON.stringify(first));

  /* 2) 等 service worker 真正休眠（MV3 空闲 30 秒回收） */
  console.log('\n等待 40 秒让 service worker 休眠…');
  await sleep(40000);

  // 看 SW 是否已经不在（target 消失）
  const alive = browser.targets().some(t => t.type() === 'service_worker');
  console.log('SW target 仍在:', alive);

  /* 3) 休眠后再解题：应该被唤醒并成功 */
  const second = await solveOnce('休眠后');
  check('休眠后仍能解题（自动唤醒 + 重试）', second.solved > 0, JSON.stringify(second));
  check('没有出现"扩展已更新请刷新页面"的假报错',
    !/扩展已更新/.test(String(second.err || '')), String(second.err || '（无错误）'));

  /* 4) 连续两题（模拟边做边答） */
  const third = await solveOnce('再解一次');
  check('第二次连续解题也成功', third.solved > 0, JSON.stringify(third));

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
