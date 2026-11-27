/** 复现：默认跟随模式下，多选题是否会自动填写 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8810;
const API_PORT = 8811;

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1320, height: 1000 }
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
    kbEnabled: true, kbDirect: true, cacheEnabled: false, skipAnswered: true, concurrency: 1
    // followMode / stealth / autoNext 全部走默认值
  });
  await sleep(300);

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(900);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8810')) || {}).id;
  });

  const snap = async label => {
    const dom = await page.evaluate(() => ({
      qnum: (document.querySelector('.qmeta') || {}).innerText.replace(/\n/g, ' ').trim().slice(0, 24),
      picked: [...document.querySelectorAll('#qcard .option.on')].map(e => e.innerText.replace(/\n/g, '')),
      optCount: document.querySelectorAll('#qcard .option').length
    }));
    const st = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          const d = globalThis.__EXA_DEBUG__;
          return {
            q: d.questions()[0] || null,
            res: d.results(),
            sig: d.followSig()
          };
        }
      });
      return r[0].result;
    }, tabId);
    console.log(`\n[${label}] 页面:`, JSON.stringify(dom));
    console.log(`[${label}] 识别: kind=${st.q && st.q.kind} opts=${(st.q && st.q.options || []).length} | 结果: ${JSON.stringify((st.res || []).map(x => ({ k: x.kind, a: x.answer, src: x.source && x.source.kind })))} | sig=${st.sig}`);
    return { dom, st };
  };

  await sleep(6000);
  await snap('第一题（判断，跟随模式）');

  // 翻到多选题
  for (let i = 0; i < 12; i++) {
    const info = await page.evaluate(() => (document.querySelector('.qmeta') || {}).innerText || '');
    if (/多选/.test(info)) break;
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
      if (btn) btn.click();
    });
    await sleep(700);
  }
  await snap('刚翻到多选题（1s 内）');
  await sleep(3000);
  await snap('多选题 3s 后');
  await sleep(4000);
  const final = await snap('多选题 7s 后');

  const ok = final.dom.picked.length >= 1;
  console.log(`\n结论：多选题自动填涂 ${ok ? '成功' : '失败'}，选中 ${final.dom.picked.length} 个`);

} catch (e) {
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
}
