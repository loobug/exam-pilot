/**
 * 复现：点击后整卡重渲染的多选页（真实站点行为）
 *   node tools/diag-multirender.mjs
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

/* 完全照抄真实站点：点击 → 改状态 → renderQuestion() 重建 DOM */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>重渲染多选</title>
<style>
body{font:15px/1.7 system-ui;margin:20px;background:#f4f6fa}
.qcard{background:#fff;border-radius:12px;padding:18px}
.qmeta{font-size:12px;color:#6b7688;margin-bottom:10px}
.qtext{font-size:17px;margin:0 0 14px}
.options{display:flex;flex-direction:column;gap:8px}
.option{display:flex;gap:10px;align-items:center;text-align:left;background:#fff;border:1px solid #e3e8f0;border-radius:9px;padding:9px 11px;cursor:pointer;font:inherit}
.option.on{background:#eef4ff;border-color:#a9c4ff}
.letter{width:22px;height:22px;border-radius:50%;background:#eef2f8;display:grid;place-items:center;font-weight:600;font-size:12px}
</style></head><body>
<div class="qcard" id="qcard"></div>
<script>
const Q = {
  type: 'multi',
  q: '“四大纪律”包括以下哪些内容？',
  options: ['影响客户使用', '侵犯客户权益', '引起客户反感', '泄露客户信息'],
  answer: [0, 1]
};
const LETTERS = 'ABCDEFGH'.split('');
let sel = [];

function renderQuestion(){
  const qcard = document.getElementById('qcard');
  qcard.innerHTML =
    '<div class="qmeta"><span class="badge multi">多选题</span><span>第 1 / 1 题</span>' +
    '<span class="hint">少选、多选、错选均不得分</span></div>' +
    '<h2 class="qtext">' + Q.q + '</h2>' +
    '<div class="options">' +
      Q.options.map((opt, i) =>
        '<button type="button" class="option ' + (sel.includes(i) ? 'on' : '') + '" data-i="' + i + '">' +
        '<span class="letter">' + LETTERS[i] + '</span><span class="otext">' + opt + '</span></button>'
      ).join('') +
    '</div>';
  qcard.querySelectorAll('.option').forEach(btn => {
    btn.addEventListener('click', () => selectOption(Number(btn.dataset.i)));
  });
}

function selectOption(i){
  if (sel.includes(i)) sel = sel.filter(x => x !== i);
  else sel.push(i);
  sel.sort((a,b) => a - b);
  renderQuestion();      // ← 关键：每次点击都重建整个卡片
}

renderQuestion();
window.__SEL__ = () => sel.slice();
</script>
</body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8922, '127.0.0.1', r));

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
    kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. “四大纪律”包括以下哪些内容？
A. 影响客户使用
B. 侵犯客户权益
C. 引起客户反感
D. 泄露客户信息
答案：AB
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8922/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8922')) || {}).id;
  });

  const out = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        const list = await d.extract();
        const q = list[0];
        const kb = await d.kbCheck();
        await d.solveAll();
        const res = d.results();
        const fillRes = await d.fillOne(0);
        return {
          kind: q && q.kind,
          options: q && (q.options || []).length,
          kbMode: kb && kb.mode,
          kbAnswer: kb && kb.answer,
          answer: res[0] && res[0].answer,
          fillRes,
          pageSel: window.__SEL__ ? window.__SEL__() : null,
          onClass: [...document.querySelectorAll('.option.on')].map(b => b.dataset.i)
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log(JSON.stringify(out, null, 1));
  const picked = out.pageSel || [];
  const ok = picked.length === 2 && picked.includes(0) && picked.includes(1);
  console.log(`\n${ok ? 'PASS' : 'FAIL'} 应选 [0,1]，实际 ${JSON.stringify(picked)}`);

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
