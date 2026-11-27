/**
 * 六选项多选题 + 知识库命中 + 多选填涂（5 项）
 *   node tools/e2e-six.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8816;
const API_PORT = 8817;
const MIME = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-six.html' : url);
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
  defaultViewport: { width: 1100, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'mock-key', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: false, cacheEnabled: false, skipAnswered: true, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65
  });

  /* 导入从考试页题库导出的知识库 */
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  const imported = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    const res = await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    return { res, stats: await kb.stats() };
  }, kbText);
  console.log('知识库导入：', JSON.stringify(imported.res), JSON.stringify(imported.stats));
  check('从题库导出并建成索引', imported.stats.entries >= 100, '条目 ' + imported.stats.entries);

  /* 页面 */
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-six.html`, { waitUntil: 'domcontentloaded' });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8816')) || {}).id;
  });

  const ident = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => qxExtract.extractAll({}).map(q => ({
        kind: q.kind, stem: String(q.stem).slice(0, 40),
        opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 10))
      }))
    });
    return r[0].result;
  }, tabId);
  console.log('\n识别：', JSON.stringify(ident, null, 1));

  check('识别出 1 道题', ident.length === 1, '实际 ' + ident.length);
  check('题型为多选', ident[0] && ident[0].kind === 'multi', ident[0] && ident[0].kind);
  check('识别出 6 个选项', ident[0] && ident[0].opts.length === 6, ident[0] && ident[0].opts.length);
  check('题干干净（无题号/标签）', ident[0] && !/^(多选|判断|单选)/.test(ident[0].stem) && ident[0].stem.includes('五项要求'),
    ident[0] && ident[0].stem);

  /* 解题（应命中知识库，答案是题库里的 ABCDE） */
  const solved = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        await globalThis.__EXA_DEBUG__.solveAll();
        return globalThis.__EXA_DEBUG__.results();
      }
    });
    return r[0].result;
  }, tabId);
  const one = (solved || [])[0] || {};
  console.log('\n解题：', JSON.stringify({ kind: one.kind, answer: one.answer, src: one.source && one.source.kind }));

  check('答案来自知识库', one.source && one.source.kind === 'kb', one.source && one.source.kind);
  check('答案与题库一致（ABCDE）', String(one.answer || '').toUpperCase() === 'ABCDE', one.answer);

  /* 填涂 */
  const rep = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => qxFill.fillByIndex(0, { kind: 'multi', answer: 'ABCDE' }, {})
    });
    return r[0].result;
  }, tabId);
  await sleep(600);

  const pageState = await page.evaluate(() => ({
    on: [...document.querySelectorAll('#qcard .option.on')].map(e => e.querySelector('.letter').textContent),
    states: document.getElementById('states').textContent,
    total: document.querySelectorAll('#qcard .option').length
  }));
  console.log('\n填涂：', JSON.stringify({ fill: rep, page: pageState }, null, 1));

  check('页面选中 5 个选项', pageState.on.length === 5, JSON.stringify(pageState.on));
  check('选中的正好是 ABCDE', pageState.on.join('') === 'ABCDE', pageState.on.join(''));
  check('F（服务结束要回访）没有被选中', !pageState.on.includes('F'), JSON.stringify(pageState.on));

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-six.png') }).catch(() => { });

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
