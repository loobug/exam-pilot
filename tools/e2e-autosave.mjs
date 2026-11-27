/**
 * 答题记录自动写本地文件
 *   node tools/e2e-autosave.mjs
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>自动保存</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body><div class="q">
<div class="qtext">接到工单后多长时间内要主动联系客户？</div>
<label class="option"><input type="radio" name="q" value="A"><span>A. 一小时</span></label>
<label class="option"><input type="radio" name="q" value="B"><span>B. 两小时</span></label>
<label class="option"><input type="radio" name="q" value="C"><span>C. 30 分钟</span></label>
</div></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8980, '127.0.0.1', r));

const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exa-dl-'));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run',
    `--download-directory=${dlDir}`
  ]
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    ocrEngine: 'auto', ocrDocImages: true, autoSaveAnswers: true,
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  // headless 下要显式设置下载行为
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }).catch(() => {});

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. 接到工单后多长时间内要主动联系客户？\nA. 一小时\nB. 两小时\nC. 30 分钟\n答案：C\n`;
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, KB);

  /* 清掉旧的下载记录 */
  await worker.evaluate(async () => {
    try { await chrome.downloads.erase({}); } catch (e) { }
  });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8980/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8980')) || {}).id;
  });

  /* 答一道题，触发记录 */
  const solved = await worker.evaluate(async tid => {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        await d.extract();
        await d.solveAll();
        const res = d.results();
        await d.fillOne(0);
        return { answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind };
      }
    });
    return out[0].result;
  }, tabId);
  console.log('已答题:', JSON.stringify(solved));

  /* 立即落盘 */
  const solvedLog = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'solve-log' }));
  console.log('solve-log 条数:', solvedLog && solvedLog.list && solvedLog.list.length);
  const status = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'answer-log-status' }));
  console.log('缓冲待写:', JSON.stringify(status));

  const flush = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'answer-log-flush' }));
  console.log('落盘结果:', JSON.stringify(flush));
  check('落盘成功', !!(flush && flush.ok && flush.wrote > 0), JSON.stringify(flush));

  await sleep(1500);

  /* 检查下载目录 */
  const files = fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : [];
  console.log('下载目录文件:', JSON.stringify(files));

  // CDP 拦截下载时会把 data: URL 存成 download.json，文件名由扩展的 filename 参数决定；
  // 内容正确即说明功能正常
  const csvLike = files.find(f => /exa-答题记录.*\.jsonl/.test(f)) || files.find(f => /download/.test(f));
  check('生成了答题记录文件', !!csvLike, JSON.stringify(files));

  if (csvLike) {
    const content = fs.readFileSync(path.join(dlDir, csvLike), 'utf8');
    console.log('\n文件内容:\n' + content.slice(0, 600));
    const lines = content.trim().split('\n').filter(Boolean);
    check('文件里有记录行', lines.length >= 1, String(lines.length));
    let rec = null;
    try { rec = JSON.parse(lines[0]); } catch (e) { }
    check('记录是合法 JSON', !!rec, lines[0].slice(0, 80));
    if (rec) {
      check('记录包含题干', typeof rec.stem === 'string' && rec.stem.length > 4, rec.stem);
      check('记录包含答案', typeof rec.answer === 'string' && rec.answer.length > 0, rec.answer);
      check('记录包含来源', typeof rec.src === 'string', rec.src);
      check('记录包含题型', typeof rec.kind === 'string', rec.kind);
    }
  }

  /* 关闭开关后不再写 */
  await worker.evaluate(async s => {
    const cur = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: Object.assign({}, cur.settings, s) });
  }, { autoSaveAnswers: false });
  await sleep(200);

  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        await d.extract();
        await d.solveForce(0);
      }
    });
  }, tabId);
  await sleep(1800);
  const flush2 = await opt.evaluate(async () => await chrome.runtime.sendMessage({ type: 'answer-log-flush' }));
  check('关闭后不再落盘', !(flush2 && flush2.wrote > 0), JSON.stringify(flush2));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) { }
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
