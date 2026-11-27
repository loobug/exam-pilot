/**
 * 同一题干多个矛盾答案时，不许盲选
 *   node tools/e2e-kbconflict.mjs
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
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>冲突</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body><div class="q">
  <div class="qtext">“服务完成要确认”包括以下哪些环节？</div>
  <label class="option"><input type="checkbox" name="q" value="A"><span>A. 甲方说法</span></label>
  <label class="option"><input type="checkbox" name="q" value="B"><span>B. 乙方说法</span></label>
  <label class="option"><input type="checkbox" name="q" value="C"><span>C. 丙方说法</span></label>
  <label class="option"><input type="checkbox" name="q" value="D"><span>D. 丁方说法</span></label>
</div>
</body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8935, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 3, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: true, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  /* 故意造冲突：同题干两条，答案不同、选项不同，页面选项无法区分 */
  const KB = `1. “服务完成要确认”包括以下哪些环节？
A. 故障处理结果验证确认
B. 现场清理和复原
C. 服务签字确认或在线评价确认
D. 预留服务工程师名片
E. 强迫客户填写满意评价
答案：ABCD

2. “服务完成要确认”包括以下哪些环节？
A. 结果验证
B. 现场清理
C. 讲解与培训
D. 签字或评价
E. 预留名片
F. 服务结果反馈
答案：ABCDEF
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'dup.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
    return await kb.stats();
  }, KB);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8935/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8935')) || {}).id;
  });

  const r = await worker.evaluate(async tid => {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        await d.extract();
        const kb = await d.kbCheck();
        return {
          mode: kb && kb.mode,
          answer: kb && kb.answer,
          hits: kb && kb.hits && kb.hits.length,
          conflict: kb && kb.conflict
        };
      }
    });
    return out[0].result;
  }, tabId);

  console.log(JSON.stringify(r, null, 1));
  check('题库内答案冲突时不盲选（strict 走 miss）', r.mode === 'miss', `mode=${r.mode}`);

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(x => !x.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
