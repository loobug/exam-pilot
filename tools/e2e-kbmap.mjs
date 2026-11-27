/**
 * 打乱选项后的知识库答案映射（复现用户报的三道错题）
 *   node tools/e2e-kbmap.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';
import { findBrowser } from './find-browser.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = findBrowser();
const WEB_PORT = 8821;
const API_PORT = 8822;
const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CASES = [
  { i: 0, kind: 'judge', expect: 'A', label: '第 1 题（判断题）' },
  { i: 1, kind: 'multi', expect: 'ABC', label: '第 2 题（项目收尾）' },
  { i: 2, kind: 'multi', expect: 'ABD', label: '第 3 题（项目启动）' },
  { i: 3, kind: 'judge', expect: 'B', label: '第 4 题（判断·选项颠倒）' }
];

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-three.html' : url);
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
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: false, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  const kbInfo = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    return kb.stats();
  }, kbText);
  console.log('知识库条目：', kbInfo.entries);

  const page = await browser.newPage();

  for (const c of CASES) {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-three.html?i=${c.i}`, { waitUntil: 'domcontentloaded' });
    await sleep(600);

    const tabId = await worker.evaluate(async () => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.includes('127.0.0.1:8821')) || {}).id;
    });

    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const list = await globalThis.__EXA_DEBUG__.extract();
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          await globalThis.__EXA_DEBUG__.fillOne(0);
          return {
            kind: list[0] && list[0].kind,
            answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind
          };
        }
      });
      return r[0].result;
    }, tabId);
    await sleep(600);

    const picked = await page.evaluate(() =>
      [...document.querySelectorAll('.option.on')].map(e => e.querySelector('.letter').textContent).join(''));
    const optTexts = await page.evaluate(() =>
      [...document.querySelectorAll('.option')].map(e => ({
        letter: e.querySelector('.letter').textContent,
        text: e.querySelector('.otext').textContent
      })));

    // 打开面板，读答案旁的来源标签
    await worker.evaluate(async tid => {
      try { await chrome.tabs.sendMessage(tid, { type: 'cmd-toggle' }); } catch (e) { }
    }, tabId);
    await sleep(500);
    const ansTag = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          try { return globalThis.__EXA_DEBUG__.ansTag(0); } catch (e) { return null; }
        }
      });
      return r[0].result;
    }, tabId);

    console.log(`\n${c.label}：kind=${out.kind} answer=${out.answer} src=${out.src} 页面选中=${picked || '无'} 标签=${JSON.stringify(ansTag)}`);

    check(`${c.label} 题型识别正确（${c.kind}）`, out.kind === c.kind, out.kind);
    check(`${c.label} 答案来自知识库`, out.src === 'kb', out.src);
    let norm;
    if (c.kind === 'judge') {
      const wantText = (optTexts.find(o => o.letter === c.expect) || {}).text || '';
      const wantTrue = /正确|对|√|true/i.test(wantText);
      const saidTrue = /^(对|正确|√|true)$/i.test(String(out.answer).trim());
      norm = (wantTrue === saidTrue) ? c.expect : '（相反）';
    } else {
      norm = String(out.answer).toUpperCase().replace(/[^A-H]/g, '');
    }
    check(`${c.label} 答案映射为 ${c.expect}`, norm === c.expect, String(out.answer));
    check(`${c.label} 页面选中 ${c.expect}`, picked === c.expect, picked || '无');
    check(`${c.label} 答案旁标明「来自知识库」`, /知识库/.test(String(ansTag || '')), JSON.stringify(ansTag));
    if (c.i === 3) {
      check('选项颠倒的判断题答对（B=正确）', picked === 'B', picked);
      check('标签标明精确命中', /精确/.test(String(ansTag || '')), JSON.stringify(ansTag));
    }
  }

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-kbmap.png') }).catch(() => { });

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
