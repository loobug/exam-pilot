/**
 * 一页多题：跟随模式是否全部自动填上 + 每题耗时
 *   node tools/e2e-multiq.mjs
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

const N = 6;
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>一页多题</title>
<style>.q{margin:10px 0;padding:10px;border:1px solid #eee;border-radius:8px}.qtext{font-weight:700}
.option{display:inline-block;margin:4px 8px}</style></head><body>
${Array.from({ length: N }, (_, i) => `
<div class="q">
  <div class="qtext">第 ${i + 1} 题 ${["接到工单后多长时间内要主动联系客户？","进入客户现场对着装有什么要求？","四大纪律包括哪些内容？","信息安全红线有哪些？","服务完成后需要做什么？","客户投诉如何处理？"][i]}</div>
  <label class="option"><input type="radio" name="q${i}" value="A"><span>A. 一小时</span></label>
  <label class="option"><input type="radio" name="q${i}" value="B"><span>B. 两小时</span></label>
  <label class="option"><input type="radio" name="q${i}" value="C"><span>C. 30 分钟</span></label>
</div>`).join('')}
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => web.listen(8901, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 10, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: true, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 3, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. 接到工单后多长时间内要主动联系客户？
答案：C

2. 进入客户现场对着装有什么要求？
答案：C

3. 四大纪律包括哪些内容？
答案：C

4. 信息安全红线有哪些？
答案：C

5. 服务完成后需要做什么？
答案：C

6. 客户投诉如何处理？
答案：C
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (t.includes('exa:dbg')) console.log('  LOG:', t); });
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'domcontentloaded' });
  await sleep(200);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8901')) || {}).id;
  });

  /* 先看识别结果 */
  const probe = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const raw = qxExtract.extractAll({ fallback: true });
        const d = (() => { try { return qxExtract.debugInfo(); } catch (e) { return null; } })();
        return {
          rawCount: raw.length,
          rawStems: raw.map(q => String(q.stem).slice(0, 20)),
          byInputs: d && d.byInputs && d.byInputs.count,
          domQ: document.querySelectorAll('.q').length,
          domRadio: document.querySelectorAll('input[type=radio]').length,
          domStems: [...document.querySelectorAll('.q .qtext')].map(e => e.textContent.slice(0, 22))
        };
      }
    });
    return r[0].result;
  }, tabId);
  console.log('识别探测:', JSON.stringify(probe, null, 1));

  const audit = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.kbAudit() });
    return r[0].result;
  }, tabId);
  console.log('知识库审计:', JSON.stringify({ 命中: audit.直接命中, 未命中: audit.未命中, 明细: audit.明细.map(x => ({ stem: x.stem.slice(0, 16), mode: x.mode, exact: x.exact })) }, null, 1));

  /* 等跟随模式自己完成（最多 15 秒） */
  let filledCount = 0, waited = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    waited += 500;
    filledCount = await page.evaluate(() =>
      [...document.querySelectorAll('.q')].filter(q => q.querySelector('input:checked')).length
    );
    if (filledCount >= N) break;
  }
  const elapsed = Date.now() - t0;
  console.log(`\n一页 ${N} 题：${filledCount} 题已填，耗时 ${elapsed}ms（轮询 ${waited}ms）`);

  check('一页多题全部自动填上', filledCount === N, `${filledCount}/${N}`);
  check('多题总耗时在合理范围（< 6 秒）', elapsed < 6000, elapsed + 'ms');

  /* 每题填的是不是正确的 C */
  const detail = await page.evaluate(() =>
    [...document.querySelectorAll('.q')].map((q, i) => {
      const checked = q.querySelector('input:checked');
      return { i: i + 1, v: checked ? checked.value : null };
    })
  );
  console.log('各题选中:', JSON.stringify(detail));
  check('每题都填了 C（知识库答案）', detail.every(d => d.v === 'C'), JSON.stringify(detail.map(d => d.v)));

  /* 覆盖率：确认没有漏题 */
  const stats = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const d = globalThis.__EXA_DEBUG__;
        return { q: d.questions().length, res: d.results().length };
      }
    });
    return r[0].result;
  }, tabId);
  console.log('识别/已解:', JSON.stringify(stats));
  check('识别到全部题目', stats.q === N, JSON.stringify(stats));
  check('全部解出', stats.res === N, JSON.stringify(stats));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
