/**
 * 自动连做长时间运行稳定性（覆盖题型切换、后台节流心跳）
 *   node tools/e2e-autolong.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8818;
const API_PORT = 8819;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(SITE, url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1320, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'mock-key', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    kbEnabled: false, cacheEnabled: false, skipAnswered: true, concurrency: 1,
    followMode: false, stealth: true,
    autoInterval: 2, autoLimit: 22, autoNext: true
  });
  await sleep(300);

  const page = await browser.newPage();
  page.on('console', m => {
    const s = m.text();
    if (/\[exa\] auto/.test(s)) console.log('  ' + s);
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(1200);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8818')) || {}).id;
  });

  const readQ = () => page.evaluate(() => {
    const t = (document.querySelector('.qmeta') || {}).innerText || '';
    const m = t.match(/第\s*(\d+)\s*\/\s*(\d+)\s*题/);
    return {
      cur: m ? Number(m[1]) : -1,
      kind: /多选/.test(t) ? 'multi' : /判断/.test(t) ? 'judge' : /单选/.test(t) ? 'single' : '?',
      picked: document.querySelectorAll('#qcard .option.on').length
    };
  });

  const start = await readQ();
  console.log('起始：', JSON.stringify(start));

  // 启动自动连做
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.auto() });
  }, tabId);

  const timeline = [];
  let last = start;
  let maxGap = 0;
  let lastChange = Date.now();
  const t0 = Date.now();
  let pingOk = null;

  while (Date.now() - t0 < 110000) {
    await sleep(700);
    const now = await readQ();
    timeline.push(now);
    if (now.cur !== last.cur) {
      const gap = Date.now() - lastChange;
      if (gap > maxGap) maxGap = gap;
      lastChange = Date.now();
      last = now;
    }
    if (pingOk === null && Date.now() - t0 > 12000) {
      pingOk = await worker.evaluate(async tid => {
        try { return await chrome.tabs.sendMessage(tid, { type: 'exa-auto-ping' }); }
        catch (e) { return { error: String(e && e.message || e) }; }
      }, tabId);
    }
    if (now.cur >= 22) break;
  }

  const trace = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.autoTrace() });
    return r[0].result;
  }, tabId);
  console.log('自动连做轨迹（最后 12 步）：');
  (trace || []).slice(-12).forEach(x => console.log('  ' + JSON.stringify(x)));

  const end = await readQ();
  const kinds = [...new Set(timeline.map(x => x.kind))];
  const advanced = last.cur - start.cur;

  console.log('\n结束：', JSON.stringify(end), ' 推进', advanced, '题，最大停顿', Math.round(maxGap / 1000) + 's');
  console.log('经过的题型：', kinds.join(' → '));
  console.log('心跳响应：', JSON.stringify(pingOk));

  check('连续推进 ≥ 14 题（覆盖你说的 14 题之后）', advanced >= 14, '推进 ' + advanced + ' 题');
  check('中途没有长时间停滞（最大停顿 < 12s）', maxGap < 12000, Math.round(maxGap / 1000) + 's');
  check('跨越了题型切换仍然连续（判断→多选）', kinds.length >= 2, kinds.join('→'));
  const filledSamples = timeline.filter(x => x.picked > 0).length;
  check('作答后确实把选项填上了（采样命中 ≥3 次）', filledSamples >= 3,
    '含选中项的采样 ' + filledSamples + '/' + timeline.length);
  check('心跳消息能唤醒自动连做', !!(pingOk && pingOk.ok && pingOk.running), JSON.stringify(pingOk));

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
