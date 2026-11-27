/**
 * 按真实考试站点结构复现「项目移交」题：带 qmeta 前缀
 *   node tools/diag-q46real.mjs
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

/* 完全照抄真实站点的 renderQuestion 结构（选项按用户页面顺序：C=初步验收报告 D=客户评价结果） */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>真实结构复现</title>
<style>
body{font:15px/1.7 system-ui;margin:20px;background:#f4f6fa}
.qcard{background:#fff;border-radius:12px;padding:18px}
.qmeta{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:#6b7688;margin-bottom:12px}
.badge{background:#eef4ff;color:#1f6feb;border-radius:6px;padding:1px 8px}
.qtext{font-size:17px;margin:0 0 14px}
.options{display:flex;flex-direction:column;gap:8px}
.option{display:flex;gap:10px;align-items:center;text-align:left;background:#fff;border:1px solid #e3e8f0;border-radius:9px;padding:9px 11px;cursor:pointer;font:inherit}
.option.on{background:#eef4ff;border-color:#a9c4ff}
.letter{width:22px;height:22px;border-radius:50%;background:#eef2f8;display:grid;place-items:center;font-weight:600;font-size:12px}
</style></head><body>
<div class="qcard" id="qcard">
  <div class="qmeta">
    <span class="badge single">单选题</span>
    <span class="qcat">六大注意</span>
    <span class="qnum">数字 6</span>
    <span>第 22 / 25 题</span>
    <span class="hint">请选择一项</span>
  </div>
  <h2 class="qtext">项目移交时必须包含以下哪项资料？</h2>
  <div class="options">
    <button type="button" class="option" data-i="0"><span class="letter">A</span><span class="otext">项目设计方案（售前方案）</span></button>
    <button type="button" class="option" data-i="1"><span class="letter">B</span><span class="otext">项目经验总结</span></button>
    <button type="button" class="option" data-i="2"><span class="letter">C</span><span class="otext">项目初步验收报告</span></button>
    <button type="button" class="option" data-i="3"><span class="letter">D</span><span class="otext">客户评价结果</span></button>
  </div>
</div>
<script>
document.querySelectorAll('.option').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.option').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
}));
</script>
</body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8921, '127.0.0.1', r));

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
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8921/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8921')) || {}).id;
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
        await d.fillOne(0);
        return {
          stemRaw: q && q.stem,
          kind: q && q.kind,
          options: q && (q.options || []).map(o => o.label + ':' + o.text),
          kbMode: kb && kb.mode,
          kbExact: kb && kb.exact,
          kbAnswer: kb && kb.answer,
          topQ: kb && kb.hits && kb.hits[0] && kb.hits[0].q,
          answer: res[0] && res[0].answer,
          src: res[0] && res[0].source && res[0].source.kind,
          picked: [...document.querySelectorAll('.option.on')].map(b => b.dataset.i)
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log(JSON.stringify(out, null, 1));
  const ok = Array.isArray(out.picked) && out.picked.includes('0');
  console.log(`\n${ok ? 'PASS' : 'FAIL'} 应选 A(索引0)，实际选中 ${JSON.stringify(out.picked)}`);

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
