/**
 * AI 预处理索引：别名命中 + 完整 enrich 流程
 *   node tools/e2e-kbenrich.mjs
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/* Mock 模型：第一次调用返回一批索引 JSON */
let apiCalls = 0;
const api = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    apiCalls += 1;
    // 返回与请求条目数量匹配的索引
    const count = (body.match(/题干：/g) || []).length || 2;
    const arr = Array.from({ length: count }, (_, i) => ({
      i: i + 1,
      aliases: i === 0
        ? ['报单后多久联系客户', '接到工单多长时间联系', '工单响应时间要求']
        : ['穿什么衣服去客户现场', '上门着装要求'],
      keywords: i === 0 ? ['响应时限', '30分钟', 'P1'] : ['着装', '短裤', '凉鞋'],
      topic: i === 0 ? '服务响应时限' : '现场着装规范'
    }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(arr) } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise(r => api.listen(8897, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:8897/v1', apiKey: 'k', model: 'mock',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 5, kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  const KB = `1. 接到工单后多长时间内要主动联系客户？
A. 一小时
B. 两小时
C. 30 分钟
答案：C

2. 进入客户现场对着装有什么要求？
A. 无要求
B. 禁止穿短裤凉鞋
C. 随意
答案：B
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
  }, KB);

  /* 1) 预处理前：换个问法应该查不到 */
  const beforeAlias = await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const rows = await kb.search('报单后多久联系客户', { exactQuestion: '报单后多久联系客户', topK: 3 });
    return rows.map(r => ({ exact: r.exact, cov: +r.coverage.toFixed(2), q: String(r.entry.question).slice(0, 30) }));
  });
  console.log('预处理前换个问法:', JSON.stringify(beforeAlias));
  const beforeHit = beforeAlias.some(r => r.exact);
  check('预处理前：换问法不会精确命中', beforeHit === false, JSON.stringify(beforeAlias));

  /* 2) 跑 AI 整理 */
  const stats0 = await opt.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'kb-enrich-stats' });
    return r;
  });
  console.log('整理前进度:', JSON.stringify(stats0));
  check('有 2 条待整理', stats0.total === 2 && stats0.pending === 2, JSON.stringify(stats0));

  let guard = 0, lastRes = null;
  for (;;) {
    if (guard++ > 10) break;
    lastRes = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'kb-enrich', batchSize: 12 }));
    if (!lastRes || !lastRes.ok || lastRes.done) break;
  }
  console.log('整理结果:', JSON.stringify(lastRes));
  check('AI 整理完成', !!(lastRes && lastRes.ok && lastRes.done), JSON.stringify(lastRes));
  console.log('模型调用次数:', apiCalls);
  check('确实调用了模型', apiCalls > 0, String(apiCalls));

  /* 诊断：看 enrich 里存了什么 */
  const enrichDump = await opt.evaluate(async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('exa-kb', 2); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    return await new Promise(res => {
      const tx = db.transaction('enrich', 'readonly');
      const rq = tx.objectStore('enrich').getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res([]);
    });
  });
  console.log('enrich 内容:', JSON.stringify(enrichDump, null, 1));

  /* 3) 预处理后：换问法应精确命中 */
  const afterAlias = await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const q1 = await kb.search('报单后多久联系客户', { exactQuestion: '报单后多久联系客户', topK: 3 });
    const q2 = await kb.search('上门着装要求', { exactQuestion: '上门着装要求', topK: 3 });
    return {
      q1: q1.map(r => ({ exact: r.exact, ans: String(r.entry.answer).slice(0, 6), q: String(r.entry.question).slice(0, 24) })),
      q2: q2.map(r => ({ exact: r.exact, ans: String(r.entry.answer).slice(0, 6), q: String(r.entry.question).slice(0, 24) }))
    };
  });
  console.log('预处理后换个问法:', JSON.stringify(afterAlias, null, 1));

  check('别名命中：「报单后多久联系客户」→ 原题', afterAlias.q1.length > 0 && afterAlias.q1[0].exact === true, JSON.stringify(afterAlias.q1[0]));
  check('别名命中：「上门着装要求」→ 原题', afterAlias.q2.length > 0 && afterAlias.q2[0].exact === true, JSON.stringify(afterAlias.q2[0]));
  check('命中后能取到正确答案（C=30分钟）', /C/.test(String(afterAlias.q1[0] && afterAlias.q1[0].ans)), String(afterAlias.q1[0] && afterAlias.q1[0].ans));

  /* 4) 进度显示 */
  const stats1 = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'kb-enrich-stats' }));
  console.log('整理后进度:', JSON.stringify(stats1));
  check('进度全部完成', stats1.done === stats1.total && stats1.pending === 0, JSON.stringify(stats1));

  /* 5) 清除后恢复原状 */
  await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'kb-enrich-clear' }));
  const afterClear = await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const rows = await kb.search('报单后多久联系客户', { exactQuestion: '报单后多久联系客户', topK: 3 });
    return rows.map(r => r.exact);
  });
  check('清除后别名不再命中', !afterClear.includes(true), JSON.stringify(afterClear));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  api.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
