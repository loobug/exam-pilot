/**
 * 填涂前的动态校验：页面换题后不能把旧答案填到新题上
 *   node tools/e2e-guard.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8850;
const API_PORT = 8851;
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
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65, kbStrict: false, flashMs: 0
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
  }, kbText);
  await opt.close();

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=0&seed=3`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
  await sleep(150);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8850')) || {}).id;
  });

  /* 1) 正常情况：题目没变 → 应该填上 */
  const normal = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        await globalThis.__EXA_DEBUG__.extract();
        await globalThis.__EXA_DEBUG__.solveAll();
        const res = globalThis.__EXA_DEBUG__.results();
        const ok = await globalThis.__EXA_DEBUG__.fillOne(0);
        return { answer: res[0] && res[0].answer, filled: ok };
      }
    });
    return r[0].result;
  }, tabId);
  await sleep(400);
  const picked1 = await page.evaluate(() => document.querySelectorAll('.option.on').length);
  console.log('\n正常:', JSON.stringify(normal), '页面选中', picked1);
  check('题目未变时正常填涂', normal.filled === true && picked1 > 0, `${JSON.stringify(normal)} 选中${picked1}`);

  /* 2) 换题后再填：必须拒绝 */
  await page.evaluate(() => {
    // 模拟考试系统翻页：题干与选项整块换掉
    const stem = document.querySelector('.qtext');
    const opts = [...document.querySelectorAll('.option .otext')];
    if (stem) stem.textContent = '这是一道完全不同的新题目，用来模拟翻页后的情况。';
    opts.forEach((o, i) => { o.textContent = '新选项' + (i + 1); });
    document.querySelectorAll('.option.on').forEach(el => el.classList.remove('on'));
  });
  await sleep(300);

  const stale = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        try {
          const rep = qxFill.fillByIndex(0, { kind: 'single', answer: 'A' }, {});
          return rep;
        } catch (e) { return { error: String(e && e.message || e) }; }
      }
    });
    return r[0].result;
  }, tabId);
  await sleep(300);
  const picked2 = await page.evaluate(() => document.querySelectorAll('.option.on').length);
  console.log('换题后:', JSON.stringify(stale), '页面选中', picked2);

  check('换题后拒绝填涂（返回 stale）', !!stale && stale.ok === false && stale.stale === true, JSON.stringify(stale));
  check('拒绝时给出原因', /题目已变化/.test(String((stale || {}).error || '')), (stale || {}).error);
  check('换题后页面上没有被填任何选项', picked2 === 0, '选中 ' + picked2);

  /* 3) 阶段心跳：卡在哪一步能看见 */
  const clock = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const src = String(globalThis.__EXA_DEBUG__ ? '' : '');
        return { hasDebug: !!globalThis.__EXA_DEBUG__ };
      }
    });
    return r[0].result;
  }, tabId);
  check('调试钩子可用（便于排查卡点）', clock.hasDebug === true, JSON.stringify(clock));

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
