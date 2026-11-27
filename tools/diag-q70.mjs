/** 严谨规范判断题：用站点原始数据 + 站点渲染结构复现 */
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

/* 站点源码原样：options:['正确','错误'], answer:[0] */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>站点结构复现</title>
<style>
body{margin:0;background:#f4f6fa;font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#1f2430}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px}
.qcard{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:20px 22px}
.qmeta{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12px;color:#6b7688;margin-bottom:12px}
.badge{background:#f3e8ff;color:#7c3aed;border-radius:6px;padding:1px 8px;font-weight:600}
.qcat,.qnum{color:#6b7688}
.hint{color:#f59e0b}
.qtext{font-size:17px;font-weight:600;margin:0 0 16px;line-height:1.6}
.options{display:flex;flex-direction:column;gap:9px}
.option{display:flex;gap:11px;align-items:center;text-align:left;background:#fff;border:1px solid #e3e8f0;
  border-radius:10px;padding:11px 13px;cursor:pointer;font:inherit;color:inherit;transition:.15s}
.option:hover{border-color:#c9d6ea}
.option.on{background:#eef4ff;border-color:#a9c4ff}
.letter{width:24px;height:24px;border-radius:50%;background:#eef2f8;display:grid;place-items:center;font-weight:600;font-size:12px;flex:0 0 auto}
.option.on .letter{background:#1f6feb;color:#fff}
</style></head><body><div class="wrap">
<div class="qcard" id="qcard">
  <div class="qmeta">
    <span class="badge judge">判断题</span>
    <span class="qcat">四大纪律</span>
    <span class="qnum">数字 4</span>
    <span>第 3 / 25 题</span>
    <span class="hint">请判断正误</span>
  </div>
  <h2 class="qtext">“严谨规范”要求所有操作都必须先做风险识别，并在操作后做结果验证。</h2>
  <div class="options" id="opts"></div>
</div>
</div>
<script>
const Q = { type:'judge', q:'“严谨规范”要求所有操作都必须先做风险识别，并在操作后做结果验证。',
            options:['正确','错误'], answer:[0] };
const LETTERS='ABCDEFGH'.split('');
let sel=[];
function render(){
  const box=document.getElementById('opts');
  box.innerHTML = Q.options.map((o,i)=>
    '<button type="button" class="option '+(sel.includes(i)?'on':'')+'" data-i="'+i+'" aria-pressed="'+(sel.includes(i)?'true':'false')+'">'+
    '<span class="letter">'+LETTERS[i]+'</span><span class="otext">'+o+'</span></button>').join('');
  box.querySelectorAll('.option').forEach(b=>b.addEventListener('click',()=>pick(Number(b.dataset.i))));
}
function pick(i){
  if (Q.type==='multi'){ sel = sel.includes(i)? sel.filter(x=>x!==i) : [...sel,i].sort((a,b)=>a-b); }
  else { sel=[i]; }
  render();
}
render();
window.__SEL__=()=>sel.slice();
</script></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8934, '127.0.0.1', r));

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
    skipAnswered: false, concurrency: 3, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8934/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8934')) || {}).id;
  });

  const r = await worker.evaluate(async tid => {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        const list = await d.extract();
        const q = list[0];
        const kb = await d.kbCheck();
        await d.solveAll();
        const res = d.results();
        await d.fillOne(0);
        await new Promise(r => setTimeout(r, 150));
        return {
          stem: String(q.stem || '').replace(/\s+/g, ' '),
          kind: q.kind,
          opts: (q.options || []).map(o => o.label + ':' + o.text),
          mode: kb && kb.mode, exact: kb && kb.exact, kbAnswer: kb && kb.answer,
          topQ: kb && kb.hits && kb.hits[0] && String(kb.hits[0].q).slice(0, 40),
          answer: res[0] && res[0].answer,
          src: res[0] && res[0].source && res[0].source.kind,
          on: [...document.querySelectorAll('.option.on')].map(b => Number(b.dataset.i)),
          onText: [...document.querySelectorAll('.option.on')].map(b => (b.querySelector('.otext') || {}).textContent || '')
        };
      }
    });
    return out[0].result;
  }, tabId);

  console.log(JSON.stringify(r, null, 1));
  console.log(`\n站点标准答案：A = 正确（索引 0）`);
  check('走知识库', r.mode === 'kb', `mode=${r.mode}`);
  check('精确命中', r.exact === true, String(r.exact));
  check('答"对"', r.answer === '对', String(r.answer));
  check('选中"正确"（索引 0）', r.on.includes(0), JSON.stringify(r.on));
  check('选中文案是"正确"', (r.onText[0] || '').includes('正确'), JSON.stringify(r.onText));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(x => !x.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
}
