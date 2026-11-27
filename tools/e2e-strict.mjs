/**
 * 严格知识库模式：库内有 → 用库答案；库内没有 → 明确报「未收录」，不调模型
 *   node tools/e2e-strict.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';
import { findBrowser } from './find-browser.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = findBrowser();
const WEB_PORT = 8842;
const API_PORT = 8843;
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
    followMode: false, stealth: false, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65,
    kbStrict: true
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

  const runOne = async (i, seed) => {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=${i}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
    await sleep(100);
    const tabId = await worker.evaluate(async () => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.includes('127.0.0.1:8842')) || {}).id;
    });
    await worker.evaluate(async tid => {
      try { await chrome.tabs.sendMessage(tid, { type: "cmd-toggle" }); } catch (e) { }
    }, tabId);
    await sleep(400);
    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          let list = await globalThis.__EXA_DEBUG__.extract();
          for (let k = 0; k < 3 && !list.length; k++) {
            await new Promise(r2 => setTimeout(r2, 120));
            list = await globalThis.__EXA_DEBUG__.extract();
          }
          if (!list.length) return { n: 0 };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          return { n: list.length, answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind, warn: res[0] && res[0].warn, tag: globalThis.__EXA_DEBUG__.ansTag(0) };
        }
      });
      return r[0].result;
    }, tabId);
    return out;
  };

  /* 1) 库内题：必须走知识库 */
  const inBank = await runOne(0, 5);
  console.log('\n库内题：', JSON.stringify(inBank));
  check('库内题走知识库', inBank.src === 'kb', inBank.src);
  check('库内题有答案', !!String(inBank.answer || '').trim(), JSON.stringify(inBank.answer));
  check('库内题标签标「知识库」', /知识库/.test(String(inBank.tag || '')), JSON.stringify(inBank.tag));

  /* 2) 库外题：构造一道题库里没有的题 */
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=0&seed=5`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
  await sleep(100);
  const changed = await page.evaluate(() => {
    const el = document.querySelector('.qtext');
    if (!el) return null;
    el.textContent = '这道题在题库里绝对没有收录，用于验证严格模式的未收录提示。';
    return el.textContent;
  });
  console.log('已把题干改为:', JSON.stringify(String(changed).slice(0, 24)));
  await sleep(150);
  const missTab = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8842')) || {}).id;
  });
  const miss = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        globalThis.__EXA_DEBUG__.clearResults();
        await globalThis.__EXA_DEBUG__.extract();
        await globalThis.__EXA_DEBUG__.solveAll();
        const res = globalThis.__EXA_DEBUG__.results();
        let kb = null;
        try { kb = await globalThis.__EXA_DEBUG__.kbCheck(); } catch (e) { kb = { error: String(e && e.message || e) }; }
        const stem = (globalThis.__EXA_DEBUG__.questions()[0] || {}).stem;
        return {
          answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind,
          warn: res[0] && res[0].warn, tag: globalThis.__EXA_DEBUG__.ansTag(0),
          stem: String(stem || "").slice(0, 40),
          kbMode: kb && kb.mode, kbExact: kb && kb.exact
        };
      }
    });
    return r[0].result;
  }, missTab);
  console.log('\n库外题：', JSON.stringify(miss));
  check('库外题不返回模型答案', !String(miss.answer || '').trim(), JSON.stringify(miss.answer));
  check('库外题来源标 miss', miss.src === 'miss', miss.src);
  check('库外题给出未收录警告', /未收录/.test(String(miss.warn || '')), JSON.stringify(miss.warn));
  check('库外题在卡片上给出「未收录」提示', /未收录/.test(String(miss.warn || '') + String(miss.tag || '')), JSON.stringify(miss.warn || miss.tag));

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-strict.png') }).catch(() => { });

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
