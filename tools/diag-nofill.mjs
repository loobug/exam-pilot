/** 复现「不答题」：默认设置下跟随模式是否自动作答 + 填涂 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8860;
const API_PORT = 8861;
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

// 起一个极简的 OpenAI 兼容服务，回答固定
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
      const payload = { answer: '对', type: 'judge', confidence: 0.9, reasoning: 'mock 回答' };
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(r => api.listen(API_PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1320, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();

  // 只配接口，其余走默认（followMode / stealth 用默认值）
  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 1024, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    kbEnabled: false, cacheEnabled: false, concurrency: 1
  });
  await sleep(300);

  const conf = await worker.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'getSettings' });
    return r && r.ok ? r.settings : null;
  }).catch(() => null);
  console.log('生效设置:', JSON.stringify({
    followMode: conf && conf.followMode, stealth: conf && conf.stealth,
    flashMs: conf && conf.flashMs, kbStrict: conf && conf.kbStrict
  }, null, 0));

  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.text();
    if (/\[exa\]/.test(t)) console.log('  console:', t);
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(800);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8860')) || {}).id;
  });

  const snap = async label => {
    const dom = await page.evaluate(() => ({
      qnum: ((document.querySelector('.qmeta') || {}).innerText || '').replace(/\n/g, ' ').slice(0, 22),
      picked: [...document.querySelectorAll('#qcard .option.on')].map(e => e.innerText.replace(/\n/g, '')),
      optCount: document.querySelectorAll('#qcard .option').length
    }));
    const st = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          const d = globalThis.__EXA_DEBUG__;
          if (!d) return { noDebug: true };
          const res = d.results();
          return {
            questions: d.questions().length,
            results: res.length,
            answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind,
            fill: res[0] && res[0].__fill,
            sig: d.followSig(),
            uiOn: d.uiOn()
          };
        }
      });
      return r[0].result;
    }, tabId);
    console.log(`[${label}] DOM:`, JSON.stringify(dom), '| 状态:', JSON.stringify(st));
    return { dom, st };
  };

  await sleep(1500);
  await snap('1.5s');
  await sleep(5000);
  const s2 = await snap('6.5s');

  // 自检输出
  const check = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => globalThis.__EXA_DEBUG__.selfCheck()
    });
    return r[0].result;
  }, tabId);
  console.log('\n自检:', JSON.stringify(check, null, 1));

  // 手动触发一次解题，看填涂环节
  const manual = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        const list = await d.extract();
        await d.solveAll();
        const res = d.results();
        const filled = await d.fillOne(0);
        return {
          n: list.length,
          answer: res[0] && res[0].answer,
          filled,
          trace: d.autoTrace ? d.autoTrace().slice(-6) : null
        };
      }
    });
    return r[0].result;
  }, tabId);
  console.log('\n手动 solve+fill:', JSON.stringify(manual, null, 1));

  await sleep(600);
  const after = await page.evaluate(() => ({
    picked: [...document.querySelectorAll('#qcard .option.on')].map(e => e.innerText.replace(/\n/g, ''))
  }));
  console.log('填后页面选中:', JSON.stringify(after));

  await page.screenshot({ path: path.join(ROOT, 'docs', 'diag-nofill.png') }).catch(() => { });

} catch (e) {
  console.error(e);
} finally {
  await browser.close();
  server.close();
  api.close();
}
