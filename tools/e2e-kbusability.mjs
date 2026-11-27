/**
 * 知识库可用性专项：精确命中 + 选项倒装 + 判断题答案文本
 *   node tools/e2e-kbusability.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8870;
const API_PORT = 8871;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-judge.html' : url);
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
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  // 用用户反馈过的那道题题干做一条精确题库
  const KB = `客户满意是服务人员最终价值体现，也是我们持续追求的目标。
A: 错误
B: 正确
答案: B
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-test.txt', size: text.length, mime: 'text/plain', text });
    const st = await kb.stats();
    const rows = await kb.search('客户满意是服务人员最终价值体现，也是我们持续追求的目标。 A. 错误 B. 正确', {
      exactQuestion: '客户满意是服务人员最终价值体现，也是我们持续追求的目标。',
      topK: 5
    });
    window.__KBDIAG__ = { st, rows: rows.map(r => ({ exact: r.exact, score: r.score, cov: r.coverage, q: r.entry.question, ans: r.entry.answer, raw: r.entry.raw })) };
  }, KB);
  const kbDiag = await opt.evaluate(() => window.__KBDIAG__);
  console.log('\n入库诊断:', JSON.stringify(kbDiag));
  await opt.close();

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8870')) || {}).id;
  });

  const runSolve = async () => worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        globalThis.__EXA_DEBUG__.clearResults();
        const list = await globalThis.__EXA_DEBUG__.extract();
        await globalThis.__EXA_DEBUG__.solveAll();
        const res = globalThis.__EXA_DEBUG__.results();
        return {
          q: list[0] && { stem: String(list[0].stem).slice(0, 30), kind: list[0].kind,
            srcField: list[0].source, refs: !!(list[0].refs && list[0].refs.container),
            options: (list[0].options || []).map(o => o.label + ':' + o.text) },
          answer: res[0] && res[0].answer,
          src: res[0] && res[0].source && res[0].source.kind,
          warn: res[0] && res[0].warn,
          kb: await globalThis.__EXA_DEBUG__.kbCheck()
        };
      }
    });
    return r[0].result;
  }, tabId);

  /* 1) 页面 A=错误 B=正确（与题库一致） */
  let out = await runSolve();
  console.log('\n一致顺序:', JSON.stringify({ q: out.q, answer: out.answer, src: out.src }));
  check('题干精确命中走知识库', out.src === 'kb', out.src);
  check('答案映射到页面 B=正确', /B|正确/.test(String(out.answer)), String(out.answer));

  /* 2) 页面选项倒过来：A=正确 B=错误，题库答案 B(正确) 应映射成 A */
  await page.evaluate(() => {
    const a = document.querySelectorAll('.option .otext');
    if (a.length >= 2) { a[0].textContent = '正确'; a[1].textContent = '错误'; }
    document.querySelectorAll('.option.on').forEach(e => e.classList.remove('on'));
    document.querySelectorAll('.option input').forEach((el, i) => { el.value = i === 0 ? 'A' : 'B'; });
  });
  await sleep(300);
  out = await runSolve();
  console.log('倒装顺序:', JSON.stringify({ q: out.q, answer: out.answer, src: out.src }));
  check('倒装后仍走知识库', out.src === 'kb', out.src);
  check('倒装后答案映射到 A=正确', /A|正确/.test(String(out.answer)), String(out.answer));

  /* 3) 库外题：应变 AI */
  await page.evaluate(() => {
    const s = document.querySelector('.qtext,.stem');
    if (s) s.textContent = '这道题完全没有收录进知识库，用来验证降级到 AI 的路径。';
  });
  await sleep(300);
  out = await runSolve();
  console.log('库外题:', JSON.stringify({ answer: out.answer, src: out.src }));
  check('库外题降级到 AI（默认非严格）', out.src === 'ai' || out.src === 'kb+ai', out.src);

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
