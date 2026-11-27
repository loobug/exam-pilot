/**
 * 跟随模式在「结构陌生 / 后台标签」下也能答题
 *   node tools/e2e-follow2.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8862;
const API_PORT = 8863;
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
    followMode: true, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65, flashMs: 0
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

  /* ---------- 场景 A：结构陌生页面（没有第 N/M 题，也没有 .qtext） ---------- */
  const weird = await browser.newPage();
  await weird.goto(`http://127.0.0.1:${WEB_PORT}/exam-weird.html`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const tabA = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8862') && t.url.includes('weird')) || {}).id;
  });

  const sigA = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ sig: globalThis.__EXA_DEBUG__.followSig(), q: globalThis.__EXA_DEBUG__.questions().length, res: globalThis.__EXA_DEBUG__.results().length })
    });
    return r[0].result;
  }, tabA);
  console.log('\n陌生结构页:', JSON.stringify(sigA));
  check('陌生页面也能算出跟随签名（不是空）', !!sigA.sig && sigA.sig.length > 2, JSON.stringify(sigA.sig));
  check('陌生页面跟随模式也解出了答案', sigA.res > 0, `已解 ${sigA.res}`);

  /* ---------- 场景 B：签名不变时也兜底检查（5 秒一次） ---------- */
  const bank = await browser.newPage();
  await bank.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=0&seed=2`, { waitUntil: 'domcontentloaded' });
  await bank.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
  await sleep(2500);

  const tabB = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8862') && t.url.includes('exam-bank')) || {}).id;
  });

  const solvedB = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ res: globalThis.__EXA_DEBUG__.results().length, picked: document.querySelectorAll('.option.on').length })
    });
    return r[0].result;
  }, tabB);
  console.log('题库页:', JSON.stringify(solvedB));
  check('题库页跟随模式自动作答并填上', solvedB.res > 0 && solvedB.picked > 0, JSON.stringify(solvedB));

  /* ---------- 场景 C：心跳能唤醒跟随 ---------- */
  const ping = await worker.evaluate(async tid => {
    try { return await chrome.tabs.sendMessage(tid, { type: 'exa-auto-ping' }); }
    catch (e) { return { error: String(e && e.message || e) }; }
  }, tabB);
  console.log('心跳响应:', JSON.stringify(ping));
  check('心跳在未开自动连做时会推动跟随模式', !!ping && (ping.mode === 'follow' || ping.running === false), JSON.stringify(ping));

  await bank.screenshot({ path: path.join(ROOT, 'docs', 'shot-follow2.png') }).catch(() => { });

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
