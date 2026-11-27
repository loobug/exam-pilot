/**
 * 验证：填涂是否走完整鼠标事件序列（而非直接改 checked）
 *   node tools/e2e-mouse.mjs
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

/* 页面记录收到的每一个事件，以及点击坐标是否落在元素上 */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>鼠标事件</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}
.option{display:block;margin:8px 0;padding:10px;border:1px solid #ddd;border-radius:8px;cursor:pointer}
.option.on{background:#eef4ff;border-color:#a9c4ff}</style></head><body>
<div class="q">
  <div class="qtext">接到工单后多长时间内要主动联系客户？</div>
  <label class="option"><input type="radio" name="q" value="A"><span>A. 一小时</span></label>
  <label class="option"><input type="radio" name="q" value="B"><span>B. 两小时</span></label>
  <label class="option"><input type="radio" name="q" value="C"><span>C. 30 分钟</span></label>
</div>
<script>
window.__EV__ = [];
window.__MOVE__ = [];
document.addEventListener('mousemove', ev => {
  window.__MOVE__.push({ x: Math.round(ev.clientX), y: Math.round(ev.clientY) });
}, true);
const types = ['pointerover','pointerenter','pointermove','pointerdown','pointerup',
               'mouseover','mouseenter','mousemove','mousedown','mouseup','click','change'];
const optC = [...document.querySelectorAll('.option')][2];
const inp = optC.querySelector('input');
const targets = { label: optC, input: inp };
for (const [name, el] of Object.entries(targets)) {
  types.forEach(t => el.addEventListener(t, ev => {
    const r = el.getBoundingClientRect();
    const inside = ev.clientX >= r.left - 2 && ev.clientX <= r.right + 2 &&
                   ev.clientY >= r.top - 2 && ev.clientY <= r.bottom + 2;
    window.__EV__.push({ on: name, type: t, x: Math.round(ev.clientX), y: Math.round(ev.clientY),
                         inside, trusted: ev.isTrusted });
  }, true));
}
</script>
</body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8925, '127.0.0.1', r));

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
  const KB = `1. 接到工单后多长时间内要主动联系客户？
答案：C
`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8925/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8925')) || {}).id;
  });

  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        await d.extract();
        await d.solveAll();
        await d.fillOne(0);
      }
    });
  }, tabId);
  await sleep(400);

  const ev = await page.evaluate(() => ({
    events: window.__EV__,
    checked: document.querySelector('input[value="C"]').checked,
    moves: window.__MOVE__
  }));

  const types = ev.events.map(e => e.type);
  const uniq = [...new Set(types)];
  console.log('\n收到事件:', JSON.stringify(uniq));
  console.log('事件总数:', ev.events.length);

  check('选项被选中', ev.checked === true, String(ev.checked));
  check('派发了 pointerdown', uniq.includes('pointerdown'), uniq.join(','));
  check('派发了 mousedown', uniq.includes('mousedown'), uniq.join(','));
  check('派发了 mouseup', uniq.includes('mouseup'), uniq.join(','));
  check('派发了 click', uniq.includes('click'), uniq.join(','));
  check('有悬停事件（pointerover/mouseover）',
    uniq.includes('pointerover') || uniq.includes('mouseover'), uniq.join(','));
  check('有 pointermove（鼠标移动轨迹）', uniq.includes('pointermove'), uniq.join(','));

  const withXY = ev.events.filter(e => e.type === 'click' || e.type === 'mousedown');
  const mv = ev.moves || [];
  console.log('轨迹点数:', mv.length);
  console.log('轨迹前5点:', JSON.stringify(mv.slice(0, 5)));
  check('鼠标轨迹是多段移动（>= 4 个点）', mv.length >= 4, String(mv.length));
  const distinct = new Set(mv.map(p => p.x + ',' + p.y));
  check('轨迹点位置各不相同（真在移动）', distinct.size >= Math.min(4, mv.length), String(distinct.size));
  const last = mv[mv.length - 1];
  const nearTarget = last && Math.abs(last.x - 42) < 30 && Math.abs(last.y - 189) < 30;
  check('轨迹终点落在目标选项附近', !!nearTarget, JSON.stringify(last));

  check('事件带真实坐标且落在元素内',
    withXY.length > 0 && withXY.every(e => e.inside && e.x > 0 && e.y > 0),
    JSON.stringify(withXY.slice(0, 2)));

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
